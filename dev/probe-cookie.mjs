/**
 * 用「网页版 cookie」尝试恢复登录态：
 *  1. 把 cookie 灌进浏览器上下文，打开 chat.deepseek.com
 *  2. 看页面是登录页还是已登录；读 localStorage 里的 token
 *  3. 只带 cookie 打一次 /api/v0/users/current（验证 cookie 本身能不能鉴权）
 *
 * 结论会写到 probe-out/cookie.json（不打印 token 原文，只打长度/前缀）。
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'

const RAW = process.env.DS_COOKIE || ''
const OUT = 'probe-out'
mkdirSync(OUT, { recursive: true })
const out = { steps: [] }
const step = (n, ok, d) => {
  out.steps.push({ n, ok, d })
  console.log(`[cookie] ${ok ? 'OK  ' : 'FAIL'} ${n} :: ${JSON.stringify(d).slice(0, 700)}`)
}

function parseCookies(raw) {
  const list = []
  for (const part of raw.split(';')) {
    const p = part.trim()
    if (!p) continue
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    list.push({ name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), domain: '.deepseek.com', path: '/' })
  }
  return list
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
})
try {
  const cookies = parseCookies(RAW)
  await ctx.addCookies(cookies)
  step('inject-cookies', cookies.length > 0, { count: cookies.length, names: cookies.map((c) => c.name) })

  const page = await ctx.newPage()
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(7000)
  await page.screenshot({ path: `${OUT}/cookie-home.png` })

  const info = await page.evaluate(() => {
    const raw = localStorage.getItem('userToken') || ''
    let tok = raw
    if (raw.trim().startsWith('{')) {
      try { tok = JSON.parse(raw).value || '' } catch (e) {}
    }
    return {
      url: location.href,
      text: (document.body.innerText || '').slice(0, 500),
      tokenLen: tok.length,
      tokenHead: tok.slice(0, 6),
      localKeys: Object.keys(localStorage).slice(0, 20),
    }
  })
  step('page-state', true, info)

  const api = await page.evaluate(async () => {
    const r = await fetch('/api/v0/users/current', { headers: { accept: 'application/json' }, credentials: 'include' })
    const t = await r.text()
    return { status: r.status, body: t.slice(0, 400) }
  })
  step('cookie-only users/current', api.status === 200, api)

  out.cookieWorks = api.status === 200
  out.tokenLen = info.tokenLen
} catch (e) {
  step('fatal', false, String(e))
} finally {
  writeFileSync(`${OUT}/cookie.json`, JSON.stringify(out, null, 2))
  await browser.close()
}
