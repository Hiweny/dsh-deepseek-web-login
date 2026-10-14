/**
 * 回归：把登录态装进传输层页面的 localStorage（`src/page-session.ts`）。
 *
 * 守什么：传输层页面必须"自己知道已登录"。此前只装 cookie ⇒ 页面渲染登录页
 * 而我们的请求带合法 Bearer —— 真人身上不会出现的组合，站点自己的 JS
 * 也就从来没跑起来过（没有会话轮询/长连接 ⇒ 没有心跳）。
 *
 * 🔴 关键手法：**真求值**。那段页面脚本不是拿来断字符串形状的，
 * 而是用假 `localStorage` 真跑一遍，断言它写进去的键与值。
 * 只断"字符串里有 xxx"的写法在改坏形态后照样会绿。
 *
 * 🔴 结构：导出 `runChecks()` 而不是只在顶层跑 —— 这样
 * `dev/mutate-page-session.mjs` 能在**同一进程内**变异源码后重跑同一批判据
 * （本机 `execFileSync` 派生 node 会返回 `status=null`，那是 spawn 失败、
 * 不是"用例变红"，靠它做变异验证会得到假结果）。
 * 源码用 specifier 上的 `?bust=` 破除 ESM 缓存，否则变异跑的还是老模块。
 *
 * 用法: node tests/check-page-session.mjs
 */

/** 一个够真的假 localStorage：能存、能读回、可选地"写进去但读不到"（模拟被静默丢弃）。 */
function fakeLocalStorage({ swallow = [], throwOn = [] } = {}) {
  const store = new Map()
  return {
    store,
    api: {
      setItem(key, value) {
        if (throwOn.includes(key)) throw new Error('QuotaExceededError')
        if (swallow.includes(key)) return // 写成功但没存 → 静默失败
        store.set(key, String(value))
      },
      getItem(key) {
        return store.has(key) ? store.get(key) : null
      },
    },
  }
}

/** 真跑一次页面脚本，返回它自己报回来的结果 + 假存储的最终内容。 */
function runExpression(expression, storageOptions) {
  if (typeof expression !== 'string') throw new Error('表达式必须是字符串')
  const { store, api } = fakeLocalStorage(storageOptions)
  // 表达式形态是 `(function(){…})()`，用一个假 localStorage 直接求值。
  const fn = new Function('localStorage', `return ${expression}`)
  const report = JSON.parse(fn(api))
  return { report, store }
}

