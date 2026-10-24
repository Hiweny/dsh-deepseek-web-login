package com.hiweny.dshweb;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 页面引擎：一个常驻的 WebView 停在 chat.deepseek.com 上，作为
 *  「真实浏览器网络栈 + 官方 PoW 求解器 + 页面 fetch 执行器」。
 *
 * 这不是 DOM 自动化：我们不点按钮、不读页面结构，只把请求交给页面 fetch，
 * 因此 TLS/HTTP2 指纹、cookie、x-hif 反爬头都与真实浏览器一致（这是上游 dsh 的
 * chromium 传输层在桌面端的等价做法，APK 里 WebView 就是那个「真实页面」）。
 */
public final class Engine {

    public interface Cb {
        void on(JSONObject ev);
    }

    public interface Stream {
        void on(String type, JSONObject ev);
    }

    public static final String SITE = "https://chat.deepseek.com/";

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<String, Cb> ONESHOT = new ConcurrentHashMap<>();
    private static final Map<String, Stream> STREAMS = new ConcurrentHashMap<>();
    private static final Map<String, Long> STARTED = new ConcurrentHashMap<>();

    private static volatile WebView wv;
    private static volatile boolean pageReady = false;
    private static volatile boolean overlayAttached = false;
    private static volatile String lastPageError = "";
    private static volatile long lastInjectAt = 0;
    public static volatile String userAgent = "";

    private Engine() {
    }

    public static boolean ready() {
        return wv != null && pageReady;
    }

    public static String state() {
        if (wv == null) return "未创建";
        if (!pageReady) return "加载中" + (lastPageError.isEmpty() ? "" : "（" + lastPageError + "）");
        return "就绪";
    }

    public static WebView view() {
        return wv;
    }

