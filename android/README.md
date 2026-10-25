# DSH Web API · Android

把 [cv-superding/dsh-deepseek-web-login](https://github.com/cv-superding/dsh-deepseek-web-login) 的
**DeepSeek 网页端协议**移植成一个单体 APK：手机本地跑 HTTP 服务，对外提供 **OpenAI 兼容 API**。

不是反代，也不是 DOM 自动化：和上游一样，**自己构造请求打网页端私有接口**，PoW 挑战在真实页面里用官方
SHA3 WASM 求解，请求由 WebView 的页面 `fetch` 发出（TLS/HTTP2 指纹、cookie、`x-hif-*` 反爬头与真实浏览器一致）。

## 模块对应关系

| 上游（TypeScript） | 本工程（Java） | 说明 |
| --- | --- | --- |
| `src/protocol.ts` | `Protocol.java` / `Filters.java` | 提示词序列化、工具目录、工具调用协议、流式过滤器（工具块捕获 / 免责声明 / 系统标记 / 历史回放守卫） |
| `src/webapi.ts` | `assets/dsh.js` + `Engine.java` | `create_pow_challenge` → 页面内 WASM 求解 → `chat_session/create` → `chat/completion`（SSE patch 流解析） |
| `src/browser-transport.ts` | `Engine.java` | 上游用 CDP 驱动 Edge/Chrome 发请求；APK 里等价物就是常驻 WebView 的页面 fetch |
| `src/adapter.ts` | `Runner.java` + `OpenAi.java` | 流事件映射、自动续写、错误分类、失败换号、usage 估算；对外换成 OpenAI 的 chunk 语义 |
| `src/gate.ts` | `Gate.java` | 串行/FIFO + 区间随机间隔（从上次调用**结束**起算） |
| `src/context-feed.ts` | `Runner.java`（Slot） | 全量 / 链式投喂、会话复用轮数、严格追加判定 |
| `src/accounts.ts` / `auth.ts` / `cookies.ts` | `Auth.java` | 账号库（token/cookie/hif/UA/extraHeaders）、探活、失效判据、限流窗口、cookie 过期构成 |
| `src/usage.ts` | `Usage.java` | 按本地日期 JSONL 记账 + 30 天聚合（只记元数据，不记对话） |
| 设置页 7 个标签 | `assets/console.html` | 手机端改成侧边栏抽屉：仪表盘 / 账号 / 模型 / 防风控 / 上下文 / 外观 / 日志 |

## 关键移植点（与上游一致的行为）

- **PoW 必须在页面内解**：`dsh.js` 用页面自己的 `sha3_wasm_bg*.wasm` 求解；不在 Java 侧算（上游明确把
  Node 侧解挑战列为封号触发条件）。
- **请求头**：只发真实浏览器会发的头（`authorization` / `x-client-*` / `x-device-id` / `x-hif-*` / `origin` / `referer`），
  绝不加任何"自报家门"的头。
- **会话策略**：按「模型 + 首条用户消息」做槽位；链式模式下 `parent_message_id` 接上一条回答的 `message_id`，
  只在严格追加时发增量，否则退回全量；会话攒批清理（6~10 个或 60~120 秒，删除间隔 0.8~2.5 秒随机）。
- **节流**：默认串行 + 2~4 秒随机间隔；并发生成会被网页端拒绝，实测几分钟就会触发 1 天限制。
- **体量阀门**：单次 prompt 默认 40 万字符（可调 12 万~150 万），刻意不顶格 1M。
- **工具调用**：`dsh-tool` 围栏 + `{"tool_calls":[...]}` 协议，流式过滤器保证调用块绝不漏进正文；
  解析失败按「历史回放 / 被截断 / 格式无法解析」分档丢弃。
- **自动续写**：回答停在句中或被服务端截断时自动再发一轮，拼进同一条回答（默认最多 2 轮）。

## 使用

1. 安装 APK，打开 App → 会请求通知权限（前台服务通知）。
2. 侧边栏「外观 → 保活」：给「电池优化白名单」和「悬浮窗权限」授权（悬浮球和后台执行引擎都要它）。
3. 切到「网页版」页签 → 登录 `chat.deepseek.com`（账号可能有短信验证）。
4. 回到「账号」页 → 点「捕获登录态」。之后所有请求只带该账号的 Bearer token。
5. 客户端填 `http://手机IP:8787/v1`，API Key 默认 `sk-dshweb`（可在「外观 → 接口」里改）。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-dshweb" \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

模型：`deepseek-chat`（thinking 关）/ `deepseek-reasoner`（thinking 开，思考走 `delta.reasoning_content`）/ `deepseek-web`（别名）。
`max_tokens`、`temperature`、`stop` 会被忽略（网页端没有这些字段）。

## 构建

```bash
cd android
gradle :app:assembleRelease
```

CI 见 `.github/workflows/android.yml`：构建 → 模拟器冒烟（`/health`、`/v1/models` 断言）→ tag `apk-*` 时发 Release。

## v1.1.x 修复记录（真机反馈驱动）

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 登录后「捕获」失败 | 捕获依赖 `localStorage.userToken` 的固定键名/结构；注入时机在 `onPageFinished`，页面自己的请求早发完了 | 注入提前到 `onPageStarted`；hook `fetch`/`XHR` 抓 `Authorization`；`capture` 依次尝试 `userToken`／`token`／`access_token`／hook 缓存；**登录成功后页面自动上报**，根本不用点捕获 |
| 进网页版后卡死、切不回控制台 | 引擎 WebView 切回时仍盖在 console 上（看不见但吃掉所有点击）→ 白屏／点不动 | 主界面放一个 1×1、屏幕外的 holder，切回控制台时把 WebView 挪进去（仍可执行 JS） |
| 点任何东西整个 App 卡死／崩溃 | **JavaBridge 单线程死锁**：`@JavascriptInterface` 方法里同步 `Engine.call()` 等回调，而回调也要 JavaBridge 线程才能送达 | bridge 线程只做分发；业务回调走 DISPATCH 单线程；主动调用走独立 CALLS 线程池；界面侧全部改成 `callAsync` + 事件回推（`__ev`） |
| 面板越用越卡 | 每次刷新都重算 30 天用量 JSONL | 用量聚合缓存 60s，状态快照缓存 1.5s，刷新降频到 5s |
| 日志页白屏 | 空日志时 pre 只有背景色 | 空态文案 + 最小高度 + 深色下的文字色 |

## 新增的移植能力（v1.1）

- **图片输入**：`POST /api/v0/file/upload_file`（multipart + 独立 PoW），拿到 `file_id` 后按 `ref_file_ids` 引用；同一张图内容寻址缓存，不重复上传；按 `maxRefImages` 只发最近 N 张。
- **账号分组**：`groups.json` 只存 `{id,name}`，账号只存 `groupId` 指针；删组不删账号（落回未分组）。
- **诊断页**：四项零额度自检（页面脚本 / 鉴权 `users/current` / PoW 求解 / 建会话），失败直接给原因。
- **服务端档位探测**：`GET /api/v0/client/settings?scope=model`，列出 model_configs 的 enabled/switchable 与 `input_character_limit`、附件 token 预算。
- **会话槽持久化**（等价上游 `resume-state.json`）：`slots.json` 存 sessionId/parentMessageId/前缀长度+hash，重启后仍能链式续写。
- **cookie 写入**：`am start --es cookie "<cookie>"` 或页面里粘贴，直接灌进 WebView 的 CookieManager。

## 已知限制

- 网页端账号密码登录可能触发**短信二次验证**，因此登录这一步是人工的（APK 里就是那个「网页版」页签）。
- 引擎依赖 WebView 存活；系统把进程冻结时请求会失败（保活三件套：前台服务 + WakeLock + JobScheduler + 电池白名单）。
- 逆向网页端违反服务条款。上游那些"降低机器可识别性"的调整只能降低概率，不构成不被封的保证。
