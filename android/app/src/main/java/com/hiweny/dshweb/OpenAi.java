package com.hiweny.dshweb;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

/**
 * OpenAI 兼容层（/v1/models、/v1/chat/completions、/v1/completions）+ 控制台用的状态接口。
 *
 * 对外语义与上游 dsh 的 provider 对齐：模型 id → (model_type=default, thinking_enabled)；
 * 工具调用走提示词协议，转发成标准 tool_calls；思考流走 delta.reasoning_content。
 */
public final class OpenAi {

    public static final String[] MODELS = {"deepseek-chat", "deepseek-reasoner", "deepseek-web"};

    private OpenAi() {
    }

    public static void route(HttpSrv.Req req, HttpSrv.Res res) throws Exception {
        String p = req.path;
        if ("/".equals(p) || "/health".equals(p) || "/v1/health".equals(p)) {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("service", "dsh-web-api");
            o.put("version", Ver.versionName());
            o.put("engine", Engine.state());
            o.put("accounts", Auth.stat());
            o.put("gate", Gate.stat());
            o.put("slots", Runner.stat());
            res.json().end(o.toString());
            return;
        }
        if ("/v1/models".equals(p) || "/models".equals(p)) {
            res.json().end(modelsJson());
            return;
        }
        if ("/v1/chat/completions".equals(p) || "/chat/completions".equals(p)) {
            handleChat(req, res);
            return;
        }
        if ("/v1/completions".equals(p)) {
            handleLegacyCompletion(req, res);
            return;
        }
        if ("/api/status".equals(p)) {
            res.json().end(statusJson().toString());
            return;
        }
        if ("/api/logs".equals(p)) {
            JSONObject o = new JSONObject();
            o.put("log", App.Lg.tail(24000));
            res.json().end(o.toString());
            return;
        }
        res.status(404).json().end("{\"error\":{\"message\":\"not found: " + req.path + "\",\"type\":\"invalid_request_error\"}}");
    }

    static String modelsJson() {
        JSONArray data = new JSONArray();
        for (String id : MODELS) {
            JSONObject m = new JSONObject();
            try {
                m.put("id", id);
                m.put("object", "model");
                m.put("owned_by", "deepseek-web");
                m.put("created", 1700000000);
                m.put("context_window", Cfg.contextWindow());
                data.put(m);
            } catch (Exception ignored) {
            }
        }
        JSONObject o = new JSONObject();
        try {
            o.put("object", "list");
            o.put("data", data);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    static JSONObject statusJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("version", Ver.versionName());
            o.put("engine", Engine.state());
            o.put("engineOverlay", Engine.hasOverlay());
            o.put("port", Cfg.port());
            o.put("accounts", Auth.views());
            o.put("activeId", Auth.activeId());
            o.put("gate", Gate.stat());
            o.put("slots", Runner.slotsDump());
            o.put("usage", Usage.summary());
            o.put("cfg", Cfg.snapshot());
            o.put("stats", EngineService.stats());
            o.put("ua", Engine.userAgent);
        } catch (Exception ignored) {
        }
        return o;
    }

    private static boolean authorized(HttpSrv.Req req) {
        if (!Cfg.requireKey()) return true;
        String key = req.bearer();
        if (key.isEmpty()) key = req.header("x-api-key");
        return Cfg.apiKey().equals(key) || key.isEmpty() && !Cfg.requireKey();
    }

