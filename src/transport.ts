/**
 * 传输层选择 —— 网页端请求到底是「从 Node 网络栈出去」还是「从 Chromium 网络栈出去」。
 *
 * 为什么在意（2026-09-12 实测，同一台机器同一天）：
 *
 * | | JA4 | cipher 列表哈希 | ALPN |
 * |---|---|---|---|
 * | Node fetch(undici) | `t13d5212h1_…` | — | **h1** |
 * | Chrome（本机 152） | `t13d1517h2_8daaf6152771_cb7bf5808d99` | `8daaf6152771` | h2 |
 * | net.fetch（Electron 43） | `t13d1516h2_8daaf6152771_806a8c22fdea` | **`8daaf6152771`** | h2 |
 *
 * 也就是说 Node 的请求在 **TLS 层**就能被判定为「非浏览器客户端」（cipher 数量差 3 倍多、
 * 不走 HTTP/2、完全不带 GREASE），而这几项**调参修不了**。
 * 改用 Electron 的 `net.fetch` 后，走的是 Chromium 内置网络栈：
 * cipher 列表哈希与 Chrome **逐字节一致**，ALPN 与 cipher 数量也都对上，
 * 唯一差异是扩展数 16 vs 17（Electron 43 内置 Chromium 150，本机 Chrome 是 152，版本差异，属正常）。
 *
 * 集成方式：宿主（index.ts）在启动时按设置**一次性注入**，而不是让 webapi 去 require electron ——
 * webapi 保持与环境无关，单测里天然不会碰到 electron。
 *
 * ⚠️ 行为变更（必须知道）：Chromium 网络栈会走**系统代理**，而 Node fetch 完全无视代理。
 * 若系统代理指向未开启的梯子，切到 chromium 后请求会失败 —— 所以这项做成设置页可切换，
 * 并在失败时给出明确指引。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { resolveDshHome } from './auth.ts'
import {
  createBrowserFetch,
  invalidateTransportSession,
  markTransportPageSessionStale,
  navigateTransportToSite,
  readTransportPageState,
  shutdownBrowserTransport,
  systemBrowserAvailable,
} from './browser-transport.ts'
import {
  createTransportHeartbeat,
  type HeartbeatSnapshot,
  type TransportHeartbeat,
} from './transport-heartbeat.ts'
import { createTransportIdleWatch, type TransportIdleWatch } from './transport-idle.ts'
import { setFetchImpl } from './webapi.ts'

export type TransportKind = 'chromium' | 'node'

/** 默认走 Chromium 网络栈 —— 这才是本插件想要的"看起来像浏览器"。 */
export const DEFAULT_TRANSPORT: TransportKind = 'chromium'

export const TRANSPORT_HINT =
  'Chrome 网络栈会跟随「系统代理」（Node 则完全无视代理）。若梯子关闭时系统代理仍指向 ' +
  '127.0.0.1:7897，切到 Chrome 后请求会失败 —— 这时切回 Node 即可。'

/** 取 Electron 的 `net.fetch`；不可用（非 Electron 环境 / 未暴露 net）返回 undefined。 */
export function electronNetFetch(): typeof fetch | undefined {
  try {
    const electron: any = createRequire(import.meta.url)('electron')
    const impl = electron?.net?.fetch
    return typeof impl === 'function' ? impl : undefined
  } catch {
    return undefined
  }
}

export function transportSettingsPath(): string {
  return join(resolveDshHome(), 'web-login', 'transport.json')
}

export function readTransportSetting(): TransportKind | undefined {
  try {
    const file = transportSettingsPath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed?.transport === 'node' || parsed?.transport === 'chromium' ? parsed.transport : undefined
  } catch {
    return undefined
  }
}

export function writeTransportSetting(kind: TransportKind): void {
  const file = transportSettingsPath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ transport: kind }, null, 2) + '\n', 'utf8')
}

