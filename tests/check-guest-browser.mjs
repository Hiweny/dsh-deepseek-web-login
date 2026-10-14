/**
 * 回归：内置浏览器（DSH 的 Chromium guest）。
 *
 * 分三块守：
 *  1. `normalizeGuestBeat` —— 面板是不可信输入，形状不对就整条丢掉；
 *  2. `guestProbeExpression` —— **真求值**（塞假 localStorage/location 进去跑），
 *     判据是"解包后的 token"，不是"字符串里有 userToken 这个词"；
 *  3. 契约（源码文本，正向断言）：guest 的门禁三条件、UA 必须在首次导航之前设好、
 *     装完必须 reload、guest 与传输层**共用同一条登录态转换链**。
 *
 * 用法: node tests/check-guest-browser.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 🔴 自己钉住 DSH_HOME：这个文件会 import 到走 `webLoginDir()` 那一族的模块，
//    直接单跑时跑批给的兜底不生效（会写进用户真实的 ~/.dsh）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-guest-browser-'))

import {
  GUEST_BEAT_STATES,
  GUEST_BROWSER_URL,
  guestProbeExpression,
  guestSessionHeaders,
  normalizeGuestBeat,
} from '../src/guest-browser.ts'
import { pageSessionFromHeaders } from '../src/page-session.ts'
import { TRANSPORT_SITE_ORIGIN } from '../src/browser-transport.ts'

const failures = []

async function test(name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const GOOD = { state: 'alive', at: 1_700_000_000_000, url: 'https://chat.deepseek.com/', beats: 3, recoveries: 1 }

/** 在假页面环境里跑探针脚本（真求值，不是文本匹配）。 */
function runProbe(env) {
  const expr = guestProbeExpression()
  const fn = new Function(
    'location',
    'document',
    'localStorage',
    `return ${expr}`,
  )
  return JSON.parse(fn(env.location, env.document, env.localStorage))
}

