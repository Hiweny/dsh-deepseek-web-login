/**
 * 面板侧：内置浏览器 guest 的生命周期 + 保活。
 *
 * ## 硬约束（踩了就会"看起来在工作、其实是重新加载了页面"）
 *
 * 1. **容器自始至终不移动、不重建**：Electron 的 `<webview>` 一旦从 DOM 摘除再插回，
 *    guest 会**重新加载**。所以宿主节点挂在一个永不卸载的槽位（`shell.overlay`）上，
 *    设置页只控制"显示/隐藏"，绝不搬运这个节点。
 * 2. 创建顺序：先设 `partition` + `src=about:blank#<lease>`（门禁要求精确相等），
 *    再挂上去；`useragent` 必须在**第一次导航到站点之前**设好 —— 晚一步，
 *    站点看到的就是带 Electron 痕迹的 UA（"洗白"白做）。
 * 3. 装完登录态**必须 reload**：站点 JS 是在启动时读 `userToken` 的，不 reload 等于没装。
 *
 * ## 这个浏览器不参与发消息
 *
 * 它只负责"有一个真人那样活着的页面"（站点自己的 JS 在跑）。回答不回显、发送不走它。
 */
import {
  GUEST_BROWSER_URL,
  buildGuestUserAgent,
  guestFingerprintFix,
  guestProbeExpression,
  type GuestBeat,
  type GuestBeatState,
} from '../guest-browser.ts'
import { judgeObservation, pickIntervalMs, SITE_ORIGIN } from '../transport-heartbeat.ts'

interface GuestReservation {
  lease: string
  partition: string
}

/** 宿主 preload 暴露的浏览器 guest 桥（只有主窗口主 frame 有）。 */
interface DesktopBrowserBridge {
  acquire(workspace: string): Promise<GuestReservation>
  release(lease: string): Promise<void>
}

interface GuestElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  reload(): void
}

export interface GuestStatus {
  running: boolean
  state: GuestBeatState
  at: number
  url: string
  beats: number
  recoveries: number
  account?: string
  note?: string
  error?: string
}

export interface GuestSessionResult {
  ok: boolean
  account?: string
  userAgent?: string
  writes?: { key: string; value: string }[]
  error?: string
}

export interface GuestDeps {
  /** 从 host 取"当前账号的登录态写法和那份真实 UA"。 */
  fetchSession: () => Promise<GuestSessionResult>
  /** 把写法编成页面脚本（复用 page-session 的构建器）。 */
  buildInstall: (writes: { key: string; value: string }[]) => string
  /** 把心跳报给 host（host 会校验形状）。 */
  reportBeat: (beat: GuestBeat) => Promise<void>
  workspace?: string
  intervalMs?: number
  now?: () => number
  random?: () => number
  log?: (message: string) => void
  /** 等待事件；用例里可注入成"立刻返回"。 */
  waitEvent?: (element: GuestElement, event: string, timeoutMs: number) => Promise<boolean>
}

export interface GuestBrowser {
  start: () => Promise<GuestStatus>
  stop: () => Promise<GuestStatus>
  setVisible: (visible: boolean) => void
  visible: () => boolean
  status: () => GuestStatus
  subscribe: (fn: (status: GuestStatus) => void) => () => void
  /** 单次探测 + 判定 + 必要时恢复（用例直接调它，不依赖真定时器）。 */
  beatOnce: () => Promise<GuestStatus>
}

const DEFAULT_INTERVAL_MS = 60_000

/**
 * 「网页版」页签占位符量出来的矩形（视口坐标）。
 *
 * 常驻宿主用 `position:fixed` 贴到这个矩形上 —— **guest 永远住在 overlay 里不动**，
 * 页签里只放一个量尺寸的占位符（webin 同款：`<webview>` 一摘一插就会重新加载）。
 * `null` = 页签当前不可见 ⇒ 宿主隐藏但 guest 继续活着。
 */
export interface GuestRect { left: number; top: number; width: number; height: number }
let targetRect: GuestRect | null = null
const rectListeners = new Set<(rect: GuestRect | null) => void>()

export function publishGuestRect(rect: GuestRect | null): void {
  targetRect = rect
  for (const fn of rectListeners) {
    try {
      fn(rect)
    } catch {
      /* 面板回调出错不该拖垮 guest */
    }
  }
}

export function subscribeGuestRect(fn: (rect: GuestRect | null) => void): () => void {
  rectListeners.add(fn)
  return () => rectListeners.delete(fn)
}

/** 宿主节点：由 overlay 组件注册进来，永不卸载。 */
let hostNode: HTMLElement | undefined

export function registerGuestHost(node: HTMLElement | null): void {
  hostNode = node ?? undefined
}

