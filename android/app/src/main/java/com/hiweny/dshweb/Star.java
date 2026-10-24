package com.hiweny.dshweb;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 悬浮球：四角星 ✦（与 DeepSeek Web API 那个同款形状，换个配色）。
 * 可拖动、松手自动贴边、点击展开状态小面板。
 */
public final class Star {

    private static View ball;
    private static View panel;
    private static WindowManager wm;
    private static WindowManager.LayoutParams ballLp;
    private static WindowManager.LayoutParams panelLp;
    private static float downX, downY;
    private static int startX, startY;
    private static boolean moved;
    private static long downAt;

    public static final class Colors {
        int a, b;
        Colors(int a, int b) {
            this.a = a;
            this.b = b;
        }
    }

    public static Colors palette(String name) {
        switch (name == null ? "violet" : name) {
            case "cyan": return new Colors(0xFF22D3EE, 0xFF2563EB);
            case "mint": return new Colors(0xFF34D399, 0xFF0EA5E9);
            case "amber": return new Colors(0xFFFBBF24, 0xFFF97316);
            case "rose": return new Colors(0xFFFB7185, 0xFFA855F7);
            case "ink": return new Colors(0xFF64748B, 0xFF0F172A);
            default: return new Colors(0xFFA78BFA, 0xFF6D28D9);
        }
    }

    private Star() {
    }

