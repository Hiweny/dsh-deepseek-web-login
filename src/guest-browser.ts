/**
 * 内置浏览器（DSH 自带的 Chromium guest）—— **共享契约 + 纯逻辑**。
 *
 * ## 它是什么，不是什么
 *
 * 它是 DSH 窗口里一个**真浏览器页面**，停在网页端站点上，长期活着：
 * 页面里站点自己的 JS 会跑、会维持它自己的会话与心跳。**我们不把网页端的回答回显进来**
 * —— 发请求仍然走原有的 API 通路，这个浏览器只负责"有一个真人那样活着的页面"。
 *
 * ## guest 的三条硬约束（来自 DSH 主进程 `will-attach-webview` 门禁，别猜）
 *
 * 1. `src` 必须**精确**等于 `about:blank#<lease>`（lease 来自 `acquire()`）；
 * 2. `partition` 必须等于 `acquire()` 返回的那个；
 * 3. bridge 只在**主窗口主 frame** 上（`globalThis.dshDesktop.browser`，protocolVersion === 1）。
 *
 * ⚠️ guest 是 Electron 的 webview ⇒ 它的默认 UA 带 Electron 痕迹，**不如系统 Edge 真**。
 * 所以启动时必须把 webview 的 `useragent` 设成**账号捕获时那份真实 UA**
 * （`userAgent` 字段，登录窗口抓的），这就是"UA 洗白"那一步 —— 没有它，
 * 这个页面的指纹反而比我们原来的传输层更假。
 */

/** guest 打开的地址（与传输层同一个站点）。 */
export const GUEST_BROWSER_URL = 'https://chat.deepseek.com/'

/** 心跳状态取值（host 侧校验用；与 `transport-heartbeat.ts` 的语义一致）。 */
export const GUEST_BEAT_STATES = ['idle', 'alive', 'logged-out', 'off-origin', 'dead'] as const
export type GuestBeatState = (typeof GUEST_BEAT_STATES)[number]

export interface GuestFingerprint {
  /** 页面自己的 `navigator.userAgent`（判定 Electron/Headless 痕迹用） */
  ua: string
  webdriver: boolean
  brands: string
  webgl: string
  /** 页面视口尺寸（排查"大小不对"用：与宿主盒子的矩形比一比就知道有没有缩放） */
  vw?: number
  vh?: number
  dpr?: string
  /** 宿主盒子（面板侧量出来的矩形）—— 与 `vw/vh` 比：相等就是 1:1，不等就有缩放 */
  box?: { w: number; h: number }
  /** 正文长度 / 图片加载数（区分"没加载完"与"尺寸不对"） */
  textLen?: number
  imgs?: string
}

export interface GuestBeat {
  state: GuestBeatState
  /** 面板侧探测时刻（ms） */
  at: number
  /** 探测到的页面地址（截断，够排查就行） */
  url: string
  /** 面板侧累计探测次数 */
  beats: number
  /** 面板侧累计恢复次数 */
  recoveries: number
  /** 说明（异常时给排查用） */
  note?: string
  /**
   * 页面眼里的环境（探针顺带带回）。🔴 落盘到 `diagnostics/guest-fingerprint.jsonl`
   * —— 网页端弹不弹「使用环境异常」只有页面自己知道，**凭这个对账，不猜**。
   */
  fingerprint?: GuestFingerprint
}

const MAX_NOTE = 300
const MAX_URL = 300

/**
 * 校验并收窄面板报上来的心跳。
 *
 * 面板是**不可信输入**（它跑在被注入的页面环境里，字段可能被塞垃圾）：
 * 未知 state 一律丢弃（不要"猜一个"），字符串截断，数字必须是有限数。
 * 返回 `null` 表示这条不合法 —— host 不该把它记进状态。
 */
