package com.hiweny.dshweb;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 提示词序列化（移植自上游 src/protocol.ts 的 serializePromptParts / buildToolSection）。
 *
 * 网页端是无状态接口：一次 completion 的 prompt = 整份对话转写。布局与上游逐段对齐：
 *   [System]\n…   /   User: …   /   Assistant: …   /   [Tool Result for <id>]\n…
 * 工具目录 + 工具调用协议放在固定头里（工具集不变 ⇒ 固定头不变 ⇒ 链式投喂可续）。
 */
public final class Protocol {

    /** 固定头占全量的比例上限（工具目录只在这个额度内渲染）。 */
    private static final double HEAD_RATIO = 0.55;
    private static final int PROTOCOL_SLACK_CHARS = 96;
    private static final int MAX_TOOLS_SECTION_CHARS = 48000;
    private static final int MAX_DESCRIPTION_CHARS = 1200;

    public static final String CONTINUE_INSTRUCTION =
            "继续：请从你上一条回复的结尾处无缝接着往下写——不要重复任何已输出的内容，不要加「好的」「以下是」之类的开场白，"
                    + "不要重新组织语言；如果上一条回复停在句子中间，就从那个断点直接把句子写完并继续。";

    public static final String TOOL_CALL_RETRY_INSTRUCTION =
            "你刚才把要执行的程序写进了正文文本。写在正文里的代码不会被执行 —— 这一轮因此没有发生任何工具调用。\n"
                    + "请把同一段程序作为工具调用重新发出：只输出一个 JSON 对象，前后不要有任何其它文字：\n"
                    + "{\"tool_calls\":[{\"name\":\"<工具名>\",\"arguments\":{...}}]}\n"
                    + "即使系统提示要求你写 TypeScript 程序来完成动作，那个程序也必须放进工具调用的 arguments 里，"
                    + "不能直接写在正文中 —— 只有作为工具调用发出，它才会真的被执行。";

    private static final String FENCE = "```";
    private static final String FENCE_OPEN = "```dsh-tool";

    public static final String TOOL_PROTOCOL = "# Tool Calling Protocol\n\n"
            + "You can call tools to complete the user's task. When you need a tool, output a single JSON object "
            + "inside a fenced code block, with no other text before or after it:\n\n"
            + "```dsh-tool\n"
            + "{\"tool_calls\":[{\"name\":\"<tool-name>\",\"arguments\":{<json-arguments>}}]}\n"
            + "```\n\n"
            + "Rules:\n"
            + "1. Put every tool you want to run in the \"tool_calls\" array (usually exactly one; a batch is allowed).\n"
            + "2. Stop immediately after the closing fence. The runner executes the call(s) and returns the results to you as the next message.\n"
            + "3. Never fabricate, guess, or simulate tool output — always wait for the real result.\n"
            + "4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.\n"
            + "5. \"arguments\" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, "
            + "escape backslashes as \\\\ (e.g. \"C:\\\\Users\\\\me\"); an unescaped single backslash makes the whole object unparsable. "
            + "Close every brace: the call object and its \"arguments\" object each need their OWN closing \"}\" — one missing \"}\" "
            + "makes the whole batch unparsable and the call will be discarded.\n"
            + "5b. Two things break the JSON most often — check them before you emit:\n"
            + "   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. "
            + "Get-ChildItem \"$env:USERPROFILE\\\\.dsh\". Every such inner double quote MUST be escaped as \\\" inside the JSON string. "
            + "An unescaped one ends the string early and discards the whole call.\n"
            + "   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. "
            + "When a command needs several statements, join them with \";\" on ONE line, or use \\n escapes — do not paste them as "
            + "actual newlines. Prefer single quotes inside commands to reduce escaping.\n"
            + "6. Always wrap the JSON in a ```dsh-tool fence (see the example above). Do NOT use XML/HTML-like markup instead: "
            + "no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>). An unfenced object or any such markup leaks into "
            + "the visible transcript and into the web conversation.\n"
            + "7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).\n"
            + "8. NEVER reproduce the transcript. Do not restate previous turns, \"[Tool Result …]\" blocks, tool output, or the current prompt. "
            + "Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry.\n"
            + "9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. "
            + "Long payloads are the ones that most often come out malformed.\n"
            + "10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.";

