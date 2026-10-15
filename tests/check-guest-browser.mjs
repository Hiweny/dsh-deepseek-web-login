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
  guestFingerprintFix,
  guestProbeExpression,
  needsViewportFix,
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
    'navigator',
    'window',
    'screen',
    `return ${expr}`,
  )
  return JSON.parse(
    fn(
      env.location,
      env.document,
      env.localStorage,
      env.navigator ?? { webdriver: false, userAgentData: { brands: [] } },
      env.window ?? { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 },
      env.screen ?? { width: 2560, height: 1440 },
    ),
  )
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

  await test('🔴 指纹修正脚本必须**真求值**通过（第一版在这挂了：uaFullVersion 拼成了代码）', async () => {
    const code = guestFingerprintFix('Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36')
    const fake = {}
    // 不 try/catch：语法错误必须把用例打红（当时调用点 .catch 把它吞了，谁都不知道）
    new Function('navigator', code)(fake)
    assert.ok(fake.userAgentData, '必须装上 userAgentData')
    assert.equal(fake.userAgentData.brands[0].brand, 'Google Chrome', '品牌要含 Google Chrome')
    assert.equal(fake.userAgentData.brands[0].version, '152')
    const hev = await fake.userAgentData.getHighEntropyValues()
    assert.equal(String(hev.uaFullVersion), '152.0.0.0', '完整版本号要是字符串')
    assert.equal(fake.webdriver, false, 'webdriver 必须钉成 false')
  })

  await test('探针真求值：指纹三件套随心跳带回（Electron 品牌一眼可见）', () => {
    const seen = runProbe({
      location: { href: 'https://chat.deepseek.com/' },
      document: { readyState: 'complete' },
      localStorage: { getItem: () => 'T' },
      navigator: {
        webdriver: true,
        userAgentData: { brands: [{ brand: 'Electron' }, { brand: 'Chromium' }] },
      },
    })
    assert.equal(seen.webdriver, true, '页面里的 webdriver 必须如实带回')
    assert.ok(String(seen.uaDataBrands).includes('Electron'), `品牌要带回：${seen.uaDataBrands}`)
    assert.equal(seen.webgl, '', '假环境里 canvas 无 webgl ⇒ 空串而不是崩')
    assert.equal(seen.vw, 1280, '视口宽要带回（排查"大小不对"的唯一依据）')
    assert.equal(seen.vh, 800, '视口高要带回')
    assert.equal(String(seen.ua).length > 0, true, 'ua 必须真的带回（第一版漏了这个字段，落盘一直是空串）')
  })

  await test('心跳形状：fingerprint 字段收窄（非对象丢弃、字符串截断、webdriver 只认 true）', () => {
    const beat = normalizeGuestBeat({
      ...GOOD,
      fingerprint: { ua: 'u'.repeat(800), webdriver: true, brands: 'b'.repeat(500), webgl: 'w'.repeat(500) },
    })
    assert.ok(beat?.fingerprint, '合法指纹要保留')
    assert.equal(beat.fingerprint.ua.length, 400)
    assert.equal(beat.fingerprint.webdriver, true)
    assert.equal(beat.fingerprint.brands.length, 200)
    const dropped = normalizeGuestBeat({ ...GOOD, fingerprint: 'ua' })
    assert.ok(dropped, '🔴 指纹形状不对只丢指纹，不丢整条心跳')
    assert.ok(!('fingerprint' in (dropped ?? {})), '坏的指纹要被丢掉')
    const noWd = normalizeGuestBeat({ ...GOOD, fingerprint: { ua: 'x', webdriver: 'yes' } })
    assert.equal(noWd?.fingerprint?.webdriver, false, 'webdriver 只认布尔 true')
    assert.ok(!('fingerprint' in (normalizeGuestBeat(GOOD) ?? {})), '没报指纹就不该有该字段')
  })

  await test('🔴 视口自检：实测数据（vw=996/vh=150 对 box 995×578）必须判为需要修正', () => {
    // 这次的真实现场：宽度对得上、高度差 3.8 倍 ⇒ 就是"只渲染顶上一条"的那个 bug
    assert.equal(needsViewportFix({ vw: 996, vh: 150 }, { w: 995, h: 578 }), true)
    // 正常情形（等于盒子）不许误报
    assert.equal(needsViewportFix({ vw: 996, vh: 578 }, { w: 995, h: 578 }), false)
    // 容差内的小差异不算
    assert.equal(needsViewportFix({ vw: 990, vh: 574 }, { w: 995, h: 578 }), false)
    // 拿不到数据/盒子无效时不动作（别瞎重载）
    assert.equal(needsViewportFix(null, { w: 995, h: 578 }), false)
    assert.equal(needsViewportFix({ vw: 0, vh: 0 }, { w: 995, h: 578 }), false)
    assert.equal(needsViewportFix({ vw: 996, vh: 578 }, null), false)
    assert.equal(needsViewportFix({ vw: 996, vh: 578 }, { w: 0, h: 0 }), false)
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

  await test('契约：「网页版」页签挂 conversation.view（与 对话/轨迹/LDW 并排），藏页签不许拆节点', () => {
    const client = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')
    assert.match(client, /slots\.inject\('conversation\.view'/, '必须注册 conversation.view（主区页签）')
    assert.match(client, /label: \(\) => '网页版'/, '页签名')
    // 常驻宿主仍在 shell.overlay（root scope，永不卸载）；页签里只是占位符
    assert.match(client, /slots\.inject\('shell\.overlay'/)
    assert.match(client, /WebLoginPlaceholder/, '占位符组件必须存在')
    // 藏宿主 = 移出视口 + visibility:hidden；**不许 display:none**（webview 会停止布局，webin 实测）
    assert.match(client, /visibility: 'hidden'/)
    // 🔴 宿主只在 guest **真在跑**时显示：否则它会变成一个空的白色圆角盒糊在页签上
    //    （用户实测：看起来就是'一块突出来的白框'，而启动卡片被盖住了）
    assert.match(client, /const visible = rect !== null && running/, '宿主可见条件必须要求 guest 在跑')
    assert.match(client, /rect && running/, '定位同样只在跑的时候生效')
    assert.ok(
      !/dsh-deepseek-guest-host[\s\S]{0,600}display: 'none'/.test(client),
      '宿主不许用 display:none 藏（会让 webview 停止布局）',
    )
  })

  console.log(`\n${failures.length ? '' : '通过 '}${failures.length ? failures.length + ' 项失败' : '所有用例通过'}`)
  if (failures.length) {
    for (const f of failures) console.error(f)
    process.exitCode = 1
  }
}

main()
