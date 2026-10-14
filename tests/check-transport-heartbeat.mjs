/**
 * 回归：传输层保活心跳（`src/transport-heartbeat.ts`）。
 *
 * 要点：
 *  1. 探测**只读页面本地值**（所以本模块必须零依赖 —— 没有 import 就不可能发网络请求）；
 *  2. 只在**状态变化**时做恢复动作（状态没变说明上次已经处理过）；
 *  3. 连续探测不到就停表（别空转），但传输层被再次使用时能复位重来；
 *  4. 间隔带抖动（固定周期本身就是模式）。
 *
 * 用法: node tests/check-transport-heartbeat.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  createTransportHeartbeat,
  judgeObservation,
  pickIntervalMs,
  SITE_ORIGIN,
} from '../src/transport-heartbeat.ts'
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

const OK = { url: `${SITE_ORIGIN}/`, readyState: 'complete', userToken: 'tok-1' }

/** 造一个心跳：所有副作用都注入，测试里不碰真定时器、不碰浏览器。 */
function makeHeartbeat(observations, options = {}) {
  const calls = { probe: 0, loggedOut: 0, offOrigin: 0, dead: 0, timers: [] }
  let index = 0
  const results = Array.isArray(observations) ? observations : [observations]
  let clock = 1_000
  const heartbeat = createTransportHeartbeat({
    probe: async () => {
      calls.probe += 1
      const value = results[Math.min(index, results.length - 1)]
      index += 1
      if (value instanceof Error) throw value
      return value
    },
    onLoggedOut: () => {
      calls.loggedOut += 1
      if (options.loggedOutThrows) throw new Error('重装失败')
    },
    onOffOrigin: () => {
      calls.offOrigin += 1
    },
    onDead: () => {
      calls.dead += 1
    },
    baseMs: options.baseMs ?? 60_000,
    stopAfterFailures: options.stopAfterFailures ?? 3,
    now: () => (clock += 1_000),
    random: options.random ?? (() => 0.5),
    log: () => {},
    setTimer: (fn, ms) => {
      calls.timers.push(ms)
      return calls.timers.length
    },
    clearTimer: () => {},
  })
  return { heartbeat, calls }
}

