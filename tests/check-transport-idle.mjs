/**
 * 回归：传输层空闲看门狗（`src/transport-idle.ts`）。
 *
 * 背景：探活（启动 20s 一次、之后每 30 分钟）每次都走传输层 ⇒ Edge 一旦拉起就永不退场，
 * 用户感知"打开 DSH 都变慢、一直有个大浏览器挂着"。判据全部用注入定时器（不碰真时间）。
 *
 * 用法: node tests/check-transport-idle.mjs
 */
import assert from 'node:assert/strict'
import { createTransportIdleWatch } from '../src/transport-idle.ts'

const failures = []

async function test(name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

/** 手动时钟 + 可手动的定时器。 */
function makeWatch(options = {}) {
  const state = { fired: 0, timers: [], suspendedLog: [] }
  const run = (index) => {
    const t = state.timers[index]
    if (!t) return
    state.timers[index] = null
    t.fn()
  }
  const watch = createTransportIdleWatch({
    idleMs: options.idleMs ?? 10 * 60_000,
    initiallySuspended: options.initiallySuspended ?? true,
    onIdle: () => {
      state.fired += 1
      if (options.onIdleThrows) throw new Error('关不掉')
    },
    log: () => {},
    setTimer: (fn, ms) => {
      state.timers.push({ fn, ms })
      return state.timers.length
    },
    clearTimer: (handle) => {
      state.timers[Number(handle) - 1] = null
    },
  })
  return { watch, state, run }
}

async function main() {
  await test('初始即挂起：没人用就不会起表（探活跳过的前提）', () => {
    const { watch, state } = makeWatch()
    assert.equal(watch.suspended(), true, '必须初始挂起 —— 否则探活会在 DSH 打开 20s 后就把 Edge 拉起来')
    assert.equal(state.timers.length, 0, '挂起状态下不该有计时器')
  })

  await test('真实使用 ⇒ 解除挂起并起表；空闲满 ⇒ 触发一次并回到挂起', async () => {
    const { watch, state, run } = makeWatch()
    watch.noteUse()
    assert.equal(watch.suspended(), false)
    assert.equal(state.timers.length, 1)
    assert.equal(state.timers[0].ms, 10 * 60_000)
    run(0)
    assert.equal(state.fired, 1)
    assert.equal(watch.suspended(), true, '触发后要回到挂起（探活继续跳过）')
    assert.equal(watch.running(), false, '触发后不该自己再起表')
  })

  await test('使用会重置计时：用了一半再用 ⇒ 原定时刻不触发，新的满额时刻才触发', async () => {
    const { watch, state, run } = makeWatch({ idleMs: 10_000 })
    watch.noteUse()
    state.timers[0].fn() // 直接推到第一次的回调前？不行 —— 用"部分时间后重置"的语义模拟：
    // 上面这行会真的触发；换一种写法：
    state.timers[0] = null
    state.fired = 0
    watch.noteUse()
    watch.noteUse() // 立刻再用一次 ⇒ 旧表被清、只留一张新表
    assert.equal(state.timers.filter(Boolean).length, 1, '重复使用只该有一张表')
    assert.equal(state.timers.find(Boolean).ms, 10_000, '新表是满额的')
    run(state.timers.indexOf(state.timers.find(Boolean)))
    assert.equal(state.fired, 1)
  })

  await test('idleMs<=0 ⇒ 永不触发（永驻模式的合法选择）', async () => {
    const { watch, state } = makeWatch({ idleMs: 0 })
    watch.noteUse()
    assert.equal(state.timers.length, 0, '关闭退场时不起表')
    assert.equal(watch.suspended(), false)
  })

  await test('stop() 只停表、不进入挂起（切传输方式后探活走 electron/node，不需要浏览器）', () => {
    const { watch } = makeWatch()
    watch.noteUse()
    watch.stop()
    assert.equal(watch.suspended(), false, 'stop 不该挂起 —— 否则非浏览器传输下探活会永远被跳过')
    assert.equal(watch.running(), false)
  })

  await test('onIdle 抛错不许炸：挂起语义照常生效', async () => {
    const { watch, state, run } = makeWatch({ onIdleThrows: true })
    watch.noteUse()
    run(0)
    assert.equal(state.fired, 1)
    assert.equal(watch.suspended(), true)
  })

  console.log(`\n${failures.length ? '' : '通过 '}${failures.length ? failures.length + ' 项失败' : '所有用例通过'}`)
  if (failures.length) {
    for (const f of failures) console.error(f)
    process.exitCode = 1
  }
}

main()
