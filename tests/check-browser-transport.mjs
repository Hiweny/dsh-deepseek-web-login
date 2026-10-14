/**
 * 回归：浏览器代理传输层（官方 DSH 桌面端 fallback）。
 *
 * 当 Electron 的 `net.fetch` 不可用时，用系统 Edge/Chrome 进程代理请求，
 * 让 TLS/HTTP2 指纹与真实浏览器一致。
 *
 * 用法: node tests/check-browser-transport.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-browser-transport-'))
process.env.DSH_HOME = HOME

const failures = []

async function test(name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

async function main() {
  // 1. 默认（本机有浏览器时）systemBrowserAvailable 为 true
  await test('本机有 Edge/Chrome 时 systemBrowserAvailable 为 true', async () => {
    const { systemBrowserAvailable } = await import('../src/browser-transport.ts')
    assert.equal(typeof systemBrowserAvailable(), 'boolean')
  })

  // 2. DSH_NO_BROWSER_TRANSPORT=1 时强制关闭
  process.env.DSH_NO_BROWSER_TRANSPORT = '1'
  await test('DSH_NO_BROWSER_TRANSPORT=1 时 systemBrowserAvailable 为 false', async () => {
    const { systemBrowserAvailable } = await import(
      '../src/browser-transport.ts?no-browser=' + Date.now()
    )
    assert.equal(systemBrowserAvailable(), false)
  })

  // 3. resolveTransportState 在浏览器可用时选择浏览器代理
  await test('浏览器可用时 resolveTransportState 走 viaBrowserProxy', async () => {
    delete process.env.DSH_NO_BROWSER_TRANSPORT
    const [{ resolveTransportState }, { findSystemBrowser }] = await Promise.all([
      import('../src/transport.ts?with-browser=' + Date.now()),
      import('../src/browser-transport.ts?find=' + Date.now()),
    ])
    const browser = findSystemBrowser()
    const state = resolveTransportState('chromium')
    if (browser) {
      assert.equal(state.effective, 'chromium')
      assert.equal(state.viaBrowserProxy, true)
      assert.equal(state.degraded, false)
    } else {
      assert.equal(state.effective, 'node')
      assert.equal(state.degraded, true)
    }
  })

  // 4. 浏览器 fetch 能走真实 HTTP 请求（对本地 server 发 POST + 流响应）
  await test('浏览器 fetch 可发送 POST 并读取响应', async () => {
    delete process.env.DSH_NO_BROWSER_TRANSPORT
    const { createBrowserFetch, shutdownBrowserTransport, systemBrowserAvailable } = await import(
      '../src/browser-transport.ts?integration=' + Date.now()
    )
    if (!systemBrowserAvailable()) {
      console.log('    (skip: 本机无 Edge/Chrome)')
      return
    }
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, path: req.url, received: body }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await new Promise((r) => setTimeout(r, 200))
    const port = server.address().port
    // 🔴 2026-10-10：这条是**第一个真拉浏览器**的用例（后面的 FormData 复用同一个实例），
    //   所以全部冷启动开销都压在这里。
    //   Ubuntu runner 上 Chrome 冷启动常超过 `waitForTransportDebugPort` 的 25s
    //   （2026-10-10 实测：ubuntu 失败「浏览器调试端口未就绪」，而 macOS / Windows 同commit 通过
    //   —— 同一份代码、同一份夹具，**纯粹是机器快慢**）。
    // ⇒ 按本项目既有约定（`check-devtools.mjs:132`）**重试两次**：首次失败先
    //   `shutdownBrowserTransport()` 复位再试；两次都失败才算它真的坏了。
    //   🔴 别把 `waitForTransportDebugPort` 的超时调大来"修"这个 —— 那是产品代码的真实上限，
    //   为了 CI 放宽它会掩盖真问题。
    let lastErr
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const fetch = createBrowserFetch()
          const response = await fetch(`http://localhost:${port}/api/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-custom': 'ok' },
            body: JSON.stringify({ key: 'value' }),
          })
          assert.equal(response.status, 200)
          const json = await response.json()
          assert.equal(json.method, 'POST')
          assert.equal(json.received, JSON.stringify({ key: 'value' }))
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          await shutdownBrowserTransport()
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1500)) // 给进程回收与下次启动留余量
        }
      }
      if (lastErr) throw lastErr
    } finally {
      // ⚠️ 成功与失败**都要**收尾（改造重试时最容易漏掉这个 finally ⇒ 端口与浏览器进程泄漏）
      await new Promise((resolve) => server.close(resolve))
      await shutdownBrowserTransport()
    }
  })

  // 5. ★ FormData（multipart）—— 图片上传走的就是这条路
  // 0.6.20 的浏览器代理传输层只支持 string/Uint8Array/ArrayBuffer，遇到 FormData 直接抛
  // "暂不支持"，于是"切到浏览器代理之后图片全传不上去"（2026-10-01 用户报）。
  await test('★ 浏览器 fetch 能上传 FormData（图片上传走这条路）', async () => {
    delete process.env.DSH_NO_BROWSER_TRANSPORT
    const { createBrowserFetch, shutdownBrowserTransport, systemBrowserAvailable } = await import(
      '../src/browser-transport.ts?formdata=' + Date.now()
    )
    if (!systemBrowserAvailable()) {
      console.log('    (skip: 本机无 Edge/Chrome)')
      return
    }
    // PNG 的 8 字节魔数 —— 用来确认**文件字节真的到了**，而不只是表单结构对
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const text = body.toString('latin1')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            contentType: req.headers['content-type'] ?? '',
            filename: /filename="([^"]*)"/.exec(text)?.[1] ?? '',
            fileType: /Content-Type: ([^\r\n]+)/.exec(text)?.[1] ?? '',
            gotMagic: body.includes(PNG_MAGIC),
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await new Promise((r) => setTimeout(r, 200))
    const port = server.address().port
    try {
      const fetch = createBrowserFetch()
      const form = new FormData()
      // 200 KB —— 真实图片的量级。不能只用 11 字节：那样测不出 base64 搬运/CDP 消息大小的问题。
      const payload = new Uint8Array(200_000).fill(7)
      payload.set(PNG_MAGIC, 0)
      // ⚠️ 必须带 filename：服务端按**文件名后缀**判图片类型（见 protocol.ts）
      form.append('file', new Blob([payload], { type: 'image/png' }), 'sample.png')
      const response = await fetch(`http://localhost:${port}/api/v0/file/upload_file`, {
        method: 'POST',
        // ⚠️ 不带 content-type：multipart 的 boundary 由浏览器自己加（带了反而会坏）
        headers: { 'x-ds-pow-response': 'pow' },
        body: form,
      })
      assert.equal(response.status, 200)
      const json = await response.json()
      assert.match(json.contentType, /^multipart\/form-data; boundary=/, `实际 content-type：${json.contentType}`)
      assert.equal(json.filename, 'sample.png', '文件名必须保住（服务端按后缀判类型）')
      assert.equal(json.fileType, 'image/png')
      assert.equal(json.gotMagic, true, '文件字节必须原样到达')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await shutdownBrowserTransport()
    }
  })

  // ── 2026-10-14：让传输层更像真浏览器（站对 origin + cookie 真的发出去）──────────

  // 6. 站点 origin 常量不许和 webapi 的 DS_BASE 漂移
  await test('TRANSPORT_SITE_ORIGIN 与 webapi 的 DS_BASE 一致（防漂移）', async () => {
    const [{ TRANSPORT_SITE_ORIGIN }, { DS_BASE }] = await Promise.all([
      import('../src/browser-transport.ts?origin=' + Date.now()),
      import('../src/webapi.ts?dsbase=' + Date.now()),
    ])
    // browser-transport 故意不 import webapi 的常量（会形成循环依赖），所以这里守相等
    assert.equal(TRANSPORT_SITE_ORIGIN, DS_BASE)
  })

  // 7. 启动参数：必须落在站点 origin 上，不能是 about:blank
  await test('传输层浏览器启动在站点 origin（不是 about:blank）', async () => {
    const { transportBrowserArgs, TRANSPORT_SITE_ORIGIN } = await import(
      '../src/browser-transport.ts?args=' + Date.now()
    )
    const profileDir = '/tmp/whatever-profile'
    const args = transportBrowserArgs(profileDir)
    assert.ok(
      args.includes(`${TRANSPORT_SITE_ORIGIN}/`),
      `启动 URL 必须是站点自己 —— Origin/Referer/Sec-Fetch-* 只能靠"页面站在那个 origin 上"才对。实际参数：${JSON.stringify(args)}`,
    )
    assert.ok(!args.includes('about:blank'), 'about:blank 会让每个请求的 Origin 都不是站点的')
    assert.ok(args.includes('--headless=new'), '仍是 headless 传输层')
    assert.ok(
      args.includes(`--user-data-dir=${profileDir}`),
      '启动参数里的 profile 必须就是传进来的那个目录',
    )
  })

  // 8. 禁止头必须被剥掉（交给页面 fetch 会被静默丢弃）
  await test('禁止头被剥离：cookie/origin/referer 不交给页面 fetch', async () => {
    const { splitBrowserFetchHeaders } = await import('../src/browser-transport.ts?headers=' + Date.now())
    const result = splitBrowserFetchHeaders({
      authorization: 'Bearer t',
      'content-type': 'application/json',
      cookie: 'a=1; b=2',
      origin: 'https://example.com',
      referer: 'https://example.com/',
      host: 'chat.deepseek.com',
      'x-hif-dliq': 'hif',
      'x-ds-pow-response': 'pow',
      'user-agent': 'UA',
    })
    // 保留的
    assert.equal(result.headers.authorization, 'Bearer t')
    assert.equal(result.headers['content-type'], 'application/json')
    assert.equal(result.headers['x-hif-dliq'], 'hif')
    assert.equal(result.headers['x-ds-pow-response'], 'pow')
    assert.equal(result.headers['user-agent'], 'UA')
    // 剥掉的 —— 注意大小写不敏感
    assert.ok(!('cookie' in result.headers), 'cookie 是禁止头，交给页面 fetch 会被静默丢掉')
    assert.ok(!('origin' in result.headers), 'origin 是禁止头，脚本补不了')
    assert.ok(!('referer' in result.headers))
    assert.ok(!('host' in result.headers))
    // 原始值要带出来（改走 CDP 安装）
    assert.equal(result.cookieHeader, 'a=1; b=2')
    assert.deepEqual(result.stripped.sort(), ['cookie', 'host', 'origin', 'referer'])
  })

  // 9. cookie 头解析的边界
  await test('parseCookieHeader 的边界：值含 = / 无值 / 空格 / 空串', async () => {
    const { parseCookieHeader } = await import('../src/browser-transport.ts?cookie=' + Date.now())
    assert.deepEqual(parseCookieHeader(''), [])
    assert.deepEqual(parseCookieHeader('a=1'), [{ name: 'a', value: '1' }])
    assert.deepEqual(parseCookieHeader(' a = 1 ; b = 2 '), [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ])
    // 🔴 值里含 `=`（base64 padding 很常见）—— 必须用**第一个** `=` 切分
    assert.deepEqual(parseCookieHeader('t=YWJjZA=='), [{ name: 't', value: 'YWJjZA==' }])
    // 没有 `=` 的片段整条丢掉（不是产出空值）
    assert.deepEqual(parseCookieHeader('flag; a=1'), [{ name: 'a', value: '1' }])
    // 空名丢掉
    assert.deepEqual(parseCookieHeader('=1; a=2'), [{ name: 'a', value: '2' }])
  })

  // 10. 转成 CDP setCookie 参数
  await test('cookiesForCdp 按请求 origin 生成 setCookie 参数', async () => {
    const { cookiesForCdp } = await import('../src/browser-transport.ts?cdp=' + Date.now())
    assert.deepEqual(cookiesForCdp('a=1; b=2', 'https://chat.deepseek.com/'), [
      { name: 'a', value: '1', url: 'https://chat.deepseek.com/', path: '/' },
      { name: 'b', value: '2', url: 'https://chat.deepseek.com/', path: '/' },
    ])
    assert.deepEqual(cookiesForCdp('', 'https://chat.deepseek.com/'), [])
  })

  // 11. cookie 的**机制级**验证：必须走 CDP `Network.setCookie`，而不是交给页面 fetch
  //
  // 🔴 为什么不在这里做"服务端真的收到 cookie"的端到端断言（试过，做不到）：
  //    传输层的页面现在站在 `https://chat.deepseek.com`，而夹具服务在 `http://localhost:PORT`
  //    ⇒ 这是**跨站**请求，Chromium 默认的 `SameSite=Lax` 不会为跨站子资源附带 cookie；
  //    想绕过就得加 `sameSite=no_restriction`，而它**强制要求 `secure`**，
  //    于是 http 请求又不可能带上。两头堵死 —— **这是夹具的局限，不是产品缺陷**：
  //    生产里页面与 API 同源（都是 chat.deepseek.com），SameSite=Lax 照常发送。
  //    ⇒ 所以这里守"我们发出了什么 CDP 调用"，机制正确性由它保证；
  //      真机行为靠"重启后跑一轮真实对话"验证（见 _ref/webview-vs-transport-2026-10-14.md）。
  await test('★ cookie 走 CDP Network.setCookie（精确断言调用序列）', async () => {
    const { installCookiesViaCdp } = await import('../src/browser-transport.ts?instc=' + Date.now())
    const calls = []
    const fakeCdp = {
      send: async (method, params) => {
        calls.push([method, params])
        return method === 'Network.setCookie' ? { success: true } : {}
      },
    }
    const installed = await installCookiesViaCdp(
      fakeCdp,
      'a=1; t=YWJjZA==',
      'https://chat.deepseek.com/api/v0/chat/completion',
    )
    assert.equal(installed, 2)
    assert.equal(calls[0][0], 'Network.enable', '先 enable 再 setCookie')
    const setCookie = calls.filter(([method]) => method === 'Network.setCookie').map(([, params]) => params)
    assert.deepEqual(setCookie, [
      { name: 'a', value: '1', url: 'https://chat.deepseek.com/', path: '/' },
      { name: 't', value: 'YWJjZA==', url: 'https://chat.deepseek.com/', path: '/' },
    ])
  })

  await test('cookie 安装失败必须被计数（setCookie 返回 success:false 而不是抛错）', async () => {
    const { installCookiesViaCdp } = await import('../src/browser-transport.ts?instfail=' + Date.now())
    const fakeCdp = { send: async () => ({ success: false }) }
    assert.equal(
      await installCookiesViaCdp(fakeCdp, 'a=1', 'https://chat.deepseek.com/'),
      0,
      '看不看返回值决定"cookie 静默丢失"会不会再发生一次',
    )
    // 没有 cookie 时不该白发 CDP 调用
    const calls = []
    const recording = { send: async (m, p) => { calls.push([m, p]); return {} } }
    assert.equal(await installCookiesViaCdp(recording, '', 'https://chat.deepseek.com/'), 0)
    assert.equal(calls.length, 0)
    // URL 不合法时也不能炸
    assert.equal(await installCookiesViaCdp(recording, 'a=1', 'not-a-url'), 0)
  })

  // 12. 接线守卫：函数写对了但没被调用 = 假绿（本项目踩过多次的坑）
  //     判据打在**真实入口** `createBrowserFetch` 的函数体上，且先剥掉注释再匹配
  //     （否则一句注释里的函数名就能把这条守卫喂饱）。
  await test('createBrowserFetch 真的调用了剥头与 cookie 安装', async () => {
    const source = readFileSync(join(import.meta.dirname, '../src/browser-transport.ts'), 'utf8')
    const start = source.indexOf('export function createBrowserFetch')
    assert.ok(start > 0, '自证：找得到 createBrowserFetch')
    const rest = source.slice(start + 1)
    const end = rest.indexOf('\nexport function ')
    const body = (end < 0 ? rest : rest.slice(0, end))
      // 粗剥注释：行注释 + 块注释。注释里出现函数名不算调用。
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      body.includes('splitBrowserFetchHeaders('),
      'createBrowserFetch 必须把请求头过一遍剥头 —— 直接交给页面 fetch 会把 cookie 静默丢掉',
    )
    assert.ok(
      body.includes('installCookiesViaCdp('),
      'createBrowserFetch 必须真的安装 cookie —— 光有这个函数不算，得有人调它',
    )
    assert.ok(
      body.includes('installPageSessionViaCdp('),
      'createBrowserFetch 必须真的把登录态装进页面 —— 只装 cookie 的话页面仍是"未登录"',
    )
    assert.ok(
      body.includes('reinstallPageBindings('),
      '重载页面后必须重装回调通道 —— 绑定丢了请求会以"莫名其妙失败"的形态出现',
    )
  })

  // 13. ★ 行为级守卫：首次请求把登录态写进传输层**页面**的 localStorage。
  //     只装 cookie 不够 —— 网页端登录态读的是 `localStorage.userToken`；
  //     页面认为未登录 ⇒ 站点自己的 JS 不会跑（没有会话轮询/长连接）
  //     ⇒ 而我们的请求却带合法 Bearer = 真人身上不会出现的组合。
  //
  //     ⚠️ 这条要真启浏览器、真发请求，并需要能访问站点 origin
  //     （localStorage 在 about:blank 这种 opaque origin 上直接不可用）。
  await test('★ 首次请求把登录态写进传输层页面（页面不再是"未登录"）', async () => {
    const {
      createBrowserFetch,
      launchBrowserTransport,
      shutdownBrowserTransport,
      systemBrowserAvailable,
      TRANSPORT_SITE_ORIGIN,
    } = await import('../src/browser-transport.ts?session=' + Date.now())
    if (!systemBrowserAvailable()) {
      console.log('    （本机没有 Edge/Chrome，跳过）')
      return
    }
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      const browserFetch = createBrowserFetch()
      const response = await browserFetch(`http://127.0.0.1:${port}/probe`, {
        method: 'POST',
        headers: { authorization: 'Bearer SESSION-TOKEN-TEST', 'x-hif-leim': 'LEIM-TEST' },
        body: '{}',
      })
      await response.text()

      const session = await launchBrowserTransport()
      const read = await session.cdp.send('Runtime.evaluate', {
        expression:
          'JSON.stringify((function(){try{' +
          'return {o: location.origin, r: document.readyState,' +
          ' t: localStorage.getItem("userToken"), l: localStorage.getItem("hif_leim_cached")};' +
          '}catch(e){return {o: location.origin, r: document.readyState, err: String(e)};}})())',
        returnByValue: true,
      })
      const seen = JSON.parse(read?.result?.value ?? 'null')
      assert.ok(
        seen,
        '自证：读得到传输层页面的状态。exceptionDetails=' +
          JSON.stringify(read?.exceptionDetails ?? null),
      )
      assert.equal(
        seen.o,
        TRANSPORT_SITE_ORIGIN,
        '前置条件失败：传输层页面没停在站点 origin（`ensureSiteOrigin` 超时 / 网络不通）—— ' +
          '此时 localStorage 是 opaque origin，登录态根本写不进去。**这不是凭证问题**。' +
          `实际 origin=${String(seen.o)}` +
          (seen.err ? `，localStorage 报错=${seen.err}` : ''),
      )
      assert.ok(
        seen.t && JSON.parse(seen.t).value === 'SESSION-TOKEN-TEST',
        `页面 localStorage 里必须是**解包后**的登录态（网页端就是这么读的）。实际：${String(seen.t)}`,
      )
      assert.equal(JSON.parse(seen.l ?? 'null'), 'LEIM-TEST')
      // 重载必须已经完成 —— 站点 JS 是在启动时读 userToken 的，没重载等于没装。
      assert.ok(
        seen.r === 'interactive' || seen.r === 'complete',
        `装完登录态后页面应当已重载完成，实际 readyState=${String(seen.r)}`,
      )
    } finally {
      await shutdownBrowserTransport()
      server.close()
    }
  })

  console.log()
  console.log(failures.length ? `失败 ${failures.length} 项` : '全部通过 OK')
  for (const failure of failures) console.log('  ' + failure)
  if (failures.length) process.exitCode = 1
}

await main()
