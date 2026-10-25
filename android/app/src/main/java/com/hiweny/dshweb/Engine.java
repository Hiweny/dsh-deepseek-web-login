package com.hiweny.dshweb;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 页面引擎：一个常驻 WebView 停在 chat.deepseek.com，作为
 * 「真实浏览器网络栈 + 官方 PoW 求解器 + 页面 fetch 执行器」。
 *
 * ⚠️ 线程模型（曾经把整个 App 卡死的坑）：
 *  WebView 的 JavaBridge 线程是**单线程**，`DSHBridge.emit`（JS→Java）和
 *  `@JavascriptInterface` 方法（Java←JS）都跑在它上面。只要在 bridge 回调里
 *  同步等待另一次 JS 调用（Engine.call 里的 latch.await），就会自己把自己锁死。
 *  所以：① bridge 线程只做分发，所有业务回调都丢给 DISPATCH 单线程执行；
 *       ② 对外提供 callAsync，禁止在 bridge/主线程里同步 call。
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
    /** 业务回调线程（流事件、一次性回调都在这里跑，保证顺序）。 */
    private static final ExecutorService DISPATCH = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "js-dispatch");
        t.setDaemon(true);
        return t;
    });
    /**
     * 主动调用的线程池。⚠️ 必须与 DISPATCH 分开：
     * callAsync 会阻塞等回调，而回调是投递给 DISPATCH 的 —— 两者共用一个线程就自己把自己锁死。
     */
    private static final ExecutorService CALLS = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "js-call");
        t.setDaemon(true);
        return t;
    });
    private static final Map<String, Cb> ONESHOT = new ConcurrentHashMap<>();
    private static final Map<String, Stream> STREAMS = new ConcurrentHashMap<>();

    private static volatile WebView wv;
    private static volatile boolean pageReady = false;
    private static volatile boolean overlayAttached = false;
    private static volatile String lastPageError = "";
    private static volatile long lastInjectAt = 0;
    private static volatile ViewGroup holder;      // MainActivity 提供的 1x1 隐藏容器
    private static volatile WindowManager overlayWm;
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

    public static void setHolder(ViewGroup h) {
        holder = h;
    }

    /** 建 WebView 并加载站点（幂等）。 */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    public static void ensure(final Context ctx) {
        MAIN.post(() -> {
            if (wv != null) return;
            try {
                WebView v = new WebView(ctx.getApplicationContext());
                WebSettings s = v.getSettings();
                s.setJavaScriptEnabled(true);
                s.setDomStorageEnabled(true);
                s.setDatabaseEnabled(true);
                s.setAllowFileAccess(false);
                s.setAllowContentAccess(false);
                s.setCacheMode(WebSettings.LOAD_DEFAULT);
                s.setMediaPlaybackRequiresUserGesture(true);
                s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                s.setJavaScriptCanOpenWindowsAutomatically(false);
                s.setSupportMultipleWindows(false);
                s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
                userAgent = s.getUserAgentString();
                CookieManager.getInstance().setAcceptCookie(true);
                CookieManager.getInstance().setAcceptThirdPartyCookies(v, true);

                v.addJavascriptInterface(new Bridge(), "DSHBridge");
                v.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                        String u = req.getUrl() == null ? "" : req.getUrl().toString();
                        return !u.contains("deepseek.com");
                    }

                    @Override
                    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                        // document-start：尽早装 hook，登录时页面自己发的请求才抓得到 Authorization
                        MAIN.postDelayed(() -> inject(view), 60);
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        pageReady = true;
                        lastPageError = "";
                        App.Lg.i("页面加载完成: " + url);
                        inject(view);
                        MAIN.postDelayed(() -> inject(view), 1500);
                        MAIN.postDelayed(() -> inject(view), 6000);
                    }

                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                        if (req != null && req.isForMainFrame()) {
                            lastPageError = String.valueOf(err.getDescription());
                            App.Lg.w("页面错误: " + lastPageError);
                        }
                    }

                    @Override
                    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                        App.Lg.e("WebView 渲染进程崩溃，重建");
                        try {
                            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
                            view.destroy();
                        } catch (Exception ignored) {
                        }
                        wv = null;
                        pageReady = false;
                        MAIN.postDelayed(() -> ensure(ctx), 800);
                        return true;
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
                park(v);
                App.Lg.i("WebView 已创建 UA=" + userAgent);
            } catch (Throwable e) {
                App.Lg.e("WebView 创建失败: " + e);
                lastPageError = String.valueOf(e.getMessage());
            }
        });
    }

    /** 把 WebView 放到「看不见但活着」的地方：优先悬浮窗 1x1，其次 Activity 的 1x1 holder。 */
    private static void park(WebView v) {
        try {
            if (android.provider.Settings.canDrawOverlays(App.ctx())) {
                WindowManager wm = (WindowManager) App.ctx().getSystemService(Context.WINDOW_SERVICE);
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
                wm.addView(v, lp);
                overlayWm = wm;
                overlayAttached = true;
                App.Lg.i("WebView 已挂到 overlay");
                return;
            }
            ViewGroup h = holder;
            if (h != null) {
                detachFromParent(v);
                h.addView(v, new ViewGroup.LayoutParams(1, 1));
                overlayAttached = false;
                App.Lg.i("WebView 已挂到隐藏 holder");
            }
        } catch (Throwable e) {
            App.Lg.w("park 失败: " + e);
        }
    }

    private static void detachFromParent(WebView v) {
        try {
            if (overlayWm != null) {
                overlayWm.removeView(v);
                overlayWm = null;
            }
        } catch (Throwable ignored) {
        }
        try {
            if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).removeView(v);
        } catch (Throwable ignored) {
        }
        overlayAttached = false;
    }

    public static boolean hasOverlay() {
        return overlayAttached;
    }

    /** 挂进 Activity 容器（网页版页签）。 */
    public static void attachTo(final ViewGroup parent) {
        MAIN.post(() -> {
            try {
                WebView v = wv;
                if (v == null) {
                    ensure(parent.getContext());
                    return;
                }
                detachFromParent(v);
                parent.addView(v, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                v.onResume();
                v.resumeTimers();
            } catch (Throwable e) {
                App.Lg.e("attachTo 失败: " + e);
            }
        });
    }

    /** 从界面上收走（回控制台/后台），但仍然保持可执行。 */
    public static void detachToPark() {
        MAIN.post(() -> {
            try {
                WebView v = wv;
                if (v == null) return;
                detachFromParent(v);
                park(v);
                v.resumeTimers();
            } catch (Throwable e) {
                App.Lg.w("detachToPark: " + e);
            }
        });
    }

    public static void inject(WebView view) {
        if (view == null) return;
        try {
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
    /** 异步调用：内部起线程等待，回调在后台线程，调用方自己 post 到主线程。 */
    public static void callAsync(final String method, final JSONObject args, final long timeoutMs, final Cb cb) {
        CALLS.execute(() -> {
            JSONObject r;
            try {
                r = call(method, args, timeoutMs);
            } catch (Throwable e) {
                r = err("ENGINE", String.valueOf(e));
            }
            if (cb != null) cb.on(r);
        });
    }

    /** 同步调用。**绝不能在主线程或 JavaBridge 线程里调用**（会死锁）。 */
    public static JSONObject call(String method, JSONObject args, long timeoutMs) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            App.Lg.e("拒绝在主线程同步调用 " + method + "（会死锁）");
            return err("ENGINE", "internal: sync call on main thread");
        }
        if (!ready()) ensure(App.ctx());
        final String id = "r" + Long.toHexString(System.nanoTime());
        final CountDownLatch latch = new CountDownLatch(1);
        final JSONObject[] box = new JSONObject[1];
        ONESHOT.put(id, ev -> {
            box[0] = ev;
            latch.countDown();
        });
        boolean sent = send(id, method, args);
        if (!sent) {
            ONESHOT.remove(id);
            return err("ENGINE", "页面未就绪（" + state() + "）");
        }
        try {
            if (!latch.await(Math.max(3000, timeoutMs), TimeUnit.MILLISECONDS)) {
                return err("TIMEOUT", "页面调用超时（" + method + "）");
            }
            return box[0] == null ? new JSONObject() : box[0];
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return err("ABORTED", "调用被中断");
        } finally {
            ONESHOT.remove(id);
        }
    }

    public static boolean stream(final String id, String method, JSONObject args, Stream sink) {
        if (!ready()) ensure(App.ctx());
        STREAMS.put(id, sink);
        boolean ok = send(id, method, args);
        if (!ok) {
            STREAMS.remove(id);
            sink.on("error", err("ENGINE", "页面未就绪（" + state() + "）"));
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

    static JSONObject err(String code, String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("t", "error");
            o.put("code", code);
            o.put("msg", msg);
        } catch (Exception ignored) {
        }
        return o;
    }

    /** JS → Java 的唯一入口：**只做分发**，任何业务逻辑都丢给 DISPATCH。 */
    public static void onEvent(String reqId, String json) {
        final JSONObject ev = Json.obj(json);
        if (ev == null) return;
        // 页面登录成功后主动上报（不走请求-响应配对）
        if ("auto".equals(reqId)) {
            final String token = ev.optString("token");
            if (token != null && token.length() > 16) {
                CALLS.execute(() -> autoCapture(token, ev));
            }
            return;
        }
        String t = ev.optString("t");
        final Cb cb = ONESHOT.get(reqId);
        if (cb != null) {
            boolean terminal = "ok".equals(t) || "error".equals(t) || "pow".equals(t)
                    || "session".equals(t) || "user".equals(t) || "pong".equals(t);
            if (terminal) {
                ONESHOT.remove(reqId);
                DISPATCH.execute(() -> {
                    try {
                        cb.on(ev);
                    } catch (Throwable e) {
                        App.Lg.e("cb: " + e);
                    }
                });
            }
            return;
        }
        final Stream s = STREAMS.get(reqId);
        if (s != null) {
            if ("end".equals(t) || "error".equals(t)) STREAMS.remove(reqId);
            DISPATCH.execute(() -> {
                try {
                    s.on(t, ev);
                } catch (Throwable e) {
                    App.Lg.e("stream cb: " + e);
                }
            });
        }
    }

    /** 页面自动上报的登录态 → 入库 + 只读探活。 */
    private static void autoCapture(String token, JSONObject ev) {
        try {
            Auth.Rec existing = Auth.active();
            if (existing != null && token.equals(existing.token)) return;
            for (Auth.Rec r : Auth.list()) {
                if (token.equals(r.token)) {
                    Auth.setActive(r.id);
                    App.Lg.i("自动识别到已登录账号: " + r.id);
                    return;
                }
            }
            Auth.Rec r = new Auth.Rec();
            r.token = token;
            r.hifLeim = ev.optString("hifLeim", "");
            r.deviceId = ev.optString("deviceId", "");
            r.userAgent = ev.optString("userAgent", userAgent);
            r.cookie = com.hiweny.dshweb.Net.cookie();
            r.capturedAt = System.currentTimeMillis();
            Auth.upsert(r, "");
            Auth.Rec acc = Auth.active();
            App.Lg.i("已自动捕获登录态（token 长度 " + token.length() + "）");
            if (acc != null) {
                JSONObject a = new JSONObject();
                a.put("token", acc.token);
                a.put("deviceId", acc.deviceId == null ? "" : acc.deviceId);
                a.put("omitCookie", true);
                JSONObject u = Engine.call("usersCurrent", a, 20000);
                if (u.optInt("status", 0) == 200) {
                    Auth.markVerified(acc);
                    App.Lg.i("自动捕获的账号探活通过");
                } else {
                    Auth.markVerifyError(acc, "HTTP " + u.optInt("status", 0));
                }
            }
        } catch (Throwable e) {
            App.Lg.e("autoCapture: " + e);
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

    public static final class Assets {
        public static String read(Context c, String name) {
            try {
                java.io.InputStream in = c.getAssets().open(name);
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                in.close();
                return new String(bo.toByteArray(), "UTF-8");
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
