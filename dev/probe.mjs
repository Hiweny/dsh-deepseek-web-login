/**
 * 协议真机验证脚本 v2（GitHub Actions ubuntu + Playwright Chromium）
 *
 * 验证「APK 采用页面内 fetch 直连 chat.deepseek.com 私有接口」这条路：
 *   1. 账号密码登录 → localStorage.userToken
 *   2. create_pow_challenge → 页面内 SHA3 WASM 求解 → completion SSE
 *   3. 只带 Bearer token（credentials:'omit'）是否通过 —— 多账号方案的前提
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
  log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail).slice(0, 900) : ''}`)
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
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
})
const page = await ctx.newPage()
page.on('console', (m) => {
  const t = m.text()
  if (/error|fail|warn/i.test(t)) log('page:', t.slice(0, 240))
})

const readToken = () =>
  page.evaluate(() => {
    const t = localStorage.getItem('userToken') || ''
    if (!t) return ''
    if (t.trim().startsWith('{')) {
      try {
        const o = JSON.parse(t)
        return o.value || o.token || ''
      } catch {
        return ''
      }
    }
    return t.trim()
  }).catch(() => '')

try {
  await page.goto('https://chat.deepseek.com/sign_in', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(3000)

  // 关掉 cookie 横幅（否则会拦截点击）
  for (const t of ['接受全部', '仅接受必要 Cookies']) {
    const b = page.getByText(t, { exact: true }).first()
    if (await b.count()) await b.click({ timeout: 3000 }).catch(() => {})
  }
  await page.screenshot({ path: `${OUT}/01-signin.png` })
  step('open-signin', true, { url: page.url(), title: await page.title() })

  // ── 登录 ────────────────────────────────────────────────────
  let token = ''
  if (USER && PASS) {
    try {
      const phone = page.locator('input.ds-input__input[type="text"], input[placeholder*="手机号"]').first()
      await phone.waitFor({ state: 'visible', timeout: 20000 })
      await phone.click()
      await phone.fill('')
      await phone.type(USER, { delay: 60 })
      const pwd = page.locator('input[type="password"]').first()
      await pwd.click()
      await pwd.fill('')
      await pwd.type(PASS, { delay: 60 })
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${OUT}/02-filled.png` })

      const btn = page.getByRole('button', { name: '登录', exact: true }).first()
      if (await btn.count()) {
        await btn.click({ timeout: 8000 })
      } else {
        await pwd.press('Enter')
      }
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1500)
        token = await readToken()
        if (token) break
        // 出现人机验证就停下，把证据留下
        const cap = await page
          .locator('[class*="captcha"], img[src*="captcha"], iframe[src*="captcha"], [class*="verify"]')
          .count()
        if (cap > 0 && i > 3) {
          log('captcha-like element appeared, count=', cap)
          break
        }
      }
      await page.screenshot({ path: `${OUT}/03-after-login.png`, fullPage: true })
      const bodyText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 800)
      step('login', !!token, { tokenLen: token.length, url: page.url(), bodyText })
    } catch (e) {
      step('login', false, { error: String(e).slice(0, 400) })
    }
  } else {
    step('login', false, 'no credentials in env')
  }

  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2))
  if (!token) {
    await browser.close()
    process.exit(0)
  }

  // ── 页面内 PoW + completion（带 cookie）─────────────────────
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(2500)

  const apiProbe = await page.evaluate(async ({ token }) => {
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
    const out = { log, ok: false }
    const txt = async (r) => {
      const t = await r.text()
      try {
        return JSON.parse(t)
      } catch {
        return { __raw: t.slice(0, 300) }
      }
    }
    try {
      const res = performance.getEntriesByType('resource').map((e) => e.name)
      let wasmUrl = res.find((u) => /sha3_wasm.*\.wasm/.test(u)) || ''
      if (!wasmUrl) wasmUrl = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'
      log.push('wasm=' + wasmUrl.slice(0, 140))

      const cr = await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
        method: 'POST',
        headers,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      })
      const cj = await txt(cr)
      log.push('challenge HTTP ' + cr.status)
      const ch = cj?.data?.biz_data?.challenge
      if (!ch) {
        out.challengeResp = cj
        return out
      }
      out.challenge = { alg: ch.algorithm, difficulty: ch.difficulty }

      const wr = await fetch(wasmUrl)
      log.push('wasm HTTP ' + wr.status)
      const { instance } = await WebAssembly.instantiate(await wr.arrayBuffer(), { wbg: {} })
      const e = instance.exports
      const enc = new TextEncoder()
      const cB = enc.encode(ch.challenge)
      const pB = enc.encode(String(ch.salt) + '_' + String(ch.expire_at) + '_')
      const cP = e.__wbindgen_export_0(cB.length, 1) >>> 0
      const pP = e.__wbindgen_export_0(pB.length, 1) >>> 0
      new Uint8Array(e.memory.buffer).set(cB, cP)
      new Uint8Array(e.memory.buffer).set(pB, pP)
      const sp = e.__wbindgen_add_to_stack_pointer(-16)
      const t0 = performance.now()
      e.wasm_solve(sp, cP, cB.length, pP, pB.length, Number(ch.difficulty))
      const dv = new DataView(e.memory.buffer)
      const code = dv.getInt32(sp, true)
      const answer = Math.floor(dv.getFloat64(sp + 8, true))
      e.__wbindgen_add_to_stack_pointer(16)
      log.push(`solve code=${code} ms=${Math.round(performance.now() - t0)}`)
      if (code !== 0) return out
      out.powOk = true

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

      const sr = await fetch(BASE + '/api/v0/chat_session/create', { method: 'POST', headers, body: '{}' })
      const sj = await txt(sr)
      const sid = sj?.data?.biz_data?.chat_session?.id
      log.push('session HTTP ' + sr.status + ' id=' + (sid ? 'yes' : 'none'))
      if (!sid) {
        out.sessionResp = sj
        return out
      }

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
      })
      log.push('completion HTTP ' + cr2.status)
      out.compStatus = cr2.status
      if (!cr2.ok) {
        out.compBody = (await cr2.text()).slice(0, 500)
        return out
      }
      const reader = cr2.body.getReader()
      const dec = new TextDecoder()
      let raw = ''
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        const { done, value } = await reader.read()
        if (done) break
        raw += dec.decode(value, { stream: true })
        if (raw.length > 300000) break
        if (/"status"\s*:\s*"FINISHED"/.test(raw)) break
      }
      out.rawHead = raw.slice(0, 1200)
      out.rawLen = raw.length
      out.ok = /"content"/.test(raw) || /FINISHED/.test(raw)

      await fetch(BASE + '/api/v0/chat_session/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ chat_session_id: sid }),
      }).catch(() => {})
      return out
    } catch (err) {
      out.error = String(err)
      return out
    }
  }, { token })

  step('page-fetch-completion(cookie)', !!apiProbe.ok, apiProbe)
  result.conclusions.pageFetch = apiProbe.ok
  result.conclusions.rawHead = apiProbe.rawHead

  // ── 只带 token、不带 cookie（多账号前提）────────────────────
  const tokenOnly = await page.evaluate(async ({ token }) => {
    const BASE = 'https://chat.deepseek.com'
    const h = {
      accept: 'application/json, text/plain, */*',
      'x-client-platform': 'web',
      'x-client-version': '2.5.0',
      authorization: 'Bearer ' + token,
    }
    const r = await fetch(BASE + '/api/v0/users/current', { headers: h, credentials: 'omit' })
    return { status: r.status, body: (await r.text()).slice(0, 400) }
  }, { token })
  step('token-only users/current', tokenOnly.status === 200, tokenOnly)
  result.conclusions.tokenOnly = tokenOnly.status === 200
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2))
} catch (e) {
  step('fatal', false, String(e))
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