export function normalizeGuestBeat(raw: unknown): GuestBeat | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const state = typeof input.state === 'string' ? input.state.trim() : ''
  if (!(GUEST_BEAT_STATES as readonly string[]).includes(state)) return null
  const at = Number(input.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const beats = Number(input.beats)
  const recoveries = Number(input.recoveries)
  const url = typeof input.url === 'string' ? input.url.slice(0, MAX_URL) : ''
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.slice(0, MAX_NOTE) : undefined
  let fingerprint: GuestFingerprint | undefined
  const fp = input.fingerprint
  if (fp && typeof fp === 'object') {
    const raw = fp as Record<string, unknown>
    const ua = typeof raw.ua === 'string' ? raw.ua.slice(0, 400) : ''
    const brands = typeof raw.brands === 'string' ? raw.brands.slice(0, 200) : ''
    const webgl = typeof raw.webgl === 'string' ? raw.webgl.slice(0, 200) : ''
    const webdriver = raw.webdriver === true
    if (ua || brands || webgl || webdriver) {
      const vw = Number(raw.vw)
      const vh = Number(raw.vh)
      const dpr = typeof raw.dpr === 'string' ? raw.dpr.slice(0, 12) : undefined
      let box: { w: number; h: number } | undefined
      const textLen = Number(raw.textLen)
      const imgs = typeof raw.imgs === 'string' ? raw.imgs.slice(0, 32) : undefined
      const rawBox = raw.box
      if (rawBox && typeof rawBox === 'object') {
        const w = Number((rawBox as Record<string, unknown>).w)
        const h = Number((rawBox as Record<string, unknown>).h)
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          box = { w: Math.floor(w), h: Math.floor(h) }
        }
      }
      fingerprint = {
        ua,
        webdriver,
        brands,
        webgl,
        ...(Number.isFinite(vw) && vw > 0 ? { vw: Math.floor(vw) } : {}),
        ...(Number.isFinite(vh) && vh > 0 ? { vh: Math.floor(vh) } : {}),
        ...(dpr ? { dpr } : {}),
        ...(Number.isFinite(textLen) && textLen > 0 ? { textLen: Math.floor(textLen) } : {}),
        ...(imgs ? { imgs } : {}),
        ...(box ? { box } : {}),
      }
    }
  }
  return {
    state: state as GuestBeatState,
    at,
    url,
    beats: Number.isFinite(beats) && beats >= 0 ? Math.floor(beats) : 0,
    recoveries: Number.isFinite(recoveries) && recoveries >= 0 ? Math.floor(recoveries) : 0,
    ...(note ? { note } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  }
}

/**
 * 页面内探针（纯函数产物）：读 `location` / `readyState` / `localStorage.userToken`。
 *
 * 与传输层的 `readTransportPageState()` **语义必须一致**（同样把 `{"value":…,"__version":"0"}`
 * 解包成裸 token），这样两边共用同一个 `judgeObservation()` 判定。
 * 返回 JSON 字符串 —— `webview.executeJavaScript` 拿回来的就是它。
 * ⚠️ 不含反引号（同样要嵌进模板字符串）。
 */
export function guestProbeExpression(): string {
  return (
    '(function(){try{' +
    "var raw=localStorage.getItem('userToken');" +
    'var t=raw;' +
    "try{var p=JSON.parse(raw);if(p&&typeof p==='object')t=p.value;}catch(e){}" +
    'var brands=(navigator.userAgentData&&navigator.userAgentData.brands||[])' +
    '.map(function(b){return b.brand;}).join(",");' +
    'var webgl="";' +
    'try{var c=document.createElement("canvas");var g=c.getContext("webgl");' +
    'var d=g.getExtension("WEBGL_debug_renderer_info");' +
    'webgl=String(g.getParameter(d.UNMASKED_RENDERER_WEBGL));}catch(e){}' +
    'return JSON.stringify({url:location.href,readyState:document.readyState,' +
    "userToken:(t===null||t===undefined)?'':String(t)," +
    'webdriver:navigator.webdriver===true,uaDataBrands:brands,webgl:webgl,' +
    'ua:String(navigator.userAgent),vw:window.innerWidth,vh:window.innerHeight,' +
    'dpr:String(window.devicePixelRatio),sw:String(screen.width),sh:String(screen.height),' +
    // 渲染完成度：用户截图里我这边"下半部分是白的"——必须能区分"还没加载完"与"尺寸不对"
    'textLen:(document.body&&document.body.innerText?document.body.innerText.length:0),' +
    'imgs:(function(){var n=0,done=0,list=document.images||[];' +
    'for(var i=0;i<list.length;i++){n++;if(list[i].complete&&list[i].naturalWidth>0)done++;}' +
    'return n+"/"+done;})()});' +
    "}catch(e){return JSON.stringify({url:location.href,readyState:'',userToken:'',webdriver:false,uaDataBrands:'',webgl:'',ua:'',vw:0,vh:0,dpr:'',sw:'',sh:'',textLen:0,imgs:''});}})()"
  )
}

/**
 * 内置浏览器的持久设置（`~/.dsh/web-login/guest-settings.json`）。
 *
 * 放在磁盘而不是 localStorage：DSH 的 UI 起源可能随端口变（localStorage 未必留得住），
 * 而"重启后要不要自动挂"必须留得住。
 */
export interface GuestSettings {
  /** 随 DSH 启动自动挂上（默认 true：用户既然装了它，就是要它一直在） */
  autoStart: boolean
}

export const DEFAULT_GUEST_SETTINGS: GuestSettings = { autoStart: true }

