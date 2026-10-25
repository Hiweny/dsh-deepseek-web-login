package com.hiweny.dshweb;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 主界面：本地控制台（console.html）+ 网页版登录页（同一个引擎 WebView）。
 *
 * ⚠️ 两个坑（都曾表现为「整个 App 卡死」）：
 *  1. ConsoleBridge 的方法跑在 WebView 的 JavaBridge **单线程**上，绝不能在里面
 *     同步等 Engine.call（回不来）。所有调用都走 callAsync，结果用 __ev 推回页面。
 *  2. 引擎 WebView 不能在切回控制台时继续盖在 console 上面（会白屏/点不动）。
 *     主界面有一个 1×1、屏幕外的 holder 专门放它。
 */
public class MainActivity extends Activity {

    private FrameLayout rootView;
    private FrameLayout content;
    private FrameLayout holder;
    private WebView console;
    private LinearLayout bottomBar;
    private TextView tabConsole, tabWeb;
    private int currentTab = 0;

    private static JSONObject sCached = null;
    private static long sCachedAt = 0;

    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Cfg.init(this);
        Auth.init(this);
        Usage.init(this);

        Window w = getWindow();
        w.setStatusBarColor(0x00000000);
        w.setNavigationBarColor(0x00000000);
        if (Build.VERSION.SDK_INT >= 23) {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }

