/**
 * 回归：内置浏览器登录态 → 账号库的同步（`syncGuestSession`）。
 *
 * 背景（2026-10-15 用户实测）：用户在内置浏览器里登录成功了，但插件发请求仍报
 * 「API 密钥无效」—— guest 有自己的分区，账号库里还是旧 token。
 * 这个用例**真跑一遍账号库**（临时 DSH_HOME，不碰用户目录），守三件事：
 *   ① 身份对得上 ⇒ 换 token，**保留**页面读不到的字段（cookie / UA / hifDliq）；
 *   ② token 没变 ⇒ 什么都不做（避免每 60 秒心跳都写盘）；
 *   ③ 库里没有这个号 ⇒ 入库并切换（用户是在内置浏览器里登的，当然要用它）。
 *
 * 用法: node tests/check-guest-session-sync.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 自己钉住 DSH_HOME（隔离守卫要求）；顺带钉住"不许真启浏览器"
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-guest-sync-'))
process.env.DSH_NO_BROWSER_TRANSPORT = '1'

const failures = []

async function test(name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const accounts = await import('../src/accounts.ts')
const { syncGuestSession } = await import('../src/index.ts')

const SEED = {
  token: 'OLD-TOKEN',
  cookie: 'a=1; b=2',
  hifDliq: 'D-OLD',
  hifLeim: 'L-OLD',
  wasmUrl: 'https://example.invalid/wasm',
  userAgent: 'UA-SEED',
  capturedAt: '2026-01-01T00:00:00.000Z',
}

const seeded = accounts.upsertAccount(SEED, { serverId: 'uid-1' })

async function main() {
  await test('身份对得上 + token 变了 ⇒ 更新那条，且**保留**页面读不到的字段', () => {
    accounts.setActiveAccount(seeded.id)
    const result = syncGuestSession({
      token: 'NEW-TOKEN',
      hifLeim: 'L-NEW',
      hifDliq: '', // 页面里没有这个键 ⇒ 必须保留旧的
      userId: 'uid-1',
      email: 'a@b.com',
    })
    assert.equal(result.action, 'updated')
    assert.equal(result.accountId, seeded.id, '应该更新同一条，而不是新建')
    const record = accounts.listAccounts().find((item) => item.id === seeded.id)
    assert.ok(record, '记录还在')
    assert.equal(record.token, 'NEW-TOKEN', 'token 必须换成页面里读到的那份')
    assert.equal(record.hifLeim, 'L-NEW')
    assert.equal(record.cookie, SEED.cookie, '🔴 cookie 页面读不到 ⇒ 必须保留旧的（清掉等于把号废了）')
    assert.equal(record.userAgent, SEED.userAgent, 'UA 同理')
    assert.equal(record.hifDliq, SEED.hifDliq, '页面没给 hifDliq ⇒ 保留旧的')
    assert.equal(accounts.listAccounts().length, 1, '不许变出第二条')
  })

  await test('token 与 hifLeim 都没变 ⇒ same（不写盘、不折腾）', () => {
    const result = syncGuestSession({
      token: 'NEW-TOKEN',
      hifLeim: 'L-NEW',
      hifDliq: '',
      userId: 'uid-1',
      email: '',
    })
    assert.equal(result.action, 'same')
  })

  await test('库里没有这个身份 ⇒ 入库并切换（用户就是在内置浏览器里登的它）', () => {
    const result = syncGuestSession({
      token: 'TOKEN-X',
      hifLeim: 'L-X',
      hifDliq: 'D-X',
      userId: 'uid-2',
      email: 'x@y.com',
    })
    assert.equal(result.action, 'added', `期望新增，实际 ${result.action}`)
    assert.equal(accounts.listAccounts().length, 2)
    assert.equal(accounts.activeAccountId(), result.accountId, '新号必须被设为当前账号，否则聊天还是用旧号')
    const record = accounts.listAccounts().find((item) => item.id === result.accountId)
    assert.equal(record.token, 'TOKEN-X')
    assert.equal(record.serverId, 'uid-2')
    assert.equal(record.cookie, '', '新号没有 cookie 基准（但鉴权只用 token，见 WebAuth 注释）')
  })

  await test('身份拿不到（页面没给 userInfo）⇒ 更新当前账号，不新建', () => {
    accounts.setActiveAccount(seeded.id)
    const before = accounts.listAccounts().length
    const result = syncGuestSession({
      token: 'TOKEN-Y',
      hifLeim: '',
      hifDliq: '',
      userId: '',
      email: '',
    })
    assert.equal(result.action, 'updated')
    assert.equal(result.accountId, seeded.id, '没有身份时必须落到当前账号上')
    assert.equal(accounts.listAccounts().length, before, '不许凭空多一条')
  })

  await test('空 token ⇒ 不动账号库（脏数据不许写进去）', () => {
    const before = JSON.stringify(accounts.listAccounts())
    const result = syncGuestSession({ token: '   ', hifLeim: '', hifDliq: '', userId: 'uid-9', email: '' })
    assert.equal(result.action, 'same')
    assert.equal(JSON.stringify(accounts.listAccounts()), before, '空 token 不该改任何记录')
  })

  console.log(`\n${failures.length ? '' : '通过 '}${failures.length ? failures.length + ' 项失败' : '所有用例通过'}`)
  if (failures.length) {
    for (const f of failures) console.error(f)
    process.exitCode = 1
  }
}

main()