/** 收窄磁盘上的值（缺字段/坏值一律回默认，不猜）。 */
export function normalizeGuestSettings(raw: unknown): GuestSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GUEST_SETTINGS }
  const input = raw as Record<string, unknown>
  return { autoStart: input.autoStart === false ? false : true }
}

/**
 * 视口与盒子是否**不一致**（2026-10-15 实测：guest 的视口尺寸是挂载那一刻定下来、
 * 之后容器变大不跟上 —— 落盘证据 `vw=996/box.w=995` 但 `vh=150/box.h=578`，
 * 表现是页面只渲染顶上一条、下面全白、内容被裁）。
 *
 * 判定留在这里（纯函数）而不是埋在组件里，是为了能被用例真求值守住。
 */
export function needsViewportFix(
  observed: { vw?: unknown; vh?: unknown } | null | undefined,
  box: { w: number; h: number } | null | undefined,
  tolerance = 8,
): boolean {
  if (!observed || !box) return false
  const vw = Number(observed.vw)
  const vh = Number(observed.vh)
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return false
  if (!(box.w > 0) || !(box.h > 0)) return false
  return Math.abs(vw - box.w) > tolerance || Math.abs(vh - box.h) > tolerance
}

/** 组装要写进 guest 页面的登录态（与传输层同一条路径：headers → writes）。 */
export function guestSessionHeaders(account: { token?: string; hifLeim?: string }): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = String(account?.token ?? '').trim()
  if (token) headers.authorization = `Bearer ${token}`
  const hifLeim = String(account?.hifLeim ?? '').trim()
  if (hifLeim) headers['x-hif-leim'] = hifLeim
  return headers
}

/**
 * guest 页面的 UA：**剔除 `Electron/` 与应用名**（dsh-webin 实测：网页端看到 `Electron/`
 * 直接回「使用环境异常」）。Chromium 大版本取**当前内核真实版本** —— 写死旧版本
 * 反而制造「UA 版本与能力不符」这个更明显的矛盾。
 *
 * 优先级（调用方决定）：**账号捕获的那份真实 UA** > 本函数的兜底。
 * 输入已是干净 UA（不含 Electron）时原样返回 —— 别把用户的真实 Edge UA 改坏。
 */
export function buildGuestUserAgent(ua: string): string {
  const raw = String(ua ?? '')
  if (!raw) return raw
  if (!/Electron\//.test(raw)) return raw
  const major = /Chrome\/(\d+)/.exec(raw)?.[1] ?? '0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/**
 * 主世界指纹修正（页面内执行一次）：
 *  - `navigator.webdriver` 钉死 false（Electron 里默认就是 false，显式钉是双保险）；
 *  - `userAgentData` 补品牌列表 —— Electron 默认缺 `"Google Chrome"` 品牌，
 *    而品牌列表是页面判断"这是不是正常浏览器"的另一个入口。
 *
 * ⚠️ 返回的字符串**不含反引号**（要嵌进模板字符串执行）。
 */
export function guestFingerprintFix(userAgent: string): string {
  const major = /Chrome\/(\d+)/.exec(String(userAgent ?? ''))?.[1] ?? '0'
  const m = JSON.stringify(major)
  /**
   * ⚠️ 完整版本号要**整个**当字符串字面量拼进去。
   * 0.9.x 的第一版写成 `'uaFullVersion:' + m + '.0.0.0,'` —— 于是生成的是
   * `uaFullVersion:"152".0.0.0` ⇒ **语法错误**，而调用点 `.catch(()=>{})` 把它吞了，
   * 表现是 brands 一直是 Electron 默认值（真求值才抓到；见 check-guest-browser 用例）。
   */
  const full = JSON.stringify(`${major}.0.0.0`)
  return (
    '(function(){try{' +
    'var brands=[{brand:"Google Chrome",version:' + m + '},{brand:"Chromium",version:' + m + '},{brand:"Not_A Brand",version:"24"}];' +
    'var uad={brands:brands,mobile:false,platform:"Windows",' +
    'getHighEntropyValues:function(){return Promise.resolve({architecture:"x86",bitness:"64",brands:brands,mobile:false,platform:"Windows",platformVersion:"10.0.0",uaFullVersion:' + full + ',fullVersionList:brands});},' +
    'toJSON:function(){return{brands:brands,mobile:false,platform:"Windows"}}};' +
    'try{Object.defineProperty(navigator,"userAgentData",{get:function(){return uad;},configurable:true});}catch(e){}' +
    'try{Object.defineProperty(navigator,"webdriver",{get:function(){return false;},configurable:true});}catch(e){}' +
    '}catch(e){}})()'
  )
}
