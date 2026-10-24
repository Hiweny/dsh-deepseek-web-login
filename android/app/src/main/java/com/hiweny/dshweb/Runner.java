package com.hiweny.dshweb;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 一轮生成的编排器（移植自上游 src/adapter.ts 的 streamImpl + webapi.ts 的 streamWebCompletion）：
 *   选账号 → 闸门 → 序列化 prompt → 会话复用/链式投喂 → 页面流式请求
 *   → 过滤器（工具调用/免责声明/系统标记/历史回放）→ 自动续写 → 用量记账
 */
public final class Runner {

    public interface Sink {
        void onText(String delta);

        void onThinking(String delta);

        void onToolCall(String id, String name, String args);

        void onFinish(String reason);

        void onUsage(long input, long output, boolean server);

        void onError(String code, String msg, long retryAfterMs);
    }

    public static final class Req {
        public String model = "deepseek-chat";
        public String system = "";
        public JSONArray messages = new JSONArray();
        public JSONArray tools = new JSONArray();
        public boolean thinking;
        public boolean search;
        public String purpose = "chat";
        public boolean allowAutoContinue = true;
        public String slotKey = "";
        public volatile boolean cancelled = false;
    }

    // ── 会话槽（复用 + 链式投喂）──────────────────────────────
    private static final class Slot {
        String sessionId;
        String accountId;
        String lastPrompt = "";
        String lastMessageId = "";
        int turns;
        long updatedAt;
    }