        rootView = new FrameLayout(this);
        rootView.setBackgroundColor(isDark() ? 0xFF0B0E14 : 0xFFF5F6FA);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        content = new FrameLayout(this);
        col.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        bottomBar = buildBottomBar();
        col.addView(bottomBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        rootView.addView(col, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 1×1 隐藏容器：引擎 WebView 待在这里（看不见但页面在跑）
        holder = new FrameLayout(this);
        FrameLayout.LayoutParams hlp = new FrameLayout.LayoutParams(1, 1);
        hlp.gravity = Gravity.TOP | Gravity.START;
        hlp.leftMargin = -20;
        hlp.topMargin = -20;
        rootView.addView(holder, hlp);
        Engine.setHolder(holder);

        setContentView(rootView);

        buildConsole();
        Engine.ensure(this);
        if (Cfg.autoStart() && !EngineService.running) EngineService.start(this);
        askNotifications();
        handleIntent(getIntent());
    }

    private boolean isDark() {
        String t = Cfg.theme();
        if ("dark".equals(t)) return true;
        if ("light".equals(t)) return false;
        int mode = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    private LinearLayout buildBottomBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        int pad = Star.dp(this, 6);
        bar.setPadding(Star.dp(this, 40), pad, Star.dp(this, 40), pad + Star.dp(this, 8));
        bar.setBackgroundColor(isDark() ? 0xFF0E121B : 0xFFFFFFFF);

        tabConsole = tab("控制台", true);
        tabWeb = tab("网页版", false);
        bar.addView(tabConsole);
        bar.addView(tabWeb);
        tabConsole.setOnClickListener(v -> switchTab(0));
        tabWeb.setOnClickListener(v -> switchTab(1));
        return bar;
    }

    private TextView tab(String text, boolean active) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(13);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, Star.dp(this, 10), 0, Star.dp(this, 10));
        t.setTextColor(active ? 0xFFA78BFA : (isDark() ? 0xFF7C8598 : 0xFF8A90A0));
        t.setTypeface(active ? android.graphics.Typeface.DEFAULT_BOLD : android.graphics.Typeface.DEFAULT);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        t.setLayoutParams(lp);
        return t;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void buildConsole() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        w.setBackgroundColor(isDark() ? 0xFF0B0E14 : 0xFFF5F6FA);
        w.addJavascriptInterface(new ConsoleBridge(), "Android");
        w.setWebChromeClient(new WebChromeClient());
        w.setWebViewClient(new WebViewClient());
        w.loadUrl("file:///android_asset/console.html");
        console = w;
        content.addView(w, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void switchTab(int tab) {
        currentTab = tab;
        tabConsole.setTextColor(tab == 0 ? 0xFFA78BFA : (isDark() ? 0xFF7C8598 : 0xFF8A90A0));
        tabWeb.setTextColor(tab == 1 ? 0xFFA78BFA : (isDark() ? 0xFF7C8598 : 0xFF8A90A0));
        if (tab == 0) {
            Engine.detachToPark();
            if (console != null) {
                console.setVisibility(View.VISIBLE);
                console.bringToFront();
            }
        } else {
            if (console != null) console.setVisibility(View.GONE);
            Engine.ensure(this);
            Engine.attachTo(content);
        }
    }

    @Override
    public void onBackPressed() {
        if (currentTab == 1) {
            WebView v = Engine.view();
            if (v != null && v.canGoBack()) {
                v.goBack();
                return;
            }
            switchTab(0);
            return;
        }
        if (console != null) console.evaluateJavascript("window.__closeDrawer && window.__closeDrawer()", null);
        moveTaskToBack(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Engine.resumeTimers();
        push("refresh", "{}");
        if (Cfg.floatBall() && Settings.canDrawOverlays(this)) Star.show(this);
    }

    @Override
    protected void onDestroy() {
        if (currentTab == 1) Engine.detachToPark();
        if (console != null) {
            try {
                content.removeView(console);
                console.destroy();
            } catch (Exception ignored) {
            }
            console = null;
        }
        super.onDestroy();
    }

    private void askNotifications() {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 71);
            }
        } catch (Exception ignored) {
        }
    }

    public void requestOverlay() {
        try {
            if (!Settings.canDrawOverlays(this)) {
                Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()));
                startActivityForResult(i, 72);
            }
        } catch (Exception e) {
            App.Lg.w("悬浮窗权限页打不开: " + e);
        }
    }

    public void requestBattery() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName()));
                startActivity(i);
            }
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
            }
        }
    }

    /** 给网页推事件（在 UI 线程）。 */
    private void push(String name, String json) {
        ui.post(() -> {
            try {
                if (console != null) {
                    console.evaluateJavascript("window.__ev && window.__ev(" + JSONObject.quote(name) + ","
                            + JSONObject.quote(json) + ")", null);
                }
            } catch (Exception ignored) {
            }
        });
    }

    private void handleIntent(Intent it) {
        if (it == null) return;
        String token = it.getStringExtra("token");
        if (token != null && token.trim().length() > 8) {
            importTokenAsync(token.trim());
        }
        String cookie = it.getStringExtra("cookie");
        if (cookie != null && !cookie.trim().isEmpty()) {
            try {
                CookieManagerCompat.set(SITE_COOKIE_URL, cookie.trim());
                push("toast", "{\"msg\":\"cookie 已写入，稍后点捕获\"}");
            } catch (Exception ignored) {
            }
        }
    }

    private static final String SITE_COOKIE_URL = "https://chat.deepseek.com";

    private String deviceId() {
        try {
            String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
            return "dsh-" + (androidId == null ? "dev" : androidId);
        } catch (Exception e) {
            return "dsh-" + Long.toHexString(System.currentTimeMillis());
        }
    }

    /** 导入 token（异步校验，绝不阻塞调用线程）。 */
    public void importTokenAsync(final String token) {
        Engine.callAsync("capture", new JSONObject(), 15000, ev -> {
            Auth.Rec r = new Auth.Rec();
            r.token = token;
            r.hifLeim = ev.optString("hifLeim", "");
            r.deviceId = ev.optString("deviceId", "");
            r.userAgent = ev.optString("userAgent", Engine.userAgent);
            r.cookie = Net.cookie();
            r.capturedAt = System.currentTimeMillis();
            Auth.upsert(r, "手动导入");
            final Auth.Rec acc = Auth.active();
            if (acc != null) verify(acc, "import");
        });
    }

    /** 探活一个账号（异步）。 */
    private void verify(final Auth.Rec acc, final String tag) {
        JSONObject a = new JSONObject();
        try {
            a.put("token", acc.token);
            a.put("deviceId", acc.deviceId == null ? "" : acc.deviceId);
            a.put("omitCookie", true);
        } catch (Exception ignored) {
        }
        Engine.callAsync("usersCurrent", a, 20000, u -> {
            int status = u.optInt("status", 0);
            String body = u.optString("body", "");
            if (status == 200) {
                JSONObject j = Json.parseObjOrNull(body);
                if (j != null) {
                    JSONObject data = j.optJSONObject("data");
                    JSONObject biz = data == null ? null : data.optJSONObject("biz_data");
                    if (biz != null) {
                        JSONObject user = biz.optJSONObject("user");
                        if (user != null) {
                            acc.userId = user.optString("id", user.optString("user_id", ""));
                            String name = user.optString("name", user.optString("display", ""));
                            if (!name.isEmpty()) acc.userDisplay = name;
                        }
                        JSONObject chat = biz.optJSONObject("chat");
                        if (chat != null && chat.optBoolean("is_muted")) {
                            long until = chat.optLong("mute_until", 0) * 1000L;
                            if (until > 0) Auth.markLimit(acc, until);
                        }
                    }
                }
                Auth.markVerified(acc);
                if ("import".equals(tag)) push("toast", "{\"msg\":\"token 有效，已加入账号库\"}");
            } else {
                Auth.markVerifyError(acc, "HTTP " + status + " " + Auth.shortId(body));
                if ("import".equals(tag)) push("toast", "{\"msg\":\"token 校验失败：HTTP " + status + "\"}");
            }
            push("refresh", "{}");
        });
    }

    /** 控制台用状态（带 1.5s 缓存 —— 每次都统计 30 天用量会卡住页面）。 */
    private JSONObject statusCached() {
        long now = System.currentTimeMillis();
        if (sCached != null && now - sCachedAt < 1500) return sCached;
        JSONObject o = OpenAi.statusJson();
        try {
            o.put("theme", isDark() ? "dark" : "light");
            o.put("overlay", Settings.canDrawOverlays(this));
            JSONObject pm = new JSONObject();
            PowerManager p = (PowerManager) getSystemService(POWER_SERVICE);
            pm.put("ignoring", p != null && p.isIgnoringBatteryOptimizations(getPackageName()));
            o.put("battery", pm);
            o.put("lanIp", Net.ip(this));
            JSONArray recent = new JSONArray();
            for (String line : Usage.recentLines(20)) {
                JSONObject r = Json.obj(line);
                if (r != null) recent.put(r);
            }
            o.put("recent", recent);
            o.put("groups", Auth.groupsJson());
        } catch (Exception ignored) {
        }
        sCached = o;
        sCachedAt = now;
        return o;
    }

    // ── 给控制台页面的桥（全部非阻塞）────────────────────────
    class ConsoleBridge {

        @JavascriptInterface
        public String state() {
            try {
                return statusCached().toString();
            } catch (Throwable e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String cfg() {
            return Cfg.snapshot().toString();
        }

        @JavascriptInterface
        public void save(String json) {
            try {
                JSONObject o = new JSONObject(json);
                java.util.Iterator<String> it = o.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    Object v = o.opt(k);
                    if (v == null) continue;
                    Cfg.put(k, (v instanceof Number || v instanceof Boolean) ? v : String.valueOf(v));
                }
                sCached = null;
                App.Lg.i("配置已保存: " + json);
                ui.post(() -> {
                    Star.hide(MainActivity.this);
                    if (Cfg.floatBall()) Star.show(MainActivity.this);
                });
            } catch (Exception e) {
                App.Lg.w("保存配置失败: " + e);
            }
        }

        @JavascriptInterface
        public void startService() {
            ui.post(() -> EngineService.start(MainActivity.this));
        }

        @JavascriptInterface
        public void stopService() {
            ui.post(() -> EngineService.stop(MainActivity.this));
        }

        @JavascriptInterface
        public void restartService() {
            ui.post(() -> {
                EngineService.stop(MainActivity.this);
                ui.postDelayed(() -> EngineService.start(MainActivity.this), 700);
            });
        }

        @JavascriptInterface
        public String accounts() {
            return Auth.views().toString();
        }

        @JavascriptInterface
        public void setActive(String id) {
            Auth.setActive(id);
            sCached = null;
            push("refresh", "{}");
        }

        @JavascriptInterface
        public void rename(String id, String label) {
            try {
                JSONObject p = new JSONObject();
                p.put("label", label);
                Auth.update(id, p);
                push("refresh", "{}");
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void setGroup(String id, String group) {
            try {
                JSONObject p = new JSONObject();
                p.put("groupId", group);
                Auth.update(id, p);
                push("refresh", "{}");
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void remove(String id) {
            Auth.remove(id);
            sCached = null;
            push("refresh", "{}");
        }

        @JavascriptInterface
        public String exportAccounts() {
            return Auth.exportAll().toString();
        }

        @JavascriptInterface
        public void importAccounts(String json) {
            try {
                int n = Auth.importAll(new JSONObject(json));
                push("toast", "{\"msg\":\"已导入 " + n + " 个账号\"}");
                push("refresh", "{}");
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void captureLogin() {
            ui.post(() -> switchTab(1));
        }

        /** 从页面里抓登录态（异步）。 */
        @JavascriptInterface
        public void captureNow() {
            Engine.callAsync("capture", new JSONObject(), 20000, ev -> {
                String token = ev.optString("token", "");
                if (token.length() > 8) {
                    Auth.Rec r = new Auth.Rec();
                    r.token = token;
                    r.hifLeim = ev.optString("hifLeim", "");
                    r.deviceId = ev.optString("deviceId", "");
                    r.userAgent = ev.optString("userAgent", Engine.userAgent);
                    r.cookie = Net.cookie();
                    r.capturedAt = System.currentTimeMillis();
                    Auth.upsert(r, "");
                    Auth.Rec acc = Auth.active();
                    if (acc != null) verify(acc, "capture");
                    push("capture", "{\"ok\":true,\"tokenLen\":" + token.length() + ",\"msg\":\"已捕获登录态\"}");
                } else {
                    push("capture", "{\"ok\":false,\"msg\":\"页面里没有找到 token —— 请确认已登录（登录后等 2 秒再点）\"}");
                }
                push("refresh", "{}");
            });
        }

        /** 只写 cookie（有些账号/节点需要 cookie 上下文）。 */
        @JavascriptInterface
        public void setCookie(String cookie) {
            try {
                CookieManagerCompat.set(SITE_COOKIE_URL, cookie);
                push("toast", "{\"msg\":\"cookie 已写入\"}");
            } catch (Exception e) {
                push("toast", "{\"msg\":\"cookie 写入失败\"}");
            }
        }

        @JavascriptInterface
        public void probeAll() {
            final java.util.List<Auth.Rec> list = Auth.list();
            if (list.isEmpty()) {
                push("probe", "{\"done\":true,\"ok\":0,\"fail\":0,\"msg\":\"没有账号\"}");
                return;
            }
            new Thread(() -> {
                int ok = 0, fail = 0, i = 0;
                for (Auth.Rec r : list) {
                    i++;
                    JSONObject a = new JSONObject();
                    try {
                        a.put("token", r.token);
                        a.put("deviceId", r.deviceId == null ? "" : r.deviceId);
                        a.put("omitCookie", true);
                    } catch (Exception ignored) {
                    }
                    JSONObject u = Engine.call("usersCurrent", a, 20000);
                    if (u.optInt("status", 0) == 200) {
                        Auth.markVerified(r);
                        ok++;
                    } else {
                        Auth.markVerifyError(r, "HTTP " + u.optInt("status", 0) + " " + Auth.shortId(u.optString("body", "")));
                        fail++;
                    }
                    push("probe", "{\"done\":false,\"ok\":" + ok + ",\"fail\":" + fail + ",\"total\":" + list.size() + ",\"at\":" + i + "}");
                }
                push("probe", "{\"done\":true,\"ok\":" + ok + ",\"fail\":" + fail + ",\"total\":" + list.size() + "}");
                push("refresh", "{}");
            }, "probe-all").start();
        }

        /** 诊断：页面/鉴权/PoW/建会话 四项，零额度（不消耗生成）。 */
        @JavascriptInterface
        public void diagnose() {
            new Thread(() -> {
                StringBuilder sb = new StringBuilder();
                JSONObject ping = Engine.call("ping", new JSONObject(), 8000);
                sb.append("页面 ").append(ping.optString("t").equals("pong") ? "✓ 就绪" : "✗ " + ping.optString("msg")).append("\n");
                sb.append("页面 token 长度 ").append(ping.optInt("token", 0)).append("\n");
                Auth.Rec acc = Auth.active();
                if (acc == null) {
                    sb.append("账号 ✗ 没有可用的登录态\n");
                } else {
                    sb.append("账号 ").append(acc.label.isEmpty() ? acc.id : acc.label).append(" token ").append(acc.token.length()).append(" 字符\n");
                    JSONObject a = new JSONObject();
                    try {
                        a.put("token", acc.token);
                        a.put("deviceId", acc.deviceId == null ? "" : acc.deviceId);
                        a.put("omitCookie", true);
                        a.put("targetPath", "/api/v0/chat/completion");
                    } catch (Exception ignored) {
                    }
                    JSONObject u = Engine.call("usersCurrent", a, 20000);
                    sb.append("鉴权 ").append(u.optInt("status", 0) == 200 ? "✓ users/current 200" : "✗ HTTP " + u.optInt("status", 0)).append("\n");
                    JSONObject pow = Engine.call("pow", a, 30000);
                    sb.append("PoW ").append(pow.optBoolean("ok") ? "✓ 求解成功（" + Auth.shortId(pow.optString("header")) + "…）" : "✗ " + pow.optString("msg")).append("\n");
                    JSONObject s = Engine.call("sessionCreate", a, 20000);
                    String sid = s.optString("id", "");
                    sb.append("会话 ").append(!sid.isEmpty() ? "✓ " + Auth.shortId(sid) : "✗ " + s.optString("msg")).append("\n");
                    if (!sid.isEmpty()) {
                        JSONObject d = new JSONObject();
                        try {
                            d.put("token", acc.token);
                            d.put("deviceId", acc.deviceId == null ? "" : acc.deviceId);
                            d.put("sessionId", sid);
                            d.put("omitCookie", true);
                        } catch (Exception ignored) {
                        }
                        Engine.call("sessionDelete", d, 15000);
                    }
                }
                push("diag", "{\"text\":" + JSONObject.quote(sb.toString()) + "}");
                push("refresh", "{}");
            }, "diag").start();
        }

        @JavascriptInterface
        public String recentCalls() {
            StringBuilder sb = new StringBuilder("[");
            for (String line : Usage.recentLines(30)) {
                if (sb.length() > 1) sb.append(',');
                sb.append(line);
            }
            return sb.append(']').toString();
        }

        @JavascriptInterface
        public void requestOverlayPerm() {
            ui.post(() -> requestOverlay());
        }

        @JavascriptInterface
        public void requestBatteryPerm() {
            ui.post(() -> requestBattery());
        }

        @JavascriptInterface
        public void testPing() {
            Engine.callAsync("ping", new JSONObject(), 8000, ev -> push("toast",
                    "{\"msg\":\"" + ("pong".equals(ev.optString("t")) ? "页面就绪" : "页面未就绪：" + ev.optString("msg")) + "\"}"));
        }

        @JavascriptInterface
        public String logs() {
            return App.Lg.tail(24000);
        }

        @JavascriptInterface
        public void clearLogs() {
            App.Lg.clear();
        }

        @JavascriptInterface
        public void reloadPage() {
            Engine.reload();
        }

        @JavascriptInterface
        public void toast(String msg) {
            ui.post(() -> android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String groupList() {
            return Auth.groupsJson().toString();
        }

        @JavascriptInterface
        public void addGroup(String name) {
            Auth.addGroup(name);
            push("refresh", "{}");
        }

        @JavascriptInterface
        public void removeGroup(String id) {
            Auth.removeGroup(id);
            push("refresh", "{}");
        }
    }

    /** CookieManager 小封装。 */
    static final class CookieManagerCompat {
        static void set(String url, String cookie) {
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            cm.setAcceptCookie(true);
            for (String part : cookie.split(";")) {
                String p = part.trim();
                if (p.isEmpty()) continue;
                int eq = p.indexOf('=');
                if (eq <= 0) continue;
                String name = p.substring(0, eq).trim();
                String value = p.substring(eq + 1).trim();
                cm.setCookie(url, name + "=" + value + "; path=/; domain=.deepseek.com");
                cm.setCookie(url, name + "=" + value + "; path=/");
            }
            cm.flush();
        }
    }
}
