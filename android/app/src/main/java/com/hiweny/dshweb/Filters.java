package com.hiweny.dshweb;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 流式过滤器（移植自上游 src/protocol.ts）：
 *  - {@link ToolCallFilter}   工具调用捕获（dsh-tool 围栏 / 裸 JSON / XML），绝不把调用块当正文
 *  - {@link Boilerplate}      剥网页端免责声明
 *  - {@link SystemMarker}     剥 <ds_system> / <system> / <ide_result_status>
 *  - {@link EchoGuard}        拦「历史回放」格式（[Tool Result …] / User: / Assistant: …）
 */
public final class Filters {

    public static final String WEB_DISCLAIMER = "本回答由 AI 生成，内容仅供参考，请仔细甄别";

    private Filters() {
    }

    // ── 工具调用 ─────────────────────────────────────────────
    public static final class Call {
        public String id;
        public String name;
        public String arguments = "{}";

        public Call(String id, String name, String arguments) {
            this.id = id;
            this.name = name;
            this.arguments = arguments == null ? "{}" : arguments;
        }
    }

    public static final class Out {
        public String text = "";
        public final List<Call> calls = new ArrayList<>();
        public boolean fenced = false;
        public String rejected;
    }

    public static final class ToolCallFilter {
        private static final int HOLD = 24;
        private static final int MAX_CAPTURE = 256 * 1024;
        private static final Pattern FENCE_OPEN = Pattern.compile("```[ \\t]*dsh-tool[ \\t]*\\n?", Pattern.CASE_INSENSITIVE);

        private final StringBuilder rest = new StringBuilder();
        private final StringBuilder cap = new StringBuilder();
        private boolean capturing = false;
        private boolean sawFence = false;
        private int callsInThisBlock = 0;

        public Out push(String chunk) {
            Out out = new Out();
            if (chunk == null || chunk.isEmpty()) return out;
            if (capturing) {
                cap.append(chunk);
                drainCapture(out, false);
                return out;
            }
            rest.append(chunk);
            scan(out);
            return out;
        }

        private void scan(Out out) {
            String s = rest.toString();
            int[] hit = findMarker(s);
            if (hit == null) {
                int keep = Math.min(HOLD, s.length());
                if (s.length() > keep) {
                    out.text = s.substring(0, s.length() - keep);
                    rest.setLength(0);
                    rest.append(s.substring(s.length() - keep));
                }
                return;
            }
            int idx = hit[0];
            String before = s.substring(0, idx);
            if (before.length() > 0) out.text = before;
            rest.setLength(0);
            rest.append(s.substring(idx));
            capturing = true;
            sawFence = hit[1] == 1;
            cap.setLength(0);
            cap.append(rest);
            rest.setLength(0);
            drainCapture(out, false);
        }

        /** 返回 [位置, 是否围栏]。 */
        private int[] findMarker(String s) {
            int best = -1;
            int fence = 0;
            Matcher m = FENCE_OPEN.matcher(s);
            if (m.find()) {
                best = m.start();
                fence = 1;
            }
            int[] cands = new int[]{s.indexOf("{\"tool_calls\""), s.indexOf("{\"tool_call\""),
                    s.indexOf("<tool_calls"), s.indexOf("<invoke"), s.indexOf("<parameter")};
            for (int c : cands) {
                if (c >= 0 && (best < 0 || c < best)) {
                    best = c;
                    fence = 0;
                }
            }
            return best < 0 ? null : new int[]{best, fence};
        }