    private static final int MAX_SLOTS = 8;
    private static final Map<String, Slot> SLOTS = Collections.synchronizedMap(
            new LinkedHashMap<String, Slot>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Slot> eldest) {
                    if (size() > MAX_SLOTS) {
                        recycle(eldest.getValue());
                        return true;
                    }
                    return false;
                }
            });

    private static final List<String> CLEANUP = Collections.synchronizedList(new ArrayList<>());
    private static volatile long cleanupFirstAt = 0;

    private Runner() {
    }

    static void recycle(Slot s) {
        if (s != null && s.sessionId != null) {
            CLEANUP.add(s.sessionId);
            if (cleanupFirstAt == 0) cleanupFirstAt = System.currentTimeMillis();
        }
    }

    public static String stat() {
        synchronized (SLOTS) {
            int turns = 0;
            for (Slot s : SLOTS.values()) turns += s.turns;
            return "会话槽=" + SLOTS.size() + " 复用轮=" + turns + " 待清理=" + CLEANUP.size();
        }
    }

    /** 清理线程（由服务每分钟调一次）。 */
    public static void tick() {
        String mode = Cfg.sessionCleanup();
        if ("keep".equals(mode)) {
            CLEANUP.clear();
            return;
        }
        if (CLEANUP.isEmpty()) return;
        boolean go;
        if ("immediate".equals(mode)) {
            go = true;
        } else {
            int batch = Cfg.cleanupBatchMin()
                    + (int) (Math.random() * Math.max(1, Cfg.cleanupBatchMax() - Cfg.cleanupBatchMin() + 1));
            int delay = Cfg.cleanupDelayMinMs()
                    + (int) (Math.random() * Math.max(1, Cfg.cleanupDelayMaxMs() - Cfg.cleanupDelayMinMs()));
            long waited = System.currentTimeMillis() - cleanupFirstAt;
            go = CLEANUP.size() >= batch || waited >= delay;
        }
        if (!go) return;
        List<String> batch = new ArrayList<>();
        synchronized (CLEANUP) {
            for (int i = 0; i < CLEANUP.size() && batch.size() < 8; i++) batch.add(CLEANUP.get(i));
            for (String id : batch) CLEANUP.remove(id);
        }
        cleanupFirstAt = CLEANUP.isEmpty() ? 0 : System.currentTimeMillis();
        for (String sid : batch) {
            try {
                Auth.Rec acc = Auth.active();
                JSONObject a = new JSONObject();
                a.put("sessionId", sid);
                if (acc != null) {
                    a.put("token", acc.token);
                    a.put("deviceId", acc.deviceId);
                    a.put("omitCookie", true);
                }
                Engine.call("sessionDelete", a, 20000);
            } catch (Exception ignored) {
            }
            int gapMin = Cfg.cleanupGapMinMs(), gapMax = Cfg.cleanupGapMaxMs();
            try {
                Thread.sleep(gapMin + (long) (Math.random() * Math.max(1, gapMax - gapMin)));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        App.Lg.i("已清理网页端会话 " + batch.size() + " 个（" + mode + "）");
    }

    // ── 主流程 ───────────────────────────────────────────────
    public static void run(Req req, Sink sink) {
        long t0 = System.currentTimeMillis();
        Auth.Rec acc = Auth.active();
        if (acc == null || !acc.usable()) {
            sink.onError("MISSING_CREDENTIAL", "没有可用的登录态：请在「账号」页登录 chat.deepseek.com", 0);
            return;
        }
        String stale = Auth.isStaleAuth(acc);
        if (stale != null) {
            Auth.Rec alt = Auth.nextUsable(acc.id);
            if (alt != null) {
                Auth.setActive(alt.id);
                acc = alt;
                App.Lg.i("当前账号失效，已自动切到 " + acc.id);
            } else {
                sink.onError("AUTH", "账号登录态已失效（" + stale + "），本次请求没有发出", 0);
                return;
            }
        }

        int maxRounds = Cfg.autoContinue() && req.allowAutoContinue ? Cfg.maxContinuations() : 0;
        int rounds = 0;
        StringBuilder collected = new StringBuilder();
        long outChars = 0;
        boolean toolEmitted = false;
        String finishReason = "stop";
        String lastErr = "";
        long inTokens = 0;

        // 自动换号：每轮最多换 1 次
        int failovers = 0;
        // 首次只带 Bearer token（不带 cookie）：多账号时不会出现「cookie 是 A、token 是 B」。
        // 若被拒，再用页面自己的 cookie 重试一次（有些账号/节点只认 cookie 上下文）。
        boolean omitCookie = true;
        boolean triedCookie = false;

        while (true) {
            Gate.Release release = null;
            try {
                release = Gate.acquire(req.purpose);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                sink.onError("ABORTED", "请求被取消", 0);
                return;
            }
            try {
                acc = Auth.active() == null ? acc : Auth.active();
                Protocol.Parts parts = buildParts(req, acc, rounds, collected);
                inTokens += Usage.estimateTokens(parts.full);
                String sessionId = null;
                String parent = null;
                String prompt = parts.full;
                Slot slot = req.slotKey.isEmpty() ? null : SLOTS.get(req.slotKey);
                boolean chained = false;

                if (slot != null && slot.accountId.equals(acc.id) && Cfg.sessionReuseTurns() > 0
                        && "chained".equals(Cfg.contextMode())
                        && slot.turns < Cfg.sessionReuseTurns()
                        && !slot.lastMessageId.isEmpty()
                        && parts.full.startsWith(slot.lastPrompt)) {
                    prompt = parts.full.substring(slot.lastPrompt.length());
                    parent = slot.lastMessageId;
                    sessionId = slot.sessionId;
                    chained = true;
                } else if (slot != null) {
                    recycle(slot);
                    SLOTS.remove(req.slotKey);
                }

                JSONObject args = new JSONObject();
                args.put("token", acc.token);
                args.put("deviceId", acc.deviceId == null ? "" : acc.deviceId);
                args.put("omitCookie", omitCookie);
                args.put("prompt", prompt);
                args.put("thinking", req.thinking);
                args.put("search", req.search);
                args.put("modelType", "default");
                args.put("parentMessageId", parent == null ? JSONObject.NULL : parent);
                if (sessionId != null) args.put("sessionId", sessionId);
                args.put("deleteAfter", "immediate".equals(Cfg.sessionCleanup()));

                final String rid = "s" + Long.toHexString(System.nanoTime());
                final StreamAcc sa = new StreamAcc(sink, req);
                Engine.stream(rid, "completion", args, (type, ev) -> sa.onEvent(type, ev));

                while (!sa.done && !req.cancelled) {
                    Thread.sleep(120);
                }
                if (req.cancelled) {
                    Engine.cancel(rid);
                    sink.onError("ABORTED", "请求被取消", 0);
                    return;
                }

                if (sa.errorCode != null) {
                    lastErr = sa.errorMsg;
                    Auth.markVerifyError(acc, sa.errorMsg);
                    boolean retryable = "TRANSPORT".equals(sa.errorCode) || "RATE_LIMIT".equals(sa.errorCode)
                            || "AUTH".equals(sa.errorCode) || "PROVIDER".equals(sa.errorCode);
                    if ("AUTH".equals(sa.errorCode) && omitCookie && !triedCookie) {
                        triedCookie = true;
                        omitCookie = false;
                        App.Lg.i("仅 token 被拒，改用页面 cookie 重试");
                        continue;
                    }
                    if ("AUTH".equals(sa.errorCode) && failovers < 1) {
                        Auth.Rec alt = Auth.nextUsable(acc.id);
                        if (alt != null) {
                            failovers++;
                            Auth.setActive(alt.id);
                            App.Lg.i("鉴权失败，换号重试: " + alt.id);
                            continue;
                        }
                    }
                    if ("RATE_LIMIT".equals(sa.errorCode) && failovers < 1) {
                        Auth.Rec alt = Auth.nextUsable(acc.id);
                        if (alt != null && Cfg.autoSwitchMinutes() > 0) {
                            failovers++;
                            Auth.setActive(alt.id);
                            continue;
                        }
                        Auth.markLimit(acc, System.currentTimeMillis() + Math.max(60000, sa.retryAfterMs));
                    }
                    if (!retryable || rounds > maxRounds) {
                        Usage.note(acc.id, req.purpose, req.model, false, inTokens, 0, null);
                        sink.onError(sa.errorCode, sa.errorMsg, sa.retryAfterMs);
                        return;
                    }
                    sink.onError(sa.errorCode, sa.errorMsg, sa.retryAfterMs);
                    return;
                }

                // 成功：记账 + 会话槽
                toolEmitted = toolEmitted || sa.toolCalls > 0;
                outChars += sa.textOut.length() + sa.thinkOut.length();
                collected.append(sa.textOut);
                finishReason = sa.finishReason;
                Auth.markVerified(acc);
                long outTokens = (long) Math.ceil(outChars / 3.2);
                Usage.note(acc.id, req.purpose, req.model, true, inTokens, outTokens, null);

                if (!req.slotKey.isEmpty()) {
                    Slot ns = SLOTS.get(req.slotKey);
                    if (ns == null) {
                        ns = new Slot();
                        SLOTS.put(req.slotKey, ns);
                    }
                    ns.sessionId = sa.sessionId;
                    ns.accountId = acc.id;
                    ns.lastPrompt = parts.full;
                    ns.lastMessageId = sa.messageId;
                    ns.turns = chained ? ns.turns + 1 : 1;
                    ns.updatedAt = System.currentTimeMillis();
                }

                if (toolEmitted) {
                    sink.onUsage(inTokens, outTokens, false);
                    sink.onFinish("tool_calls");
                    App.Lg.i("完成[工具] " + (System.currentTimeMillis() - t0) + "ms 正文字=" + sa.textOut.length());
                    return;
                }

                boolean mid = Protocol.looksMidSentence(sa.textOut.toString());
                boolean cut = sa.finishReason == null || sa.finishReason.isEmpty();
                if (rounds < maxRounds && (mid || cut) && sa.textOut.length() > 0) {
                    rounds++;
                    App.Lg.i("回答中断（mid=" + mid + " cut=" + cut + "），自动续写第 " + rounds + " 轮");
                    continue;
                }

                sink.onUsage(inTokens, outTokens, false);
                sink.onFinish("stop");
                App.Lg.i("完成 " + (System.currentTimeMillis() - t0) + "ms 正文=" + sa.textOut.length()
                        + " 思考=" + sa.thinkOut.length() + " 槽=" + stat());
                return;
            } catch (Exception e) {
                lastErr = String.valueOf(e);
                App.Lg.e("Runner 异常: " + e);
                sink.onError("TRANSPORT", lastErr, 0);
                return;
            } finally {
                if (release != null) release.release();
            }
        }
    }

    private static Protocol.Parts buildParts(Req req, Auth.Rec acc, int rounds, StringBuilder collected) {
        JSONArray msgs = new JSONArray();
        for (int i = 0; i < req.messages.length(); i++) msgs.put(req.messages.opt(i));
        if (rounds > 0) {
            try {
                JSONObject a = new JSONObject();
                a.put("role", "assistant");
                a.put("content", collected.toString());
                msgs.put(a);
                JSONObject u = new JSONObject();
                u.put("role", "user");
                u.put("content", Protocol.CONTINUE_INSTRUCTION);
                msgs.put(u);
            } catch (Exception ignored) {
            }
        }
        return Protocol.serialize(req.system, msgs, req.tools, Cfg.maxPromptChars(), Cfg.serialToolCalls());
    }

    // ── 流累加器（含过滤器与自动续写判定所需状态）─────────────
    private static final class StreamAcc {
        final Sink sink;
        final Req req;
        final Filters.ToolCallFilter tools = new Filters.ToolCallFilter();
        final Filters.Boilerplate boiler = new Filters.Boilerplate();
        final Filters.SystemMarker marker = new Filters.SystemMarker();
        final Filters.EchoGuard echo = new Filters.EchoGuard();
        final StringBuilder textOut = new StringBuilder();
        final StringBuilder thinkOut = new StringBuilder();
        volatile boolean done = false;
        volatile String errorCode = null;
        volatile String errorMsg = "";
        volatile long retryAfterMs = 0;
        volatile String sessionId = "";
        volatile String messageId = "";
        volatile String finishReason = "stop";
        volatile int toolCalls = 0;

        StreamAcc(Sink sink, Req req) {
            this.sink = sink;
            this.req = req;
        }

        void onEvent(String type, JSONObject ev) {
            try {
                if ("error".equals(type)) {
                    errorCode = ev.optString("code", "TRANSPORT");
                    errorMsg = ev.optString("msg", "请求失败");
                    retryAfterMs = ev.optLong("retryAfterMs", 0);
                    done = true;
                    return;
                }
                if ("ready".equals(type)) {
                    sessionId = ev.optString("sid", sessionId);
                    return;
                }
                if ("thinking".equals(type)) {
                    String v = ev.optString("v");
                    if (v.isEmpty()) return;
                    String clean = Filters.stripStrayToolMarkup(v);
                    if (!clean.isEmpty()) {
                        thinkOut.append(clean);
                        sink.onThinking(clean);
                    }
                    return;
                }
                if ("thinking_reset".equals(type)) {
                    return;
                }
                if ("text".equals(type)) {
                    pushText(ev.optString("v"));
                    return;
                }
                if ("text_reset".equals(type)) {
                    return;
                }
                if ("end".equals(type)) {
                    sessionId = ev.optString("sid", sessionId);
                    messageId = String.valueOf(ev.opt("mid"));
                    if ("0".equals(messageId) || "null".equals(messageId)) messageId = "";
                    finishReason = ev.optString("status", "stop");
                    if ("FINISHED".equals(finishReason)) finishReason = "stop";
                    close();
                }
            } catch (Exception e) {
                App.Lg.e("StreamAcc: " + e);
                errorCode = "TRANSPORT";
                errorMsg = String.valueOf(e);
                done = true;
            }
        }

        private void pushText(String chunk) {
            if (chunk == null || chunk.isEmpty()) return;
            Filters.Out fo = tools.push(chunk);
            String a = marker.push(fo.text == null ? "" : fo.text);
            String b = boiler.push(a);
            String c = echo.push(b);
            if (c != null && !c.isEmpty()) {
                textOut.append(c);
                sink.onText(c);
            }
            for (Filters.Call call : fo.calls) {
                toolCalls++;
                sink.onToolCall(call.id, call.name, call.arguments);
            }
            if (fo.rejected != null) App.Lg.w("工具调用被丢弃: " + fo.rejected);
        }

        private void close() {
            Filters.Out fo = tools.flush();
            String a = marker.push(fo.text == null ? "" : fo.text);
            String b = boiler.push(a);
            String c = echo.push(b);
            String tail = (c == null ? "" : c) + marker.flush() + boiler.flush() + echo.flush();
            for (Filters.Call call : fo.calls) {
                toolCalls++;
                sink.onToolCall(call.id, call.name, call.arguments);
            }
            if (!tail.isEmpty()) {
                textOut.append(tail);
                sink.onText(tail);
            }
            done = true;
        }
    }

    public static String slotsDump() {
        JSONArray arr = new JSONArray();
        synchronized (SLOTS) {
            for (Map.Entry<String, Slot> e : SLOTS.entrySet()) {
                JSONObject o = new JSONObject();
                try {
                    o.put("key", e.getKey().length() > 24 ? e.getKey().substring(0, 24) : e.getKey());
                    o.put("sid", Auth.shortId(e.getValue().sessionId));
                    o.put("turns", e.getValue().turns);
                    o.put("mode", "chained".equals(Cfg.contextMode()) ? "chained" : "full");
                } catch (Exception ignored) {
                }
                arr.put(o);
            }
        }
        return arr.toString();
    }

    public static void resetSlots() {
        synchronized (SLOTS) {
            for (Slot s : SLOTS.values()) recycle(s);
            SLOTS.clear();
        }
    }
}
