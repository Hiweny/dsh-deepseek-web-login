package com.hiweny.dshweb;

import org.json.JSONArray;
import org.json.JSONObject;

/** JSON 工具：严格解析失败时走宽松解析 + 结构修复（模型输出经常少转义/多转义）。 */
public final class Json {

    private Json() {
    }

    public static JSONObject obj(String s) {
        if (s == null) return null;
        try {
            return new JSONObject(s);
        } catch (Exception ignored) {
        }
        return null;
    }

    public static JSONObject parseObjOrNull(String s) {
        if (s == null || s.trim().isEmpty()) return null;
        JSONObject o = obj(s);
        if (o != null) return o;
        try {
            String fixed = JsonRepair.tryRebuild(s);
            if (fixed != null) {
                o = obj(fixed);
                if (o != null) return o;
            }
        } catch (Exception ignored) {
        }
        try {
            Object v = LooseJson.parse(s);
            if (v instanceof JSONObject) return (JSONObject) v;
            if (v instanceof JSONArray) {
                JSONObject wrap = new JSONObject();
                wrap.put("__array", v);
                return wrap;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    public static Object parseAny(String s) {
        JSONObject o = parseObjOrNull(s);
        if (o != null) {
            Object arr = o.opt("__array");
            return arr != null ? arr : o;
        }
        try {
            return new JSONArray(s);
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 从任意位置取第一个配平的 JSON 对象（含字符串内的括号处理）。 */
    public static int[] balancedEnd(String text, int start) {
        if (text == null || start < 0 || start >= text.length()) return null;
        int depth = 0;
        boolean inStr = false;
        boolean esc = false;
        for (int i = start; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inStr) {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return new int[]{start, i + 1};
            }
        }
        return null;
    }

    public static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max);
    }

    public static long safeLong(Object v) {
        if (v instanceof Number) {
            long n = ((Number) v).longValue();
            return n <= 0 ? 0 : n;
        }
        try {
            long n = Long.parseLong(String.valueOf(v).trim());
            return n <= 0 ? 0 : n;
        } catch (Exception e) {
            return 0;
        }
    }
}