/** 传输层空闲多久自动关闭（毫秒）；transport.json 的 `idleShutdownMs`。默认 10 分钟，0 = 永不退场。 */
export const DEFAULT_TRANSPORT_IDLE_SHUTDOWN_MS = 10 * 60_000

export function readTransportIdleShutdownMs(): number | undefined {
  try {
    const file = transportSettingsPath()
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value = parsed?.idleShutdownMs
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

export interface TransportState {
  /** 用户/配置要求的那一个 */
  requested: TransportKind
  /** 实际生效的那一个 */
  effective: TransportKind
  /** 要求 chromium 但没有任何可用 Chrome 网络栈实现，已降级到 Node */
  degraded: boolean
  /** 本环境是否具备 Chromium 网络栈（Electron utility 进程里才有） */
  chromiumAvailable: boolean
  /** 本环境是否具备系统浏览器（Edge/Chrome），可用作浏览器代理 */
  browserAvailable: boolean
  /** 实际走的是浏览器代理（不是 electron.net.fetch） */
  viaBrowserProxy: boolean
}

/**
 * 决定实际用哪个。
 *
 * 优先级：electron.net.fetch > 系统浏览器代理 > Node fetch。
 * 降级只在**启动时**按能力判定，**不做「请求失败后自动换一条重试」** ——
 * 完成请求一旦重发可能就是一次重复生成，代价比"切错了手动改回来"大得多。
 */
export function resolveTransportState(requested: TransportKind): TransportState {
  const electronFetch = electronNetFetch()
  const chromiumAvailable = electronFetch !== undefined
  const browserAvailable = systemBrowserAvailable()

  if (requested === 'chromium') {
    if (electronFetch) {
      return {
        requested,
        effective: 'chromium',
        degraded: false,
        chromiumAvailable: true,
        browserAvailable,
        viaBrowserProxy: false,
      }
    }
    if (browserAvailable) {
      return {
        requested,
        effective: 'chromium',
        degraded: false,
        chromiumAvailable: false,
        browserAvailable: true,
        viaBrowserProxy: true,
      }
    }
    return {
      requested,
      effective: 'node',
      degraded: true,
      chromiumAvailable: false,
      browserAvailable: false,
      viaBrowserProxy: false,
    }
  }
  return {
    requested,
    effective: 'node',
    degraded: false,
    chromiumAvailable,
    browserAvailable,
    viaBrowserProxy: false,
  }
}

let appliedBrowserFetch: typeof fetch | undefined
let currentEffectiveKind: 'node' | 'electron' | 'browser' = 'node'

export { shutdownBrowserTransport } from './browser-transport.ts'

/**
 * 传输层保活心跳（单例）。
 *
 * 起表时机：**第一次真正用过浏览器传输层之后**（那时会话一定已经存在）。
 * 绝不在 `applyTransportState` 里就起表 —— 那时浏览器还没拉起，探测必然读不到页面，
 * 会被判成"死了"从而把正在启动/即将启动的会话标记失效。
 */
let transportHeartbeat: TransportHeartbeat | undefined

export function transportHeartbeatSnapshot(): HeartbeatSnapshot | undefined {
  return transportHeartbeat?.snapshot()
}

/**
 * 空闲看门狗：**没人用就退场**。
 *
 * 背景（2026-10-15 用户实测）：探活（启动 20s 一次、之后每 30 分钟）每次都走传输层 ⇒
 * Edge 一旦拉起就永不退场 —— DSH 刚打开 20 秒就多出一个完整 Edge 实例，用户感知是
 * "打开 DSH 都变慢、一直有个大浏览器挂着"。
 * ⇒ **初始即挂起**：浏览器只在第一次真实使用后才拉起（探活跳过）；空闲满
 *   `idleShutdownMs`（transport.json 可配，默认 10 分钟；0 = 永不退场）自动关闭。
 */
const idleWatch: TransportIdleWatch = createTransportIdleWatch({
  idleMs: readTransportIdleShutdownMs() ?? 10 * 60_000,
  initiallySuspended: true,
  onIdle: () => {
    stopTransportHeartbeat()
    return shutdownBrowserTransport()
  },
  log: (message) => console.log(`[deepseek-web] ${message}`),
})

/** 探活据此跳过：浏览器没在跑时，探活只会把它重新拉起来（违背"没人用就退场"）。 */
export function transportSuspended(): boolean {
  return idleWatch.suspended()
}

/** 传输层被用过一次 ⇒ 起表（幂等）。 */
export function noteTransportUsed(): void {
  idleWatch.noteUse()
  if (!transportHeartbeat) {
    transportHeartbeat = createTransportHeartbeat({
      probe: readTransportPageState,
      // 未登录 ⇒ 作废签名，下一次请求按既有流程把登录态重装进页面（凭据来自那次请求）
      onLoggedOut: markTransportPageSessionStale,
      // 被导航走 ⇒ 带回站点 origin（本地动作）
      onOffOrigin: navigateTransportToSite,
      // 页面/浏览器不可用 ⇒ 收掉会话，下一次请求重新拉起
      onDead: invalidateTransportSession,
    })
  }
  transportHeartbeat.noteTransportUsed()
}

/** 传输层关停时一并停表（否则会对着一个不存在的会话空转）。 */
export function stopTransportHeartbeat(): void {
  transportHeartbeat?.stop()
}

/** 当前实际生效的 fetch 实现与它是哪一种 Chrome/Node 网络栈。 */
export function currentEffectiveFetch(): {
  fetch: typeof fetch
  kind: 'node' | 'electron' | 'browser'
} {
  if (currentEffectiveKind === 'browser' && appliedBrowserFetch) {
    return { fetch: appliedBrowserFetch, kind: 'browser' }
  }
  const electron = electronNetFetch()
  if (currentEffectiveKind === 'electron' && electron) {
    return { fetch: electron, kind: 'electron' }
  }
  return { fetch: globalThis.fetch, kind: 'node' }
}

/** 把状态落到 webapi 的注入层（`undefined` 即还原为 Node 全局 fetch）。 */
export function applyTransportState(state: TransportState): void {
  if (state.effective === 'chromium' && state.viaBrowserProxy) {
    const rawBrowserFetch = createBrowserFetch()
    /**
     * 包一层只为一件事：**用完一次之后开始保活**。
     * （不在建 fetch 时起表 —— 那时会话还不存在，探测必然读不到页面。）
     */
    appliedBrowserFetch = (async (...args: any[]) => {
      const response = await (rawBrowserFetch as any)(...args)
      noteTransportUsed()
      return response
    }) as typeof fetch
    // 进入浏览器代理：先挂起（浏览器还没起，探活只会把它拉起来），第一次真实使用后解除
    idleWatch.suspend()
    setFetchImpl(appliedBrowserFetch)
    currentEffectiveKind = 'browser'
    return
  }
  if (appliedBrowserFetch) {
    // 离开浏览器代理：保活/空闲看门狗都要停，否则会对着一个已经不存在的会话空转
    stopTransportHeartbeat()
    idleWatch.stop()
    void shutdownBrowserTransport()
    appliedBrowserFetch = undefined
  }
  // 非浏览器传输下探活走 electron/node fetch，不需要浏览器 ⇒ 解除挂起，让探活照常跑
  idleWatch.resume()
  if (state.effective === 'chromium' && electronNetFetch()) {
    setFetchImpl(electronNetFetch())
    currentEffectiveKind = 'electron'
    return
  }
  setFetchImpl(undefined)
  currentEffectiveKind = 'node'
}

/** 读设置 → 解析 → 应用，一步到位。 */
export function applyTransport(requested: TransportKind): TransportState {
  const state = resolveTransportState(requested)
  applyTransportState(state)
  return state
}