export function guestHostNode(): HTMLElement | undefined {
  return hostNode
}

function bridge(): DesktopBrowserBridge | undefined {
  const carrier = (globalThis as unknown as { dshDesktop?: { protocolVersion?: number; browser?: unknown } })
    .dshDesktop
  if (!carrier || carrier.protocolVersion !== 1) return undefined
  const found = carrier.browser as DesktopBrowserBridge | undefined
  return found && typeof found.acquire === 'function' ? found : undefined
}

export function createGuestBrowser(deps: GuestDeps): GuestBrowser {
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const log = deps.log ?? (() => {})
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const waitEvent =
    deps.waitEvent ??
    ((element: GuestElement, event: string, timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          element.removeEventListener(event, onEvent)
          resolve(false)
        }, timeoutMs)
        function onEvent(): void {
          clearTimeout(timer)
          element.removeEventListener(event, onEvent)
          resolve(true)
        }
        element.addEventListener(event, onEvent)
      }))

  let element: GuestElement | undefined
  let lease: string | undefined
  let visible = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let status: GuestStatus = {
    running: false,
    state: 'idle',
    at: 0,
    url: '',
    beats: 0,
    recoveries: 0,
  }
  const listeners = new Set<(status: GuestStatus) => void>()

  function emit(patch: Partial<GuestStatus>): void {
    status = { ...status, ...patch }
    for (const fn of listeners) {
      try {
        fn({ ...status })
      } catch {
        /* 面板回调出错不该拖垮 guest */
      }
    }
  }

  /** 把登录态写进 guest 页面，然后 **reload**（站点 JS 启动时才读它）。 */
  async function installSession(): Promise<boolean> {
    if (!element) return false
    const session = await deps.fetchSession()
    if (!session?.ok || !session.writes?.length) {
      emit({ account: session?.account, note: session?.error ?? 'host 没有给出可用的登录态' })
      return false
    }
    const expression = deps.buildInstall(session.writes)
    const report = await element.executeJavaScript(expression)
    emit({ account: session.account })
    log(`guest：登录态已写入（${String(report).slice(0, 120)}）`)
    element.reload()
    await waitEvent(element, 'did-finish-load', 20_000)
    return true
  }

  /** 失败也要留痕：面板报错只在界面上，截图排不动问题（host 会落盘）。 */
  async function reportFailure(reason: string): Promise<void> {
    emit({ running: false, error: reason })
    try {
      await deps.reportBeat({
        state: 'dead',
        at: now(),
        url: '',
        beats: status.beats + 1,
        recoveries: status.recoveries,
        note: reason,
      })
    } catch {
      /* 留痕失败不影响主流程 */
    }
  }

  async function attach(): Promise<boolean> {
    const carrier = bridge()
    if (!carrier) {
      await reportFailure(
        '本环境没有内置浏览器通道（主窗口 globalThis.dshDesktop.browser 不存在或 protocolVersion≠1）',
      )
      return false
    }
    const node = hostNode
    if (!node) {
      await reportFailure('浏览器宿主节点还没挂上（shell.overlay 未渲染）')
      return false
    }
    const reservation = await carrier.acquire(deps.workspace ?? 'deepseek-web-login')
    lease = reservation.lease
    /**
     * 🔴 会话与 UA 必须在**创建/挂载元素之前**拿。
     *
     * `useragent` 属性只在**挂载/导航前**被读取 —— 挂载之后再设等于没设。
     * 上一版就栽在这里：页面带着 `Electron/` UA 出去，网页端直接回「使用环境异常」。
     * （dsh-webin 的注释原文：「useragent 属性在导航之前生效 —— 不能等 dom-ready
     *   再用 setUserAgent，否则第一次请求已经带着 Electron UA 出去了」。）
     */
    const session = await deps.fetchSession()
    const pageUa =
      String(session?.userAgent ?? '').trim() || buildGuestUserAgent(navigator.userAgent)
    const created = document.createElement('webview') as GuestElement
    // 门禁要求：partition 用 acquire 给的；src 必须**精确**是 about:blank#<lease>
    created.setAttribute('name', reservation.lease)
    created.setAttribute('partition', reservation.partition)
    created.setAttribute('useragent', pageUa)
    created.setAttribute('allowpopups', '')
    created.setAttribute('src', `about:blank#${reservation.lease}`)
    created.style.width = '100%'
    created.style.height = '100%'
    created.style.border = '0'
    created.style.display = 'block'
    // 主世界指纹修正（webdriver=false / userAgentData 品牌）—— 监听要在 append **之前**注册，
    // 否则第一次 dom-ready（约 blank）之后的站点 dom-ready 也可能错过
    created.addEventListener('dom-ready', () => {
      void created.executeJavaScript(guestFingerprintFix(pageUa)).catch(() => {})
    })
    node.appendChild(created)
    element = created
    const ready = await waitEvent(created, 'dom-ready', 20_000)
    if (!ready) log('guest：dom-ready 等超时（继续试）')
    await created.loadURL(GUEST_BROWSER_URL).catch((error) => {
      log(`guest：导航失败 ${String(error)}`)
    })
    await waitEvent(created, 'did-finish-load', 25_000)
    if (session?.ok && session.writes?.length) {
      await installSession()
    } else {
      emit({ note: session?.error ?? 'host 没有给出可用的登录态（页面会是未登录）' })
    }
    emit({ running: true, error: undefined })
    return true
  }

  async function detach(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    element?.remove()
    element = undefined
    const current = lease
    lease = undefined
    if (current) {
      await bridge()?.release(current).catch(() => {})
    }
    emit({ running: false })
  }

  function schedule(): void {
    if (timer !== undefined || !element) return
    // 抖动：固定周期本身就是模式（与传输层心跳同一个函数）
    timer = setTimeout(() => {
      timer = undefined
      void beatOnce().then(() => {
        if (status.running && status.state !== 'dead') schedule()
      })
    }, pickIntervalMs(intervalMs, random))
  }

  async function beatOnce(): Promise<GuestStatus> {
    if (!element || inFlight) return { ...status }
    inFlight = true
    try {
      let observed = null
      try {
        const raw = await element.executeJavaScript(guestProbeExpression())
        observed = typeof raw === 'string' ? JSON.parse(raw) : null
      } catch (error) {
        observed = null
        log(`guest：探测失败 ${String(error)}`)
      }
      const judged = judgeObservation(observed, SITE_ORIGIN)
      const changed = judged.state !== status.state
      emit({
        state: judged.state,
        at: now(),
        beats: status.beats + 1,
        url: String((observed as { url?: string } | null)?.url ?? ''),
        ...(judged.reason ? { note: judged.reason } : {}),
      })
      if (changed) {
        if (judged.state === 'logged-out') {
          log('guest：页面未登录 ⇒ 重装登录态')
          await installSession().catch((error) => emit({ note: `重装失败：${String(error)}` }))
        } else if (judged.state === 'off-origin') {
          log('guest：页面被导航走了 ⇒ 带回站点')
          await element.loadURL(GUEST_BROWSER_URL).catch(() => {})
        } else if (judged.state === 'dead') {
          emit({ running: false, note: 'guest 探测不到（已停表，重新启动即可）' })
        }
        if (judged.state !== 'dead') emit({ recoveries: status.recoveries + 1 })
      }
      await deps.reportBeat({
        state: status.state,
        at: status.at,
        url: status.url,
        beats: status.beats,
        recoveries: status.recoveries,
        ...(status.note ? { note: status.note } : {}),
        // 🔴 把页面眼里的环境一起带回去（host 落盘对账）：弹不弹「使用环境异常」
        //    只有页面自己知道，凭这里的 ua/webdriver/brands/webgl 对账，不猜。
        ...(observed
          ? {
              fingerprint: {
                ua: String((observed as Record<string, unknown>).ua ?? ''),
                webdriver: (observed as Record<string, unknown>).webdriver === true,
                brands: String((observed as Record<string, unknown>).uaDataBrands ?? ''),
                webgl: String((observed as Record<string, unknown>).webgl ?? ''),
                // 页面自己的视口尺寸（"大小不对"要跟宿主盒子比一比）
                vw: Number((observed as Record<string, unknown>).vw ?? 0),
                vh: Number((observed as Record<string, unknown>).vh ?? 0),
                dpr: String((observed as Record<string, unknown>).dpr ?? ''),
                ...(targetRect
                  ? { box: { w: Math.round(targetRect.width), h: Math.round(targetRect.height) } }
                  : {}),
              },
            }
          : {}),
      })
      return { ...status }
    } finally {
      inFlight = false
    }
  }

  return {
    async start() {
      if (status.running) return { ...status }
      const ok = await attach().catch(async (error) => {
        await reportFailure(`启动失败：${String((error as Error)?.message ?? error)}`)
        return false
      })
      if (ok) schedule()
      return { ...status }
    },
    async stop() {
      await detach()
      return { ...status }
    },
    setVisible() {
      // 可见性现在由「网页版」页签的矩形驱动（publishGuestRect），这里保留空实现以免调用点炸
    },
    visible: () => targetRect !== null,
    status: () => ({ ...status }),
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    beatOnce,
  }
}
