#!/usr/bin/env node
/**
 * 全量离线用例（审计 F20）。
 *
 * 只跑**不需要网络与账号**的用例（清单见 scripts/test-files.mjs）。
 * 明确排除 `probe-*.mjs` —— 那几个会打真实接口、需要有效账号，属于人工诊断工具。
 *
 * 为什么要有这个入口：CI 之前只写了 7 个测试文件名，手工维护容易漏；
 * 而"漏跑"的代价在这一轮审计里已经出现过多次（改了源码但没跑全量，回归晚几天才发现）。
 * 这里按文件名扫全量，新增用例自动纳入。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickOfflineTests, pickDiagnosis } from './test-files.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const testsDir = join(ROOT, 'tests')
const files = pickOfflineTests(testsDir)

/**
 * 🔴 每个用例都在**临时** DSH_HOME 下跑。
 *
 * 用例会真实调用 `webLoginDir()` 那一族路径（投喂留痕、账号库、journal…），
 * 不隔离就直接写进用户真实的 `~/.dsh/web-login/`。2026-10-02 实测：一次全量跑批往
 * 用户的 `feed-decisions.jsonl` 灌了 695 条测试噪声（`sess-1..7` + 同一毫秒），
 * 诊断真实问题前得先手工把噪声滤掉 —— 诊断数据被污染比没有数据更糟。
 *
 * 用例自己仍可覆盖（既有用例就是 `process.env.DSH_HOME = mkdtempSync(...)`），
 * 这里是**兜底**：新写的用例忘了隔离也污染不到真实目录。
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-web-login-tests-'))

/**
 * 需要更长上限的用例 —— **按文件名给**，不要全局放宽。
 *
 * `check-browser-transport` 会**真启一个浏览器**来验"浏览器代理能否发 POST / 上传 FormData"，
 * 而且每个用例各起一次。实测本机 **4 分 29 秒**（还只是"用户同时开着 DSH + Edge"的普通状态），
 * 远超 180s 的通用上限 ⇒ 跑批每轮都把它报成 FAIL，而它其实**是通过的**。
 *
 * ⚠️ 这类"红"比没有用例更糟：它会训练人忽略 FAIL。所以宁可给这一个文件放宽，也不改通用上限
 * （通用上限的语义是"超过就说明有东西挂住了"，放宽就失去意义）。
 * ⚠️ 真正的修法是让它**复用同一个浏览器会话**（5 个用例只起一次），那才是把它压回几十秒；
 * 在那之前先让跑批说实话。
 */
const SLOW_FILES = { 'check-browser-transport.mjs': 600_000 }

/**
 * 每个用例的输出落到**文件**里，而不是 pipe，也不是直接 inherit。
 *
 * - 不用 pipe：子进程里可能留下浏览器/守护进程握着管道，`spawnSync` 会一直等它。
 * - 不用 inherit：那样输出只进 job 日志 —— 而 job 日志在无 token 时下载是 403
 *   （2026-10-14 实测：win 上 `check-browser-transport` 报红，除了"退出码 1"什么也拿不到）。
 *   存文件后可以把**失败原因**一并做成 annotation，界面与 API 都能看到。
 */
const LOG_DIR = mkdtempSync(join(tmpdir(), 'dsh-offline-logs-'))

const failed = []
for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const logPath = join(LOG_DIR, `${file}.log`)
  const fd = openSync(logPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [join(testsDir, file)], {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, DSH_HOME: SANDBOX_HOME },
      // 单个文件的上限：超过说明有东西挂住了（而不是"慢"）。慢的用例见 SLOW_FILES。
      timeout: SLOW_FILES[file] ?? 180_000,
    })
  } finally {
    closeSync(fd)
  }
  let output = ''
  try {
    output = readFileSync(logPath, 'utf8')
  } catch {
    /* 读不到就当空（下面的判定用的是退出状态，不依赖它） */
  }

  if (result.error || result.status !== 0) {
    failed.push(file)
    // 失败时回放全文：有 token 的人看 job 日志时上下文是全的
    console.log(output.trimEnd())
    const why = result.error ? result.error.message : `退出码 ${result.status}`
    console.error(`FAIL ${file}：${why}`)
    /**
     * 🔴 让"CI 红"自带病因。GitHub 把 `::error::` 记成 annotation，
     * 于是**不用下载日志**（无 token 时那是 403）也能从界面/API 看到是哪个文件、哪一条红的。
     * 2026-10-14 实测：win 上 `check-browser-transport` 报红、ubuntu/mac 绿，
     * 而日志拿不到 ⇒ 只能把文件名与失败行推出来。
     */
    console.error(`::error::离线用例失败：${file}（${why}）\n${pickDiagnosis(output).slice(0, 1200)}`)
  } else {
    // 成功也留一行：把每个用例自报的"通过 N 项"带出来，日志才有进度可看
    const summary = output.trimEnd().split('\n').filter(Boolean).pop() ?? '(无输出)'
    console.log(`  ${summary}`)
  }
}

try {
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
  rmSync(LOG_DIR, { recursive: true, force: true })
} catch {
  /* 清理失败无所谓，临时目录 */
}

console.log(`\n[test] ${files.length - failed.length}/${files.length} 个用例文件通过`)
if (failed.length) {
  for (const file of failed) console.log(`  FAIL ${file}`)
  process.exitCode = 1
}