export async function runChecks({ quiet = false } = {}) {
  const failures = []
  const test = async (name, fn) => {
    try {
      await fn()
      if (!quiet) console.log('  ✓', name)
    } catch (error) {
      failures.push(`x ${name}: ${error?.message ?? error}`)
    }
  }

  // 🔴 `?bust=` 破除 ESM 模块缓存：变异验证要靠它拿到改过的模块。
  const bust = process.env.DSH_PAGE_SESSION_BUST ?? 'base'
  const mod = await import(`../src/page-session.ts?bust=${bust}`)
  const { pageSessionFromHeaders, buildSessionInstallExpression, wrapUserToken } = mod

  // ── 1. 从请求头抽出会话值 ────────────────────────────────────────────────

  await test('Authorization 能抽出 token，且按网页端格式包一层', () => {
    const writes = pageSessionFromHeaders({ authorization: 'Bearer abc.def.ghi' })
    const userToken = writes.find((w) => w.key === 'userToken')
    if (!userToken) throw new Error('必须写出 userToken')
    // 🔴 断语义：解包后必须等于原 token（而不是断字符串前缀）。
    const parsed = JSON.parse(userToken.value)
    if (parsed.value !== 'abc.def.ghi') throw new Error('解包后的 token 不对：' + parsed.value)
    if (parsed.__version !== '0') throw new Error('包装形态不是网页端的 __version:"0"')
  })

  await test('头名大小写不敏感（真实链路里不保证是 authorization）', () => {
    const writes = pageSessionFromHeaders({ Authorization: 'Bearer TOKEN-CAPS' })
    const userToken = writes.find((w) => w.key === 'userToken')
    if (!userToken) throw new Error('大写头名时没抽出 userToken')
    if (JSON.parse(userToken.value).value !== 'TOKEN-CAPS') throw new Error('值不对')
  })

  await test('bearer 前缀大小写不敏感、多余空格也能剥掉', () => {
    const writes = pageSessionFromHeaders({ authorization: '  bearer   TOKEN-X  ' })
    const userToken = writes.find((w) => w.key === 'userToken')
    if (!userToken) throw new Error('没抽出 userToken')
    if (JSON.parse(userToken.value).value !== 'TOKEN-X') {
      throw new Error('空格/大小写没剥干净：' + JSON.parse(userToken.value).value)
    }
  })

  await test('没有 Authorization ⇒ 不写 userToken（不编造空串）', () => {
    const writes = pageSessionFromHeaders({ cookie: 'a=b' })
    if (writes.some((w) => w.key === 'userToken')) throw new Error('凭空写了 userToken')
  })

  await test('Authorization 不是 Bearer 形态 ⇒ 不写 userToken', () => {
    const writes = pageSessionFromHeaders({ authorization: 'Basic dXNlcjpwYXNz' })
    if (writes.some((w) => w.key === 'userToken')) throw new Error('把 Basic 认证当成 token 了')
  })

  await test('x-hif-leim 写成 JSON 串，读回来还是同一个字符串', () => {
    const writes = pageSessionFromHeaders({ 'x-hif-leim': 'leim-value' })
    const item = writes.find((w) => w.key === 'hif_leim_cached')
    if (!item) throw new Error('必须写出 hif_leim_cached')
    if (JSON.parse(item.value) !== 'leim-value') throw new Error('JSON 串形态读回来不是原值')
  })

  // 🔴 这条是边界守卫：没有来源的键不许写。site JS 走到没验证过的分支比不写更危险。
  await test('键集合恰好是有来源那两个 —— 不写 __appKit_userInfo / hif_dliq', () => {
    const writes = pageSessionFromHeaders({
      authorization: 'Bearer T',
      'x-hif-leim': 'L',
      'x-hif-dliq': 'D',
      'x-device-id': 'uuid',
    })
    const keys = writes.map((w) => w.key).sort().join(',')
    if (keys !== 'hif_leim_cached,userToken') {
      throw new Error('只允许写有来源的键，实际写了：' + keys)
    }
  })

  // ── 2. 页面脚本真跑一遍 ─────────────────────────────────────────────────

  await test('脚本真跑：token 与 leim 都落进 localStorage，读回来对得上', () => {
    const writes = pageSessionFromHeaders({ authorization: 'Bearer T1', 'x-hif-leim': 'L1' })
    const { report, store } = runExpression(buildSessionInstallExpression(writes))
    if (report.written.slice().sort().join(',') !== 'hif_leim_cached,userToken') {
      throw new Error('写进去的键不对：' + report.written.join(','))
    }
    if (report.failed.length) throw new Error('不该有失败：' + report.failed.join(','))
    // 真的落在存储里，且页面读回来的形态能被站点 JS 解包。
    if (JSON.parse(store.get('userToken')).value !== 'T1') throw new Error('存储里 token 不对')
    if (JSON.parse(store.get('hif_leim_cached')) !== 'L1') throw new Error('存储里 leim 不对')
    // verified 是"读回来核对"的结果，必须等于写进去的原值。
    const expected = JSON.stringify({ value: 'T1', __version: '0' })
    if (report.verified.userToken !== expected) {
      throw new Error('verified 不是写进去的原值：' + String(report.verified.userToken))
    }
  })

  await test('表达式里不含反引号（否则嵌进模板字符串会提前终止）', () => {
    const expr = buildSessionInstallExpression([{ key: 'k', value: 'v' }])
    if (expr.includes('`')) throw new Error('表达式含反引号')
  })

  await test('单个键抛错不拖垮其余的（写失败要能隔离）', () => {
    const writes = [
      { key: 'userToken', value: '{"value":"T","__version":"0"}' },
      { key: 'hif_leim_cached', value: '"L"' },
    ]
    const { report } = runExpression(buildSessionInstallExpression(writes), {
      throwOn: ['userToken'],
    })
    if (report.failed.join(',') !== 'userToken') throw new Error('失败没有被记下来')
    if (report.written.join(',') !== 'hif_leim_cached') throw new Error('另一个键被拖垮了')
  })

  await test('空写入列表 ⇒ 表达式仍是合法脚本（不抛错、什么都不写）', () => {
    const { report } = runExpression(buildSessionInstallExpression([]))
    if (report.written.length || report.failed.length) throw new Error('空列表却动了存储')
  })

  // ── 3. 静默失败必须被看见（这是本轮整个改动的动机） ──────────────────────

  await test('写进去但读不到 ⇒ written 有它、verified 为 null ⇒ mismatched 抓到', () => {
    const writes = [{ key: 'userToken', value: '{"value":"T","__version":"0"}' }]
    const { report } = runExpression(buildSessionInstallExpression(writes), {
      swallow: ['userToken'],
    })
    if (report.written.join(',') !== 'userToken') throw new Error('页面没认为自己写成功')
    if (report.verified.userToken !== null) {
      throw new Error('读回来应该是 null，实际：' + String(report.verified.userToken))
    }
    // 🔴 这就是"装了个寂寞"：必须由 Node 侧按原值比对抓出来。
    const mismatched = mod.diffSessionWrites(report, writes)
    if (mismatched.join(',') !== 'userToken') throw new Error('静默失败没被抓出来')
  })

  await test('读回来对得上 ⇒ mismatched 为空', () => {
    const writes = [{ key: 'userToken', value: '{"value":"T","__version":"0"}' }]
    const { report } = runExpression(buildSessionInstallExpression(writes))
    if (mod.diffSessionWrites(report, writes).length) throw new Error('正常情况误报 mismatched')
  })

  // ── 4. CDP 安装器 ───────────────────────────────────────────────────────

  await test('无值可写 ⇒ 一次 CDP 调用都不发', async () => {
    let calls = 0
    await mod.installPageSessionViaCdp({ send: async () => (calls += 1) }, [])
    if (calls !== 0) throw new Error('空写入却发了 ' + calls + ' 次 CDP 调用')
  })

  await test('CDP 安装器：要求 returnByValue 并解析 result.result.value', async () => {
    const writes = [{ key: 'userToken', value: '{"value":"T","__version":"0"}' }]
    const seen = []
    const result = await mod.installPageSessionViaCdp(
      {
        send: async (method, params) => {
          seen.push({ method, params })
          const { report } = runExpression(params.expression)
          return { result: { value: JSON.stringify(report) } }
        },
      },
      writes,
    )
    if (seen.length !== 1) throw new Error('CDP 调用次数不对：' + seen.length)
    if (seen[0].method !== 'Runtime.evaluate') throw new Error('方法不是 Runtime.evaluate')
    if (seen[0].params.returnByValue !== true) throw new Error('没要求 returnByValue')
    if (result.written.join(',') !== 'userToken') throw new Error('结果没解析出来')
    if (result.mismatched.length) throw new Error('不该有 mismatched')
  })

  await test('页面返回非法值 ⇒ 不抛错，返回空报告（请求路径上不能因此挂掉）', async () => {
    const result = await mod.installPageSessionViaCdp(
      { send: async () => ({ result: { value: 'not-json' } }) },
      [{ key: 'k', value: 'v' }],
    )
    if (result.written.length || result.mismatched.length) throw new Error('垃圾输入却给了结论')
  })

  await test('parseSessionInstallResult 对垃圾输入一律返回空报告', () => {
    for (const input of [undefined, null, '', 42, '[]', '"x"']) {
      const report = mod.parseSessionInstallResult(input)
      if (report.written.length || report.failed.length || Object.keys(report.verified).length) {
        throw new Error('垃圾输入 ' + JSON.stringify(input) + ' 返回了非空报告')
      }
    }
  })

  await test('wrapUserToken 与站点读法形成闭环（解包 == 原 token）', () => {
    if (JSON.parse(wrapUserToken('t')).value !== 't') throw new Error('闭环断了')
  })

  // ── 5. 完整流程：瞬时失败必须能重试 ────────────────────────────────────
  // 🔴 这一组守的是一个**真踩到的缺陷**（0.9.1）：调用点当时"尝试前先置位"签名，
  // 于是一次 `ensureSiteOrigin` 超时（页面没停在站点 origin ⇒ localStorage 写不进去）
  // 就让整条浏览器会话永远不再重试。顺序语义现在由 `runPageSessionInstall` 持有。

  const WRITES = [{ key: 'userToken', value: '{"value":"T","__version":"0"}' }]
  const okResult = { written: ['userToken'], failed: [], verified: {}, mismatched: [] }
  const failResult = { written: [], failed: ['userToken'], verified: {}, mismatched: [] }

  await test('★ 装失败 ⇒ 不记签名 ⇒ 下一次仍然重试', async () => {
    const slot = {}
    const warned = []
    const first = await mod.runPageSessionInstall(slot, WRITES, {
      install: async () => failResult,
      afterInstall: async () => true,
      warn: (message) => warned.push(message),
    })
    if (first.installed) throw new Error('失败却报成功')
    if (slot.signature !== undefined) {
      throw new Error('失败后不该记签名 —— 记了就等于这条会话永远不再重试')
    }
    if (slot.installing !== undefined) throw new Error('失败后 installing 必须清掉（否则并发闸卡死）')
    if (!warned.some((message) => message.includes('一条都没写进'))) {
      throw new Error('失败必须被说出来（静默失败是本项目的老病根）')
    }

    let installCalls = 0
    const second = await mod.runPageSessionInstall(slot, WRITES, {
      install: async () => {
        installCalls += 1
        return okResult
      },
      afterInstall: async () => true,
      warn: () => {},
    })
    if (installCalls !== 1) throw new Error('第二次没有重试（install 调用 ' + installCalls + ' 次）')
    if (!second.installed) throw new Error('第二次应当成功')
    if (slot.signature !== JSON.stringify(WRITES)) throw new Error('成功后必须记签名')
  })

  await test('★ 装成功后再来一次 ⇒ 不重复安装、不重复重载（幂等）', async () => {
    const slot = {}
    let installs = 0
    let reloads = 0
    const effects = {
      install: async () => {
        installs += 1
        return okResult
      },
      afterInstall: async () => {
        reloads += 1
        return true
      },
      warn: () => {},
    }
    await mod.runPageSessionInstall(slot, WRITES, effects)
    const again = await mod.runPageSessionInstall(slot, WRITES, effects)
    if (installs !== 1 || reloads !== 1) {
      throw new Error(`第二次不该再装/再重载（install=${installs} reload=${reloads}）`)
    }
    if (again.attempted) throw new Error('第二次不该发起尝试')
  })

  await test('★ 换号（签名变了）⇒ 必须重装', async () => {
    const slot = {}
    let installs = 0
    const effects = {
      install: async () => {
        installs += 1
        return okResult
      },
      afterInstall: async () => true,
      warn: () => {},
    }
    await mod.runPageSessionInstall(slot, WRITES, effects)
    await mod.runPageSessionInstall(slot, [{ key: 'userToken', value: '{"value":"OTHER"}' }], effects)
    if (installs !== 2) throw new Error('换号后必须重装（否则页面是 A、请求带 B）')
  })

  await test('绑定没建起来 ⇒ 必须 warn（别让人误以为是凭证问题）', async () => {
    const warned = []
    await mod.runPageSessionInstall({}, WRITES, {
      install: async () => okResult,
      afterInstall: async () => false,
      warn: (message) => warned.push(message),
    })
    if (!warned.some((message) => message.includes('回调通道'))) {
      throw new Error('绑定失败必须被说出来')
    }
  })

  await test('install 抛错 ⇒ 不报成功、槽位清干净、异常被说出来', async () => {
    const slot = {}
    const warned = []
    const outcome = await mod.runPageSessionInstall(slot, WRITES, {
      install: async () => {
        throw new Error('boom')
      },
      afterInstall: async () => true,
      warn: (message) => warned.push(message),
    })
    if (outcome.installed) throw new Error('抛错不该报成功')
    if (slot.signature !== undefined || slot.installing !== undefined) {
      throw new Error('异常路径必须把槽位清干净')
    }
    if (!warned.some((message) => message.includes('boom'))) throw new Error('异常必须被说出来')
  })

  await test('没有可写的值 ⇒ 一次副作用都不触发', async () => {
    let calls = 0
    const outcome = await mod.runPageSessionInstall({}, [], {
      install: async () => {
        calls += 1
        return okResult
      },
      afterInstall: async () => {
        calls += 1
        return true
      },
      warn: () => {},
    })
    if (calls !== 0 || outcome.attempted) throw new Error('空写入列表不该触发任何副作用')
  })

  return failures
}

const entry = (process.argv[1] ?? '').replace(/\\/g, '/')
if (entry.endsWith('check-page-session.mjs')) {
  const failures = await runChecks()
  if (failures.length) {
    console.log('\n失败：')
    for (const failure of failures) console.log(' ', failure)
    process.exit(1)
  }
  console.log('\n全部通过 OK')
}