        private void drainCapture(Out out, boolean flush) {
            String s = cap.toString();
            int jsonStart = -1;
            Matcher m = FENCE_OPEN.matcher(s);
            if (m.find()) {
                sawFence = true;
                jsonStart = m.end();
                out.fenced = true;
            } else {
                for (String k : new String[]{"{\"tool_calls\"", "{\"tool_call\"", "<tool_calls", "<invoke", "<parameter"}) {
                    int i = s.indexOf(k);
                    if (i >= 0 && (jsonStart < 0 || i < jsonStart)) jsonStart = i;
                }
            }
            if (jsonStart < 0) {
                if (s.length() > MAX_CAPTURE) {
                    out.rejected = "oversize";
                    capturing = false;
                    cap.setLength(0);
                }
                return;
            }
            String body = s.substring(jsonStart);
            if (body.startsWith("<")) {
                int endXml = body.indexOf(">");
                int close = body.indexOf("</tool_calls>");
                if (close < 0) close = body.lastIndexOf('>');
                if (close >= 0 && body.contains("</tool_calls>")) {
                    String xml = body.substring(0, body.indexOf("</tool_calls>") + "</tool_calls>".length());
                    List<Call> parsed = parseXmlCalls(xml);
                    if (!parsed.isEmpty()) {
                        out.calls.addAll(parsed);
                        out.fenced = true;
                        emitTail(out, body.substring(xml.length()));
                        reset();
                        return;
                    }
                }
                if (flush) {
                    out.text = out.text + stripFence(s);
                    reset();
                }
                return;
            }
            int[] span = Json.balancedEnd(body, 0);
            if (span == null) {
                if (body.length() > MAX_CAPTURE) {
                    out.rejected = "oversize";
                    reset();
                } else if (flush) {
                    if (looksLikeCall(body)) out.rejected = "unbalanced";
                    else out.text = out.text + stripFence(s);
                    reset();
                }
                return;
            }
            String jsonText = body.substring(span[0], span[1]);
            List<Call> calls = parseJsonCalls(jsonText);
            if (calls == null || calls.isEmpty()) {
                if (looksLikeCall(jsonText)) {
                    out.rejected = "unparsable";
                    reset();
                } else {
                    out.text = out.text + stripFence(jsonText);
                    emitTail(out, body.substring(span[1]));
                    reset();
                }
                return;
            }
            out.calls.addAll(calls);
            emitTail(out, body.substring(span[1]));
            reset();
        }

        private void emitTail(Out out, String tail) {
            String t = tail;
            int fence = t.lastIndexOf("```");
            if (fence >= 0) t = t.substring(0, fence) + t.substring(Math.min(t.length(), fence + 3));
            t = t.replaceAll("(?s)^\\s*```[a-zA-Z]*\\s*", "");
            if (!t.trim().isEmpty()) out.text = out.text + t;
        }

        private void reset() {
            capturing = false;
            cap.setLength(0);
            callsInThisBlock = 0;
        }

        public Out flush() {
            Out out = new Out();
            if (capturing) drainCapture(out, true);
            else if (rest.length() > 0) {
                out.text = rest.toString();
                rest.setLength(0);
            }
            return out;
        }
    }

    static boolean looksLikeCall(String s) {
        if (s == null) return false;
        String t = s.toLowerCase(java.util.Locale.ROOT);
        return t.contains("tool_calls") || t.contains("<tool_calls") || t.contains("<invoke") || t.contains("\"arguments\"");
    }

    static String stripFence(String s) {
        String t = s.replaceAll("(?s)^\\s*```[a-zA-Z]*\\s*", "");
        int i = t.lastIndexOf("```");
        if (i >= 0) t = t.substring(0, i);
        return t;
    }

