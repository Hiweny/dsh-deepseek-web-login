package com.hiweny.dshweb;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.Locale;

/**
 * 配置中心。字段名刻意与上游 dsh-deepseek-web-login 的 entry config 保持一致，
 * 便于对照 README / 设置页语义（见 README「配置」一节）。
 */
public final class Cfg {

    private static final String SP = "dshweb_cfg";
    private static SharedPreferences sp;

    public static synchronized void init(Context c) {
        if (sp == null) sp = c.getApplicationContext().getSharedPreferences(SP, Context.MODE_PRIVATE);
    }

    // ── 服务 ────────────────────────────────────────────────
    public static int port() { return getInt("port", 8787); }
    public static String apiKey() { return getStr("api_key", "sk-dshweb"); }
    public static boolean requireKey() { return getBool("require_key", true); }
    public static boolean autoStart() { return getBool("auto_start", true); }

    // ── 请求体量与风控 ──────────────────────────────────────
    public static int maxPromptChars() { return clamp(getInt("max_prompt_chars", 400000), 120000, 1500000); }
    public static int maxRefImages() { return clamp(getInt("max_ref_images", 24), 0, 100); }
    public static int idleTimeoutMs() { return clamp(getInt("idle_timeout_ms", 120000), 20000, 600000); }
    public static int connectTimeoutMs() { return clamp(getInt("connect_timeout_ms", 45000), 10000, 300000); }
    public static int sessionReuseTurns() { return clamp(getInt("session_reuse_turns", 20), 0, 200); }

    public static int minIntervalMs() { return clamp(getInt("min_request_interval_ms", 2000), 0, 30000); }
    public static int maxIntervalMs() {
        return clamp(getInt("max_request_interval_ms", 4000), minIntervalMs(), 30000);
    }
    public static boolean allowConcurrent() { return getBool("allow_concurrent", false); }

    /** immediate / deferred / keep */
    public static String sessionCleanup() { return getStr("session_cleanup", "deferred"); }
    public static int cleanupBatchMin() { return clamp(getInt("cleanup_batch_min", 6), 1, 50); }
    public static int cleanupBatchMax() { return clamp(getInt("cleanup_batch_max", 10), cleanupBatchMin(), 50); }
    public static int cleanupDelayMinMs() { return clamp(getInt("cleanup_delay_min_ms", 60000), 5000, 600000); }
    public static int cleanupDelayMaxMs() { return clamp(getInt("cleanup_delay_max_ms", 120000), cleanupDelayMinMs(), 600000); }
    public static int cleanupGapMinMs() { return clamp(getInt("cleanup_gap_min_ms", 800), 0, 60000); }
    public static int cleanupGapMaxMs() { return clamp(getInt("cleanup_gap_max_ms", 2500), cleanupGapMinMs(), 60000); }

    // ── 上下文投喂 ──────────────────────────────────────────
    /** full / chained */
    public static String contextMode() { return getStr("context_mode", "full"); }
    public static int contextWindow() { return clamp(getInt("context_window", 1048576), 32768, 1048576); }

    // ── 生成行为 ────────────────────────────────────────────
    public static boolean autoContinue() { return getBool("auto_continue", true); }
    public static int maxContinuations() { return clamp(getInt("max_continuations", 2), 0, 6); }
    public static boolean serialToolCalls() { return getBool("serial_tool_calls", true); }
    public static boolean defaultThinking() { return getBool("default_thinking", false); }
    public static boolean defaultSearch() { return getBool("default_search", false); }

    // ── 账号 ────────────────────────────────────────────────
    public static int autoSwitchMinutes() { return clamp(getInt("auto_switch_minutes", 0), 0, 120); }
    public static int probeIntervalMs() { return getInt("probe_interval_ms", 1800000); }

    // ── 外观 / 保活 ─────────────────────────────────────────
    /** auto / dark / light */
    public static String theme() { return getStr("theme", "auto"); }
    public static boolean floatBall() { return getBool("float_ball", true); }
    public static String ballColor() { return getStr("ball_color", "violet"); }
    public static boolean batteryOptHint() { return getBool("battery_hint", true); }
    public static boolean keepAliveAccessibility() { return getBool("keep_accessibility", false); }

    // ── 后台 ────────────────────────────────────────────────
    public static synchronized boolean getBool(String k, boolean d) {
        return sp != null && sp.getBoolean(k, d);
    }

    public static synchronized int getInt(String k, int d) {
        if (sp == null) return d;
        try {
            return sp.getInt(k, d);
        } catch (Exception e) {
            try {
                return Integer.parseInt(sp.getString(k, String.valueOf(d)));
            } catch (Exception ignored) {
                return d;
            }
        }
    }

    public static synchronized String getStr(String k, String d) {
        if (sp == null) return d;
        try {
            String v = sp.getString(k, d);
            return v == null ? d : v;
        } catch (Exception e) {
            return d;
        }
    }

    public static synchronized void put(String k, Object v) {
        if (sp == null) return;
        SharedPreferences.Editor e = sp.edit();
        if (v instanceof Boolean) e.putBoolean(k, (Boolean) v);
        else if (v instanceof Integer) e.putInt(k, (Integer) v);
        else if (v instanceof Long) e.putLong(k, (Long) v);
        else e.putString(k, String.valueOf(v));
        e.apply();
    }

    public static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    /** 给控制台 UI 的完整快照。 */
    public static JSONObject snapshot() {
        JSONObject o = new JSONObject();
        try {
            o.put("port", port());
            o.put("apiKey", apiKey());
            o.put("requireKey", requireKey());
            o.put("autoStart", autoStart());
            o.put("maxPromptChars", maxPromptChars());
            o.put("maxRefImages", maxRefImages());
            o.put("idleTimeoutMs", idleTimeoutMs());
            o.put("sessionReuseTurns", sessionReuseTurns());
            o.put("minRequestIntervalMs", minIntervalMs());
            o.put("maxRequestIntervalMs", maxIntervalMs());
            o.put("allowConcurrent", allowConcurrent());
            o.put("sessionCleanup", sessionCleanup());
            o.put("cleanupBatchMin", cleanupBatchMin());
            o.put("cleanupBatchMax", cleanupBatchMax());
            o.put("cleanupDelayMinMs", cleanupDelayMinMs());
            o.put("cleanupDelayMaxMs", cleanupDelayMaxMs());
            o.put("cleanupGapMinMs", cleanupGapMinMs());
            o.put("cleanupGapMaxMs", cleanupGapMaxMs());
            o.put("contextMode", contextMode());
            o.put("contextWindow", contextWindow());
            o.put("autoContinue", autoContinue());
            o.put("maxContinuations", maxContinuations());
            o.put("serialToolCalls", serialToolCalls());
            o.put("defaultThinking", defaultThinking());
            o.put("defaultSearch", defaultSearch());
            o.put("autoSwitchMinutes", autoSwitchMinutes());
            o.put("theme", theme());
            o.put("floatBall", floatBall());
            o.put("ballColor", ballColor());
            o.put("version", Ver.versionName());
        } catch (Exception ignored) {
        }
        return o;
    }

    public static String num(int v) {
        return String.format(Locale.US, "%d", v);
    }
}
