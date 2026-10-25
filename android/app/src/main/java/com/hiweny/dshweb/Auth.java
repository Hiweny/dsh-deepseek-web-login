package com.hiweny.dshweb;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 账号库（移植自上游 src/accounts.ts + src/auth.ts + src/cookies.ts）。
 *
 * 一条账号 = 一份 {@link WebAuth}（token / cookie / x-hif-* / UA / extraHeaders）
 * + 元数据（备注 / 分组 / 探活结果 / 限流窗口）。
 * 存储：files/accounts/<id>.json，单账号单文件；files/accounts.json 存 {version, activeId}。
 */
public final class Auth {

    private static final Pattern AUTH_FAIL = Pattern.compile(
            "authorization failed|invalid token|unauthori[sz]ed|授权失败|登录(态|状态)?[^。；;]{0,8}(过期|失效|无效)|HTTP\\s*40[13]\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern MUTED = Pattern.compile("user\\s+is\\s+muted|account\\s+is\\s+muted", Pattern.CASE_INSENSITIVE);

    public static final String DEFAULT_WASM =
            "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

    private static final Object LOCK = new Object();
    private static final List<Rec> CACHE = new ArrayList<>();
    private static String activeId = "";
    private static boolean loaded = false;
    private static File dir;

    private Auth() {
    }

    // ── 数据模型 ─────────────────────────────────────────────
    public static final class CookieMeta {
        public String name = "";
        public String domain = "";
        public boolean session = true;
        public long expiresAt = 0;
    }

    /** 一条账号记录（含凭证本体）。 */
    public static final class Rec {
        public String id = "";
        public String label = "";
        public String groupId = "";
        public String serverId = "";
        public long capturedAt = 0;
        public long lastVerifiedAt = 0;
        public long lastVerifyErrorAt = 0;
        public String lastVerifyError = "";
        public long lastCheckErrorAt = 0;
        public String lastCheckError = "";
        public long limitUntilMs = 0;
        public long limitObservedAt = 0;
        public boolean unverified = false;

        // 凭证
        public String token = "";
        public String cookie = "";
        public String hifDliq = "";
        public String hifLeim = "";
        public String userAgent = "";
        public String deviceId = "";
        public String wasmUrl = DEFAULT_WASM;
        public JSONObject extraHeaders = new JSONObject();
        public String userId = "";
        public String userDisplay = "";
        public List<CookieMeta> cookieMeta = new ArrayList<>();

        public boolean usable() {
            return token != null && token.length() > 8;
        }

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id);
                o.put("label", label);
                o.put("groupId", groupId);
                o.put("serverId", serverId);
                o.put("capturedAt", capturedAt);
                o.put("lastVerifiedAt", lastVerifiedAt);
                o.put("lastVerifyError", lastVerifyError);
                o.put("lastVerifyErrorAt", lastVerifyErrorAt);
                o.put("lastCheckError", lastCheckError);
                o.put("lastCheckErrorAt", lastCheckErrorAt);
                o.put("limitUntilMs", limitUntilMs);
                o.put("limitObservedAt", limitObservedAt);
                o.put("unverified", unverified);
                o.put("token", token);
                o.put("cookie", cookie);
                o.put("hifDliq", hifDliq);
                o.put("hifLeim", hifLeim);
                o.put("userAgent", userAgent);
                o.put("deviceId", deviceId);
                o.put("wasmUrl", wasmUrl);
                o.put("extraHeaders", extraHeaders == null ? new JSONObject() : extraHeaders);
                o.put("userId", userId);
                o.put("userDisplay", userDisplay);
                JSONArray arr = new JSONArray();
                for (CookieMeta m : cookieMeta) {
                    JSONObject c = new JSONObject();
                    c.put("name", m.name);
                    c.put("domain", m.domain);
                    c.put("session", m.session);
                    c.put("expiresAt", m.expiresAt);
                    arr.put(c);
                }
                o.put("cookieMeta", arr);
            } catch (Exception ignored) {
            }
            return o;
        }

        public static Rec from(JSONObject o) {
            Rec r = new Rec();
            r.id = o.optString("id");
            r.label = o.optString("label");
            r.groupId = o.optString("groupId");
            r.serverId = o.optString("serverId");
            r.capturedAt = o.optLong("capturedAt");
            r.lastVerifiedAt = o.optLong("lastVerifiedAt");
            r.lastVerifyError = o.optString("lastVerifyError");
            r.lastVerifyErrorAt = o.optLong("lastVerifyErrorAt");
            r.lastCheckError = o.optString("lastCheckError");
            r.lastCheckErrorAt = o.optLong("lastCheckErrorAt");
            r.limitUntilMs = o.optLong("limitUntilMs");
            r.limitObservedAt = o.optLong("limitObservedAt");
            r.unverified = o.optBoolean("unverified");
            r.token = o.optString("token");
            r.cookie = o.optString("cookie");
            r.hifDliq = o.optString("hifDliq");
            r.hifLeim = o.optString("hifLeim");
            r.userAgent = o.optString("userAgent");
            r.deviceId = o.optString("deviceId");
            r.wasmUrl = o.optString("wasmUrl", DEFAULT_WASM);
            JSONObject eh = o.optJSONObject("extraHeaders");
            r.extraHeaders = eh == null ? new JSONObject() : eh;
            r.userId = o.optString("userId");
            r.userDisplay = o.optString("userDisplay");
            JSONArray arr = o.optJSONArray("cookieMeta");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject c = arr.optJSONObject(i);
                    if (c == null) continue;
                    CookieMeta m = new CookieMeta();
                    m.name = c.optString("name");
                    m.domain = c.optString("domain");
                    m.session = c.optBoolean("session", true);
                    m.expiresAt = c.optLong("expiresAt");
                    r.cookieMeta.add(m);
                }
            }
            return r;
        }

        /** 展示用：账号名（服务端屏蔽值）+ 备注 + 状态。 */
        public JSONObject view() {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id);
                o.put("label", label);
                o.put("groupId", groupId);
                o.put("capturedAt", capturedAt);
                o.put("lastVerifiedAt", lastVerifiedAt);
                o.put("userDisplay", userDisplay);
                o.put("userId", userId);
                o.put("unverified", unverified);
                o.put("active", id.equals(activeId));
                o.put("hasToken", usable());
                o.put("tokenLen", token == null ? 0 : token.length());
                o.put("tokenHead", token == null || token.length() < 6 ? "" : token.substring(0, 6));
                o.put("lastVerifyError", lastVerifyError);
                o.put("lastCheckError", lastCheckError);
                o.put("limitUntilMs", limitUntilMs);
                o.put("cookieSummary", cookieSummary());
                o.put("stale", isStaleAuth(this) != null);
            } catch (Exception ignored) {
            }
            return o;
        }

        public String cookieSummary() {
            if (cookieMeta == null || cookieMeta.isEmpty()) return "未记录";
            int session = 0;
            long latest = 0;
            String latestName = "";
            for (CookieMeta m : cookieMeta) {
                if (m.session || m.expiresAt <= 0) session++;
                if (m.expiresAt > latest) {
                    latest = m.expiresAt;
                    latestName = m.name;
                }
            }
            int persistent = cookieMeta.size() - session;
            String s = cookieMeta.size() + " 项 · " + session + " 会话级 · " + persistent + " 持久级";
            if (latest > 0) s += " · " + latestName + " 还剩 " + ((latest - System.currentTimeMillis()) / 86400000L) + " 天";
            return s;
        }
    }

    // ── 加载 / 持久化 ────────────────────────────────────────
    public static void init(Context c) {
        synchronized (LOCK) {
            dir = new File(c.getFilesDir(), "accounts");
            if (!dir.exists()) dir.mkdirs();
            if (loaded) return;
            loaded = true;
            File idx = new File(c.getFilesDir(), "accounts.json");
            if (idx.exists()) {
                try {
                    JSONObject o = new JSONObject(read(idx));
                    activeId = o.optString("activeId", "");
                } catch (Exception ignored) {
                }
            }
            File[] files = dir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (!f.getName().endsWith(".json")) continue;
                    try {
                        CACHE.add(Rec.from(new JSONObject(read(f))));
                    } catch (Exception e) {
                        App.Lg.w("账号文件损坏: " + f.getName());
                    }
                }
            }
            sortLocked();
        }
    }

    private static String read(File f) throws Exception {
        InputStream in = new FileInputStream(f);
        byte[] buf = new byte[(int) f.length()];
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) break;
            off += n;
        }
        in.close();
        return new String(buf, 0, off, StandardCharsets.UTF_8);
    }

    private static void write(File f, String text) throws Exception {
        File tmp = new File(f.getAbsolutePath() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        out.write(text.getBytes(StandardCharsets.UTF_8));
        out.getFD().sync();
        out.close();
        if (f.exists()) f.delete();
        tmp.renameTo(f);
        try {
            f.setReadable(false, false);
            f.setReadable(true, true);
        } catch (Exception ignored) {
        }
    }

    private static void sortLocked() {
        CACHE.sort((a, b) -> Long.compare(b.capturedAt, a.capturedAt));
    }

    private static void persist(Rec r) {
        try {
            if (dir == null) return;
            write(new File(dir, r.id + ".json"), r.toJson().toString());
        } catch (Exception e) {
            App.Lg.e("写账号失败: " + e);
        }
    }

    private static void persistIndex() {
        try {
            Context c = App.ctx();
            JSONObject o = new JSONObject();
            o.put("version", 1);
            o.put("activeId", activeId);
            write(new File(c.getFilesDir(), "accounts.json"), o.toString());
        } catch (Exception ignored) {
        }
    }

    // ── CRUD ────────────────────────────────────────────────
    public static List<Rec> list() {
        synchronized (LOCK) {
            return new ArrayList<>(CACHE);
        }
    }

    public static Rec get(String id) {
        synchronized (LOCK) {
            for (Rec r : CACHE) if (r.id.equals(id)) return r;
            return null;
        }
    }

    public static Rec active() {
        synchronized (LOCK) {
            for (Rec r : CACHE) if (r.id.equals(activeId)) return r;
            return CACHE.isEmpty() ? null : CACHE.get(0);
        }
    }

    public static String activeId() {
        synchronized (LOCK) {
            return activeId;
        }
    }

    public static boolean setActive(String id) {
        synchronized (LOCK) {
            if (id != null && !id.isEmpty() && get(id) == null) return false;
            activeId = id == null ? "" : id;
            persistIndex();
            return true;
        }
    }

    /** 账号库为空时用捕获到的凭证自动建一条。 */
    public static Rec upsert(Rec fresh, String label) {
        synchronized (LOCK) {
            Rec target = null;
            // 去重优先级：同 token > 同 serverId > 同 userId
            for (Rec r : CACHE) {
                if (fresh.token != null && fresh.token.length() > 8 && fresh.token.equals(r.token)) {
                    target = r;
                    break;
                }
            }
            if (target == null && fresh.userId != null && !fresh.userId.isEmpty()) {
                for (Rec r : CACHE) {
                    if (fresh.userId.equals(r.userId)) {
                        target = r;
                        break;
                    }
                }
            }
            if (target == null) {
                target = new Rec();
                target.id = "acc_" + Long.toHexString(System.currentTimeMillis()).substring(4)
                        + Integer.toHexString((int) (Math.random() * 0xffff));
                target.capturedAt = fresh.capturedAt > 0 ? fresh.capturedAt : System.currentTimeMillis();
                if (label != null && !label.isEmpty()) target.label = label;
                CACHE.add(target);
            }
            // 凭证字段全部取自新捕获，绝不合并
            target.token = fresh.token;
            target.cookie = fresh.cookie;
            target.hifDliq = fresh.hifDliq;
            target.hifLeim = fresh.hifLeim;
            target.userAgent = fresh.userAgent;
            target.deviceId = fresh.deviceId;
            if (fresh.wasmUrl != null && !fresh.wasmUrl.isEmpty()) target.wasmUrl = fresh.wasmUrl;
            if (fresh.extraHeaders != null) target.extraHeaders = fresh.extraHeaders;
            if (fresh.userId != null && !fresh.userId.isEmpty()) target.userId = fresh.userId;
            if (fresh.userDisplay != null && !fresh.userDisplay.isEmpty()) target.userDisplay = fresh.userDisplay;
            if (fresh.cookieMeta != null && !fresh.cookieMeta.isEmpty()) target.cookieMeta = fresh.cookieMeta;
            target.unverified = fresh.unverified;
            target.lastVerifyError = "";
            target.lastVerifyErrorAt = 0;
            target.lastCheckError = "";
            target.lastCheckErrorAt = 0;
            if (target.capturedAt == 0) target.capturedAt = System.currentTimeMillis();
            if (activeId.isEmpty()) activeId = target.id;
            sortLocked();
            persist(target);
            persistIndex();
            return target;
        }
    }

    public static void update(String id, JSONObject patch) {
        synchronized (LOCK) {
            Rec r = get(id);
            if (r == null) return;
            if (patch.has("label")) r.label = patch.optString("label");
            if (patch.has("groupId")) r.groupId = patch.optString("groupId");
            persist(r);
        }
    }

    public static void remove(String id) {
        synchronized (LOCK) {
            Rec r = get(id);
            if (r == null) return;
            CACHE.remove(r);
            if (dir != null) {
                File f = new File(dir, id + ".json");
                if (f.exists()) f.delete();
            }
            if (activeId.equals(id)) activeId = CACHE.isEmpty() ? "" : CACHE.get(0).id;
            persistIndex();
        }
    }

    // ── 探活 / 失效判据（移植自 accounts.ts）─────────────────
    public static void markVerified(Rec r) {
        synchronized (LOCK) {
            r.lastVerifiedAt = System.currentTimeMillis();
            r.lastVerifyError = "";
            r.lastVerifyErrorAt = 0;
            r.lastCheckError = "";
            r.lastCheckErrorAt = 0;
            r.unverified = false;
            persist(r);
        }
    }

    public static void markVerifyError(Rec r, String msg) {
        synchronized (LOCK) {
            if (isAuthFailure(msg)) {
                r.lastVerifyError = msg;
                r.lastVerifyErrorAt = System.currentTimeMillis();
            } else {
                r.lastCheckError = msg;
                r.lastCheckErrorAt = System.currentTimeMillis();
            }
            persist(r);
        }
    }

    public static void markLimit(Rec r, long untilMs) {
        synchronized (LOCK) {
            r.limitUntilMs = untilMs;
            r.limitObservedAt = System.currentTimeMillis();
            persist(r);
        }
    }

    public static boolean isAuthFailure(String msg) {
        return msg != null && AUTH_FAIL.matcher(msg).find();
    }

    public static boolean isMutedText(String msg) {
        return msg != null && MUTED.matcher(msg).find();
    }

    /**
     * 请求前拦截：有「授权类」失败且比上次成功探活更晚 → 直接不发出请求。
     * 断网 / 超时 / 5xx / 429 不算（不能把健康账号锁住）。
     */
    public static String staleAuthAuth(Rec r) {
        return isStaleAuth(r);
    }

    public static String isStaleAuth(Rec r) {
        if (r == null) return null;
        if (r.lastVerifyError == null || r.lastVerifyError.isEmpty()) return null;
        if (r.lastVerifyErrorAt <= r.lastVerifiedAt) return null;
        if (!isAuthFailure(r.lastVerifyError)) return null;
        return r.lastVerifyError.isEmpty() ? "登录态已失效" : r.lastVerifyError;
    }

    public static boolean isLimited(Rec r) {
        return r != null && r.limitUntilMs > System.currentTimeMillis();
    }

    // ── 分组（只影响显示，删组不删账号）────────────────────
    public static JSONArray groupsJson() {
        JSONArray arr = new JSONArray();
        try {
            File f = new File(App.ctx().getFilesDir(), "groups.json");
            if (!f.exists()) return arr;
            String txt = read(f);
            JSONArray raw = new JSONArray(txt);
            for (int i = 0; i < raw.length(); i++) {
                JSONObject g = raw.optJSONObject(i);
                if (g != null) arr.put(g);
            }
        } catch (Exception ignored) {
        }
        return arr;
    }

    public static synchronized void addGroup(String name) {
        try {
            if (name == null || name.trim().isEmpty()) return;
            JSONArray arr = groupsJson();
            JSONObject g = new JSONObject();
            g.put("id", "grp_" + Long.toHexString(System.currentTimeMillis()).substring(4));
            g.put("name", name.trim());
            arr.put(g);
            write(new File(App.ctx().getFilesDir(), "groups.json"), arr.toString());
        } catch (Exception ignored) {
        }
    }

    public static synchronized void removeGroup(String id) {
        try {
            JSONArray arr = groupsJson();
            JSONArray out = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject g = arr.optJSONObject(i);
                if (g != null && !id.equals(g.optString("id"))) out.put(g);
            }
            write(new File(App.ctx().getFilesDir(), "groups.json"), out.toString());
            // 组没了，账号落回「未分组」
            for (Rec r : list()) {
                if (id.equals(r.groupId)) {
                    r.groupId = "";
                    persist(r);
                }
            }
        } catch (Exception ignored) {
        }
    }

    public static JSONArray views() {
        JSONArray arr = new JSONArray();
        for (Rec r : list()) arr.put(r.view());
        return arr;
    }

    public static JSONObject exportAll() {
        JSONObject o = new JSONObject();
        try {
            o.put("version", 1);
            o.put("exportedAt", System.currentTimeMillis());
            o.put("warning", "此文件含可完整登录的凭证（token + cookie），等同于账号本身，请勿分享或提交到仓库");
            JSONArray arr = new JSONArray();
            for (Rec r : list()) arr.put(r.toJson());
            o.put("accounts", arr);
            o.put("activeId", activeId);
        } catch (Exception ignored) {
        }
        return o;
    }

    public static int importAll(JSONObject pack) {
        JSONArray arr = pack.optJSONArray("accounts");
        if (arr == null) return 0;
        int n = 0;
        for (int i = 0; i < arr.length() && i < 500; i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            Rec r = Rec.from(o);
            if (!r.usable()) continue;
            r.id = "";
            upsert(r, r.label);
            n++;
        }
        return n;
    }

    /** 选下一个可用账号（跳过失效 / 限流 / 当前账号）。 */
    public static Rec nextUsable(String exceptId) {
        synchronized (LOCK) {
            List<Rec> all = new ArrayList<>(CACHE);
            for (Rec r : all) {
                if (r.id.equals(exceptId)) continue;
                if (!r.usable()) continue;
                if (isStaleAuth(r) != null) continue;
                if (isLimited(r)) continue;
                return r;
            }
            return null;
        }
    }

    public static String stat() {
        StringBuilder sb = new StringBuilder();
        sb.append(CACHE.size()).append(" 个账号");
        Rec a = active();
        if (a != null) sb.append(" · 当前 ").append(a.label.isEmpty() ? mask(a.userDisplay) : a.label);
        return sb.toString();
    }

    public static String mask(String s) {
        if (s == null || s.isEmpty()) return "未命名";
        if (s.length() <= 4) return s.charAt(0) + "***";
        return s.substring(0, 2) + "****" + s.substring(s.length() - 2);
    }

    public static String describeRemaining(long ms) {
        long left = ms - System.currentTimeMillis();
        if (left <= 0) return "已过期";
        long days = left / 86400000L;
        if (days >= 1) return "还剩 " + days + " 天";
        return "还剩 " + Math.max(1, left / 3600000L) + " 小时";
    }

    public static String shortId(String s) {
        return s == null ? "" : (s.length() <= 6 ? s : s.substring(0, 6));
    }

    public static String lower(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }

    public static final Comparator<Rec> BY_CAPTURE = (a, b) -> Long.compare(b.capturedAt, a.capturedAt);
}