    public static List<Call> parseJsonCalls(String jsonText) {
        Object any = Json.parseAny(jsonText);
        if (!(any instanceof JSONObject)) return null;
        JSONObject o = (JSONObject) any;
        JSONArray arr = o.optJSONArray("tool_calls");
        if (arr == null && o.has("tool_call")) {
            arr = new JSONArray();
            arr.put(o.opt("tool_call"));
        }
        if (arr == null) return null;
        List<Call> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject c = arr.optJSONObject(i);
            if (c == null) continue;
            JSONObject fn = c.optJSONObject("function");
            String name = fn != null ? fn.optString("name") : c.optString("name");
            if (name == null || name.isEmpty()) continue;
            Object argsRaw = fn != null ? fn.opt("arguments") : c.opt("arguments");
            String args;
            if (argsRaw instanceof JSONObject || argsRaw instanceof JSONArray) args = String.valueOf(argsRaw);
            else {
                String a = argsRaw == null ? "" : String.valueOf(argsRaw).trim();
                if (a.isEmpty()) a = "{}";
                if (!a.startsWith("{") && !a.startsWith("[")) a = "{}";
                args = a;
            }
            String id = c.optString("id");
            if (id == null || id.isEmpty()) id = "call_" + Long.toHexString(System.nanoTime());
            out.add(new Call(id, name, args));
        }
        return out;
    }

    static List<Call> parseXmlCalls(String xml) {
        List<Call> out = new ArrayList<>();
        Pattern invoke = Pattern.compile("(?s)<invoke\\s+name=\"([^\"]+)\"[^>]*>(.*?)</invoke>");
        Matcher m = invoke.matcher(xml);
        while (m.find()) {
            String name = m.group(1);
            String inner = m.group(2);
            JSONObject args = new JSONObject();
            Matcher p = Pattern.compile("(?s)<parameter\\s+name=\"([^\"]+)\"[^>]*>(.*?)</parameter>").matcher(inner);
            while (p.find()) {
                try {
                    args.put(p.group(1), p.group(2).trim());
                } catch (Exception ignored) {
                }
            }
            out.add(new Call("call_" + Long.toHexString(System.nanoTime()), name, args.toString()));
        }
        return out;
    }

    // ── 免责声明 ─────────────────────────────────────────────
    public static final class Boilerplate {
        private final StringBuilder buf = new StringBuilder();
        private final int hold = WEB_DISCLAIMER.length() - 1;
        public int hits = 0;

        public String push(String chunk) {
            if (chunk == null) return "";
            buf.append(chunk);
            String s = buf.toString();
            if (s.contains(WEB_DISCLAIMER)) {
                s = s.replace(WEB_DISCLAIMER, "");
                hits++;
            }
            if (s.length() <= hold) {
                buf.setLength(0);
                buf.append(s);
                return "";
            }
            String out = s.substring(0, s.length() - hold);
            buf.setLength(0);
            buf.append(s.substring(s.length() - hold));
            return out;
        }

        public String flush() {
            String s = buf.toString().replace(WEB_DISCLAIMER, "");
            buf.setLength(0);
            return s;
        }
    }

    // ── 系统标记 ─────────────────────────────────────────────
    public static final class SystemMarker {
        private final StringBuilder buf = new StringBuilder();
        private static final Pattern BLOCK = Pattern.compile(
                "(?s)<ds_system>.*?</ds_system>|<system>.*?</system>|<ide_result_status[^>]*/?>(?:.*?</ide_result_status>)?",
                Pattern.CASE_INSENSITIVE);

        public String push(String chunk) {
            if (chunk == null) return "";
            buf.append(chunk);
            String s = buf.toString();
            s = BLOCK.matcher(s).replaceAll("");
            // 尾部可能是半个标签，先扣住
            int lt = s.lastIndexOf('<');
            String tail = "";
            if (lt >= 0 && s.length() - lt < 60 && !s.substring(lt).contains(">")) {
                tail = s.substring(lt);
                s = s.substring(0, lt);
            }
            buf.setLength(0);
            buf.append(tail);
            return s;
        }

        public String flush() {
            String s = BLOCK.matcher(buf.toString()).replaceAll("");
            buf.setLength(0);
            return s;
        }
    }

    // ── 历史回放守卫 ─────────────────────────────────────────
    public static final class EchoGuard {
        private final StringBuilder buf = new StringBuilder();
        public boolean fired = false;
        private static final Pattern SIG = Pattern.compile(
                "^\\[\\s*Tool Result\\b|^\\[\\s*status\\s*:\\s*[a-z_]+\\s*\\]|^\\[\\s*(?:System|Assistant)\\s*\\]|^(?:User|Assistant)\\s*:",
                Pattern.CASE_INSENSITIVE);

        public String push(String chunk) {
            if (chunk == null || fired) return "";
            buf.append(chunk);
            String s = buf.toString();
            int cut = -1;
            int pos = 0;
            boolean inFence = false;
            for (String line : s.split("\n", -1)) {
                String t = line.trim();
                if (t.startsWith("```") || t.startsWith("~~~")) inFence = !inFence;
                if (!inFence && SIG.matcher(t).find()) {
                    cut = pos;
                    break;
                }
                pos += line.length() + 1;
            }
            if (cut >= 0) {
                fired = true;
                String out = s.substring(0, Math.max(0, cut));
                buf.setLength(0);
                return out;
            }
            // 保留最后一行（可能是半行）
            int nl = s.lastIndexOf('\n');
            if (nl < 0) return "";
            String out = s.substring(0, nl + 1);
            buf.setLength(0);
            buf.append(s.substring(nl + 1));
            return out;
        }

        public String flush() {
            if (fired) {
                buf.setLength(0);
                return "";
            }
            String s = buf.toString();
            // 末行也要判一次
            if (SIG.matcher(s.trim()).find()) {
                buf.setLength(0);
                fired = true;
                return "";
            }
            buf.setLength(0);
            return s;
        }
    }

    /** 从思考通道里剥掉工具标记（思考里不该出现调用块）。 */
    public static String stripStrayToolMarkup(String text) {
        if (text == null) return "";
        String t = text.replaceAll("(?s)```[ \\t]*dsh-tool[ \\t]*\\n?.*?```", "");
        return t;
    }
}
