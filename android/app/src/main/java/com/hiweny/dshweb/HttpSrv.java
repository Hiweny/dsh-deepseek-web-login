package com.hiweny.dshweb;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 极简 HTTP/1.1 服务器：监听 0.0.0.0（局域网可用），支持普通响应与 SSE 流式输出。
 * 只用 TcpListener 自建 HTTP —— 不用 HttpListener / Kestrel 那套，避免权限与依赖问题。
 */
public final class HttpSrv {

    public interface Router {
        void handle(Req req, Res res) throws Exception;
    }

    private final int port;
    private final Router router;
    private ServerSocket server;
    private volatile boolean running;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    public HttpSrv(int port, Router router) {
        this.port = port;
        this.router = router;
    }

    public void start() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress("0.0.0.0", port), 128);
        running = true;
        Thread t = new Thread(this::acceptLoop, "http-accept");
        t.setDaemon(true);
        t.start();
        App.Lg.i("HTTP 已启动 :" + port);
    }

    public void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (Exception ignored) {
        }
        pool.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = server.accept();
                pool.execute(() -> handle(s));
            } catch (Exception e) {
                if (running) App.Lg.w("accept: " + e.getMessage());
            }
        }
    }

    private void handle(Socket socket) {
        Res res = null;
        try {
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(900000);
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = socket.getOutputStream();

            String line = readLine(in);
            if (line == null || line.isEmpty()) {
                socket.close();
                return;
            }
            String[] parts = line.split(" ");
            if (parts.length < 2) {
                socket.close();
                return;
            }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String target = parts[1];

            Map<String, String> headers = new LinkedHashMap<>();
            String h;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                int c = h.indexOf(':');
                if (c > 0) headers.put(h.substring(0, c).trim().toLowerCase(Locale.ROOT), h.substring(c + 1).trim());
            }
            String body = readBody(in, headers);

            String path = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path = target.substring(0, q);
                query = target.substring(q + 1);
            }

            Req req = new Req(method, path, query, headers, body, socket);
            res = new Res(out, "HEAD".equals(method));

            if ("OPTIONS".equals(method)) {
                res.status(204);
                res.cors();
                res.end("");
                return;
            }
            router.handle(req, res);
        } catch (Exception e) {
            try {
                if (res != null) res.end("{\"error\":\"" + esc(String.valueOf(e.getMessage())) + "\"}");
            } catch (Exception ignored) {
            }
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c == '\r') continue;
            sb.append((char) c);
            if (sb.length() > 65536) break;
        }
        if (c == -1 && sb.length() == 0) return null;
        return sb.toString();
    }

    private static String readBody(InputStream in, Map<String, String> headers) throws IOException {
        String te = headers.get("transfer-encoding");
        if (te != null && te.toLowerCase(Locale.ROOT).contains("chunked")) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            while (true) {
                String sizeLine = readLine(in);
                if (sizeLine == null || sizeLine.isEmpty()) break;
                int size = Integer.parseInt(sizeLine.trim(), 16);
                if (size == 0) {
                    readLine(in);
                    break;
                }
                byte[] buf = new byte[size];
                int off = 0;
                while (off < size) {
                    int n = in.read(buf, off, size - off);
                    if (n < 0) break;
                    off += n;
                }
                bo.write(buf, 0, off);
                readLine(in);
            }
            return bo.toString("UTF-8");
        }
        int len = 0;
        try {
            len = Integer.parseInt(headers.getOrDefault("content-length", "0").trim());
        } catch (Exception ignored) {
        }
        if (len <= 0) return "";
        if (len > 40 * 1024 * 1024) return "";
        byte[] buf = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) break;
            off += n;
        }
        return new String(buf, 0, off, StandardCharsets.UTF_8);
    }

    // ── 请求 ─────────────────────────────────────────────────
    public static final class Req {
        public final String method, path, query, body;
        public final Map<String, String> headers;
        public final Socket socket;

        Req(String method, String path, String query, Map<String, String> headers, String body, Socket socket) {
            this.method = method;
            this.path = path;
            this.query = query;
            this.headers = headers;
            this.body = body;
            this.socket = socket;
        }

        public String header(String k) {
            return headers.get(k.toLowerCase(Locale.ROOT));
        }

        public String bearer() {
            String a = header("authorization");
            if (a == null) return "";
            a = a.trim();
            if (a.toLowerCase(Locale.ROOT).startsWith("bearer ")) return a.substring(7).trim();
            return a;
        }
    }

    // ── 响应 ─────────────────────────────────────────────────
    public static final class Res {
        private final OutputStream out;
        private final boolean headOnly;
        private boolean headerSent = false;
        private int status = 200;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private boolean chunked = false;

        Res(OutputStream out, boolean headOnly) {
            this.out = out;
            this.headOnly = headOnly;
        }

        public Res status(int s) {
            this.status = s;
            return this;
        }

        public Res header(String k, String v) {
            headers.put(k, v);
            return this;
        }

        public Res cors() {
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
            headers.put("Access-Control-Allow-Headers", "Authorization, Content-Type, *");
            return this;
        }

        public Res json() {
            headers.put("Content-Type", "application/json; charset=utf-8");
            return this;
        }

        private void sendHead(long contentLength) throws IOException {
            if (headerSent) return;
            headerSent = true;
            StringBuilder sb = new StringBuilder();
            sb.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
            if (!headers.containsKey("Content-Type")) headers.put("Content-Type", "application/json; charset=utf-8");
            headers.put("Connection", "close");
            headers.put("Access-Control-Allow-Origin", "*");
            if (chunked) headers.put("Transfer-Encoding", "chunked");
            else headers.put("Content-Length", String.valueOf(contentLength));
            for (Map.Entry<String, String> e : headers.entrySet()) {
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
            sb.append("\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        /** 一次性响应。 */
        public void end(String text) throws IOException {
            if (headOnly) {
                sendHead(text == null ? 0 : text.getBytes(StandardCharsets.UTF_8).length);
                return;
            }
            byte[] b = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
            sendHead(b.length);
            out.write(b);
            out.flush();
        }

        public void end(byte[] b, String contentType) throws IOException {
            headers.put("Content-Type", contentType);
            if (headOnly) {
                sendHead(b.length);
                return;
            }
            sendHead(b.length);
            out.write(b);
            out.flush();
        }

        /** 开一条 chunked 流（SSE 用）。 */
        public void beginStream(String contentType) throws IOException {
            headers.put("Content-Type", contentType);
            headers.put("Cache-Control", "no-cache, no-transform");
            headers.put("X-Accel-Buffering", "no");
            chunked = true;
            sendHead(0);
        }

        public void writeChunk(String s) throws IOException {
            if (headOnly) return;
            if (!headerSent) beginStream("text/event-stream; charset=utf-8");
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            out.write((Integer.toHexString(b.length) + "\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(b);
            out.write("\r\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        public void finishStream() {
            if (headOnly || !chunked) return;
            try {
                out.write("0\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (Exception ignored) {
            }
        }

        private static String reason(int s) {
            switch (s) {
                case 200: return "OK";
                case 201: return "Created";
                case 204: return "No Content";
                case 400: return "Bad Request";
                case 401: return "Unauthorized";
                case 404: return "Not Found";
                case 405: return "Method Not Allowed";
                case 429: return "Too Many Requests";
                case 500: return "Internal Server Error";
                case 503: return "Service Unavailable";
                default: return "OK";
            }
        }
    }
}