    public static final String SERIAL_TOOL_PROTOCOL = "# Tool Calling Protocol\n\n"
            + "You can call tools to complete the user's task. When you need a tool, output a single JSON object "
            + "inside a fenced code block, with no other text before or after it:\n\n"
            + "```dsh-tool\n"
            + "{\"tool_calls\":[{\"name\":\"<tool-name>\",\"arguments\":{<json-arguments>}}]}\n"
            + "```\n\n"
            + "Rules:\n"
            + "1. Put exactly ONE tool in the \"tool_calls\" array — one call per message, never a batch.\n"
            + "2. Stop immediately after the closing fence. The runner executes the call and returns the result to you as the next message.\n"
            + "3. Never fabricate, guess, or simulate tool output — always wait for the real result.\n"
            + "4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.\n"
            + "5. \"arguments\" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, "
            + "escape backslashes as \\\\ (e.g. \"C:\\\\Users\\\\me\"); an unescaped single backslash makes the whole object unparsable. "
            + "Close every brace: the call object and its \"arguments\" object each need their OWN closing \"}\" — one missing \"}\" "
            + "makes the whole batch unparsable and the call will be discarded.\n"
            + "5b. Two things break the JSON most often — check them before you emit:\n"
            + "   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. "
            + "Get-ChildItem \"$env:USERPROFILE\\\\.dsh\". Every such inner double quote MUST be escaped as \\\" inside the JSON string. "
            + "An unescaped one ends the string early and discards the whole call.\n"
            + "   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. "
            + "When a command needs several statements, join them with \";\" on ONE line, or use \\n escapes — do not paste them as "
            + "actual newlines. Prefer single quotes inside commands to reduce escaping.\n"
            + "6. Always wrap the JSON in a ```dsh-tool fence (see the example above). Do NOT use XML/HTML-like markup instead: "
            + "no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>). An unfenced object or any such markup leaks into "
            + "the visible transcript and into the web conversation.\n"
            + "7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).\n"
            + "8. NEVER reproduce the transcript. Do not restate previous turns, \"[Tool Result …]\" blocks, tool output, or the current prompt. "
            + "Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry.\n"
            + "9. Do NOT batch. Exactly one call per message; if you need more, send them in successive steps.\n"
            + "10. Each call may depend on the previous result — that is the point of one-call-per-step.";

    public static String toolProtocolInstructions(boolean serial) {
        return serial ? SERIAL_TOOL_PROTOCOL : TOOL_PROTOCOL;
    }

    // ── 序列化结果 ───────────────────────────────────────────
    public static final class Image {
        public String dataUrl;
        public String name;

        public Image(String dataUrl, String name) {
            this.dataUrl = dataUrl;
            this.name = name;
        }
    }

    public static final class Parts {
        public String full = "";
        public String head = "";
        public String transcript = "";
        public int promptChars;
        /** 请求里带的图片（data: URL），由调用方上传成 ref_file_ids。 */
        public final List<Image> images = new ArrayList<>();
    }