    /** 建 WebView 并加载站点（幂等，必须在主线程调用路径上）。 */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    public static void ensure(final Context ctx) {
        MAIN.post(() -> {
            if (wv != null) return;
            try {
                WebView v = new WebView(ctx);
                WebSettings s = v.getSettings();
                s.setJavaScriptEnabled(true);
                s.setDomStorageEnabled(true);
                s.setDatabaseEnabled(true);
                s.setAllowFileAccess(false);
                s.setAllowContentAccess(false);
                s.setLoadsImagesAutomatically(true);
                s.setCacheMode(WebSettings.LOAD_DEFAULT);
                s.setMediaPlaybackRequiresUserGesture(true);
                s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
                userAgent = s.getUserAgentString();
                CookieManager.getInstance().setAcceptCookie(true);
                CookieManager.getInstance().setAcceptThirdPartyCookies(v, true);

                v.addJavascriptInterface(new Bridge(), "DSHBridge");
                v.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                        String u = req.getUrl() == null ? "" : req.getUrl().toString();
                        return !(u.contains("deepseek.com"));
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        pageReady = true;
                        lastPageError = "";
                        App.Lg.i("页面加载完成: " + url);
                        inject(view);
                        // 站点是 SPA，路由变化后也补一次（幂等：脚本自己判重）
                        MAIN.postDelayed(() -> inject(view), 2500);
                        MAIN.postDelayed(() -> inject(view), 8000);
                    }

                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                        if (req != null && req.isForMainFrame()) {
                            lastPageError = String.valueOf(err.getDescription());
                            App.Lg.w("页面错误: " + lastPageError);
                        }
                    }
                });
                v.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public boolean onConsoleMessage(ConsoleMessage m) {
                        String t = m.message();
                        if (t != null && (t.contains("[DSH]") || m.messageLevel() == ConsoleMessage.MessageLevel.ERROR)) {
                            App.Lg.i("console: " + t);
                        }
                        return true;
                    }
                });
                wv = v;
                v.loadUrl(SITE);
                attachOverlay(ctx, v);
                App.Lg.i("WebView 已创建 UA=" + userAgent);
            } catch (Throwable e) {
                App.Lg.e("WebView 创建失败: " + e);
                lastPageError = String.valueOf(e.getMessage());
            }
        });
    }

    /** 用 1x1 的不可见 overlay 把 WebView 挂上（后台也能跑 JS，需要悬浮窗权限）。 */
    private static void attachOverlay(Context ctx, WebView v) {
        try {
            if (android.provider.Settings.canDrawOverlays(ctx)) {
                WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
                WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                        2, 2,
                        android.os.Build.VERSION.SDK_INT >= 26
                                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                                : WindowManager.LayoutParams.TYPE_PHONE,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                        android.graphics.PixelFormat.TRANSLUCENT);
                lp.alpha = 0.01f;
                lp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
                lp.x = 0;
                lp.y = 0;
                wm.addView(v, lp);
                overlayWm = wm;
                overlayAttached = true;
                App.Lg.i("WebView 已挂到 overlay（后台可执行）");
            }
        } catch (Throwable e) {
            App.Lg.w("overlay 挂载失败（退回 Activity 承载）: " + e);
        }
    }

    public static boolean hasOverlay() {
        return overlayAttached;
    }

    private static WindowManager overlayWm;

    /** 把同一个 WebView 挂进 Activity 容器（登录/查看网页版）。 */
    public static void attachTo(final android.view.ViewGroup parent) {
        MAIN.post(() -> {
            try {
                WebView v = wv;
                if (v == null) {
                    ensure(parent.getContext());
                    return;
                }
                if (overlayWm != null) {
                    try {
                        overlayWm.removeView(v);
                    } catch (Throwable ignored) {
                    }
                    overlayAttached = false;
                }
                if (v.getParent() instanceof android.view.ViewGroup) {
                    ((android.view.ViewGroup) v.getParent()).removeView(v);
                }
                android.view.ViewGroup.LayoutParams lp = new android.view.ViewGroup.LayoutParams(
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT);
                parent.addView(v, lp);
                v.onResume();
                v.resumeTimers();
            } catch (Throwable e) {
                App.Lg.e("attachTo 失败: " + e);
            }
        });
    }

    /** 从 Activity 容器摘下来，重新挂回不可见 overlay（保证后台还能跑）。 */
    public static void detachToOverlay() {
        MAIN.post(() -> {
            try {
                WebView v = wv;
                if (v == null) return;
                // 没有悬浮窗权限时**不要**把它从界面上摘下来：摘掉之后 WebView 失去宿主，
                // 页面会停止调度，后台请求就发不出去了。宁可留在 Activity 里。
                if (!android.provider.Settings.canDrawOverlays(App.ctx())) {
                    v.resumeTimers();
                    return;
                }
                if (v.getParent() instanceof android.view.ViewGroup) {
                    ((android.view.ViewGroup) v.getParent()).removeView(v);
                }
                attachOverlay(App.ctx(), v);
                v.resumeTimers();
            } catch (Throwable e) {
                App.Lg.w("detachToOverlay: " + e);
            }
        });
    }

    /** 注入驱动脚本（幂等，脚本自带 __DSH_LOADED 判重）。 */
    public static void inject(WebView view) {
        if (view == null) return;
        try {
            if (System.currentTimeMillis() - lastInjectAt < 1200) return;
            lastInjectAt = System.currentTimeMillis();
            String js = Assets.read(view.getContext(), "dsh.js");
            if (js == null || js.isEmpty()) {
                App.Lg.e("assets/dsh.js 读取失败");
                return;
            }
            view.evaluateJavascript(js, null);
        } catch (Exception e) {
            App.Lg.e("注入失败: " + e);
        }
    }

    public static void reload() {
        MAIN.post(() -> {
            pageReady = false;
            if (wv != null) wv.reload();
        });
    }

    public static void resumeTimers() {
        MAIN.post(() -> {
            try {
                if (wv != null) {
                    wv.onResume();
                    wv.resumeTimers();
                }
            } catch (Exception ignored) {
            }
        });
    }

    // ── 调用通道 ─────────────────────────────────────────────
    /** 一次性调用（等待结果或超时）。 */
    public static JSONObject call(String method, JSONObject args, long timeoutMs) {
        if (!ready()) ensure(App.ctx());
        final String id = "r" + Long.toHexString(System.nanoTime());
        final CountDownLatch latch = new CountDownLatch(1);
        final JSONObject[] box = new JSONObject[1];
        ONESHOT.put(id, ev -> {
            box[0] = ev;
            latch.countDown();
        });
        STARTED.put(id, System.currentTimeMillis());
        boolean sent = send(id, method, args);
        if (!sent) {
            ONESHOT.remove(id);
            STARTED.remove(id);
            JSONObject err = new JSONObject();
            try {
                err.put("t", "error");
                err.put("code", "ENGINE");
                err.put("msg", "页面未就绪（" + state() + "）");
            } catch (Exception ignored) {
            }
            return err;
        }
        try {
            if (!latch.await(Math.max(3000, timeoutMs), TimeUnit.MILLISECONDS)) {
                JSONObject err = new JSONObject();
                try {
                    err.put("t", "error");
                    err.put("code", "TIMEOUT");
                    err.put("msg", "页面调用超时（" + method + "）");
                } catch (Exception ignored) {
                }
                return err;
            }
            return box[0] == null ? new JSONObject() : box[0];
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new JSONObject();
        } finally {
            ONESHOT.remove(id);
            STARTED.remove(id);
        }
    }

    /** 流式调用：JS 每产出一个事件回调一次；return 后仍会继续收，直到 end/error。 */
    public static boolean stream(final String id, String method, JSONObject args, Stream sink) {
        if (!ready()) ensure(App.ctx());
        STREAMS.put(id, sink);
        STARTED.put(id, System.currentTimeMillis());
        boolean ok = send(id, method, args);
        if (!ok) {
            STREAMS.remove(id);
            JSONObject err = new JSONObject();
            try {
                err.put("t", "error");
                err.put("code", "ENGINE");
                err.put("msg", "页面未就绪（" + state() + "）");
            } catch (Exception ignored) {
            }
            sink.on("error", err);
            return false;
        }
        return true;
    }

    public static void cancel(String id) {
        STREAMS.remove(id);
        ONESHOT.remove(id);
        eval("window.__DSH && window.__DSH.cancel && window.__DSH.cancel(" + JSONObject.quote(id) + ")");
    }

    private static boolean send(String id, String method, JSONObject args) {
        final WebView v = wv;
        if (v == null) {
            ensure(App.ctx());
            return false;
        }
        final String js = "(function(){try{if(!window.__DSH){return 'no';}"
                + "window.__DSH.run(" + JSONObject.quote(id) + "," + JSONObject.quote(method) + ","
                + JSONObject.quote(args == null ? "{}" : args.toString()) + ");return 'ok';"
                + "}catch(e){return 'err:'+e.message}})()";
        MAIN.post(() -> {
            try {
                v.evaluateJavascript(js, null);
                v.resumeTimers();
            } catch (Throwable e) {
                App.Lg.e("evaluateJavascript 失败: " + e.getMessage());
            }
        });
        return true;
    }

    static void eval(String js) {
        MAIN.post(() -> {
            try {
                if (wv != null) wv.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    // ── JS → Java ────────────────────────────────────────────
    public static void onEvent(String reqId, String json) {
        JSONObject ev = Json.obj(json);
        if (ev == null) return;
        String t = ev.optString("t");
        Cb cb = ONESHOT.get(reqId);
        if (cb != null) {
            boolean terminal = "ok".equals(t) || "error".equals(t) || "pow".equals(t)
                    || "session".equals(t) || "user".equals(t) || "pong".equals(t);
            if (terminal) {
                ONESHOT.remove(reqId);
                STARTED.remove(reqId);
                cb.on(ev);
            }
            return;
        }
        Stream s = STREAMS.get(reqId);
        if (s != null) {
            STARTED.put(reqId, System.currentTimeMillis());
            s.on(t, ev);
            if ("end".equals(t) || "error".equals(t)) STREAMS.remove(reqId);
        }
    }

    public static final class Bridge {
        @JavascriptInterface
        public void emit(String reqId, String json) {
            try {
                onEvent(reqId, json);
            } catch (Throwable e) {
                App.Lg.e("bridge 异常: " + e);
            }
        }

        @JavascriptInterface
        public void log(String msg) {
            App.Lg.i("JS " + msg);
        }

        @JavascriptInterface
        public String meta() {
            JSONObject o = new JSONObject();
            try {
                o.put("wasmUrl", Auth.DEFAULT_WASM);
                o.put("clientVersion", Cfg.getStr("client_version", "2.5.0"));
            } catch (Exception ignored) {
            }
            return o.toString();
        }
    }

    /** 资源读取。 */
    public static final class Assets {
        public static String read(Context c, String name) {
            try {
                java.io.InputStream in = c.getAssets().open(name);
                byte[] buf = new byte[in.available()];
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n < 0) break;
                    off += n;
                }
                in.close();
                return new String(buf, 0, off, "UTF-8");
            } catch (Exception e) {
                return "";
            }
        }
    }

    public static int pending() {
        return ONESHOT.size() + STREAMS.size();
    }

    public static void dropAll() {
        ONESHOT.clear();
        STREAMS.clear();
    }
}
