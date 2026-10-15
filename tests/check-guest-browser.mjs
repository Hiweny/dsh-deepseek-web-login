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
  chooseSessionAuthority,
  guestSessionFromObservation,
  needsViewportFix,
  normalizeGuestSettings,
  normalizeGuestStorage,
  guestSessionHeaders,
  normalizeGuestBeat,
} from '../src/guest-browser.ts'
import { buildSessionInstallExpression, pageSessionFromHeaders } from '../src/page-session.ts'
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
      localStorage: {
        getItem: (key) => (key === 'hif_leim_cached' ? '"L-1"' : 'T'),
        length: 1,
        key: () => 'hif_leim_cached',
      },
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
    // 登录态回读：hif_* 与身份（"在内置浏览器登录 → 插件可用"靠它）
    assert.ok(seen.hif && typeof seen.hif === 'object', 'hif_* 缓存头必须带回')
    assert.ok(seen.info && typeof seen.info === 'object', '身份必须带回')
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

  await test('持久设置：默认自动启动，只有显式 false 才关（坏值不猜）', () => {
    assert.equal(normalizeGuestSettings(undefined).autoStart, true, '缺省必须是"自动启动"')
    assert.equal(normalizeGuestSettings(null).autoStart, true)
    assert.equal(normalizeGuestSettings({}).autoStart, true)
    assert.equal(normalizeGuestSettings({ autoStart: false }).autoStart, false)
    assert.equal(normalizeGuestSettings({ autoStart: 'no' }).autoStart, true, '只认布尔 false')
    assert.equal(normalizeGuestSettings({ autoStart: 0 }).autoStart, true)
    assert.equal(normalizeGuestSettings('x').autoStart, true)
  })

  await test('契约：自动启动必须走"单窗口认领"（多窗口各挂一个 = 同一号多份页面）', () => {
    const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    const client = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')
    assert.ok(host.includes("route === '/browser/claim-autostart'"), 'host 必须提供认领入口')
    assert.ok(host.includes('guestAutoStartClaimed'), 'host 必须有认领位')
    assert.ok(host.includes("route === '/browser/settings'"), 'host 必须提供设置读写')
    assert.ok(client.includes("api('/browser/claim-autostart'"), '客户端必须认领后才自动挂')
    assert.ok(/settings\?\.autoStart === false/.test(client), '客户端必须尊重"自动启动"开关')
    /**
     * 🔴 自动挂的**触发点**必须是"页签显示出可用尺寸"，**不是面板加载** ——
     * 后者每次开 DSH 都冷启一个 Chromium + 加载整个网页端，实测让启动多花 ~15 秒
     * （webin 没有这个问题，因为它的 guest 是切到页签时才建）。
     */
    assert.ok(client.includes('const autoStartIfNeeded'), '必须有"页签触发"的自动挂函数')
    // ⚠️ 定义与调用的**先后顺序不定**（measure 先定义、闭包后调用是合法的），所以只查"调用点存在"
    assert.ok(
      client.includes('if (r.width >= 200 && r.height >= 200) autoStartIfNeeded()'),
      '自动挂必须在量到可用尺寸时触发',
    )
    // 面板加载路径里不许再直接 start（那才是拖慢启动的写法）
    const hostMountAt = client.indexOf('function GuestHost')
    const hostMountEnd = client.indexOf('function WebLoginPlaceholder')
    const hostMount = client.slice(hostMountAt, hostMountEnd)
    assert.ok(
      !hostMount.includes('guestBrowser.start()'),
      '🔴 GuestHost（面板加载即挂载）里不许直接 start —— 那会让 DSH 启动冷启浏览器',
    )
    // 🔴 还要**等 UI 空闲**再挂（上次停在网页版页签时，启动即挂会让 DSH 多花 ~15 秒）
    assert.ok(client.includes('requestIdleCallback'), '自动挂必须延到 UI 空闲（空闲回调 + 超时兜底）')
    /**
     * 🔴 等待窗口期必须显示**加载态**（转圈 + 说明），不能显示"未启动 + 启动按钮"——
     * 实测反馈：那样用户会以为自动启动开关没生效。
     */
    assert.ok(client.includes('.dsw-spin'), '样式表里必须有转圈动画')
    assert.ok(client.includes('@keyframes dsw-spin'), '转圈动画要有 keyframes')
    assert.ok(client.includes('正在恢复内置浏览器'), '等待期要有明确的加载文案')
    assert.match(client, /autoPhase === 'pending'/, '渲染必须区分"等待/加载"与"未启动"两种状态')
    // 传输层：失败请求也要起空闲计时（否则浏览器被拉起后永不退场）
    const transport = readFileSync(fileURLToPath(new URL('../src/transport.ts', import.meta.url)), 'utf8')
    assert.ok(
      /finally \{\s*noteTransportUsed\(\)/.test(transport),
      '🔴 传输层必须在 finally 里记使用：失败请求也会拉起浏览器，不记就永远不睡',
    )
  })

  await test('🔴 登录态抽取（纯函数）：解包 hif 头、带身份；没 token 就不发', () => {
    const got = guestSessionFromObservation({
      userToken: 'TOK-1',
      hif: { hif_leim_cached: JSON.stringify('L-1'), hif_dliq_cached: 'D-1' },
      info: { id: 'uid-1', email: 'a@b.com' },
    })
    assert.ok(got.session, '必须抽出 session')
    assert.equal(got.session.token, 'TOK-1')
    assert.equal(got.session.hifLeim, 'L-1', 'hif_leim_cached 是 JSON 串，要解包')
    assert.equal(got.session.hifDliq, 'D-1')
    assert.equal(got.session.userId, 'uid-1')
    assert.equal(got.session.email, 'a@b.com')
    // 未登录 ⇒ 什么都不发（别把空 token 写到账号库）
    assert.deepEqual(guestSessionFromObservation({ userToken: '', hif: {}, info: {} }), {})
    assert.deepEqual(guestSessionFromObservation(null), {})
  })

  await test('🔴 形状契约：session 必须在**顶层**（放进 fingerprint 里 host 读不到 —— 这就是"依旧无效"的根因）', () => {
    const nested = normalizeGuestBeat({ ...GOOD, fingerprint: { ua: 'x', session: { token: 'T' } } })
    assert.ok(!nested?.session, '嵌在 fingerprint 里的 session 不算（host 只读顶层）')
    const top = normalizeGuestBeat({ ...GOOD, session: { token: 'T-9', hifLeim: 'L', hifDliq: '', userId: 'u', email: '' } })
    assert.equal(top?.session?.token, 'T-9', '顶层 session 必须被收下')
    /**
     * 客户端侧用**结构性判据**（括号配平），不看子串：
     * 上一版的 bug 就是"调用写了、但落在 fingerprint 的花括号里"——
     * 只查"有没有这行"是查不出来的（子串判据在这里恰好是假绿的典型）。
     */
    const guest = readFileSync(fileURLToPath(new URL('../src/client/guest.ts', import.meta.url)), 'utf8')
    const callAt = guest.indexOf('...(guestSessionFromObservation(observed))')
    assert.ok(callAt > 0, '客户端必须调用纯函数抽出顶层 session')
    // 找到包含这次调用的 reportBeat 对象字面量，扫描到调用点为止：
    // 若此刻仍"处于某个 fingerprint 块内部"，说明又放错了容器
    const beatStart = guest.lastIndexOf('reportBeat({', callAt)
    assert.ok(beatStart > 0, '找不到包含该调用的 reportBeat 调用')
    let depth = 0
    let fpDepth = -1
    for (let i = guest.indexOf('{', beatStart); i < callAt; i += 1) {
      const ch = guest[i]
      if (ch === '{') {
        const before = guest.slice(Math.max(0, i - 24), i)
        depth += 1
        if (/fingerprint:\s*$/.test(before)) fpDepth = depth
      } else if (ch === '}') {
        if (depth === fpDepth) fpDepth = -1
        depth -= 1
      }
    }
    assert.equal(fpDepth, -1, '🔴 session 必须落在 fingerprint **之外**（顶层）—— 放进里面 host 读不到')
  })

  await test('🔴 localStorage 快照：收窄上限 + 没 token 也要带回来（分区不持久化，靠它续命）', () => {
    const storage = normalizeGuestStorage({ userToken: 'T', big: 'x'.repeat(9000), ok: 'small' })
    assert.ok(storage, '快照要收下')
    assert.equal(storage.userToken, 'T')
    assert.equal(storage.ok, 'small')
    assert.ok(!('big' in storage), '单值超上限的键要丢掉（不许把巨型值搬回来）')
    assert.equal(normalizeGuestStorage({ bad: 123 }), undefined, '非字符串值丢掉；全丢光 ⇒ undefined')
    assert.equal(normalizeGuestStorage(null), undefined)
    // 没 token 但页面有快照 ⇒ 也必须带回去（快照里可能还有别的键能救回来）
    const only = guestSessionFromObservation({ userToken: '', ls: { userToken: 'FROM-SNAPSHOT' } })
    assert.ok(!only.session, '没 token 不算已登录')
    assert.equal(only.storage?.userToken, 'FROM-SNAPSHOT', '快照要带回来')
    // 形状：顶层 storage 必须被 host 收下
    const beat = normalizeGuestBeat({ ...GOOD, storage: { userToken: 'T' } })
    assert.equal(beat?.storage?.userToken, 'T', '顶层 storage 必须被收下')
  })

  await test('契约：快照必须先落盘、挂载时**先装快照再装账号凭证**（同名以账号为准）', () => {
    const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    const guest = readFileSync(fileURLToPath(new URL('../src/client/guest.ts', import.meta.url)), 'utf8')
    assert.ok(host.includes('writeGuestStorage(beat.storage ?? {}'), 'host 必须把快照落盘')
    assert.ok(host.includes('beat.cookie'), 'host 必须把 cookie 一起落盘（webin：存了不回写 = 白存）')
    assert.ok(host.includes('guest-storage.json'), '落盘文件名要明确')
    assert.ok(host.includes('storage: readGuestStorage()'), '/browser/session 必须把快照交回面板')
    assert.ok(host.includes('cookie: readGuestStorage()?.cookie'), '/browser/session 必须把 cookie 交回面板')
    // 安装表达式要带 cookie 与**源检查**（webin 实测：在 about:blank 上写等于白写）
    const page = readFileSync(fileURLToPath(new URL('../src/page-session.ts', import.meta.url)), 'utf8')
    assert.ok(page.includes('wrongOrigin'), '安装表达式必须报出源不对的情形')
    assert.ok(page.includes('cookiesWritten'), '安装表达式必须报告 cookie 写回数量')
    // 客户端：恢复路径必须防重载风暴（同一个 token 不再反复 reload）
    assert.ok(guest.includes('if (recovery && tokenToInstall && tokenToInstall === lastInstalledToken)'), '恢复路径要有防重载风暴闸门')
    // 写入顺序：快照在前、账号凭证在后（后者覆盖前者）
    const snapAt = guest.indexOf('Object.entries(session?.storage ?? {})')
    const writesAt = guest.indexOf('for (const write of session?.writes ?? [])')
    assert.ok(snapAt > 0 && writesAt > 0 && snapAt < writesAt, '必须先写快照、再写账号凭证')
  })

  await test('🔴 安装表达式真求值：cookie 要写回；源不对（about:blank）必须报出来', () => {
    const writes = [{ key: 'userToken', value: 'T' }]
    const cookies = ['a=1', 'b=2']
    const run = (origin) => {
      const store = {}
      const jar = []
      const expr = buildSessionInstallExpression(writes, cookies)
      const fn = new Function('location', 'document', 'localStorage', `return ${expr}`)
      const result = fn(
        { origin, href: origin + '/' },
        {
          get cookie() {
            return jar.join('; ')
          },
          set cookie(value) {
            jar.push(String(value))
          },
        },
        {
          setItem: (k, v) => {
            store[k] = v
          },
          getItem: (k) => (k in store ? store[k] : null),
        },
      )
      return JSON.parse(result)
    }
    const good = run('https://chat.deepseek.com')
    assert.equal(good.wrongOrigin, false, '正常源不该被判错')
    assert.equal(good.cookiesWritten, 2, 'cookie 必须真的写回（webin：存了不回写 = 白存）')
    assert.deepEqual(good.written, ['userToken'])
    assert.equal(good.verified.userToken, 'T', '写进去还要读回来核对')

    // 🔴 webin 踩过的坑：在 about:blank（opaque origin）上写 storage 会静默失败
    const bad = run('about:blank')
    assert.equal(bad.wrongOrigin, true, 'about:blank 必须被判为源不对')
    assert.equal(bad.cookiesWritten, 0, '源不对时不许写 cookie')
  })

  await test('🔴 谁新用谁：快照比账号库新 ⇒ 以快照为准（否则新登录会被旧 token 踢掉）', () => {
    const older = '2026-10-11T09:17:59.721Z'
    const newer = '2026-10-15T12:28:28.517Z'
    assert.equal(chooseSessionAuthority(newer, older), 'snapshot', '快照新 ⇒ 听快照')
    assert.equal(chooseSessionAuthority(older, newer), 'account', '账号库新 ⇒ 听账号库')
    assert.equal(chooseSessionAuthority(older, older), 'account', '同时刻保守听账号库')
    assert.equal(chooseSessionAuthority(undefined, older), 'account', '没有快照时间 ⇒ 听账号库')
    assert.equal(chooseSessionAuthority(newer, undefined), 'snapshot', '没有账号时间 ⇒ 只能听快照')
    assert.equal(chooseSessionAuthority('坏值', '坏值'), 'account', '坏值不猜')
  })

  await test('契约：authority=snapshot 时不许用账号的 token 覆盖快照；崩溃后有上限地自动重挂', () => {
    const guest = readFileSync(fileURLToPath(new URL('../src/client/guest.ts', import.meta.url)), 'utf8')
    // 覆盖禁用：两个 token 键必须在 preferSnapshot 时被跳过
    assert.ok(guest.includes("const preferSnapshot = session?.authority === 'snapshot'"), '要读 authority')
    assert.ok(
      /if \(preferSnapshot && tokenKeys\.has\(write\.key\)\) continue/.test(guest),
      'preferSnapshot 时必须跳过账号的 token 键（不许覆盖快照）',
    )
    assert.ok(guest.includes("new Set(['userToken', 'hif_leim_cached'])"), '要覆盖的键就这两个')
    // 自动重挂：上限 3 次 + 用户手动停过就不再拉起
    assert.ok(guest.includes('status.recoveries < 3'), '自动重挂要有上限（别无限重启）')
    assert.ok(guest.includes('stoppedByUser = true'), '用户手动停过就不再自动拉起')
    assert.ok(guest.includes('void startGuest()'), '重挂要复用 startGuest（不是对象方法）')
    // 崩溃原因必须留痕（实测：只写"探测不到"查不出为什么死）
    for (const ev of ["'crashed'", "'destroyed'", "'render-process-gone'"]) {
      assert.ok(guest.includes(ev), `要监听 ${ev} 并记录原因`)
    }
    assert.ok(guest.includes('lastCrashReason'), '崩溃原因要能带进心跳说明')
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
    // 🔴 启动必须幂等 + 清孤儿：用户实测"页签里出现两份页面"（双击建了两个 webview，
    //    内层是 flex 行 ⇒ 两个 100% 宽的 guest 并排各占一半）
    const guestSrc = readFileSync(fileURLToPath(new URL('../src/client/guest.ts', import.meta.url)), 'utf8')
    assert.match(guestSrc, /if \(attaching \|\| element \|\| status\.running\) return/, 'attach 必须有幂等闸门')
    assert.match(guestSrc, /querySelectorAll\('webview'\)/, '建/删之前必须清掉宿主里的孤儿 guest')
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
