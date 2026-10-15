/**
 * 传输层空闲看门狗 —— "没人用就退场"。
 *
 * ## 为什么需要（2026-10-15 用户实测）
 *
 * 传输层浏览器是常驻的，而**探活**（启动 20s 后一次、之后每 30 分钟一次）每次都走传输层
 * ⇒ Edge 一旦被拉起就**永远不会退场**：DSH 刚打开 20 秒就多出一个完整 Edge 实例（几百 MB），
 * 用户感知就是"打开 DSH 都变慢、一直有个大浏览器挂着"。
 *
 * ## 语义
 *
 *  - **初始即挂起**：浏览器只在第一次**真实使用**后才拉起 —— 探活在这种状态下跳过
 *    （跳过的代价：登录态失效要等下一次真实使用才发现，而探活本来就"只提示、不阻断"）；
 *  - 每次真实使用都会**重置**空闲计时；空闲满 `idleMs` ⇒ `onIdle()`（关浏览器）并进入挂起；
 *  - `stop()`（切换传输方式等场景）只停表、**不**进入挂起 —— 那时探活走的是 electron/node
 *    fetch，不需要浏览器，让它照常跑。
 *
 * 定时器全部可注入（用例不碰真定时器）。
 */

export interface IdleWatchOptions {
  /** 空闲多久后触发 `onIdle`（毫秒）；`<= 0` 表示永不触发。 */
  idleMs: number
  onIdle: () => void | Promise<void>
  /** 初始是否挂起（传输层的语义：初始挂起，第一次真实使用才解除）。 */
  initiallySuspended?: boolean
  log?: (message: string) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface TransportIdleWatch {
  /** 真实使用过一次 ⇒ 解除挂起 + 重置计时（幂等）。 */
  noteUse: () => void
  /** 停表但**不**进入挂起（切换传输方式用 —— 那时探活不需要浏览器）。 */
  stop: () => void
  /** 解除挂起并停表（非浏览器传输下探活照常跑，不需要浏览器）。 */
  resume: () => void
  /** 强制进入挂起（仅供用例与特殊路径）。 */
  suspend: () => void
  suspended: () => boolean
  running: () => boolean
}

const DEFAULT_SET_TIMER = (fn: () => void, ms: number): unknown => {
  const handle = setTimeout(fn, ms)
  // 后台表：不因为它把宿主进程留在事件循环里
  ;(handle as { unref?: () => void })?.unref?.()
  return handle
}

export function createTransportIdleWatch(options: IdleWatchOptions): TransportIdleWatch {
  const log = options.log ?? (() => {})
  const setTimer = options.setTimer ?? DEFAULT_SET_TIMER
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let suspended = options.initiallySuspended === true
  let timer: unknown

  function disarm(): void {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  function arm(): void {
    if (!(options.idleMs > 0)) return
    if (timer !== undefined) return
    timer = setTimer(() => {
      timer = undefined
      suspended = true
      log(`传输层空闲超过 ${Math.round(options.idleMs / 60_000)} 分钟 ⇒ 关闭浏览器（下次使用自动重开）`)
      // ⚠️ 用 async 包装而不是 Promise.resolve(onIdle())：后者挡不住**同步抛错**
      //    （函数在 resolve 之前就 throw 了，异常直接冒出定时器回调）
      void (async () => options.onIdle())().catch((error) => {
        log(`传输层空闲关闭失败：${(error as Error)?.message ?? error}`)
      })
    }, options.idleMs)
  }

  return {
    noteUse() {
      suspended = false
      disarm()
      arm()
    },
    stop() {
      disarm()
    },
    resume() {
      disarm()
      suspended = false
    },
    suspend() {
      disarm()
      suspended = true
    },
    suspended: () => suspended,
    running: () => timer !== undefined,
  }
}