    /**
     * 把 OpenAI 风格的 messages 序列化成网页端 prompt。
     *
     * @param system       system 内容（多条 system 已由调用方合并）
     * @param messages     请求里的 messages
     * @param tools        tools（OpenAI 格式）
     * @param maxChars     prompt 字符上限（风控阀门）
     * @param serialTools  是否用「一次一个」版协议
     */
    public static Parts serialize(String system, JSONArray messages, JSONArray tools,
                                  int maxChars, boolean serialTools) {
        Parts p = new Parts();
        StringBuilder head = new StringBuilder();
        String proto = toolProtocolInstructions(serialTools);
        int toolBudget = (int) Math.max(0, Math.floor(maxChars * HEAD_RATIO) - (system == null ? 0 : system.length())
                - proto.length() - PROTOCOL_SLACK_CHARS);
        String toolSection = buildToolSection(tools, toolBudget);

        head.append("[System]\n");
        String sys = system == null ? "" : system.trim();
        if (!sys.isEmpty()) head.append(sys).append("\n\n");
        if (!toolSection.isEmpty()) head.append(proto).append(toolSection).append("\n\n");
        head.append("---\n\n");

        StringBuilder body = new StringBuilder();
        List<String> pendingToolIds = new ArrayList<>();

        for (int i = 0; messages != null && i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null) continue;
            String role = m.optString("role");
            if ("system".equals(role) || "developer".equals(role)) {
                String t = flat(m.opt("content"));
                if (!t.trim().isEmpty()) body.append("[System]\n").append(t).append("\n\n");
                continue;
            }
            if ("assistant".equals(role)) {
                String t = flat(m.opt("content"));
                JSONArray calls = m.optJSONArray("tool_calls");
                String rendered = renderToolCalls(calls);
                pendingToolIds.clear();
                if (rendered != null) {
                    if (calls != null) {
                        for (int k = 0; k < calls.length(); k++) {
                            JSONObject c = calls.optJSONObject(k);
                            if (c != null) pendingToolIds.add(c.optString("id"));
                        }
                    }
                    body.append("Assistant: ").append(rendered).append("\n\n");
                } else if (!t.trim().isEmpty()) {
                    body.append("Assistant: ").append(t).append("\n\n");
                }
                continue;
            }
            if ("tool".equals(role) || "function".equals(role)) {
                String t = flat(m.opt("content"));
                if (t.trim().isEmpty()) t = "(no output)";
                body.append("[Tool Result").append(" for ").append(m.optString("tool_call_id")).append("]\n")
                        .append(t).append("\n\n");
                pendingToolIds.clear();
                continue;
            }
            // user
            String t = flat(m.opt("content"));
            int imgs = countImages(m.opt("content"));
            if (t.trim().isEmpty() && imgs == 0) continue;
            body.append("User: ").append(t).append("\n\n");
            if (imgs > 0) collectImages(m.opt("content"), p.images);
        }

        String transcript = body.toString();
        String full = head + transcript;

