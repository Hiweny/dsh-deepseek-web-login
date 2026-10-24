/**
 * 协议真机验证脚本（跑在 GitHub Actions ubuntu + Playwright Chromium 上）
 *
 * 目的：验证「APK 采用页面内 fetch 直连 chat.deepseek.com 私有接口」这条路线成立：
 *   1. 能否用账号密码登录，拿到 localStorage.userToken
 *   2. create_pow_challenge → 页面内 SHA3 WASM 求解 → x-ds-pow-response 是否被接受
 *   3. chat_session/create + chat/completion(SSE) 能否流式返回
 *   4. 只带 Bearer token、不带 cookie（credentials:'omit'）是否照样通过（多账号方案的前提）
 *
 * 输出：JSON 结论 + 关键阶段日志（不打印 token / 密码原文）。
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'

const USER = process.env.DS_USER || ''
const PASS = process.env.DS_PASS || ''
const OUT = 'probe-out'
mkdirSync(OUT, { recursive: true })

const log = (...a) => console.log('[probe]', ...a)
const result = { steps: [], conclusions: {} }
const step = (name, ok, detail) => {
  result.steps.push({ name, ok, detail })
  log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}`)
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
})
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
})
const page = await ctx.newPage()
page.on('console', (m) => log('page:', m.text().slice(0, 300)))

try {
  // ── 1. 打开站点并诊断 ──────────────────────────────────────────
  await page.goto('https://chat.deepseek.com/sign_in', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${OUT}/01-signin.png` })
  const shape = await page.evaluate(() => {
    const ins = [...document.querySelectorAll('input')].map((i) => ({
      type: i.type,
      name: i.name,
      placeholder: i.placeholder,
      cls: (i.className || '').slice(0, 60),
      visible: !!(i.offsetWidth || i.offsetHeight),
    }))
    const btns = [...document.querySelectorAll('button,div[role=button],a')]
      .map((b) => (b.innerText || '').trim())
      .filter((t) => t && t.length < 20)
      .slice(0, 40)
    return { url: location.href, title: document.title, ins, btns }
  })
  step('open-signin', true, shape)

  // ── 2. 登录 ────────────────────────────────────────────────────
  let token = ''
  const hasToken = async () => {
    try {
      return await page.evaluate(() => {
        const t = localStorage.getItem('userToken') || ''
        if (t) {
          try {
            const o = JSON.parse(t)
            return o.value || o.token || (typeof o === 'string' ? o : '')
          } catch {
            return t
          }
        }
        return ''
      })
    } catch {
      return ''
    }
  }

  if (USER && PASS) {
    try {
      // 密码登录：切到「密码登录」再填表
      const pwdTab = page.getByText('密码登录', { exact: false }).first()
      if (await pwdTab.count()) {
        await pwdTab.click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(800)
      }
      const phone = page.locator('input[type="text"], input[type="tel"], input:not([type])').first()
      await phone.fill(USER, { timeout: 15000 })
      const pwd = page.locator('input[type="password"]').first()
      await pwd.fill(PASS, { timeout: 15000 })
      await page.waitForTimeout(300)
      await page.locator('input[type="password"]').first().press('Enter')
      await page.waitForTimeout(1500)
      // 有些版本需要点按钮
      const loginBtn = page
        .locator('button:has-text("登录"), div[role=button]:has-text("登录")')
        .filter({ hasNotText: '密码登录' })
        .first()
      if (await loginBtn.count()) await loginBtn.click({ timeout: 5000 }).catch(() => {})

      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(1500)
        token = await hasToken()
        if (token) break
      }
      await page.screenshot({ path: `${OUT}/02-after-login.png` })
      step('login', !!token, {
        tokenLen: token.length,
        tokenHead: token.slice(0, 6),
        url: page.url(),
        hasCaptcha:
          (await page.locator('img[src*="captcha"], .captcha, [class*="captcha"]').count()) > 0,
      })
    } catch (e) {
      step('login', false, { error: String(e).slice(0, 300) })
    }
  } else {
    step('login', false, 'no credentials in env')
  }

  if (!token) {
    // 没登录成功就到此为止，把页面结构留给人看
    writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2))
    await browser.close()
    process.exit(0)
  }

  // 回到主页（拿到登录态后站点会跳转）
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${OUT}/03-home.png` })

  // ── 3. 页面内 PoW + completion ─────────────────────────────────
  const apiProbe = await page.evaluate(async ({ token, mode }) => {
    const log = []
    const BASE = 'https://chat.deepseek.com'
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-client-platform': 'web',
      'x-client-version': '2.5.0',
      origin: BASE,
      referer: BASE + '/',
      authorization: 'Bearer ' + token,
    }
    const opts = mode === 'omit' ? { credentials: 'omit' } : {}
    const out = { log, ok: false }
    const j = async (r) => {
      const t = await r.text()
      try {
        return JSON.parse(t)
      } catch {
        return { __raw: t.slice(0, 300) }
      }
    }

    try {
      // 找官方 sha3 wasm
      let wasmUrl = ''
      const res = performance.getEntriesByType('resource').map((e) => e.name)
      wasmUrl = res.find((u) => /sha3_wasm.*\.wasm/.test(u)) || ''
      if (!wasmUrl) {
        // 兜底：从已知静态域名猜（版本号会变，失败就报出来）
        wasmUrl = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'
      }
      log.push('wasm=' + wasmUrl.slice(0, 120))

      const cr = await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
        method: 'POST',
        headers,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
        ...opts,
      })
      const cj = await j(cr)
      log.push('challenge HTTP ' + cr.status)
      const ch = cj?.data?.biz_data?.challenge
      out.challenge = ch ? { alg: ch.algorithm, difficulty: ch.difficulty, salt: !!ch.salt, sig: !!ch.signature } : cj
      if (!ch) return out

      const wr = await fetch(wasmUrl)
      log.push('wasm HTTP ' + wr.status)
      const bytes = await wr.arrayBuffer()
      const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} })
      const e = instance.exports
      const enc = new TextEncoder()
      const cBytes = enc.encode(ch.challenge)
      const pBytes = enc.encode(String(ch.salt) + '_' + String(ch.expire_at) + '_')
      const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0
      const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0
      new Uint8Array(e.memory.buffer).set(cBytes, cP)
      new Uint8Array(e.memory.buffer).set(pBytes, pP)
      const sp = e.__wbindgen_add_to_stack_pointer(-16)
      const t0 = performance.now()
      e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, Number(ch.difficulty))
      const dv = new DataView(e.memory.buffer)
      const code = dv.getInt32(sp, true)
      const answer = Math.floor(dv.getFloat64(sp + 8, true))
      e.__wbindgen_add_to_stack_pointer(16)
      log.push(`solve code=${code} answer_len=${String(answer).length} ms=${Math.round(performance.now() - t0)}`)
      if (code !== 0) return out

      const powHeader = btoa(
        JSON.stringify({
          algorithm: ch.algorithm,
          challenge: ch.challenge,
          salt: ch.salt,
          answer,
          signature: ch.signature,
          target_path: '/api/v0/chat/completion',
        }),
      )
      out.powOk = true

      // 建会话
      const sr = await fetch(BASE + '/api/v0/chat_session/create', {
        method: 'POST',
        headers,
        body: '{}',
        ...opts,
      })
      const sj = await j(sr)
      const sid = sj?.data?.biz_data?.chat_session?.id
      log.push('session HTTP ' + sr.status + ' id=' + (sid ? 'yes' : 'none'))
      out.session = !!sid
      if (!sid) {
        out.sessionResp = sj
        return out
      }
      out.sid = sid

      // completion
      const cr2 = await fetch(BASE + '/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...headers, accept: 'text/event-stream', 'x-ds-pow-response': powHeader },
        body: JSON.stringify({
          chat_session_id: sid,
          parent_message_id: null,
          prompt: '用一句话介绍你自己，不要超过30字。',
          ref_file_ids: [],
          thinking_enabled: false,
          search_enabled: false,
          model_type: 'default',
          action: null,
          preempt: false,
        }),
        ...opts,
      })
      log.push('completion HTTP ' + cr2.status + ' ct=' + cr2.headers.get('content-type'))
      out.compStatus = cr2.status
      if (!cr2.ok) {
        out.compBody = (await cr2.text()).slice(0, 400)
        return out
      }
      const reader = cr2.body.getReader()
      const dec = new TextDecoder()
      let buf = '',
        frames = 0,
        text = ''
      const deadline = Date.now() + 60000
      let raw = ''
      while (Date.now() < deadline) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = dec.decode(value, { stream: true })
        raw += chunk
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          frames++
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const obj = JSON.parse(payload)
            const v = obj.v
            if (typeof v === 'string' && /content$/.test(obj.p || '')) text += v
            else if (obj.p === 'response/fragments' && v && v.content) text += v.content
            else if (typeof obj.v === 'object' && obj.v?.response?.content) text = obj.v.response.content
          } catch {}
          if (obj0Finished(line)) break
        }
        if (raw.length > 200000) break
        if (/"status"\s*:\s*"FINISHED"/.test(raw)) break
      }
      function obj0Finished(l) {
        return l.includes('FINISHED')
      }
      out.frames = frames
      out.textLen = text.length
      out.textSample = text.slice(0, 120)
      out.rawHead = raw.slice(0, 600)
      out.ok = frames > 0

      // 清理会话
      await fetch(BASE + '/api/v0/chat_session/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ chat_session_id: sid }),
        ...opts,
      }).catch(() => {})
      return out
    } catch (err) {
      out.error = String(err)
      return out
    }
  }, { token, mode: 'cookie' })

  step('page-fetch-completion(cookie)', !!apiProbe.ok, apiProbe)
  result.conclusions.pageFetchCookie = apiProbe.ok
  result.conclusions.frames = apiProbe.frames
  result.conclusions.sample = apiProbe.textSample
  result.conclusions.rawHead = apiProbe.rawHead

  // ── 4. 只带 token、不带 cookie ─────────────────────────────────
  const tokenOnly = await page.evaluate(async ({ token }) => {
    const BASE = 'https://chat.deepseek.com'
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-client-platform': 'web',
      'x-client-version': '2.5.0',
      origin: BASE,
      referer: BASE + '/',
      authorization: 'Bearer ' + token,
    }
    const r = await fetch(BASE + '/api/v0/users/current', {
      method: 'GET',
      headers,
      credentials: 'omit',
    })
    const t = await r.text()
    return { status: r.status, body: t.slice(0, 300) }
  }, { token })
  step('token-only users/current', tokenOnly.status === 200, tokenOnly)
  result.conclusions.tokenOnly = tokenOnly.status === 200
} catch (e) {
  step('fatal', false, String(e))
} finally {
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2))
  await browser.close()
}
