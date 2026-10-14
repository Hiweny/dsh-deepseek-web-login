/**
 * 变异验证：把 `src/page-session.ts` 的每处判据逐个打坏，确认用例真的变红。
 *
 * 🔴 为什么不用 `execFileSync`：本机从 node 派生 node 会返回 `status=null`
 * （spawn 失败，不是"用例变红"）⇒ 靠它做变异验证会得到假结果。
 * 这里在**同一进程内**变异 → 重跑同一批判据 → 还原：
 * 靠 specifier 上的 `?bust=` 破除 ESM 缓存，拿到改动后的模块。
 *
 * 用法: node dev/mutate-page-session.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/page-session.ts'
const original = readFileSync(FILE, 'utf8')

const mutations = [
  {
    id: 1,
    why: '写一个没有来源的键（__appKit_userInfo）',
    from: '  return writes\n}',
    to: "  writes.push({ key: '__appKit_userInfo', value: '{}' })\n  return writes\n}",
  },
  {
    id: 2,
    why: '去掉"读回来核对"（verified 永远为空 ⇒ 静默失败看不见）',
    from: "    'var verified={};' +\n    'for(var j=0;j<written.length;j++){try{verified[written[j]]=localStorage.getItem(written[j]);}catch(e){verified[written[j]]=null;}}' +\n",
    to: "    'var verified={};' +\n",
  },
  {
    id: 3,
    why: 'CDP 不要求 returnByValue（拿不到页面返回值）',
    from: '    returnByValue: true,\n  })',
    to: '  })',
  },
  {
    id: 4,
    why: '吞掉写入异常（不做失败隔离）',
    from: 'catch(e){failed.push(writes[i].key);}',
    to: 'catch(e){}',
  },
  {
    id: 5,
    why: 'token 不做 Bearer 校验（把 Basic 也当 token）',
    from: "const bearer = /^Bearer\\s+(.+)$/i.exec(authorization.trim())",
    to: 'const bearer = authorization.trim() ? /^(.+)$/i.exec(authorization.trim()) : null',
  },
  {
    id: 6,
    why: '签名在"尝试前"就置位（一次瞬时失败 ⇒ 永远不再重试）',
    from: '  slot.installing = signature\n  try {',
    to: '  slot.installing = signature\n  slot.signature = signature\n  try {',
  },
  {
    id: 7,
    why: '装成功后不记签名（同一签名被反复安装 + 反复重载页面）',
    from: '    slot.signature = signature\n    const bindingsOk = await effects.afterInstall()',
    to: '    const bindingsOk = await effects.afterInstall()',
  },
]

let bust = 0
async function runChecks() {
  process.env.DSH_PAGE_SESSION_BUST = `mut${++bust}`
  // 测试模块本身也要换 specifier，否则它内部那次 import 还是老模块。
  const testMod = await import(`../tests/check-page-session.mjs?run=${bust}`)
  return testMod.runChecks({ quiet: true })
}

const baseline = await runChecks()
console.log('=== 基线 ===')
if (baseline.length) {
  console.log('基线就红了 ❌')
  for (const f of baseline) console.log(' ', f)
  process.exit(1)
}
console.log('全部通过 OK')

let allCaught = true
for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`\n#${m.id} ⚠️ 变异没写进去（锚点找不到）—— 这条不算数`)
    allCaught = false
    continue
  }
  writeFileSync(FILE, original.replace(m.from, m.to))
  let red = []
  try {
    red = await runChecks()
  } finally {
    writeFileSync(FILE, original)
  }
  if (red.length === 0) {
    console.log(`\n#${m.id} → 仍全绿 ❌ 虚守卫：${m.why}`)
    allCaught = false
  } else {
    console.log(`\n#${m.id} → 变红 ✅ (${m.why})`)
    for (const line of red.slice(0, 2)) console.log('   ', line)
  }
}

const after = await runChecks()
console.log('\n=== 还原后 ===')
if (after.length) {
  console.log('还原失败 ❌')
  for (const f of after) console.log(' ', f)
  process.exit(1)
}
console.log('全部通过 OK')
console.log(
  allCaught
    ? `\n结论：${mutations.length} 处判据全部被真实守住 ✅`
    : '\n结论：有虚守卫 ❌',
)