async function main() {
  await test('guest 打开的地址就在传输层那个站点 origin 下', () => {
    assert.ok(GUEST_BROWSER_URL.startsWith(TRANSPORT_SITE_ORIGIN), `${GUEST_BROWSER_URL} 不在 ${TRANSPORT_SITE_ORIGIN}`)
  })

  await test('心跳形状：合法入参被收窄；未知 state / 缺 at / 非对象一律丢弃', () => {
    const beat = normalizeGuestBeat(GOOD)
    assert.ok(beat, '合法心跳不该被丢')
    assert.equal(beat.state, 'alive')
    assert.equal(beat.at, GOOD.at)
    assert.equal(beat.beats, 3)

    assert.equal(normalizeGuestBeat({ ...GOOD, state: 'whatever' }), null, '未知 state 必须丢弃（别猜）')
    assert.equal(normalizeGuestBeat({ ...GOOD, at: undefined }), null, '缺 at 必须丢弃')
    assert.equal(normalizeGuestBeat({ ...GOOD, at: -1 }), null, 'at 非正数必须丢弃')
    assert.equal(normalizeGuestBeat({ ...GOOD, at: 'x' }), null, 'at 非数字必须丢弃')
    assert.equal(normalizeGuestBeat(null), null)
    assert.equal(normalizeGuestBeat('alive'), null)
    for (const state of GUEST_BEAT_STATES) {
      assert.ok(normalizeGuestBeat({ ...GOOD, state }), `${state} 应被接受`)
    }
  })

  await test('心跳形状：字符串截断、计数取整、note 空串不进结果', () => {
    const beat = normalizeGuestBeat({
      ...GOOD,
      url: 'u'.repeat(1000),
      note: 'n'.repeat(1000),
      beats: 2.7,
      recoveries: -5,
    })
    assert.ok(beat)
    assert.equal(beat.url.length, 300)
    assert.equal(beat.note.length, 300)
    assert.equal(beat.beats, 2, '小数取整')
    assert.equal(beat.recoveries, 0, '负数归零')
    const noNote = normalizeGuestBeat({ ...GOOD, note: '   ' })
    assert.ok(noNote)
    assert.ok(!('note' in noNote), '空白 note 不该进结果')
  })

  await test('🔴 探针真求值：把 {"value":…,"__version":"0"} 解包成裸 token', () => {
    const seen = runProbe({
      location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
      document: { readyState: 'complete' },
      localStorage: { getItem: () => JSON.stringify({ value: 'TOKEN-1', __version: '0' }) },
    })
    assert.equal(seen.userToken, 'TOKEN-1', `解包失败：${JSON.stringify(seen)}`)
    assert.equal(seen.readyState, 'complete')
    assert.ok(seen.url.includes('/a/chat/s/abc'))
  })

  await test('探针真求值：裸串原样、没有值给空串、localStorage 抛错也不崩', () => {
    const bare = runProbe({
      location: { href: 'https://chat.deepseek.com/' },
      document: { readyState: 'interactive' },
      localStorage: { getItem: () => 'RAW-TOKEN' },
    })
    assert.equal(bare.userToken, 'RAW-TOKEN')

    const none = runProbe({
      location: { href: 'https://chat.deepseek.com/' },
      document: { readyState: 'complete' },
      localStorage: { getItem: () => null },
    })
    assert.equal(none.userToken, '')

    const broken = runProbe({
      location: { href: 'https://chat.deepseek.com/' },
      document: { readyState: 'complete' },
      localStorage: {
        getItem: () => {
          throw new Error('storage 被禁用')
        },
      },
    })
    assert.equal(broken.userToken, '')
    assert.ok(broken.url.includes('deepseek.com'), '出错了也要把 url 带回来（排查要用）')
  })

  await test('🔴 guest 与传输层共用同一条登录态链（形状不许分叉）', () => {
    const writes = pageSessionFromHeaders(guestSessionHeaders({ token: 'T-1', hifLeim: 'L-1' }))
    const byKey = Object.fromEntries(writes.map((w) => [w.key, w.value]))
    assert.deepEqual(Object.keys(byKey).sort(), ['hif_leim_cached', 'userToken'])
    assert.deepEqual(JSON.parse(byKey.userToken), { value: 'T-1', __version: '0' })
    assert.equal(JSON.parse(byKey.hif_leim_cached), 'L-1', 'hif_leim_cached 存的是 JSON 串')

    // 没有 token 的账号 ⇒ 一条都不写（宁可什么都不装，也别写半个登录态）
    assert.deepEqual(pageSessionFromHeaders(guestSessionHeaders({})), [])
    assert.deepEqual(pageSessionFromHeaders(guestSessionHeaders({ token: '   ' })), [])
  })

  await test('契约：guest 的门禁三条件 + UA 时机 + 装完 reload（源码文本，正向）', () => {
    const guest = readFileSync(fileURLToPath(new URL('../src/client/guest.ts', import.meta.url)), 'utf8')
    // ① 必须用 acquire 给的 partition；② src 必须精确是 about:blank#<lease>
    assert.match(guest, /setAttribute\('partition', reservation\.partition\)/)
    assert.match(guest, /setAttribute\('src', `about:blank\#\$\{reservation\.lease\}`\)/)
    // ③ UA 必须在**第一次导航到站点之前**设（晚一步，站点看到的就是 Electron UA）
    const iUa = guest.indexOf("setAttribute('useragent'")
    const iLoad = guest.indexOf('loadURL(GUEST_BROWSER_URL)')
    assert.ok(iUa > 0 && iLoad > 0 && iUa < iLoad, `UA 必须在 loadURL 之前设：ua@${iUa} load@${iLoad}`)
    // ④ 装完登录态必须 reload（站点 JS 启动时才读 userToken）
    assert.match(guest, /element\.reload\(\)/)
    // ⑤ 抖动复用同一个函数（别在这边自造固定周期）
    assert.match(guest, /pickIntervalMs\(/)
  })

  await test('契约：host 侧有这两个入口，且 guest 不参与发送', () => {
    const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    assert.ok(host.includes("route === '/browser/session'"), 'host 必须提供登录态入口')
    assert.ok(host.includes("route === '/browser/guest-beat'"), 'host 必须接收心跳')
    // guest 只喂"登录态 + UA"；发送通路（streamWebCompletion）不许被它改
    assert.ok(host.includes('guestSessionHeaders'), 'host 必须用共享的转换链')
    const guest = readFileSync(fileURLToPath(new URL('../src/client/guest.ts', import.meta.url)), 'utf8')
    assert.ok(!/streamWebCompletion|postMessage\(.*prompt/.test(guest), 'guest 不许插进发送通路')
  })

  console.log(`\n${failures.length ? '' : '通过 '}${failures.length ? failures.length + ' 项失败' : '所有用例通过'}`)
  if (failures.length) {
    for (const f of failures) console.error(f)
    process.exitCode = 1
  }
}

main()
