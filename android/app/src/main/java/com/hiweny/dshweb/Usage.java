package com.hiweny.dshweb;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 调用台账（移植自上游 src/usage.ts）：按本地日期 JSONL 追加，聚合出 totalse/series/byModel。
 * 只记元数据，绝不记对话内容。
 */
public final class Usage {

    private static final int KEEP_DAYS = 90;
    private static File dir;
    private static final Object LOCK = new Object();

    private Usage() {
    }

    public static void init(Context c) {
        dir = new File(c.getFilesDir(), "usage");
        if (!dir.exists()) dir.mkdirs();
        prune(30);
    }

    private static String dayKey(long at) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(at));
    }

    public static void note(String accountId, String purpose, String model, boolean ok,
                            long in, long out, Long serverTotal) {
        synchronized (LOCK) {
            try {
                if (dir == null) return;
                JSONObject o = new JSONObject();
                o.put("at", System.currentTimeMillis());
                o.put("accountId", accountId == null ? "" : accountId);
                o.put("purpose", purpose == null ? "chat" : purpose);
                o.put("model", model == null ? "" : model);
                o.put("ok", ok);
                o.put("in", in);
                o.put("out", out);
                if (serverTotal != null) o.put("server", serverTotal);
                File f = new File(dir, dayKey(System.currentTimeMillis()) + ".jsonl");
                FileOutputStream fos = new FileOutputStream(f, true);
                fos.write((o.toString() + "\n").getBytes("UTF-8"));
                fos.close();
            } catch (Exception ignored) {
            }
        }
    }

    public static void prune(int keepDays) {
        synchronized (LOCK) {
            if (dir == null) return;
            long cutoff = System.currentTimeMillis() - keepDays * 86400000L;
            File[] fs = dir.listFiles();
            if (fs == null) return;
            for (File f : fs) {
                if (f.getName().endsWith(".jsonl") && f.lastModified() < cutoff) f.delete();
            }
        }
    }

    public static JSONObject summary(int days) {
        days = Math.max(1, Math.min(KEEP_DAYS, days));
        JSONObject result = new JSONObject();
        long totalCalls = 0, okCalls = 0, totalIn = 0, totalOut = 0, serverCalls = 0;
        JSONArray series = new JSONArray();
        JSONObject byModel = new JSONObject();
        JSONObject byAccount = new JSONObject();
        try {
            for (int d = days - 1; d >= 0; d--) {
                long at = System.currentTimeMillis() - d * 86400000L;
                String key = dayKey(at);
                File f = new File(dir == null ? "" : dir.getPath(), key + ".jsonl");
                long cCalls = 0, cIn = 0, cOut = 0;
                if (f.exists()) {
                    byte[] buf = new byte[(int) f.length()];
                    java.io.FileInputStream in = new java.io.FileInputStream(f);
                    int off = 0;
                    while (off < buf.length) {
                        int n = in.read(buf, off, buf.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                    in.close();
                    for (String line : new String(buf, 0, off, "UTF-8").split("\n")) {
                        if (line.trim().isEmpty()) continue;
                        try {
                            JSONObject o = new JSONObject(line);
                            long i = o.optLong("in"), ou = o.optLong("out");
                            totalCalls++;
                            if (o.optBoolean("ok")) okCalls++;
                            totalIn += i;
                            totalOut += ou;
                            if (o.has("server")) serverCalls++;
                            cCalls++;
                            cIn += i;
                            cOut += ou;
                            String m = o.optString("model", "?");
                            JSONObject mo = byModel.optJSONObject(m);
                            if (mo == null) mo = new JSONObject();
                            mo.put("calls", mo.optLong("calls") + 1);
                            mo.put("in", mo.optLong("in") + i);
                            mo.put("out", mo.optLong("out") + ou);
                            byModel.put(m, mo);
                            String a = o.optString("accountId", "");
                            if (!a.isEmpty()) {
                                JSONObject ao = byAccount.optJSONObject(a);
                                if (ao == null) ao = new JSONObject();
                                ao.put("calls", ao.optLong("calls") + 1);
                                ao.put("in", ao.optLong("in") + i);
                                ao.put("out", ao.optLong("out") + ou);
                                byAccount.put(a, ao);
                            }
                        } catch (Exception ignored) {
                        }
                    }
                }
                JSONObject day = new JSONObject();
                day.put("date", key);
                day.put("calls", cCalls);
                day.put("in", cIn);
                day.put("out", cOut);
                series.put(day);
            }
            JSONObject totals = new JSONObject();
            totals.put("calls", totalCalls);
            totals.put("ok", okCalls);
            totals.put("failed", totalCalls - okCalls);
            totals.put("in", totalIn);
            totals.put("out", totalOut);
            totals.put("total", totalIn + totalOut);
            totals.put("serverCalls", serverCalls);
            totals.put("avgPerCall", totalCalls == 0 ? 0 : (totalIn + totalOut) / totalCalls);
            result.put("days", days);
            result.put("totals", totals);
            result.put("series", series);
            result.put("byModel", byModel);
            result.put("byAccount", byAccount);
        } catch (Exception ignored) {
        }
        return result;
    }

    public static JSONObject summary() {
        return summary(30);
    }

    public static List<String> recentLines(int max) {
        List<String> out = new ArrayList<>();
        if (dir == null) return out;
        File f = new File(dir, dayKey(System.currentTimeMillis()) + ".jsonl");
        if (!f.exists()) return out;
        try {
            byte[] buf = new byte[(int) f.length()];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            in.close();
            String[] lines = new String(buf, 0, off, "UTF-8").split("\n");
            for (int i = Math.max(0, lines.length - max); i < lines.length; i++) {
                if (!lines[i].trim().isEmpty()) out.add(lines[i]);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    /** token 估算：CJK 按 1.5 字符/token，ASCII 按 4 字符/token（与上游一致）。 */
    public static long estimateTokens(String t) {
        if (t == null || t.isEmpty()) return 0;
        int cjk = 0;
        int len = t.length();
        for (int i = 0; i < len; ) {
            int cp = t.codePointAt(i);
            if (cp >= 0x3000 && cp <= 0x9fff) cjk++;
            i += Character.charCount(cp);
        }
        int ascii = len - cjk;
        return (long) Math.ceil(cjk / 1.5 + ascii / 4.0);
    }
}