    // ── chat/completions ─────────────────────────────────────
    private static void handleChat(HttpSrv.Req req, HttpSrv.Res res) throws Exception {
        if (!"POST".equals(req.method)) {
            res.status(405).json().end("{\"error\":{\"message\":\"POST required\",\"type\":\"invalid_request_error\"}}");
            return;
        }
        JSONObject body = Json.parseObjOrNull(req.body);
        if (body == null) {
            res.status(400).json().end("{\"error\":{\"message\":\"invalid JSON body\",\"type\":\"invalid_request_error\"}}");
            return;
        }
        boolean stream = body.optBoolean("stream", false);
        String model = body.optString("model", "deepseek-chat");
        JSONArray messages = body.optJSONArray("messages");
        JSONArray tools = body.optJSONArray("tools");
        if (messages == null) messages = new JSONArray();

        Runner.Req r = new Runner.Req();
        r.model = model;
        r.tools = tools == null ? new JSONArray() : tools;
        r.thinking = resolveThinking(model, body);
        r.search = body.optBoolean("search", body.optBoolean("web_search", Cfg.defaultSearch()));

        StringBuilder sys = new StringBuilder();
        JSONArray conv = new JSONArray();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null) continue;
            String role = m.optString("role");
            if ("system".equals(role) || "developer".equals(role)) {
                String t = Protocol.flat(m.opt("content"));
                if (!t.isEmpty()) {
                    if (sys.length() > 0) sys.append("\n\n");
                    sys.append(t);
                }
            } else {
                conv.put(m);
            }
        }
        r.system = sys.toString();
        r.messages = conv;
        r.slotKey = slotKey(model, conv);
        r.purpose = "chat";

        String id = "chatcmpl-" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        long created = System.currentTimeMillis() / 1000;

        if (!Cfg.requireKey() || authorized(req)) {
            // ok
        } else {
            res.status(401).json().end("{\"error\":{\"message\":\"invalid api key\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}");
            return;
        }

        if (stream) {
            res.cors();
            res.beginStream("text/event-stream; charset=utf-8");
            sendSse(res, chunk(id, model, created, "{\"role\":\"assistant\",\"content\":\"\"}", null));
            final boolean[] first = {true};
            final long[] usage = new long[3];
            r.cancelled = false;
            Runner.run(r, new Runner.Sink() {
                @Override
                public void onText(String delta) {
                    try {
                        sendSse(res, chunk(id, model, created, "{\"content\":" + JSONObject.quote(delta) + "}", null));
                    } catch (Exception e) {
                        r.cancelled = true;
                    }
                }

                @Override
                public void onThinking(String delta) {
                    try {
                        sendSse(res, chunk(id, model, created, "{\"reasoning_content\":" + JSONObject.quote(delta) + "}", null));
                    } catch (Exception e) {
                        r.cancelled = true;
                    }
                }

                @Override
                public void onToolCall(String callId, String name, String args) {
                    try {
                        JSONObject fn = new JSONObject();
                        fn.put("name", name);
                        fn.put("arguments", args);
                        JSONObject tc = new JSONObject();
                        tc.put("index", 0);
                        tc.put("id", callId);
                        tc.put("type", "function");
                        tc.put("function", fn);
                        JSONObject delta = new JSONObject();
                        delta.put("tool_calls", new JSONArray().put(tc));
                        sendSse(res, chunk(id, model, created, delta.toString(), null));
                    } catch (Exception e) {
                        r.cancelled = true;
                    }
                }

                @Override
                public void onFinish(String reason) {
                    try {
                        String fr = "tool_calls".equals(reason) ? "tool_calls" : "stop";
                        sendSse(res, chunk(id, model, created, "{}", fr));
                        JSONObject u = new JSONObject();
                        JSONObject usageObj = new JSONObject();
                        usageObj.put("prompt_tokens", usage[0]);
                        usageObj.put("completion_tokens", usage[1]);
                        usageObj.put("total_tokens", usage[0] + usage[1]);
                        u.put("id", id);
                        u.put("object", "chat.completion.chunk");
                        u.put("created", created);
                        u.put("model", model);
                        u.put("choices", new JSONArray());
                        u.put("usage", usageObj);
                        sendSse(res, u.toString());
                        sendSse(res, "[DONE]");
                        res.finishStream();
                    } catch (Exception ignored) {
                    }
                }

                @Override
                public void onUsage(long input, long output, boolean server) {
                    usage[0] = input;
                    usage[1] = output;
                }

                @Override
                public void onError(String code, String msg, long retryAfterMs) {
                    try {
                        JSONObject e = new JSONObject();
                        JSONObject err = new JSONObject();
                        err.put("message", msg);
                        err.put("type", "provider_error");
                        err.put("code", code);
                        e.put("error", err);
                        sendSse(res, e.toString());
                        sendSse(res, "[DONE]");
                        res.finishStream();
                    } catch (Exception ignored) {
                    }
                }
            });
        } else {
            final StringBuilder text = new StringBuilder();
            final StringBuilder think = new StringBuilder();
            final JSONArray calls = new JSONArray();
            final long[] usage = new long[3];
            final String[] err = new String[2];
            final String[] finish = {"stop"};
            Runner.run(r, new Runner.Sink() {
                @Override
                public void onText(String delta) {
                    text.append(delta);
                }

                @Override
                public void onThinking(String delta) {
                    think.append(delta);
                }

                @Override
                public void onToolCall(String callId, String name, String args) {
                    try {
                        JSONObject fn = new JSONObject();
                        fn.put("name", name);
                        fn.put("arguments", args);
                        JSONObject tc = new JSONObject();
                        tc.put("id", callId);
                        tc.put("type", "function");
                        tc.put("function", fn);
                        calls.put(tc);
                    } catch (Exception ignored) {
                    }
                }

                @Override
                public void onFinish(String reason) {
                    finish[0] = reason;
                }

                @Override
                public void onUsage(long input, long output, boolean server) {
                    usage[0] = input;
                    usage[1] = output;
                }

                @Override
                public void onError(String code, String msg, long retryAfterMs) {
                    err[0] = code;
                    err[1] = msg;
                }
            });
            if (err[0] != null) {
                res.status("AUTH".equals(err[0]) ? 401 : "RATE_LIMIT".equals(err[0]) ? 429 : 502).json().end(errorJson(err[0], err[1]));
                return;
            }
            JSONObject msg = new JSONObject();
            msg.put("role", "assistant");
            msg.put("content", text.toString());
            if (think.length() > 0) msg.put("reasoning_content", think.toString());
            if (calls.length() > 0) msg.put("tool_calls", calls);
            JSONObject choice = new JSONObject();
            choice.put("index", 0);
            choice.put("message", msg);
            choice.put("finish_reason", calls.length() > 0 ? "tool_calls" : "stop");
            JSONObject out = new JSONObject();
            out.put("id", id);
            out.put("object", "chat.completion");
            out.put("created", created);
            out.put("model", model);
            out.put("choices", new JSONArray().put(choice));
            JSONObject u = new JSONObject();
            u.put("prompt_tokens", usage[0]);
            u.put("completion_tokens", usage[1]);
            u.put("total_tokens", usage[0] + usage[1]);
            out.put("usage", u);
            res.cors().json().end(out.toString());
        }
    }

    private static String errorJson(String code, String msg) {
        try {
            JSONObject err = new JSONObject();
            err.put("message", msg);
            err.put("type", "provider_error");
            err.put("code", code);
            JSONObject o = new JSONObject();
            o.put("error", err);
            return o.toString();
        } catch (Exception e) {
            return "{\"error\":{\"message\":\"error\"}}";
        }
    }

    private static String chunk(String id, String model, long created, String deltaJson, String finish) {
        try {
            JSONObject delta = new JSONObject(deltaJson);
            JSONObject choice = new JSONObject();
            choice.put("index", 0);
            choice.put("delta", delta);
            choice.put("finish_reason", finish == null ? JSONObject.NULL : finish);
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("object", "chat.completion.chunk");
            o.put("created", created);
            o.put("model", model);
            o.put("choices", new JSONArray().put(choice));
            return o.toString();
        } catch (Exception e) {
            return "{\"choices\":[]}";
        }
    }

    private static void sendSse(HttpSrv.Res res, String data) throws IOException {
        res.writeChunk("data: " + data + "\n\n");
    }

    private static boolean resolveThinking(String model, JSONObject body) {
        String effort = body.optString("reasoning_effort", "");
        if (!effort.isEmpty()) {
            if ("off".equalsIgnoreCase(effort) || "none".equalsIgnoreCase(effort)) return false;
            return true;
        }
        if (body.has("thinking")) return body.optBoolean("thinking", true);
        if (body.has("enable_thinking")) return body.optBoolean("enable_thinking", true);
        String m = model == null ? "" : model.toLowerCase(Locale.ROOT);
        if (m.contains("reasoner") || m.contains("pro") || m.contains("expert") || m.contains("think")) return true;
        return Cfg.defaultThinking();
    }

    private static void handleLegacyCompletion(HttpSrv.Req req, HttpSrv.Res res) throws Exception {
        JSONObject body = Json.parseObjOrNull(req.body);
        if (body == null) {
            res.status(400).json().end("{\"error\":{\"message\":\"invalid JSON body\"}}");
            return;
        }
        String prompt = body.optString("prompt", "");
        JSONArray msgs = new JSONArray();
        JSONObject u = new JSONObject();
        u.put("role", "user");
        u.put("content", prompt);
        msgs.put(u);
        body.put("messages", msgs);
        body.put("stream", false);
        String s = body.toString();
        HttpSrv.Req copy = new HttpSrv.Req(req.method, "/v1/chat/completions", "", req.headers, s, req.socket);
        handleChat(copy, res);
    }

    /** 会话槽 key：模型 + 首条用户消息内容（同一段对话的后续请求命中同一槽）。 */
    private static String slotKey(String model, JSONArray msgs) {
        String first = "";
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.optJSONObject(i);
            if (m == null) continue;
            if ("user".equals(m.optString("role"))) {
                first = Protocol.flat(m.opt("content"));
                break;
            }
        }
        return model + "|" + first.hashCode() + "|" + first.length();
    }

    public static String now() {
        return new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
    }
}
