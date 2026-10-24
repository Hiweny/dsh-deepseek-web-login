package com.hiweny.dshweb;

import android.app.Application;
import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 全局入口：日志落盘 + 崩溃捕获（真机排障唯一手段）。 */
public class App extends Application {

    private static Context sCtx;
    private static final Object LOCK = new Object();
    private static final long MAX_LOG = 512 * 1024;

    @Override
    public void onCreate() {
        super.onCreate();
        sCtx = this.getApplicationContext();
        Lg.init(sCtx);

        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            StringWriter sw = new StringWriter();
            e.printStackTrace(new PrintWriter(sw));
            Lg.e("CRASH in " + t.getName() + ": " + sw.toString());
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    public static Context ctx() {
        return sCtx;
    }

    /** 极简日志工具：写 files/logs/dsh.log（滚动截断），同时进 logcat。 */
    public static final class Lg {
        private static final String TAG = "DSHWEB";
        private static File file;

        static void init(Context c) {
            file = new File(c.getFilesDir(), "dsh.log");
            if (file.length() > MAX_LOG) {
                File old = new File(c.getFilesDir(), "dsh.old.log");
                if (old.exists()) old.delete();
                file.renameTo(old);
            }
        }

        public static void i(String msg) {
            Log.i(TAG, msg);
            write("I", msg);
        }

        public static void w(String msg) {
            Log.w(TAG, msg);
            write("W", msg);
        }

        public static void e(String msg) {
            Log.e(TAG, msg);
            write("E", msg);
        }

        private static void write(String level, String msg) {
            synchronized (LOCK) {
                if (file == null) return;
                try {
                    String ts = new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
                    java.io.FileOutputStream out = new java.io.FileOutputStream(file, true);
                    out.write((ts + " " + level + " " + msg + "\n").getBytes("UTF-8"));
                    out.close();
                } catch (Exception ignored) {
                }
            }
        }

        public static String tail(int maxChars) {
            if (file == null || !file.exists()) return "";
            try {
                java.io.RandomAccessFile raf = new java.io.RandomAccessFile(file, "r");
                long len = raf.length();
                long from = Math.max(0, len - maxChars);
                raf.seek(from);
                byte[] buf = new byte[(int) (len - from)];
                raf.readFully(buf);
                raf.close();
                return new String(buf, "UTF-8");
            } catch (Exception e) {
                return "";
            }
        }

        public static void clear() {
            if (file != null) file.delete();
        }
    }
}