async function main() {
  await test('站点 origin 常量与传输层那边一致（防两处漂移）', () => {
    assert.equal(SITE_ORIGIN, TRANSPORT_SITE_ORIGIN)
  })

  await test('🔴 本模块零依赖：没有 import 就不可能发网络请求', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/transport-heartbeat.ts', import.meta.url)),
      'utf8',
    )
    assert.ok(!/^import\s/m.test(src), '保活心跳不许 import 任何东西（含 node:http / fetch 实现）')
    assert.ok(!/\bfetch\s*\(/.test(src), '保活心跳不许发 fetch —— 它只能读页面本地值')
  })

  await test('判定：探测不到 ⇒ dead；不在站点 ⇒ off-origin；没登录态 ⇒ logged-out', () => {
    assert.equal(judgeObservation(null, SITE_ORIGIN).state, 'dead')
    assert.equal(judgeObservation({ ...OK, url: 'https://example.com/' }, SITE_ORIGIN).state, 'off-origin')
    assert.equal(judgeObservation({ ...OK, userToken: '   ' }, SITE_ORIGIN).state, 'logged-out')
    assert.equal(judgeObservation(OK, SITE_ORIGIN).state, 'alive')
    // 深路径也算在站点上
    assert.equal(
      judgeObservation({ ...OK, url: `${SITE_ORIGIN}/a/chat/s/xxx` }, SITE_ORIGIN).state,
      'alive',
    )
  })

  await test('🔴 域名边界：chat.deepseek.com.evil.com 不许被当成站点（前缀相同的坑）', () => {
    const case1 = judgeObservation({ ...OK, url: 'https://chat.deepseek.com.evil.com/' }, SITE_ORIGIN)
    assert.equal(case1.state, 'off-origin', `漏判了：${JSON.stringify(case1)}`)
    const case2 = judgeObservation({ ...OK, url: 'https://chat.deepseek.com.attacker.cn/x' }, SITE_ORIGIN)
    assert.equal(case2.state, 'off-origin')
  })

  await test('间隔带抖动：落在 [0.6, 1.4]×base，且不是固定值', () => {
    assert.equal(pickIntervalMs(60_000, () => 0), 36_000)
    assert.equal(pickIntervalMs(60_000, () => 1), 84_000)
    assert.equal(pickIntervalMs(60_000, () => 0.5), 60_000)
    const draws = [0.1, 0.3, 0.55, 0.7, 0.9].map((r) => pickIntervalMs(60_000, () => r))
    assert.equal(new Set(draws).size, draws.length, '不同随机数应给出不同间隔（固定周期是模式）')
    for (const ms of draws) {
      assert.ok(ms >= 36_000 && ms <= 84_000, `超出抖动区间：${ms}`)
    }
    // 非法输入不炸：NaN 随机数按中点处理，base 非法直接报错（不要静默用 0 去排表）
    assert.equal(pickIntervalMs(60_000, () => Number.NaN), 60_000)
    assert.throws(() => pickIntervalMs(0), /baseMs/)
  })

  await test('心跳：页面正常 ⇒ 不做任何恢复动作', async () => {
    const { heartbeat, calls } = makeHeartbeat([OK, OK])
    await heartbeat.beatOnce()
    await heartbeat.beatOnce()
    assert.deepEqual([calls.loggedOut, calls.offOrigin, calls.dead], [0, 0, 0])
    assert.equal(heartbeat.snapshot().state, 'alive')
    assert.equal(heartbeat.snapshot().beats, 2)
  })

  await test('🔴 只在状态变化时恢复：连续两次"未登录"只重装一次', async () => {
    const { heartbeat, calls } = makeHeartbeat([{ ...OK, userToken: '' }, { ...OK, userToken: '' }])
    await heartbeat.beatOnce()
    await heartbeat.beatOnce()
    assert.equal(calls.loggedOut, 1, `状态没变不该重复重装，实际 ${calls.loggedOut} 次`)
    assert.equal(heartbeat.snapshot().recoveries, 1)
  })

  await test('状态变化会再次恢复：好 → 坏 → 好 → 坏 各恢复一次', async () => {
    const { heartbeat, calls } = makeHeartbeat([
      OK,
      { ...OK, url: 'https://example.com/' },
      OK,
      { ...OK, url: 'https://example.com/' },
    ])
    for (let i = 0; i < 4; i++) await heartbeat.beatOnce()
    assert.equal(calls.offOrigin, 2)
    assert.equal(heartbeat.snapshot().recoveries, 2)
  })

  await test('连续探测不到 ⇒ 每次都标记失效，但累计到阈值就停表', async () => {
    const { heartbeat, calls } = makeHeartbeat([null, null, null, null], { stopAfterFailures: 3 })
    for (let i = 0; i < 4; i++) await heartbeat.beatOnce()
    assert.equal(calls.dead, 1, '只有第一次（状态由 idle 变 dead）才做恢复动作')
    assert.equal(heartbeat.snapshot().consecutiveFailures, 4)
    heartbeat.start()
    assert.equal(heartbeat.running(), false, '连续失败到阈值后不该再起表空转')
  })

  await test('🔴 传输层被再次使用时复位：失败计数清零、重新起表', async () => {
    const { heartbeat, calls } = makeHeartbeat([null, null, null], { stopAfterFailures: 2 })
    for (let i = 0; i < 3; i++) await heartbeat.beatOnce()
    assert.ok(heartbeat.snapshot().consecutiveFailures >= 2)
    heartbeat.start()
    assert.equal(heartbeat.running(), false)
    heartbeat.noteTransportUsed()
    assert.equal(heartbeat.snapshot().consecutiveFailures, 0)
    assert.equal(heartbeat.running(), true, '重新拉起传输层之后保活要能回来')
    assert.equal(calls.timers.length, 1)
  })

  await test('起表幂等：重复 noteTransportUsed 只排一个表', async () => {
    const { heartbeat, calls } = makeHeartbeat([OK])
    heartbeat.noteTransportUsed()
    heartbeat.noteTransportUsed()
    heartbeat.start()
    assert.equal(calls.timers.length, 1, `重复起表了：${calls.timers.length} 次`)
    heartbeat.stop()
    assert.equal(heartbeat.running(), false)
  })

  await test('恢复动作抛错不许把心跳打挂：记下原因，后续仍能探测', async () => {
    const { heartbeat } = makeHeartbeat([{ ...OK, userToken: '' }, OK], { loggedOutThrows: true })
    await heartbeat.beatOnce()
    assert.match(String(heartbeat.snapshot().lastReason), /重装失败/)
    await heartbeat.beatOnce()
    assert.equal(heartbeat.snapshot().state, 'alive')
    assert.equal(heartbeat.snapshot().beats, 2)
  })

  await test('probe 抛错按"探测不到"处理，不让异常冒出去', async () => {
    const { heartbeat, calls } = makeHeartbeat([new Error('CDP 断了')])
    const snap = await heartbeat.beatOnce()
    assert.equal(snap.state, 'dead')
    assert.equal(calls.dead, 1)
  })

  await test('snapshot 形状供 /status 用（面板要读 state/at/recoveries）', async () => {
    const { heartbeat } = makeHeartbeat([OK])
    await heartbeat.beatOnce()
    const snap = heartbeat.snapshot()
    for (const key of ['state', 'at', 'beats', 'recoveries', 'consecutiveFailures']) {
      assert.ok(key in snap, `snapshot 缺字段：${key}`)
    }
    assert.ok(snap.at > 0)
  })

  console.log(`\n${failures.length ? '' : '通过 '}${failures.length ? failures.length + ' 项失败' : '所有用例通过'}`)
  if (failures.length) {
    for (const f of failures) console.error(f)
    process.exitCode = 1
  }
}

main()
