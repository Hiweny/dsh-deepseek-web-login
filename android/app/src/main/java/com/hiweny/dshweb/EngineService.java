package com.hiweny.dshweb;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * 常驻前台服务：WebView 引擎 + 本地 HTTP 服务 + 探活 + 会话清理 + 状态通知。
 * 通知里实时显示 API 调用状态（谁在调、成功/失败、耗时）。
 */
public class EngineService extends Service {

    public static final String ACTION_START = "com.hiweny.dshweb.START";
    public static final String ACTION_STOP = "com.hiweny.dshweb.STOP";
    private static final int NOTIF_ID = 1201;
    private static final String CH = "dshweb_service";

    public static volatile boolean running = false;
    private static volatile EngineService inst;

    private HttpSrv server;
    private PowerManager.WakeLock wake;
    private final Handler hb = new Handler(Looper.getMainLooper());
    private long startedAt = 0;
    private long lastProbeAt = 0;
    private int lastNotifHash = 0;
    private long lastNotifAt = 0;

    // ── 全局统计（给控制台/通知用）─────────────────────────────
    public static final AtomicInteger calls = new AtomicInteger(0);
    public static final AtomicInteger okCalls = new AtomicInteger(0);
    public static final AtomicInteger failCalls = new AtomicInteger(0);
    public static volatile String lastCall = "—";
    public static volatile long lastCallAt = 0;
    public static volatile long lastLatencyMs = 0;
    public static volatile boolean lastOk = true;

    public static EngineService get() {
        return inst;
    }

    public static JSONObject stats() {
        JSONObject o = new JSONObject();
        try {
            o.put("running", running);
            o.put("calls", calls.get());
            o.put("ok", okCalls.get());
            o.put("fail", failCalls.get());
            o.put("last", lastCall);
            o.put("lastAt", lastCallAt);
            o.put("lastLatencyMs", lastLatencyMs);
            o.put("lastOk", lastOk);
            o.put("uptimeMs", running && inst != null ? System.currentTimeMillis() - inst.startedAt : 0);
        } catch (Exception ignored) {
        }
        return o;
    }

    public static void noteCall(boolean ok, long ms, String who) {
        calls.incrementAndGet();
        if (ok) okCalls.incrementAndGet();
        else failCalls.incrementAndGet();
        lastOk = ok;
        lastLatencyMs = ms;
        lastCallAt = System.currentTimeMillis();
        lastCall = (ok ? "✓ " : "✗ ") + (who == null ? "" : who) + " · " + ms + "ms";
        if (inst != null) inst.refreshNotification(true);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        Cfg.init(this);
        Auth.init(this);
        Usage.init(this);
        Runner.loadSlots();
        createChannel();
        startForeground(NOTIF_ID, buildNotification());

        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dshweb:engine");
            wake.setReferenceCounted(false);
            wake.acquire();
        } catch (Exception e) {
            App.Lg.w("WakeLock 失败: " + e);
        }

        Engine.ensure(this);
        startServer();
        running = true;
        startedAt = System.currentTimeMillis();

        hb.postDelayed(this::heartbeat, 8000);
        App.Lg.i("服务已启动");
    }

    private void startServer() {
        try {
            if (server != null) return;
            server = new HttpSrv(Cfg.port(), OpenAi::route);
            server.start();
        } catch (Exception e) {
            App.Lg.e("HTTP 启动失败: " + e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            startForeground(NOTIF_ID, buildNotification());
        }
        return START_STICKY;
    }

    private void heartbeat() {
        try {
            Runner.tick();
            Engine.resumeTimers();
            probeIfDue();
            refreshNotification(false);
        } catch (Exception e) {
            App.Lg.w("心跳: " + e);
        }
        hb.postDelayed(this::heartbeat, 60000);
    }

    /** 登录态探活：只读 users/current，零额度。 */
    private void probeIfDue() {
        long interval = Cfg.probeIntervalMs();
        if (interval <= 0) return;
        if (System.currentTimeMillis() - lastProbeAt < interval) return;
        lastProbeAt = System.currentTimeMillis();
        new Thread(() -> {
            Auth.Rec acc = Auth.active();
            if (acc == null || !acc.usable()) return;
            JSONObject a = new JSONObject();
            try {
                a.put("token", acc.token);
                a.put("deviceId", acc.deviceId == null ? "" : acc.deviceId);
                a.put("omitCookie", true);
            } catch (Exception ignored) {
            }
            JSONObject r = Engine.call("usersCurrent", a, 25000);
            int status = r.optInt("status", 0);
            String body = r.optString("body", "");
            if (status == 200) {
                Auth.markVerified(acc);
                App.Lg.i("探活 OK: " + acc.id);
            } else if (status >= 400) {
                Auth.markVerifyError(acc, "HTTP " + status + " " + Auth.shortId(body));
                App.Lg.w("探活失败: " + acc.id + " HTTP " + status);
            }
        }, "probe").start();
    }

    private void refreshNotification(boolean forced) {
        long now = System.currentTimeMillis();
        if (!forced && now - lastNotifAt < 4000) return;
        lastNotifAt = now;
        Notification n = buildNotification();
        int hash = n.toString().hashCode();
        if (hash == lastNotifHash) return;
        lastNotifHash = hash;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, n);
        } catch (Exception ignored) {
        }
    }

    private void createChannel() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CH) == null) {
                NotificationChannel c = new NotificationChannel(CH, "API 服务", NotificationManager.IMPORTANCE_LOW);
                c.setShowBadge(false);
                c.setSound(null, null);
                nm.createNotificationChannel(c);
            }
        } catch (Exception ignored) {
        }
    }

    private Notification buildNotification() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, i, flags);

        String title = "DSH Web API · " + Cfg.port();
        String text = lastCallAt == 0
                ? "等待请求 · " + Auth.stat() + " · " + Engine.state()
                : lastCall + " · 共 " + calls.get() + " 次";
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH)
                : new Notification.Builder(this);
        b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setOngoing(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT >= 24) {
            b.setSubText(Engine.state());
        }
        if (lastCallAt > 0) {
            b.setStyle(new Notification.BigTextStyle().bigText(text + "\n" + Auth.stat() + "\n" + Engine.state()));
        }
        return b.build();
    }

    @Override
    public void onDestroy() {
        running = false;
        try {
            if (server != null) server.stop();
        } catch (Exception ignored) {
        }
        try {
            if (wake != null && wake.isHeld()) wake.release();
        } catch (Exception ignored) {
        }
        try {
            Star.hide(this);
        } catch (Exception ignored) {
        }
        Engine.dropAll();
        inst = null;
        App.Lg.i("服务结束");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── 启停 ────────────────────────────────────────────────
    public static void start(Context c) {
        Intent i = new Intent(c, EngineService.class);
        i.setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Exception e) {
            App.Lg.e("startService 失败: " + e);
        }
    }

    public static void stop(Context c) {
        try {
            c.stopService(new Intent(c, EngineService.class));
        } catch (Exception ignored) {
        }
    }
}