        // 中段截断：保固定头 + 最近回合
        if (full.length() > maxChars) {
            full = truncateMiddle(full, head.toString(), maxChars);
        }
        p.head = head.toString();
        p.transcript = transcript;
        p.full = full;
        p.promptChars = full.length();
        return p;
    }

    /** 头部完整保留，正文从**中段**截断（保留最近的回合，previousTurn 起点前插省略标记）。 */
    public static String truncateMiddle(String full, String head, int maxChars) {
        if (full.length() <= maxChars) return full;
        int headKeep = Math.min(head.length(), (int) (maxChars * 0.6));
        String h = head.substring(0, headKeep);
        int budget = maxChars - h.length() - 40;
        if (budget <= 0) return h;
        String tail = full.substring(full.length() - budget);
        // 尽量从段落边界开始，避免切断一行
        int nl = tail.indexOf("\n\n");
        if (nl > 0 && nl < 400) tail = tail.substring(nl + 2);
        int omitted = full.length() - h.length() - tail.length();
        return h + "\n[... " + omitted + " chars omitted ...]\n\n" + tail;
    }

    static String flat(Object content) {
        if (content == null || content == JSONObject.NULL) return "";
        if (content instanceof String) return (String) content;
        if (content instanceof JSONArray) {
            StringBuilder sb = new StringBuilder();
            JSONArray a = (JSONArray) content;
            for (int i = 0; i < a.length(); i++) {
                Object b = a.opt(i);
                if (b instanceof JSONObject) {
                    JSONObject o = (JSONObject) b;
                    String type = o.optString("type");
                    if ("text".equals(type) || "input_text".equals(type)) sb.append(o.optString("text"));
                    else if ("image_url".equals(type)) sb.append("[image attached]");
                    else if ("tool_result".equals(type) || "tool-result".equals(type)) sb.append(flat(o.opt("content")));
                } else if (b instanceof String) {
                    sb.append(b);
                }
            }
            return sb.toString();
        }
        if (content instanceof JSONObject) {
            JSONObject o = (JSONObject) content;
            return o.optString("text", o.optString("content", ""));
        }
        return String.valueOf(content);
    }

    /** 收集 data: URL 形式的图片（http(s) 链接也要，但 APK 侧只处理 base64）。 */
    static void collectImages(Object content, List<Image> out) {
        if (!(content instanceof JSONArray)) return;
        JSONArray a = (JSONArray) content;
        for (int i = 0; i < a.length(); i++) {
            Object b = a.opt(i);
            if (!(b instanceof JSONObject)) continue;
            JSONObject o = (JSONObject) b;
            String type = o.optString("type");
            String url = null;
            if ("image_url".equals(type)) {
                Object u = o.opt("image_url");
                if (u instanceof JSONObject) url = ((JSONObject) u).optString("url");
                else if (u instanceof String) url = (String) u;
            } else if ("image".equals(type)) {
                url = o.optString("url", o.optString("data"));
            }
            if (url == null || !url.startsWith("data:")) continue;
            if (out.size() >= 60) break;
            String ext = "png";
            int semi = url.indexOf(';');
            if (semi > 5) {
                String mime = url.substring(5, semi);
                if (mime.contains("jpeg") || mime.contains("jpg")) ext = "jpg";
                else if (mime.contains("webp")) ext = "webp";
                else if (mime.contains("gif")) ext = "gif";
            }
            out.add(new Image(url, "image-" + (out.size() + 1) + "." + ext));
        }
    }

    static int countImages(Object content) {
        int n = 0;
        if (content instanceof JSONArray) {
            JSONArray a = (JSONArray) content;
            for (int i = 0; i < a.length(); i++) {
                Object b = a.opt(i);
                if (!(b instanceof JSONObject)) continue;
                String type = ((JSONObject) b).optString("type");
                if ("image_url".equals(type) || "image".equals(type) || "input_image".equals(type)) n++;
            }
        }
        return n;
    }

    static String renderToolCalls(JSONArray calls) {
        if (calls == null || calls.length() == 0) return null;
        try {
            JSONArray out = new JSONArray();
            for (int i = 0; i < calls.length(); i++) {
                JSONObject c = calls.optJSONObject(i);
                if (c == null) continue;
                JSONObject fn = c.optJSONObject("function");
                String name = fn != null ? fn.optString("name") : c.optString("name");
                String args = fn != null ? fn.optString("arguments") : String.valueOf(c.opt("arguments"));
                JSONObject one = new JSONObject();
                one.put("name", name);
                JSONObject parsed = Json.parseObjOrNull(args);
                one.put("arguments", parsed != null ? parsed : new JSONObject());
                out.put(one);
            }
            JSONObject wrap = new JSONObject();
            wrap.put("tool_calls", out);
            return FENCE_OPEN + "\n" + wrap.toString() + "\n" + FENCE;
        } catch (Exception e) {
            return null;
        }
    }

    /** 工具目录（对齐上游 buildToolSection：核心工具一段一个，其余一行一个）。 */
    public static String buildToolSection(JSONArray tools, int budget) {
        if (tools == null || tools.length() == 0) return "";
        List<JSONObject> all = new ArrayList<>();
        for (int i = 0; i < tools.length(); i++) {
            JSONObject t = tools.optJSONObject(i);
            if (t == null) continue;
            if (t.optBoolean("deferLoading")) continue;
            all.add(t);
        }
        if (all.isEmpty()) {
            for (int i = 0; i < tools.length(); i++) {
                JSONObject t = tools.optJSONObject(i);
                if (t != null) all.add(t);
            }
        }
        StringBuilder sb = new StringBuilder();
        sb.append("\n\n## Available tools\n");
        int left = Math.max(0, Math.min(MAX_TOOLS_SECTION_CHARS, budget));
        boolean any = false;
        for (JSONObject t : all) {
            JSONObject fn = t.optJSONObject("function");
            String name = fn != null ? fn.optString("name") : t.optString("name");
            String desc = fn != null ? fn.optString("description") : t.optString("description");
            Object params = fn != null ? fn.opt("parameters") : t.opt("parameters");
            String sig = "- " + name + "(" + paramSignature(params) + ")";
            if (desc != null && !desc.isEmpty()) sig += " — " + truncate(desc.replaceAll("\\s+", " ").trim(), 400);
            sig += "\n";
            if (sig.length() > left) {
                sb.append("\n(⚠️ remaining tools omitted for length; ask the user for exact parameters instead of guessing.)\n");
                break;
            }
            left -= sig.length();
            sb.append(sig);
            any = true;
        }
        return any ? sb.toString() : "";
    }

    static String paramSignature(Object params) {
        if (!(params instanceof JSONObject)) return "";
        JSONObject p = (JSONObject) params;
        JSONObject props = p.optJSONObject("properties");
        if (props == null) return "";
        JSONArray required = p.optJSONArray("required");
        List<String> req = new ArrayList<>();
        if (required != null) for (int i = 0; i < required.length(); i++) req.add(required.optString(i));
        StringBuilder sb = new StringBuilder();
        java.util.Iterator<String> it = props.keys();
        boolean first = true;
        while (it.hasNext()) {
            String k = it.next();
            JSONObject v = props.optJSONObject(k);
            String type = v == null ? "any" : v.optString("type", "any");
            if (!first) sb.append(", ");
            first = false;
            sb.append(k).append(": ").append(type);
            if (req.contains(k)) sb.append(" (required)");
            String d = v == null ? "" : v.optString("description");
            if (!d.isEmpty()) sb.append(" — ").append(truncate(d.replaceAll("\\s+", " "), 90));
        }
        return sb.toString();
    }

    static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    /** 判断正文是不是「把工具程序写进了正文」（移植自 looksLikeUnexecutedToolProgram 的主判据）。 */
    public static boolean looksLikeUnexecutedToolProgram(String text) {
        if (text == null || text.isEmpty()) return false;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("```([^\\n]*)\\n([\\s\\S]*?)```", java.util.regex.Pattern.DOTALL)
                .matcher(text);
        boolean sawFence = false;
        while (m.find()) {
            sawFence = true;
            String lang = m.group(1).toLowerCase(java.util.Locale.ROOT);
            String body = m.group(2);
            if (body.length() >= 80 && body.matches("(?s).*tools\\.[A-Za-z_$][\\w$]*\\s*\\(.*")) return true;
            if ((lang.contains("sh") || lang.contains("bash") || lang.contains("powershell") || lang.contains("ps1"))
                    && body.trim().length() >= 2) return true;
        }
        if (sawFence) return false;
        return text.matches("(?s).*await\\s+tools\\.[A-Za-z_$][\\w$]*\\s*\\(.*");
    }

    /** 判断一段文本是否「停在句中」（移植自 looksMidSentence）。 */
    public static boolean looksMidSentence(String text) {
        if (text == null) return false;
        String t = text.replaceAll("\\s+$", "");
        if (t.isEmpty() || t.length() < 40) return false;
        char c = t.charAt(t.length() - 1);
        String tail = String.valueOf(c);
        if (" *_#~`".indexOf(c) >= 0) return t.endsWith("**") || t.endsWith("__");
        if ("，、；：,;:".indexOf(c) >= 0) return true;
        if ("。！？!?…）)】》」』\"”’".indexOf(c) >= 0) return false;
        return Character.isLetterOrDigit(c) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff);
    }
}
