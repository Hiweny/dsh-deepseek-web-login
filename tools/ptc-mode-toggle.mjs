#!/usr/bin/env node
/**
 * PTC（Code Mode）开关：给指定 agent preset 加 / 去 `tool-presentation` 行。
 *
 * ## 它是什么
 * DSH 的工具呈现模式（`@deepseek-ai/dsh-agent-tool-presentation` 的 `config.mode`）：
 *  - `native`（缺省）：每个工具各自出现在提示词的工具目录里，模型逐个调用；
 *  - `ptc`：所有工具**塌缩成一份 SDK 声明 + 唯一可直接调用的 `run_code`**，模型写代码调工具。
 *
 * `ptc` 就是 cuckoo 那套做法，官方已实现并有内置 preset：
 * `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`（其中正是 `config: { mode: ptc }`）。
 * 运行时 `@deepseek-ai/dsh-ptc-runtime-node` 挂在 base bundle，本机已具备。
 *
 * ## 为什么不是"直接改"
 * ⚠️ 切到 ptc 会**改变 agent 的工具调用形态**（模型必须写代码，不能再单独调用某个工具），
 * 影响该 preset 下的**所有**会话。所以这里做成显式开关 + 备份，而不是默认改掉。
 *
 * ## 用法
 *   node tools/ptc-mode-toggle.mjs status
 *   node tools/ptc-mode-toggle.mjs apply liangshen
 *   node tools/ptc-mode-toggle.mjs revert
 *
 * ⚠️ 改完必须**重启 DSH**（profile 的 cordis.patch.yml 只在启动时读）。
 * ⚠️ 这是**本机 profile** 的操作，与插件本身无关 —— 插件侧不需要任何改动。
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const PROFILE = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop')
const PATCH = join(PROFILE, 'cordis.patch.yml')

/**
 * 生成要插入的行。**缩进必须按目标 preset 现成的同级行来定** —— 不同 preset 不一样：
 * `pj-mode` 的 plugins 行是 10 空格，`liangshen` 是 6 空格。
 * 写死过一次，结果产出非法 YAML（被下面的校验抓住）。
 */
function rowFor(indent) {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 2)
  const deeper = ' '.repeat(indent + 4)
  return [
    `${pad}- id: tool-presentation`,
    `${inner}name: '@deepseek-ai/dsh-agent-tool-presentation'`,
    `${inner}config:`,
    `${deeper}mode: ptc`,
  ]
}

/**
 * 用 profile 自带的 js-yaml 解析一遍。`!!js` 不是标准标签，得自己注册。
 * `js-yaml` 装在 profile 的 node_modules 里，所以从 profile 的 package.json 解析。
 *
 * 🔴 **这一步是必须的**：它抓到过"缩进写死"导致的非法 YAML。
 * 手工拼 YAML 不做校验 = 下次 DSH 启动直接起不来，而且报错信息离现场很远。
 */
function assertParseable(text) {
  let yaml
  const candidates = [
    join(PROFILE, 'package.json'),
    join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json'),
    new URL('./package.json', import.meta.url).pathname,
  ]
  for (const anchor of candidates) {
    try {
      yaml = createRequire(anchor)('js-yaml')
      break
    } catch { /* 换下一个锚点 */ }
  }
  if (!yaml) {
    // ⚠️ 校验是**强制**的：拼 YAML 却不校验 = 下次 DSH 起不来，且报错离现场很远。
    // 找不到依赖就是环境问题，不该降级成"跳过"。
    throw new Error('拿不到 js-yaml（profile / ~/.dsh/profiles/desktop 都找不到）—— 拒绝在无校验的情况下改这个文件')
  }
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  yaml.load(text, { schema }) // 抛错就说明改坏了
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!existsSync(PATCH)) fail(`找不到 profile 覆盖文件：${PATCH}`)

const mode = process.argv[2] ?? 'status'
const lines = () => readFileSync(PATCH, 'utf8').split('\n')

