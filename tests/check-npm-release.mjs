/**
 * 回归：npm 发布决策与核验（`scripts/npm-release.mjs`）。
 *
 * 背景（2026-10-14 真实事故）：v0.9.2 推了 tag，Release 也建了（带 tgz），
 * **但 npm 上没有 0.9.2**，而"发布到 npm"那一步报的是 success。
 * 根因是旧判据 `if npm view <pkg>@<version> version >/dev/null 2>&1` 拿**退出码**当
 * "已发布"：同一个不存在的版本，本机 npm 10 冷缓存给 1、热缓存给 0，npm 11 给 1
 * ⇒ CI 上读成"已有，跳过发布"，于是静默漏发。
 *
 * 用法: node tests/check-npm-release.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { decidePublish, verifyPublished, VERSION_RE } from '../scripts/npm-release.mjs'

const failures = []

async function test(name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const RELEASE_YML = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))

async function main() {
  // ① 事故本体：空输出（npm 10 热缓存下的形态）必须判成"还没发布"
  await test('🔴 npm view 输出为空（旧判据在此静默跳过发布）⇒ 必须 PUBLISH', () => {
    assert.equal(decidePublish({ version: '0.9.2', view: () => '' }), 'PUBLISH')
  })

  // ② 纯空白也算空 —— `trim()` 不到位就会把它当成"已有版本号"
  await test('输出只有空白/换行 ⇒ PUBLISH（别把换行当版本号）', () => {
    assert.equal(decidePublish({ version: '0.9.2', view: () => '   \n\t' }), 'PUBLISH')
    assert.equal(decidePublish({ version: '0.9.2', view: () => '\n' }), 'PUBLISH')
  })

  // ③ 正向对照：真发出去了才允许跳过（否则重跑会撞 E403）
  await test('输出里有版本号 ⇒ SKIP（重跑安全）', () => {
    assert.equal(decidePublish({ version: '0.9.2', view: () => '0.9.2\n' }), 'SKIP')
  })

  // ④ 判据看"非空"而不是"等于目标版本"：registry 上出现了别的版本号也说明查到了东西，
  //    此时宁可跳过、让人工看一眼，也不要在不确定的状态下重复发。
  await test('输出了别的版本号 ⇒ SKIP（非空即视为查到了）', () => {
    assert.equal(decidePublish({ version: '0.9.2', view: () => '0.8.0\n' }), 'SKIP')
  })

  // ⑤ 版本号来自 tag，会进 shell 与命令行 ⇒ 非法形态必须抛错，不能拼出去
  await test('🔴 非法版本号（含注入形态）必须抛错', () => {
    for (const bad of ['0.9.2; rm -rf /', 'v0.9.2', '$(id)', '0.9', '', null, undefined, '0.9.2\n0.8.0']) {
      assert.throws(() => decidePublish({ version: bad, view: () => '' }), /版本号不合法/, `应拒绝：${JSON.stringify(bad)}`)
    }
    assert.equal(VERSION_RE.test('0.9.2'), true)
    assert.equal(VERSION_RE.test('1.0.0-rc.1'), true, '预发布形态要放过')
  })

  // ⑥ 核验：传播中要重试，看到就立刻返回；sleep 是注入点（用例不许真等 60s）
  await test('核验：先空后有 ⇒ 返回版本号，且只 sleep 一次', async () => {
    let calls = 0
    const sleeps = []
    const got = await verifyPublished({
      version: '0.9.2',
      view: () => (++calls >= 2 ? '0.9.2' : ''),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      log: () => {},
    })
    assert.equal(got, '0.9.2')
    assert.equal(sleeps.length, 1, `应只等一轮，实际等了 ${sleeps.length} 轮`)
  })

  await test('🔴 核验：始终没有 ⇒ 返回 null（调用方据此退出 1），且不超次数', async () => {
    const sleeps = []
    const got = await verifyPublished({
      version: '0.9.2',
      view: () => '',
      attempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      log: () => {},
    })
    assert.equal(got, null)
    assert.equal(sleeps.length, 2, 'attempts=3 时最多等 2 次（最后一次不该白等）')
  })

  // ⑦ 真实入口：release.yml 必须走这两个入口，且顺序固定（先 npm 后 Release）
  await test('release.yml 调用了 should-publish 与 verify，且顺序是 publish → verify → 建 Release', () => {
    const wf = readFileSync(RELEASE_YML, 'utf8')
    assert.ok(wf.includes('npm-release.mjs should-publish'), 'release.yml 应走 npm-release.mjs should-publish')
    assert.ok(wf.includes('npm-release.mjs verify'), 'release.yml 应走 npm-release.mjs verify')
    const iPub = wf.indexOf('npm publish')
    const iVerify = wf.indexOf('npm-release.mjs verify')
    const iRelease = wf.indexOf('gh release create')
    assert.ok(iPub >= 0 && iVerify >= 0 && iRelease >= 0, '三个锚点都要在')
    assert.ok(iPub < iVerify, '必须先发布再核验')
    assert.ok(iVerify < iRelease, '🔴 核验必须在建 Release 之前 —— 否则又会出现「Release 有、npm 没有」的错位')
  })

  console.log(`\n${failures.length ? '' : '通过 '}${failures.length ? failures.length + ' 项失败' : '所有用例通过'}`)
  if (failures.length) {
    for (const f of failures) console.error(f)
    process.exitCode = 1
  }
}

main()
