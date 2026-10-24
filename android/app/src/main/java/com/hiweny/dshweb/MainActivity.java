package com.hiweny.dshweb;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
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
 * 主界面：本地控制台（assets/console.html）+ 网页版登录页（同一个引擎 WebView）。
 * 深色/浅色自动适配，控制面板全部收在侧边栏里。
 */
public class MainActivity extends Activity {

    private FrameLayout content;
    private WebView console;
    private LinearLayout bottomBar;
    private TextView tabConsole, tabWeb;
    private int currentTab = 0;

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

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(isDark() ? 0xFF0B0E14 : 0xFFF5F6FA);

        content = new FrameLayout(this);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        root.addView(content, clp);

        bottomBar = buildBottomBar();
        root.addView(bottomBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(root);

        buildConsole();
        if (Cfg.autoStart() && !EngineService.running) EngineService.start(this);

        askNotifications();
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
        int pad = Star.dp(this, 8);
        bar.setPadding(Star.dp(this, 40), pad, Star.dp(this, 40), pad + Star.dp(this, 10));
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
            Engine.detachToOverlay();
            if (console != null) console.setVisibility(View.VISIBLE);
        } else {
            if (console != null) console.setVisibility(View.GONE);
            Engine.ensure(this);
            Engine.attachTo(content);
        }
    }

    @Override
    public void onBackPressed() {
        if (currentTab == 1) {
            if (Engine.view() != null && Engine.view().canGoBack()) {
                Engine.view().goBack();
                return;
            }
            switchTab(0);
            return;
        }
        if (console != null) {
            console.evaluateJavascript("window.__closeDrawer && window.__closeDrawer()", null);
        }
        moveTaskToBack(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (console != null) console.evaluateJavascript("window.__refresh && window.__refresh()", null);
        if (Cfg.floatBall() && Settings.canDrawOverlays(this)) Star.show(this);
    }

    @Override
    protected void onDestroy() {
        if (currentTab == 1) Engine.detachToOverlay();
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

    // ── 给控制台页面的桥 ─────────────────────────────────────
    class ConsoleBridge {

        @JavascriptInterface
        public String state() {
            try {
                JSONObject o = OpenAi.statusJson();
                o.put("theme", isDark() ? "dark" : "light");
                o.put("overlay", Settings.canDrawOverlays(MainActivity.this));
                JSONObject pm = new JSONObject();
                PowerManager p = (PowerManager) getSystemService(POWER_SERVICE);
                pm.put("ignoring", p != null && p.isIgnoringBatteryOptimizations(getPackageName()));
                o.put("battery", pm);
                o.put("lanIp", Net.ip(MainActivity.this));
                return o.toString();
            } catch (Exception e) {
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
                    Cfg.put(k, v instanceof Integer || v instanceof Boolean || v instanceof Long ? v : String.valueOf(v));
                }
                App.Lg.i("配置已保存: " + json);
                if (Cfg.floatBall()) {
                    Star.hide(MainActivity.this);
                    runOnUiThread(() -> Star.show(MainActivity.this));
                } else {
                    Star.hide(MainActivity.this);
                }
            } catch (Exception e) {
                App.Lg.w("保存配置失败: " + e);
            }
        }

        @JavascriptInterface
        public void startService() {
            runOnUiThread(() -> EngineService.start(MainActivity.this));
        }

        @JavascriptInterface
        public void stopService() {
            runOnUiThread(() -> EngineService.stop(MainActivity.this));
        }

        @JavascriptInterface
        public void restartService() {
            runOnUiThread(() -> {
                EngineService.stop(MainActivity.this);
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                        () -> EngineService.start(MainActivity.this), 700);
            });
        }

        @JavascriptInterface
        public String accounts() {
            return Auth.views().toString();
        }

        @JavascriptInterface
        public void setActive(String id) {
            Auth.setActive(id);
            runOnUiThread(() -> refreshUi());
        }

        @JavascriptInterface
        public void rename(String id, String label) {
            try {
                JSONObject p = new JSONObject();
                p.put("label", label);
                Auth.update(id, p);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void remove(String id) {
            Auth.remove(id);
        }

        @JavascriptInterface
        public String exportAccounts() {
            return Auth.exportAll().toString();
        }

        @JavascriptInterface
        public void importAccounts(String json) {
            try {
                Auth.importAll(new JSONObject(json));
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void captureLogin() {
            runOnUiThread(() -> switchTab(1));
        }

        @JavascriptInterface
        public String captureNow() {
            JSONObject r = Engine.call("capture", new JSONObject(), 15000);
            String token = r.optString("token", "");
            if (token.length() > 8) {
                Auth.Rec rec = new Auth.Rec();
                rec.token = token;
                rec.hifLeim = r.optString("hifLeim", "");
                rec.deviceId = r.optString("deviceId", "");
                rec.userAgent = r.optString("userAgent", Engine.userAgent);
                rec.capturedAt = System.currentTimeMillis();
                rec.cookie = Net.cookie();
                Auth.upsert(rec, "");
                Auth.Rec active = Auth.active();
                if (active != null) {
                    JSONObject a = new JSONObject();
                    try {
                        a.put("token", active.token);
                        a.put("deviceId", active.deviceId);
                        a.put("omitCookie", true);
                    } catch (Exception ignored) {
                    }
                    JSONObject u = Engine.call("usersCurrent", a, 20000);
                    String body = u.optString("body", "");
                    JSONObject j = Json.parseObjOrNull(body);
                    if (u.optInt("status", 0) == 200 && j != null) {
                        JSONObject data = j.optJSONObject("data");
                        JSONObject biz = data == null ? null : data.optJSONObject("biz_data");
                        if (biz != null && biz.optJSONObject("user") != null) {
                            JSONObject user = biz.optJSONObject("user");
                            active.userId = user.optString("id", user.optString("user_id", ""));
                            String name = user.optString("name", user.optString("display", ""));
                            if (!name.isEmpty()) active.userDisplay = name;
                            Auth.upsert(active, active.label);
                        }
                        Auth.markVerified(active);
                    } else {
                        Auth.markVerifyError(active, "HTTP " + u.optInt("status", 0) + " " + Auth.shortId(body));
                    }
                }
            }
            JSONObject out = new JSONObject();
            try {
                out.put("ok", token.length() > 8);
                out.put("tokenLen", token.length());
                out.put("msg", token.length() > 8 ? "已捕获登录态" : "页面里没有找到 userToken，请先登录");
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        @JavascriptInterface
        public String probeAll() {
            int ok = 0, fail = 0;
            for (Auth.Rec r : Auth.list()) {
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
            }
            return "{\"ok\":" + ok + ",\"fail\":" + fail + "}";
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
            runOnUiThread(() -> requestOverlay());
        }

        @JavascriptInterface
        public void requestBatteryPerm() {
            runOnUiThread(() -> requestBattery());
        }

        @JavascriptInterface
        public void testPing() {
            Engine.call("ping", new JSONObject(), 8000);
        }

        @JavascriptInterface
        public String logs() {
            return App.Lg.tail(30000);
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
            runOnUiThread(() -> android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void openConsoleUrl() {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("http://127.0.0.1:" + Cfg.port() + "/health"));
                startActivity(i);
            } catch (Exception ignored) {
            }
        }
    }

    private void refreshUi() {
        if (console != null) console.evaluateJavascript("window.__refresh && window.__refresh()", null);
    }
}