/** 找一个 preset 块的边界与它 plugins 行的缩进。 */
function locate(all, presetId) {
  const startPattern = new RegExp(`^\\s*- id: preset-${presetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  let start = -1
  for (let i = 0; i < all.length; i += 1) {
    if (startPattern.test(all[i])) { start = i; break }
  }
  if (start < 0) return null
  // 块边界：下一个 4 空格同级 `- id:` 或顶格 `- `
  let end = all.length
  for (let j = start + 1; j < all.length; j += 1) {
    if (/^    - id: /.test(all[j]) || /^- /.test(all[j])) { end = j; break }
  }
  // plugins: 之后的最小缩进才是同级 plugin 行（组内嵌套行缩进更深）
  let pluginsAt = -1
  for (let j = start; j < end; j += 1) {
    if (/^\s*plugins:\s*$/.test(all[j])) { pluginsAt = j; break }
  }
  let indent = null
  if (pluginsAt >= 0) {
    for (let j = pluginsAt + 1; j < end; j += 1) {
      const match = /^(\s*)- id: /.exec(all[j])
      if (!match) continue
      if (indent === null || match[1].length < indent) indent = match[1].length
    }
  }
  return { start, end, pluginsAt, indent }
}

/** 列出文件里声明的 preset 及其当前的 tool-presentation 状态。 */
function survey() {
  const all = lines()
  const out = []
  for (const match of all.map((line, index) => [line, index])) {
    if (!/^\s*- id: preset-\S+\s*$/.test(match[0])) continue
    const presetId = /- id: preset-(\S+)\s*$/.exec(match[0])[1]
    const spot = locate(all, presetId)
    const body = all.slice(spot.start, spot.end)
    const rowIndex = body.findIndex((line) => /^\s*- id: tool-presentation\s*$/.test(line))
    const modeLine = rowIndex >= 0
      ? body.slice(rowIndex, rowIndex + 6).find((line) => /mode:/.test(line))
      : undefined
    out.push({
      presetId,
      end: spot.end,
      indent: spot.indent,
      hasRow: rowIndex >= 0,
      mode: modeLine ? modeLine.split('mode:')[1].trim() : (rowIndex >= 0 ? '(未写 mode → 缺省 native)' : '-'),
    })
  }
  return out
}

if (mode === 'status') {
  console.log(`profile: ${PROFILE}`)
  const rows = survey()
  if (rows.length === 0) fail('这个文件里没有 preset 声明（`- id: preset-<name>`）')
  for (const row of rows) {
    console.log(`  ${row.presetId.padEnd(16)} tool-presentation=${row.hasRow ? '有' : '无'}  mode=${row.mode}`)
  }
  console.log('\n（mode=ptc 才是 Code Mode；无该行 = 缺省 native）')
  process.exit(0)
}

/** 本工具插入的那 4 行长这样，摘除时按这个形状严格匹配，不匹配就拒绝动手。 */
function isOurRowBlock(all, index) {
  const a = all[index]
  const b = all[index + 1]
  const c = all[index + 2]
  const d = all[index + 3]
  return (
    /^(\s*)- id: tool-presentation\s*$/.test(a ?? '')
    && /^\s*name: '@deepseek-ai\/dsh-agent-tool-presentation'\s*$/.test(b ?? '')
    && /^\s*config:\s*$/.test(c ?? '')
    && /^\s*mode:\s*\S+\s*$/.test(d ?? '')
  )
}

if (mode === 'revert') {
  // 🔴 故意**不**用"恢复最新备份"。踩过的坑：连续 apply 两个 preset 后有两个备份，
  // "恢复最新"只回退了一层，用户以为全撤了其实还剩一个 —— 留下的那份正是最容易被忽略的。
  // 改成**精确摘除本工具插入的块**：与"应用了几次"无关，也不会覆盖用户的其他改动。
  const all = lines()
  const hits = []
  for (let i = 0; i < all.length; i += 1) if (isOurRowBlock(all, i)) hits.push(i)
  if (hits.length === 0) {
    console.log('没有找到本工具插入的 tool-presentation 块（可能已经撤过，或格式被手工改过）。')
    console.log('若确认要整文件回退，请手工用备份：')
    const backups = readdirSync(PROFILE).filter((name) => name.startsWith('cordis.patch.yml.bak-ptc-')).sort()
    for (const name of backups) console.log(`  ${join(PROFILE, name)}`)
    process.exit(0)
  }
  const keep = all.filter((_, index) => !hits.some((start) => index >= start && index < start + 4))
  const text = keep.join('\n')
  try {
    assertParseable(text)
  } catch (error) {
    fail(`摘除后 YAML 解析失败，**未改动任何文件**：${error.message.split('\n')[0]}`)
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const backup = `cordis.patch.yml.bak-ptc-revert-${stamp}`
  copyFileSync(PATCH, join(PROFILE, backup))
  writeFileSync(PATCH, text)
  console.log(`已摘除 ${hits.length} 处 tool-presentation 块（改前快照：${backup}）`)
  console.log('⚠️ 重启 DSH 后生效。')
  process.exit(0)
}

if (mode !== 'apply') fail(`未知子命令：${mode}（status / apply <presetId> / revert）`)

const presetId = process.argv[3]
if (!presetId) {
  const rows = survey()
  fail([
    'apply 需要指定 presetId。当前文件里的 preset：',
    ...rows.map((row) => `  - ${row.presetId}（tool-presentation=${row.hasRow ? '有' : '无'}）`),
    '',
    `例：node tools/ptc-mode-toggle.mjs apply ${rows[0]?.presetId ?? '<presetId>'}`,
  ].join('\n'))
}

const all = lines()
const rows = survey()
const target = rows.find((row) => row.presetId === presetId)
if (!target) {
  fail(`没找到 preset "${presetId}"。可选：${rows.map((row) => row.presetId).join(' / ')}`)
}
if (target.hasRow) {
  console.log(`preset "${presetId}" 已经有 tool-presentation 行（mode=${target.mode}），无需重复添加。`)
  console.log('要改模式请手工编辑，或先 revert 再用 apply。')
  process.exit(0)
}
if (target.indent === null) {
  fail(`preset "${presetId}" 里找不到 plugins 列表（或列表为空），不敢猜缩进 —— 请手工加这一行。`)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const backup = `cordis.patch.yml.bak-ptc-${stamp}`
copyFileSync(PATCH, join(PROFILE, backup))
console.log(`备份：${backup}`)

const mutated = [...all]
mutated.splice(target.end, 0, ...rowFor(target.indent))
const mutatedText = mutated.join('\n')
try {
  assertParseable(mutatedText)
} catch (error) {
  copyFileSync(join(PROFILE, backup), PATCH)
  fail([
    `插入后 YAML 解析失败 ⇒ **已自动还原**，profile 未被改动。`,
    `原因：${error.message.split('\n')[0]}`,
    `（上次踩过的坑：把缩进写死成 10 空格，而 preset "${presetId}" 是 ${target.indent} 空格）`,
  ].join('\n'))
}
writeFileSync(PATCH, mutatedText)
console.log(`已在 preset "${presetId}" 的 plugins 列表末尾插入 tool-presentation（mode: ptc，缩进 ${target.indent}）`)
console.log('')
console.log('⚠️ 下一步：')
console.log('  1) 重启 DSH（profile 只在启动时读）')
console.log('  2) 切到该 preset 的会话试一轮，看工具调用是否变成写代码调 run_code')
console.log('  3) 想回滚：node tools/ptc-mode-toggle.mjs revert')
console.log('')
console.log('📌 量化提醒（别凭感觉）：')
console.log('  实测本插件在 37 个真机工具下的紧凑目录 = 12036 字符。')
console.log('  而官方 SDK 段是**带逐参数 JSDoc + 返回类型**的 TS 声明，信息量严格更多，')
console.log('  所以 head 很可能**变大**。PTC 省的不是目录体积，而是：')
console.log('  ① 每轮 chat 往返次数（一次 run_code 可调多个工具）② JSON 转义负担。')
