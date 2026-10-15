#!/usr/bin/env node
/**
 * npm 发布决策 + 事后核验（`release.yml` 的入口在这里，判据也在这里 —— 为了能用例守）。
 *
 * 🔴 为什么不能只看退出码（0.9.2 真实事故）：
 *   `npm view <pkg>@<不存在的版本> version` 的退出码**不保证非零**：
 *   本机实测 npm 10 冷缓存给 1、热缓存给 0；npm 11 给 1。
 *   旧写法 `if npm view … >/dev/null 2>&1; then 跳过发布` 于是在 CI 上把"版本不存在"
 *   读成"已发布" ⇒ 静默跳过 `npm publish`，而 GitHub Release 照建：
 *   0.9.2 就只留下 tag + Release，npm 上没有这一版 —— 而那个步骤报的是 **success**。
 *   ⇒ 判"在不在"只能看**输出里有没有版本号**，并且发完必须**再核一次**。
 *
 * 用法：
 *   node scripts/npm-release.mjs should-publish <version>   # 打印 PUBLISH | SKIP
 *   node scripts/npm-release.mjs verify <version>           # 没上 registry 就退出 1
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PKG = 'dsh-deepseek-web-login'

/** 版本号要进 shell 与命令行 ⇒ 只接受规范形态，不受控的 tag 不许直接拼进去。 */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** `npm view` 的输出里有东西 ⇒ 这一版已在 registry 上。空串/纯空白一律算"没有"。 */
export function isPublished(viewOutput) {
  return String(viewOutput ?? '').trim().length > 0
}

/**
 * 决策：`'PUBLISH'` | `'SKIP'`。
 * `view` 是注入点 —— 用例用假输出喂它（离线、不用网、也不受本机 npm 版本影响）。
 */
export function decidePublish({ version, view }) {
  if (!VERSION_RE.test(String(version ?? ''))) {
    throw new Error(`版本号不合法，拒绝发布：${JSON.stringify(version)}`)
  }
  return isPublished(view(version)) ? 'SKIP' : 'PUBLISH'
}

/**
 * 核验：registry 传播要几秒，重试若干次。
 * `sleep` 也是注入点 —— 用例里换成空实现，否则这条用例要真等 60s。
 * @returns {Promise<string|null>} 看到的版本号；始终没看到返回 null
 */
export async function verifyPublished({
  version,
  view,
  /**
   * ⚠️ 1.0.0 与 1.0.1 两次真实故障：npm publish 返回成功、registry 也很快有了这一版，
   * 但 CI 里 60 秒（6×10s）没等到 ⇒ 第 10 步判失败 ⇒ **Release 被整个跳过**
   * （于是"npm 有、GitHub 没有"）。放宽到 3 分钟（12×15s），把这种传播抖动吃掉。
   */
  attempts = 12,
  intervalMs = 15_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (msg) => console.log(msg),
}) {
  for (let i = 1; i <= attempts; i++) {
    const got = String(view(version) ?? '').trim()
    if (got) return got
    log(`第 ${i}/${attempts} 次核验还没看到 ${version}（registry 传播中？）`)
    if (i < attempts) await sleep(intervalMs)
  }
  return null
}

/**
 * 真实的 `npm view`。
 * 任何失败（没网 / npm 不在 / 权限）都当"没看到" —— 于是决策会倾向 PUBLISH，
 * 真发不出去时由后面的核验步骤以**非零退出**兜住，而不是在这里静默跳过。
 */
export function npmView(version) {
  try {
    return execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'view',
        `${PKG}@${version}`,
        'version',
        /**
         * 🔴 `--prefer-online` 必须有。
         *
         * 1.0.0 的真实故障：发布**之前**先跑了一次 `should-publish`（那时问的是"有没有 1.0.0"
         * ⇒ 答案是"没有"，这个 packument 进了 npm 本地缓存）⇒ 紧接着发布之后核验，
         * 6 次重试（60 秒）全在读那个**旧缓存** ⇒ 核验判失败 ⇒ 整条 Release 流程中断
         * （npm 上其实已经发成功了）。`--prefer-online` 强制对 registry 重新校验，
         * 从根上避开这种"自己把自己缓存坑了"的竞态。
         */
        '--prefer-online',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return ''
  }
}

async function main(argv) {
  const [mode, version] = argv
  if (mode === 'should-publish') {
    console.log(decidePublish({ version, view: npmView }))
    return 0
  }
  if (mode === 'verify') {
    const got = await verifyPublished({ version, view: npmView })
    if (!got) {
      console.error(`::error::npm 上找不到 ${PKG}@${version} —— 发布没有真的发生`)
      return 1
    }
    console.log(`npm 上已确认 ${PKG}@${got}`)
    return 0
  }
  console.error('用法：npm-release.mjs should-publish|verify <version>')
  return 2
}

// 只有被当脚本直接运行时才走 CLI（被 import 时 argv[1] 不是本文件）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`::error::${error?.message ?? error}`)
      process.exitCode = 1
    })
}