    public static void show(Context ctx) {
        if (ctx == null) return;
        if (!Settings.canDrawOverlays(ctx)) {
            App.Lg.w("没有悬浮窗权限，跳过悬浮球");
            return;
        }
        if (ball != null) {
            ball.setVisibility(View.VISIBLE);
            return;
        }
        try {
            wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            final Context app = ctx.getApplicationContext();
            final StarView v = new StarView(app, palette(Cfg.ballColor()));

            int size = dp(app, 56);
            ballLp = new WindowManager.LayoutParams(
                    size, size,
                    Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                            : WindowManager.LayoutParams.TYPE_PHONE,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    android.graphics.PixelFormat.TRANSLUCENT);
            ballLp.gravity = Gravity.TOP | Gravity.START;
            int sw = app.getResources().getDisplayMetrics().widthPixels;
            int sh = app.getResources().getDisplayMetrics().heightPixels;
            ballLp.x = sw - size - dp(app, 8);
            ballLp.y = (int) (sh * 0.42f);
            wm.addView(v, ballLp);
            ball = v;

            v.setOnTouchListener((view, e) -> {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX();
                        downY = e.getRawY();
                        startX = ballLp.x;
                        startY = ballLp.y;
                        moved = false;
                        downAt = System.currentTimeMillis();
                        view.setAlpha(0.82f);
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = e.getRawX() - downX;
                        float dy = e.getRawY() - downY;
                        if (Math.abs(dx) > dp(app, 4) || Math.abs(dy) > dp(app, 4)) moved = true;
                        if (moved) {
                            ballLp.x = (int) (startX + dx);
                            ballLp.y = (int) (startY + dy);
                            try {
                                wm.updateViewLayout(view, ballLp);
                            } catch (Exception ignored) {
                            }
                        }
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        view.setAlpha(1f);
                        snapToEdge(app);
                        if (!moved && System.currentTimeMillis() - downAt < 600) togglePanel(app);
                        return true;
                }
                return false;
            });
            App.Lg.i("悬浮球已显示");
        } catch (Throwable e) {
            App.Lg.e("悬浮球创建失败: " + e);
        }
    }

    private static void snapToEdge(Context c) {
        try {
            int sw = c.getResources().getDisplayMetrics().widthPixels;
            int half = ballLp.width / 2;
            boolean left = ballLp.x + half < sw / 2;
            ballLp.x = left ? dp(c, 6) : sw - ballLp.width - dp(c, 6);
            wm.updateViewLayout(ball, ballLp);
            if (panel != null && panelLp != null) {
                panelLp.x = left ? dp(c, 6) + ballLp.width + dp(c, 10) : sw - panelLp.width - dp(c, 6) - ballLp.width - dp(c, 10);
                panelLp.y = Math.max(dp(c, 40), ballLp.y - dp(c, 20));
                wm.updateViewLayout(panel, panelLp);
            }
        } catch (Exception ignored) {
        }
    }

    public static void hide(Context c) {
        try {
            if (ball != null && wm != null) wm.removeView(ball);
        } catch (Exception ignored) {
        }
        ball = null;
        hidePanel();
    }

    private static void hidePanel() {
        try {
            if (panel != null && wm != null) wm.removeView(panel);
        } catch (Exception ignored) {
        }
        panel = null;
    }

    private static void togglePanel(Context c) {
        if (panel != null) {
            hidePanel();
            return;
        }
        try {
            FrameLayout card = new FrameLayout(c);
            LinearLayout box = new LinearLayout(c);
            box.setOrientation(LinearLayout.VERTICAL);
            int pad = dp(c, 14);
            box.setPadding(pad, pad, pad, pad);
            android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
            bg.setColor(0xF2141824);
            bg.setCornerRadius(dp(c, 18));
            bg.setStroke(dp(c, 1), 0x33FFFFFF);
            box.setBackground(bg);

            TextView title = new TextView(c);
            title.setText("✦ DSH Web API");
            title.setTextColor(0xFFEDEBFF);
            title.setTextSize(14);
            title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            box.addView(title);

            TextView st = new TextView(c);
            st.setText(Engine.state() + " · " + Auth.stat() + "\n" + ":" + Cfg.port() + " · 调用 " + EngineService.calls.get() + " 次");
            st.setTextColor(0xFF9AA3B2);
            st.setTextSize(11);
            st.setPadding(0, dp(c, 6), 0, dp(c, 10));
            box.addView(st);

            TextView open = action(c, "打开控制台");
            TextView toggle = action(c, EngineService.running ? "停止服务" : "启动服务");
            box.addView(open);
            box.addView(toggle);

            open.setOnClickListener(v -> {
                hidePanel();
                try {
                    android.content.Intent i = new android.content.Intent(c, MainActivity.class);
                    i.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(i);
                } catch (Exception ignored) {
                }
            });
            toggle.setOnClickListener(v -> {
                hidePanel();
                if (EngineService.running) EngineService.stop(c);
                else EngineService.start(c);
            });

            card.addView(box);

            int w = dp(c, 196);
            panelLp = new WindowManager.LayoutParams(
                    w, WindowManager.LayoutParams.WRAP_CONTENT,
                    Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                            : WindowManager.LayoutParams.TYPE_PHONE,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    android.graphics.PixelFormat.TRANSLUCENT);
            panelLp.gravity = Gravity.TOP | Gravity.START;
            int sw = c.getResources().getDisplayMetrics().widthPixels;
            boolean left = ballLp.x < sw / 2;
            panelLp.x = left ? ballLp.x + ballLp.width + dp(c, 10) : ballLp.x - w - dp(c, 10);
            panelLp.y = Math.max(dp(c, 40), ballLp.y);
            wm.addView(card, panelLp);
            panel = card;
        } catch (Throwable e) {
            App.Lg.e("面板失败: " + e);
        }
    }

    private static TextView action(Context c, String text) {
        TextView t = new TextView(c);
        t.setText(text);
        t.setTextColor(0xFFD9D4FF);
        t.setTextSize(12);
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(0x22A78BFA);
        g.setCornerRadius(dp(c, 12));
        t.setBackground(g);
        t.setPadding(dp(c, 12), dp(c, 9), dp(c, 12), dp(c, 9));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(c, 8);
        t.setLayoutParams(lp);
        return t;
    }

    static int dp(Context c, int v) {
        return (int) (v * c.getResources().getDisplayMetrics().density + 0.5f);
    }

    /** 四角星本体（✦），带渐变与轻微呼吸。 */
    static final class StarView extends View {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private final Colors colors;
        private float phase = 0f;

        StarView(Context c, Colors colors) {
            super(c);
            this.colors = colors;
            setLayerType(LAYER_TYPE_SOFTWARE, null);
            halo.setStyle(Paint.Style.FILL);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int w = getWidth(), h = getHeight();
            float cx = w / 2f, cy = h / 2f;
            float R = Math.min(w, h) * 0.42f;
            float inner = R * 0.17f;

            phase += 0.02f;
            float breathe = 1f + (float) Math.sin(phase) * 0.02f;

            // 外光晕
            halo.setShader(new RadialGradient(cx, cy, R * 1.25f,
                    new int[]{withAlpha(colors.a, 90), withAlpha(colors.a, 0)},
                    new float[]{0.55f, 1f}, Shader.TileMode.CLAMP));
            canvas.drawCircle(cx, cy, R * 1.28f, halo);

            path.reset();
            float r = R * breathe;
            path.moveTo(cx, cy - r);
            path.quadTo(cx + inner, cy - inner, cx + r, cy);
            path.quadTo(cx + inner, cy + inner, cx, cy + r);
            path.quadTo(cx - inner, cy + inner, cx - r, cy);
            path.quadTo(cx - inner, cy - inner, cx, cy - r);
            path.close();

            fill.setShader(new LinearGradient(cx - r, cy - r, cx + r, cy + r,
                    new int[]{colors.a, colors.b}, null, Shader.TileMode.CLAMP));
            fill.setShadowLayer(dp(4), 0, dp(3), withAlpha(colors.b, 150));
            canvas.drawPath(path, fill);
        }

        private int dp(int v) {
            return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
        }

        private static int withAlpha(int color, int alpha) {
            return (color & 0x00FFFFFF) | ((alpha & 0xFF) << 24);
        }
    }
}
