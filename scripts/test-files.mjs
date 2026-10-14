/**
 * 全量离线用例清单（审计 F20）。
 *
 * 单独放一个模块是为了**能被测试**：`probe-*.mjs` 会打真实接口、需要有效账号，
 * 一旦被误纳入自动化，就要拿真账号去跑 —— 这条边界值得有一条断言守着。
 * `scripts/test-offline.mjs` 与 tests/check-round2.mjs 共用这里的实现。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 返回该目录下应当由自动化执行的用例文件名（已排序）。
 * 只认 `check-*.mjs` 与 `logic-test.mjs`。
 */
export function pickOfflineTests(testsDir) {
  const names = readdirSync(testsDir)
  const files = names.filter((name) => /^check-.*\.mjs$/.test(name)).sort()
  if (names.includes('logic-test.mjs')) files.push('logic-test.mjs')
  return files
}

/** 是否为"需要真实网络/账号"的人工诊断脚本（自动化必须排除）。 */
export function isManualProbe(name) {
  return /^probe-.*\.mjs$/.test(name) || /probe/i.test(name)
}

export function resolveTestPaths(root, files) {
  return files.map((name) => join(root, 'tests', name))
}

/**
 * 从某个用例的输出里挑出"病因"几行，供跑批把失败原因一起报出去。
 *
 * 🔴 为什么要挑：CI 上日志下载要么需要 token（无 token 时是 403）、要么得点进界面翻，
 * 而 GitHub 会把 `::error::` 记成 annotation，**不用下载日志就能看到**。
 * annotation 有长度限制 ⇒ 只能挑关键的几行：优先"失败行"（本仓库约定以 `x ` 或 `✗` 开头），
 * 一行都没有时退回输出的尾部（有些用例是异常直接抛出、没走失败行约定）。
 */
export function pickDiagnosis(text) {
  const lines = String(text ?? '').split('\n')
  const bad = lines.filter((line) => /^\s*(x\s|✗)/.test(line))
  const picked = bad.length ? bad.slice(-8) : lines.slice(-6)
  return picked.join('\n').trim()
}
