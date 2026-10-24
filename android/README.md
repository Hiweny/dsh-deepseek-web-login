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

## 已知限制

- 网页端账号密码登录可能触发**短信二次验证**，因此登录这一步是人工的（APK 里就是那个「网页版」页签）。
- 引擎依赖 WebView 存活；系统把进程冻结时请求会失败（保活三件套：前台服务 + WakeLock + JobScheduler + 电池白名单）。
- 逆向网页端违反服务条款。上游那些"降低机器可识别性"的调整只能降低概率，不构成不被封的保证。
