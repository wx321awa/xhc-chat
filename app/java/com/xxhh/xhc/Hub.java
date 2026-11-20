package com.xxhh.xhc;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 纯 JDK 的 HTTP + WebSocket 单房间 Hub（不 import 任何 android.*）。
 *
 * 职责：
 *  - HTTP GET：/ -> index.html，其余 -> AssetProvider；404 兜底；Cache-Control: no-store。
 *  - /ws：RFC6455 握手 + 帧解析（客户端必掩码、服务端不掩码、单帧≤1MiB、分片重组）。
 *  - 协议严格按 docs/PROTOCOL.md v1.2：hello/welcome/peers/send/msg/ack/history/read/ping/pong/error，
 *    以及 §14 的头像（avatar / peer-info）、群名（group）、图片视频（POST /upload、GET /m/<id>）。
 *  - 本机 Hub 不持久化：history 恒回空数组，不发 pending；头像 / 群名 / 媒体都只在内存。
 *  - 能力由 welcome.server.caps = ["avatar","group","media"] 声明。
 *
 * 用法（桌面测试）：
 *   java -cp app/build/classes com.xxhh.xhc.Hub <port> <key|-> <assetsDir>
 */
public final class Hub {

    public static final int DEFAULT_PORT = 21001;
    private static final int MAX_FRAME = 1024 * 1024;
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int HANDSHAKE_TIMEOUT_MS = 15000;
    private static final int HELLO_TIMEOUT_MS = 10000;
    private static final int IDLE_TIMEOUT_MS = 60000;

    // v1.2（docs/PROTOCOL.md §14）：头像 / 群名 / 图片视频
    private static final int MAX_AVATAR_CHARS = 48000;
    private static final String AVATAR_PREFIX = "data:image/jpeg;base64,";
    private static final int MAX_IMAGE_BYTES = 4 * 1024 * 1024;
    private static final int MAX_VIDEO_BYTES = 16 * 1024 * 1024;
    private static final long MEDIA_TOTAL_BYTES = 32L * 1024 * 1024;
    private static final String DEFAULT_GROUP = "群聊（全部）";
    private static final String CAPS_JSON = "[\"avatar\",\"group\",\"media\",\"gavatar\"]";
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /** 静态资源提供者；返回 null 表示 404。 */
    public interface AssetProvider {
        byte[] read(String path) throws IOException;
    }

    private final int port;
    private final String key;
    private final AssetProvider assets;
    private final String mode;

    private volatile boolean running;
    private ServerSocket server;
    private int boundPort;

    private final Object lock = new Object();
    private final Map<String, Client> clients = new HashMap<String, Client>();

    /** v1.2 头像：id → data URL；仅内存（Hub 不落盘）。 */
    private final Map<String, String> avatars = new HashMap<String, String>();
    /** v1.2 群名；仅内存，默认「群聊（全部）」。 */
    private volatile String groupName = DEFAULT_GROUP;
    private volatile String groupAvatar;
    /** v1.2 媒体：id → bytes+mime；总量 ≤32MiB，accessOrder=true 提供 LRU。 */
    private final Object mediaLock = new Object();
    private final Map<String, MediaEntry> media =
            new LinkedHashMap<String, MediaEntry>(16, 0.75f, true);
    private long mediaBytes;
    private final SecureRandom random = new SecureRandom();

    public Hub(int port, String key, AssetProvider assets) {
        this(port, key, assets, "hub");
    }

    public Hub(int port, String key, AssetProvider assets, String mode) {
        this.port = port;
        this.key = key;
        this.assets = assets;
        this.mode = mode == null ? "hub" : mode;
    }

    public int getPort() {
        return boundPort;
    }

    public boolean isRunning() {
        return running;
    }

    public synchronized void start() throws IOException {
        if (running) {
            return;
        }
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress("0.0.0.0", port), 50);
        server = s;
        boundPort = s.getLocalPort();
        running = true;
        Thread t = new Thread(new Runnable() {
            public void run() {
                acceptLoop();
            }
        }, "hub-accept");
        t.setDaemon(true);
        t.start();
        log("listening on 0.0.0.0:" + boundPort + " key=" + (key == null ? "(none)" : "***")
                + " mode=" + mode);
    }

    public synchronized void stop() {
        if (!running) {
            return;
        }
        running = false;
        closeQuietly(server);
        List<Client> snapshot;
        synchronized (lock) {
            snapshot = new ArrayList<Client>(clients.values());
            clients.clear();
        }
        for (Client c : snapshot) {
            c.shutdown(1001, "server stop");
        }
        log("stopped");
    }

    // ------------------------------------------------------------------ accept

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = server.accept();
                s.setTcpNoDelay(true);
                final Socket socket = s;
                Thread t = new Thread(new Runnable() {
                    public void run() {
                        handleConnection(socket);
                    }
                }, "hub-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (running) {
                    log("accept error: " + e);
                }
            }
        }
    }

    private void handleConnection(Socket socket) {
        Client client = null;
        try {
            socket.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
            InputStream in = new BufferedInputStream(socket.getInputStream(), 8192);
            OutputStream out = socket.getOutputStream();
            Req req = readRequest(in);
            if (req == null) {
                return;
            }
            if ("/ws".equals(req.path) && req.isUpgrade()) {
                if (!handshake(req, out)) {
                    return;
                }
                client = new Client(this, socket, in, out);
                client.run();
            } else {
                serveHttp(req, in, out);
            }
        } catch (SocketTimeoutException e) {
            log("handshake timeout");
        } catch (IOException e) {
            // 客户端断开属于正常现象
        } finally {
            if (client == null) {
                closeQuietly(socket);
            }
        }
    }

    // ------------------------------------------------------------------ http

    private static final class Req {
        String method = "";
        String path = "/";
        final Map<String, String> headers = new HashMap<String, String>();

        boolean isUpgrade() {
            String up = headers.get("upgrade");
            String conn = headers.get("connection");
            String ver = headers.get("sec-websocket-version");
            String k = headers.get("sec-websocket-key");
            if (up == null || !"websocket".equalsIgnoreCase(up.trim())) {
                return false;
            }
            if (conn == null || conn.toLowerCase().indexOf("upgrade") < 0) {
                return false;
            }
            if (ver == null || !"13".equals(ver.trim())) {
                return false;
            }
            return k != null && k.length() > 0;
        }
    }

    private static Req readRequest(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(1024);
        int a = 0;
        int b = 0;
        int c = 0;
        while (true) {
            int x = in.read();
            if (x < 0) {
                return null;
            }
            buf.write(x);
            if (buf.size() > 16384) {
                throw new IOException("request header too large");
            }
            if (a == '\r' && b == '\n' && c == '\r' && x == '\n') {
                break;
            }
            a = b;
            b = c;
            c = x;
        }
        String head = new String(buf.toByteArray(), StandardCharsets.UTF_8);
        String[] lines = head.split("\r\n");
        if (lines.length == 0) {
            return null;
        }
        String[] first = lines[0].split(" ");
        Req req = new Req();
        if (first.length >= 2) {
            req.method = first[0];
            req.path = first[1];
        }
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) {
                String name = lines[i].substring(0, colon).trim().toLowerCase();
                String value = lines[i].substring(colon + 1).trim();
                if (!req.headers.containsKey(name)) {
                    req.headers.put(name, value);
                }
            }
        }
        return req;
    }

    private void serveHttp(Req req, InputStream in, OutputStream out) throws IOException {
        String path = pathOf(req.path);

        // v1.2 §14.3：媒体上传（POST /upload）
        if ("POST".equals(req.method)) {
            if ("/upload".equals(path)) {
                handleUpload(req, in, out);
            } else {
                writeText(out, 404, "404 Not Found");
            }
            return;
        }
        if (!"GET".equals(req.method) && !"HEAD".equals(req.method)) {
            writeText(out, 405, "Method Not Allowed");
            return;
        }
        // v1.2 §14.3：按 id 取媒体（长缓存，区别于 assets 的 no-store）
        if (path.startsWith("/m/")) {
            serveMedia(path.substring(3), req, out);
            return;
        }
        if (path.length() == 0 || "/".equals(path)) {
            path = "/index.html";
        }
        if (path.indexOf("..") >= 0 || path.indexOf('\0') >= 0) {
            writeText(out, 404, "404 Not Found");
            return;
        }
        byte[] data = null;
        if (assets != null) {
            try {
                data = assets.read(path.substring(1));
            } catch (IOException e) {
                data = null;
            }
        }
        if (data == null) {
            writeText(out, 404, "404 Not Found");
            return;
        }
        String head = "HTTP/1.1 200 OK\r\nContent-Type: " + contentType(path)
                + "\r\nContent-Length: " + data.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        if (!"HEAD".equals(req.method)) {
            out.write(data);
        }
        out.flush();
        log("http " + req.method + " " + path + " -> 200 (" + data.length + "B)");
    }

    /** 去掉 query / fragment 后的路径。 */
    private static String pathOf(String raw) {
        String path = raw == null ? "/" : raw;
        int q = path.indexOf('?');
        if (q >= 0) {
            path = path.substring(0, q);
        }
        int h = path.indexOf('#');
        if (h >= 0) {
            path = path.substring(0, h);
        }
        return path;
    }

    private void serveMedia(String id, Req req, OutputStream out) throws IOException {
        byte[] data;
        String mime;
        synchronized (mediaLock) {
            MediaEntry entry = media.get(id);
            if (entry == null) {
                writeText(out, 404, "404 Not Found");
                return;
            }
            data = entry.data;
            mime = entry.mime;
        }
        String head = "HTTP/1.1 200 OK\r\nContent-Type: " + mime
                + "\r\nContent-Length: " + data.length
                + "\r\nCache-Control: public, max-age=31536000, immutable"
                + "\r\nAccept-Ranges: none"
                + "\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        if (!"HEAD".equals(req.method)) {
            out.write(data);
        }
        out.flush();
        log("media GET /m/" + id + " -> 200 (" + data.length + "B, " + mime + ")");
    }

    private void handleUpload(Req req, InputStream in, OutputStream out) throws IOException {
        String provided = req.headers.get("x-key");
        if (key != null && !key.equals(provided == null ? "" : provided)) {
            writeJson(out, 403, "{\"ok\":false,\"error\":\"bad_key\"}");
            return;
        }
        String kind = req.headers.get("x-kind");
        kind = kind == null ? "" : kind.trim().toLowerCase();
        if (!"image".equals(kind) && !"video".equals(kind)) {
            writeJson(out, 400, "{\"ok\":false,\"error\":\"bad_kind\"}");
            return;
        }
        long limit = "image".equals(kind) ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
        long declared = parseLong(req.headers.get("content-length"), -1L);
        if (declared <= 0) {
            writeJson(out, 400, "{\"ok\":false,\"error\":\"empty\"}");
            return;
        }
        if (declared > limit) {
            writeJson(out, 400, "{\"ok\":false,\"error\":\"too_large\"}");
            return;
        }
        byte[] body = new byte[(int) declared];
        int off = 0;
        while (off < body.length) {
            int n = in.read(body, off, body.length - off);
            if (n < 0) {
                break;
            }
            off += n;
        }
        if (off != body.length || off == 0) {
            writeJson(out, 400, "{\"ok\":false,\"error\":\"empty\"}");
            return;
        }
        String id = newMediaId();
        String mime = mimeFor(kind, req.headers.get("x-name"));
        synchronized (mediaLock) {
            media.put(id, new MediaEntry(body, mime));
            mediaBytes += body.length;
            Iterator<Map.Entry<String, MediaEntry>> it = media.entrySet().iterator();
            while (mediaBytes > MEDIA_TOTAL_BYTES && it.hasNext()) {
                Map.Entry<String, MediaEntry> eldest = it.next();
                mediaBytes -= eldest.getValue().data.length;
                it.remove();
                log("media evict /m/" + eldest.getKey());
            }
        }
        StringBuilder b = new StringBuilder(128);
        b.append("{\"ok\":true,\"id\":").append(Json.quote(id))
                .append(",\"path\":\"/m/").append(id)
                .append("\",\"mime\":").append(Json.quote(mime))
                .append(",\"size\":").append(body.length).append('}');
        writeJson(out, 200, b.toString());
        log("upload kind=" + kind + " id=" + id + " " + body.length + "B (" + mime + ")");
    }

    private String newMediaId() {
        byte[] raw = new byte[8];
        synchronized (mediaLock) {
            while (true) {
                random.nextBytes(raw);
                StringBuilder b = new StringBuilder(16);
                for (int i = 0; i < raw.length; i++) {
                    b.append(HEX[(raw[i] >> 4) & 0x0f]).append(HEX[raw[i] & 0x0f]);
                }
                String id = b.toString();
                if (!media.containsKey(id)) {
                    return id;
                }
            }
        }
    }

    private static String mimeFor(String kind, String rawName) {
        String name = rawName == null ? "" : rawName.toLowerCase();
        if ("image".equals(kind)) {
            if (name.endsWith(".png")) {
                return "image/png";
            }
            if (name.endsWith(".webp")) {
                return "image/webp";
            }
            if (name.endsWith(".gif")) {
                return "image/gif";
            }
            return "image/jpeg";
        }
        if (name.endsWith(".webm")) {
            return "video/webm";
        }
        if (name.endsWith(".mov")) {
            return "video/quicktime";
        }
        if (name.endsWith(".mkv")) {
            return "video/x-matroska";
        }
        return "video/mp4";
    }

    private static long parseLong(String s, long def) {
        if (s == null) {
            return def;
        }
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static void writeJson(OutputStream out, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + statusText(status)
                + "\r\nContent-Type: application/json; charset=utf-8"
                + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String statusText(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 400:
                return "Bad Request";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            default:
                return "Error";
        }
    }

    private static void writeText(OutputStream out, int status, String text) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + text
                + "\r\nContent-Type: text/plain; charset=utf-8"
                + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String contentType(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) {
            return "text/html; charset=utf-8";
        }
        if (p.endsWith(".js")) {
            return "application/javascript; charset=utf-8";
        }
        if (p.endsWith(".css")) {
            return "text/css; charset=utf-8";
        }
        if (p.endsWith(".json")) {
            return "application/json; charset=utf-8";
        }
        if (p.endsWith(".png")) {
            return "image/png";
        }
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (p.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (p.endsWith(".ico")) {
            return "image/x-icon";
        }
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------ ws handshake

    private boolean handshake(Req req, OutputStream out) throws IOException {
        String clientKey = req.headers.get("sec-websocket-key");
        if (clientKey == null || base64Decode(clientKey.trim()) == null
                || base64Decode(clientKey.trim()).length != 16) {
            writeText(out, 400, "Bad Request");
            return false;
        }
        String accept;
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((clientKey.trim() + WS_GUID).getBytes(StandardCharsets.UTF_8));
            accept = base64Encode(digest);
        } catch (Exception e) {
            writeText(out, 500, "Internal Server Error");
            return false;
        }
        String resp = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.UTF_8));
        out.flush();
        return true;
    }

    // ------------------------------------------------------------------ room

    private Client register(String id, Client client) {
        synchronized (lock) {
            return clients.put(id, client);
        }
    }

    private Client find(String id) {
        synchronized (lock) {
            return clients.get(id);
        }
    }

    private List<Client> snapshotExcept(Client self) {
        List<Client> list = new ArrayList<Client>();
        synchronized (lock) {
            for (Client c : clients.values()) {
                if (c != self && c.ready && !c.closed) {
                    list.add(c);
                }
            }
        }
        return list;
    }

    private void broadcastPeers() {
        List<Client> all;
        synchronized (lock) {
            all = new ArrayList<Client>(clients.values());
        }
        for (Client c : all) {
            if (!c.ready || c.closed) {
                continue;
            }
            List<Client> peers = snapshotExcept(c);
            StringBuilder b = new StringBuilder(64 + peers.size() * 64);
            b.append("{\"t\":\"peers\",\"peers\":[");
            for (int i = 0; i < peers.size(); i++) {
                if (i > 0) {
                    b.append(',');
                }
                Client p = peers.get(i);
                String av = avatarOf(p.id);
                b.append("{\"id\":").append(Json.quote(p.id))
                        .append(",\"name\":").append(Json.quote(p.name))
                        .append(",\"avatar\":").append(av == null ? "null" : Json.quote(av))
                        .append('}');
            }
            b.append("]}");
            c.sendText(b.toString());
        }
    }

    private void drop(Client client) {
        boolean removed = false;
        synchronized (lock) {
            if (client.id != null && clients.get(client.id) == client) {
                clients.remove(client.id);
                removed = true;
            }
        }
        if (removed) {
            log("leave id=" + client.id);
            broadcastPeers();
        }
    }

    /** 读某人当前头像（null=无）。 */
    private String avatarOf(String id) {
        synchronized (lock) {
            return avatars.get(id);
        }
    }

    /** v1.2 §14.1：向房内所有连接（含发送者）广播某个人的新头像。 */
    private void broadcastPeerInfo(Client who) {
        if (who == null || who.id == null) {
            return;
        }
        String avatar = avatarOf(who.id);
        String frame = "{\"t\":\"peer-info\",\"id\":" + Json.quote(who.id)
                + ",\"name\":" + Json.quote(who.name)
                + ",\"avatar\":" + (avatar == null ? "null" : Json.quote(avatar)) + "}";
        broadcast(frame);
    }

    /** 给房内所有 ready 连接发同一帧（顺序不保证）。 */
    private void broadcast(String frame) {
        List<Client> all;
        synchronized (lock) {
            all = new ArrayList<Client>(clients.values());
        }
        for (Client c : all) {
            if (c.ready && !c.closed) {
                c.sendText(frame);
            }
        }
    }

    private static void log(String msg) {
        System.err.println("[hub] " + msg);
    }

    // ------------------------------------------------------------------ client

    private static final class ProtoEx extends Exception {
        private static final long serialVersionUID = 1L;
        final int code;
        final String reason;

        ProtoEx(int code, String reason) {
            super(reason);
            this.code = code;
            this.reason = reason;
        }
    }

    private static final class Frame {
        final boolean fin;
        final int opcode;
        final byte[] payload;

        Frame(boolean fin, int opcode, byte[] payload) {
            this.fin = fin;
            this.opcode = opcode;
            this.payload = payload;
        }
    }

    private static final class MediaEntry {
        final byte[] data;
        final String mime;

        MediaEntry(byte[] data, String mime) {
            this.data = data;
            this.mime = mime;
        }
    }

    private static final class Client implements Runnable {
        final Hub hub;
        final Socket socket;
        final InputStream in;
        final OutputStream out;
        volatile String id;
        volatile String name;
        volatile boolean ready;
        volatile boolean closed;

        Client(Hub hub, Socket socket, InputStream in, OutputStream out) {
            this.hub = hub;
            this.socket = socket;
            this.in = in;
            this.out = out;
        }

        public void run() {
            try {
                // 握手完成 → hello 计时从 10s 开始（docs/PROTOCOL.md §3）
                try {
                    socket.setSoTimeout(HELLO_TIMEOUT_MS);
                } catch (IOException ignored) {
                    // ignore
                }
                while (!closed) {
                    Frame f = readFrame();
                    if (f == null) {
                        break;
                    }
                    if (!handleFrame(f)) {
                        break;
                    }
                }
            } catch (SocketTimeoutException e) {
                if (!ready) {
                    sendError("hello_timeout", "10s 内没有 hello", null);
                    shutdown(1008, "hello_timeout");
                } else {
                    shutdown(1001, "idle timeout");
                }
            } catch (ProtoEx e) {
                sendError(e.code == 1009 ? "too_large" : "bad_frame", e.reason, null);
                shutdown(e.code, e.reason);
            } catch (IOException e) {
                // 对端断开
            } finally {
                closed = true;
                hub.drop(this);
                closeQuietly(socket);
            }
        }

        void shutdown(int code, String reason) {
            if (closed) {
                return;
            }
            closed = true;
            sendClose(code, reason);
            closeQuietly(socket);
        }

        // -------------------------------------------------------------- frames

        private Frame readFrame() throws IOException, ProtoEx {
            int b0 = in.read();
            if (b0 < 0) {
                return null;
            }
            int b1 = in.read();
            if (b1 < 0) {
                return null;
            }
            boolean fin = (b0 & 0x80) != 0;
            if ((b0 & 0x70) != 0) {
                throw new ProtoEx(1002, "rsv bits not zero");
            }
            int opcode = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            if (!masked) {
                throw new ProtoEx(1002, "client frame must be masked");
            }
            long len = b1 & 0x7f;
            if (len == 126) {
                int hi = in.read();
                int lo = in.read();
                if (hi < 0 || lo < 0) {
                    return null;
                }
                len = ((long) hi << 8) | lo;
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) {
                    int x = in.read();
                    if (x < 0) {
                        return null;
                    }
                    len = (len << 8) | (x & 0xff);
                }
            }
            if (len < 0 || len > MAX_FRAME) {
                throw new ProtoEx(1009, "frame too large");
            }
            byte[] mask = new byte[4];
            readFully(mask, 4);
            byte[] payload = new byte[(int) len];
            readFully(payload, payload.length);
            for (int i = 0; i < payload.length; i++) {
                payload[i] = (byte) (payload[i] ^ mask[i & 3]);
            }
            if (opcode >= 8) {
                if (!fin) {
                    throw new ProtoEx(1002, "fragmented control frame");
                }
                if (payload.length > 125) {
                    throw new ProtoEx(1002, "control frame too large");
                }
            }
            return new Frame(fin, opcode, payload);
        }

        private void readFully(byte[] dst, int len) throws IOException {
            int off = 0;
            while (off < len) {
                int n = in.read(dst, off, len - off);
                if (n < 0) {
                    throw new IOException("eof");
                }
                off += n;
            }
        }

        private boolean handleFrame(Frame f) throws IOException, ProtoEx {
            switch (f.opcode) {
                case 0x8: {
                    int code = 1000;
                    String reason = "";
                    if (f.payload.length >= 2) {
                        code = ((f.payload[0] & 0xff) << 8) | (f.payload[1] & 0xff);
                        if (f.payload.length > 2) {
                            reason = new String(f.payload, 2, f.payload.length - 2,
                                    StandardCharsets.UTF_8);
                        }
                    }
                    sendClose(code == 1005 || code == 1006 || code < 1000 ? 1000 : code, "");
                    closed = true;
                    log("close from id=" + id + " code=" + code + " reason=" + reason);
                    return false;
                }
                case 0x9: {
                    sendFrame(0xA, f.payload, true);
                    return true;
                }
                case 0xA:
                    return true;
                case 0x2:
                    throw new ProtoEx(1003, "binary frames not supported");
                case 0x0:
                case 0x1:
                    return handleData(f);
                default:
                    throw new ProtoEx(1002, "bad opcode " + f.opcode);
            }
        }

        private byte[] fragment;
        private int fragmentOpcode;

        private boolean handleData(Frame f) throws IOException, ProtoEx {
            if (f.opcode == 0x1) {
                if (fragment != null) {
                    throw new ProtoEx(1002, "new data frame inside fragment");
                }
                if (!f.fin) {
                    fragment = f.payload;
                    fragmentOpcode = 0x1;
                    return true;
                }
                processText(f.payload);
                return true;
            }
            // opcode 0x0 continuation
            if (fragment == null || fragmentOpcode != 0x1) {
                throw new ProtoEx(1002, "unexpected continuation frame");
            }
            if (fragment.length + f.payload.length > MAX_FRAME) {
                throw new ProtoEx(1009, "fragmented message too large");
            }
            byte[] merged = new byte[fragment.length + f.payload.length];
            System.arraycopy(fragment, 0, merged, 0, fragment.length);
            System.arraycopy(f.payload, 0, merged, fragment.length, f.payload.length);
            if (!f.fin) {
                fragment = merged;
                return true;
            }
            fragment = null;
            fragmentOpcode = 0;
            processText(merged);
            return true;
        }

        private void processText(byte[] payload) throws IOException {
            String text = new String(payload, StandardCharsets.UTF_8);
            Map<String, Object> m;
            try {
                Object parsed = Json.parse(text);
                m = Json.asObject(parsed);
            } catch (RuntimeException e) {
                sendError("bad_json", "invalid json: " + e.getMessage(), null);
                shutdown(1002, "bad_json");
                return;
            }
            String t = Json.str(m.get("t"));
            if (t == null) {
                sendError("bad_json", "missing t", null);
                shutdown(1002, "bad_json");
                return;
            }
            if (!ready) {
                if ("hello".equals(t)) {
                    handleHello(m);
                } else {
                    sendError("not_hello", "hello first", null);
                    shutdown(1008, "not_hello");
                }
                return;
            }
            if ("hello".equals(t)) {
                return; // 重复 hello 忽略
            }
            if ("send".equals(t)) {
                handleSend(m);
            } else if ("history".equals(t)) {
                handleHistory(m);
            } else if ("read".equals(t)) {
                // v1 无应答：本机 Hub 不保存已读状态
            } else if ("avatar".equals(t)) {
                handleAvatar(m);
            } else if ("profile".equals(t)) {
                handleProfile(m);
            } else if ("group".equals(t)) {
                handleGroup(m);
            } else if ("gavatar".equals(t)) {
                handleGavatar(m);
            } else if ("ping".equals(t)) {
                sendText("{\"t\":\"pong\",\"ts\":" + System.currentTimeMillis() + "}");
            }
            // 未知 t：§14.4 规定服务端忽略（不报错、不断线），避免新客户端的新帧打断旧服务端。
        }

        // -------------------------------------------------------------- protocol

        private void handleHello(Map<String, Object> m) {
            Object k = m.get("key");
            String provided = k instanceof String ? (String) k : "";
            if (hub.key != null && !hub.key.equals(provided)) {
                sendError("bad_key", "通行码错误", null);
                shutdown(1008, "bad_key");
                return;
            }
            String newId;
            String newName;
            try {
                Map<String, Object> user = Json.asObject(m.get("user"));
                newId = Json.str(user.get("id"));
                newName = Json.str(user.get("name"));
            } catch (RuntimeException e) {
                sendError("bad_user", "user must be object", null);
                shutdown(1008, "bad_user");
                return;
            }
            if (!isHex32(newId)) {
                sendError("bad_user", "id must be 32 lowercase hex", null);
                shutdown(1008, "bad_user");
                return;
            }
            newName = newName == null ? "" : newName.trim();
            int cp = newName.codePointCount(0, newName.length());
            if (cp < 1 || cp > 24) {
                sendError("bad_user", "name must be 1-24 chars", null);
                shutdown(1008, "bad_user");
                return;
            }
            Client old = hub.register(newId, this);
            this.id = newId;
            this.name = newName;
            this.ready = true;
            try {
                socket.setSoTimeout(IDLE_TIMEOUT_MS);
            } catch (IOException ignored) {
                // ignore
            }
            sendWelcome();
            if (old != null && old != this) {
                log("replace id=" + newId);
                old.shutdown(4001, "replaced");
            }
            hub.broadcastPeers();
            log("join id=" + newId + " name=" + newName);
        }

        private void sendWelcome() {
            StringBuilder b = new StringBuilder(256);
            List<Client> peers;
            Map<String, String> avatarSnap;
            String meAvatar;
            String group;
            synchronized (hub.lock) {
                peers = hub.snapshotExcept(this);
                avatarSnap = new HashMap<String, String>(hub.avatars);
                meAvatar = hub.avatars.get(id);
                group = hub.groupName;
            }
            b.append("{\"t\":\"welcome\",\"me\":{\"id\":").append(Json.quote(id))
                    .append(",\"name\":").append(Json.quote(name));
            appendAvatar(b, meAvatar);
            b.append("},\"peers\":[");
            for (int i = 0; i < peers.size(); i++) {
                if (i > 0) {
                    b.append(',');
                }
                Client p = peers.get(i);
                b.append("{\"id\":").append(Json.quote(p.id))
                        .append(",\"name\":").append(Json.quote(p.name));
                appendAvatar(b, avatarSnap.get(p.id));
                b.append('}');
            }
            b.append("],\"server\":{\"mode\":").append(Json.quote(hub.mode))
                    .append(",\"ver\":\"1\",\"caps\":").append(CAPS_JSON)
                    .append(",\"group\":").append(Json.quote(group))
                    .append(",\"gavatar\":").append(hub.groupAvatar == null ? "null" : Json.quote(hub.groupAvatar))
                    .append("}}");
            sendText(b.toString());
        }

        private static void appendAvatar(StringBuilder b, String avatar) {
            b.append(",\"avatar\":").append(avatar == null ? "null" : Json.quote(avatar));
        }

        private void handleSend(Map<String, Object> m) {
            String to = Json.str(m.get("to"));
            String kind = Json.str(m.get("kind"));
            if (!"text".equals(kind) && !"image".equals(kind) && !"video".equals(kind)) {
                sendError("bad_kind", "kind 需为 text / image / video", null);
                return;
            }
            if (to == null || !(to.equals("all") || isHex32(to))) {
                sendError("bad_to", "to must be all or 32hex id", null);
                return;
            }
            if (to.equals(id)) {
                sendError("bad_to", "cannot send to self", null);
                return;
            }
            String text = Json.str(m.get("text"));
            if (text == null) {
                text = "";
            }
            final String mid = Json.str(m.get("mid"));
            if (!isValidMid(mid)) {
                sendError("bad_mid", "mid must be 1-64 chars [A-Za-z0-9_.:-]", null);
                return;
            }
            long ts = System.currentTimeMillis();
            // §14.3：image/video 的 meta 原样透传（服务端不改写）；text 忽略 meta
            Object meta = null;
            if (!"text".equals(kind)) {
                Object rawMeta = m.get("meta");
                if (rawMeta instanceof Map) {
                    meta = rawMeta;
                }
            }
            String frame = buildMsg(id, name, to, kind, text, mid, ts, meta);
            if (to.equals("all")) {
                List<Client> others = hub.snapshotExcept(this);
                for (Client c : others) {
                    c.sendText(frame);
                }
                sendText(frame);
                sendAck(mid, ts);
            } else {
                Client target = hub.find(to);
                if (target == null) {
                    sendError("no_peer", "peer not in room", mid);
                    return;
                }
                target.sendText(frame);
                sendText(frame);
                sendAck(mid, ts);
            }
        }

        // -------------------------------------------------------------- v1.2 §14

        /** §14.1：头像（data URL 或 null 清除）；仅内存，成功则向全房广播 peer-info。 */
        private void handleAvatar(Map<String, Object> m) {
            if (!m.containsKey("data")) {
                sendError("bad_avatar", "avatar.data required", null);
                return;
            }
            Object raw = m.get("data");
            String data = null;
            if (raw != null) {
                if (!(raw instanceof String)) {
                    sendError("bad_avatar", "avatar must be data URL or null", null);
                    return;
                }
                data = (String) raw;
                if (data.isEmpty()) {
                    // 与中继一致：'' 也当清除（§14.1 只规定 null，这是宽松对齐）
                    data = null;
                }
                if (data != null && (!data.startsWith(AVATAR_PREFIX)
                        || data.length() > MAX_AVATAR_CHARS)) {
                    sendError("bad_avatar",
                            "avatar must start with " + AVATAR_PREFIX + " and be <= 48000 chars", null);
                    return;
                }
            }
            synchronized (hub.lock) {
                if (data == null) {
                    hub.avatars.remove(id);
                } else {
                    hub.avatars.put(id, data);
                }
            }
            hub.broadcastPeerInfo(this);
            log("avatar id=" + id + " " + (data == null ? "cleared" : data.length() + " chars"));
        }

        /** §14.6：改名（不改连接、不改历史；成功广播 peer-info）。 */
        private void handleProfile(Map<String, Object> m) {
            String raw = Json.str(m.get("name"));
            String name = raw == null ? "" : raw.trim();
            if (name.isEmpty() || name.codePointCount(0, name.length()) > 24) {
                sendError("bad_name", "昵称需为 1-24 个字符", null);
                return;
            }
            String old;
            synchronized (hub.lock) {
                old = this.name;
                this.name = name;
            }
            hub.broadcastPeerInfo(this);
            log("rename id=" + id + " " + old + " -> " + name);
        }

        /** §14.2：群名（trim 后 1–24 字符）；仅内存，成功则向全房广播 group。 */
        private void handleGroup(Map<String, Object> m) {
            String raw = Json.str(m.get("name"));
            String trimmed = raw == null ? "" : raw.trim();
            int cp = trimmed.codePointCount(0, trimmed.length());
            if (cp < 1 || cp > 24) {
                sendError("bad_group", "group name must be 1-24 chars", null);
                return;
            }
            hub.groupName = trimmed;
            String frame = "{\"t\":\"group\",\"name\":" + Json.quote(trimmed)
                    + ",\"by\":" + Json.quote(id)
                    + ",\"ts\":" + System.currentTimeMillis() + "}";
            hub.broadcast(frame);
            log("group=" + trimmed + " by=" + id);
        }

        private void handleGavatar(Map<String, Object> m) {
            Object rawObj = m.get("data");
            if (rawObj == null) {
                hub.groupAvatar = null;
                String cleared = "{\"t\":\"gavatar\",\"data\":null,\"by\":" + Json.quote(id)
                        + ",\"ts\":" + System.currentTimeMillis() + "}";
                hub.broadcast(cleared);
                log("gavatar cleared by=" + id);
                return;
            }
            String data = Json.str(rawObj);
            if (data == null) {
                sendError("bad_gavatar", "gavatar.data must be a data URL or null", null);
                return;
            }
            data = data.trim();
            if (data.isEmpty()) {
                hub.groupAvatar = null;
                String cleared = "{\"t\":\"gavatar\",\"data\":null,\"by\":" + Json.quote(id)
                        + ",\"ts\":" + System.currentTimeMillis() + "}";
                hub.broadcast(cleared);
                return;
            }
            if (!data.startsWith(AVATAR_PREFIX) || data.length() > MAX_AVATAR_CHARS) {
                sendError("bad_gavatar", "group avatar must start with " + AVATAR_PREFIX + " and be <= " + MAX_AVATAR_CHARS + " chars", null);
                return;
            }
            hub.groupAvatar = data;
            String frame = "{\"t\":\"gavatar\",\"data\":" + Json.quote(data)
                    + ",\"by\":" + Json.quote(id)
                    + ",\"ts\":" + System.currentTimeMillis() + "}";
            hub.broadcast(frame);
            log("gavatar=" + data.length() + " chars by=" + id);
        }

        private void handleHistory(Map<String, Object> m) {
            String with = Json.str(m.get("with"));
            long limit = Json.lng(m.get("limit"), 50);
            if (limit < 1) {
                limit = 1;
            }
            if (limit > 100) {
                limit = 100;
            }
            StringBuilder b = new StringBuilder(64);
            b.append("{\"t\":\"history\",\"with\":")
                    .append(with == null ? "null" : Json.quote(with))
                    .append(",\"msgs\":[]}");
            sendText(b.toString());
        }

        private static String buildMsg(String from, String fromName, String to, String kind,
                                       String text, String mid, long ts, Object meta) {
            StringBuilder b = new StringBuilder(128 + text.length());
            b.append("{\"t\":\"msg\",\"from\":").append(Json.quote(from))
                    .append(",\"fromName\":").append(Json.quote(fromName))
                    .append(",\"to\":").append(Json.quote(to))
                    .append(",\"kind\":").append(Json.quote(kind))
                    .append(",\"text\":").append(Json.quote(text))
                    .append(",\"mid\":").append(Json.quote(mid))
                    .append(",\"ts\":").append(ts);
            if (meta != null && !"text".equals(kind)) {
                b.append(",\"meta\":").append(jsonValue(meta));
            }
            b.append('}');
            return b.toString();
        }

        /** 把 Json.parse 产出的 Map/List/String/Long/Double/Boolean/null 重新写成 JSON（meta 透传用，见 §14.3）。 */
        private static String jsonValue(Object v) {
            if (v == null) {
                return "null";
            }
            if (v instanceof String) {
                return Json.quote((String) v);
            }
            if (v instanceof Boolean) {
                return ((Boolean) v).booleanValue() ? "true" : "false";
            }
            if (v instanceof Long || v instanceof Integer) {
                return String.valueOf(v);
            }
            if (v instanceof Double) {
                double d = ((Double) v).doubleValue();
                long l = (long) d;
                if ((double) l == d) {
                    return String.valueOf(l);
                }
                return String.valueOf(d);
            }
            if (v instanceof Map) {
                StringBuilder b = new StringBuilder(64);
                b.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                    if (!first) {
                        b.append(',');
                    }
                    first = false;
                    b.append(Json.quote(String.valueOf(e.getKey()))).append(':')
                            .append(jsonValue(e.getValue()));
                }
                b.append('}');
                return b.toString();
            }
            if (v instanceof List) {
                StringBuilder b = new StringBuilder(64);
                b.append('[');
                boolean first = true;
                for (Object item : (List<?>) v) {
                    if (!first) {
                        b.append(',');
                    }
                    first = false;
                    b.append(jsonValue(item));
                }
                b.append(']');
                return b.toString();
            }
            return Json.quote(String.valueOf(v));
        }

        private void sendAck(String mid, long ts) {
            sendText("{\"t\":\"ack\",\"mid\":" + Json.quote(mid) + ",\"ts\":" + ts + "}");
        }

        void sendError(String code, String msg, String ref) {
            StringBuilder b = new StringBuilder(96);
            b.append("{\"t\":\"error\",\"code\":").append(Json.quote(code))
                    .append(",\"msg\":").append(Json.quote(msg));
            if (ref != null) {
                b.append(",\"ref\":").append(Json.quote(ref));
            }
            b.append('}');
            sendText(b.toString());
        }

        // -------------------------------------------------------------- output

        void sendText(String text) {
            sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8), true);
        }

        private void sendClose(int code, String reason) {
            byte[] r = reason == null ? new byte[0] : reason.getBytes(StandardCharsets.UTF_8);
            if (r.length > 123) {
                byte[] cut = new byte[123];
                System.arraycopy(r, 0, cut, 0, 123);
                r = cut;
            }
            byte[] payload = new byte[2 + r.length];
            payload[0] = (byte) ((code >> 8) & 0xff);
            payload[1] = (byte) (code & 0xff);
            System.arraycopy(r, 0, payload, 2, r.length);
            sendFrame(0x8, payload, true);
        }

        private void sendFrame(int opcode, byte[] payload, boolean fin) {
            if (closed && opcode != 0x8) {
                return;
            }
            try {
                synchronized (out) {
                    out.write((fin ? 0x80 : 0x00) | (opcode & 0x0f));
                    int len = payload.length;
                    if (len <= 125) {
                        out.write(len);
                    } else if (len <= 65535) {
                        out.write(126);
                        out.write((len >>> 8) & 0xff);
                        out.write(len & 0xff);
                    } else {
                        out.write(127);
                        for (int i = 7; i >= 0; i--) {
                            out.write((int) (((long) len >>> (8 * i)) & 0xff));
                        }
                    }
                    out.write(payload);
                    out.flush();
                }
            } catch (IOException e) {
                closed = true;
                closeQuietly(socket);
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    static boolean isHex32(String s) {
        if (s == null || s.length() != 32) {
            return false;
        }
        for (int i = 0; i < 32; i++) {
            char c = s.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    static boolean isValidMid(String s) {
        if (s == null || s.length() < 1 || s.length() > 64) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')
                    || (c >= 'A' && c <= 'Z') || c == '_' || c == '.' || c == ':'
                    || c == '-';
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            .toCharArray();

    static String base64Encode(byte[] data) {
        StringBuilder b = new StringBuilder((data.length + 2) / 3 * 4);
        int i = 0;
        while (i + 2 < data.length) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8) | (data[i + 2] & 0xff);
            b.append(B64[(n >>> 18) & 0x3f]);
            b.append(B64[(n >>> 12) & 0x3f]);
            b.append(B64[(n >>> 6) & 0x3f]);
            b.append(B64[n & 0x3f]);
            i += 3;
        }
        int rem = data.length - i;
        if (rem == 1) {
            int n = (data[i] & 0xff) << 16;
            b.append(B64[(n >>> 18) & 0x3f]);
            b.append(B64[(n >>> 12) & 0x3f]);
            b.append("==");
        } else if (rem == 2) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8);
            b.append(B64[(n >>> 18) & 0x3f]);
            b.append(B64[(n >>> 12) & 0x3f]);
            b.append(B64[(n >>> 6) & 0x3f]);
            b.append('=');
        }
        return b.toString();
    }

    static byte[] base64Decode(String s) {
        if (s == null || (s.length() & 3) != 0) {
            return null;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length() / 4 * 3);
        int[] buf = new int[4];
        for (int i = 0; i < s.length(); i += 4) {
            int pad = 0;
            for (int j = 0; j < 4; j++) {
                char c = s.charAt(i + j);
                if (c == '=') {
                    buf[j] = 0;
                    pad++;
                    continue;
                }
                int v = decodeChar(c);
                if (v < 0) {
                    return null;
                }
                buf[j] = v;
            }
            int n = (buf[0] << 18) | (buf[1] << 12) | (buf[2] << 6) | buf[3];
            out.write((n >>> 16) & 0xff);
            if (pad < 2) {
                out.write((n >>> 8) & 0xff);
            }
            if (pad < 1) {
                out.write(n & 0xff);
            }
        }
        return out.toByteArray();
    }

    private static int decodeChar(char c) {
        if (c >= 'A' && c <= 'Z') {
            return c - 'A';
        }
        if (c >= 'a' && c <= 'z') {
            return c - 'a' + 26;
        }
        if (c >= '0' && c <= '9') {
            return c - '0' + 52;
        }
        if (c == '+') {
            return 62;
        }
        if (c == '/') {
            return 63;
        }
        return -1;
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) {
            return;
        }
        try {
            c.close();
        } catch (IOException ignored) {
            // ignore
        }
    }

    // ------------------------------------------------------------------ desktop entry

    /** 桌面/测试入口：java -cp app/build/classes com.xxhh.xhc.Hub <port> <key|-> <assetsDir> */
    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : DEFAULT_PORT;
        final String key = args.length > 1 && !"-".equals(args[1]) && !args[1].isEmpty() ? args[1] : null;
        final File root = new File(args.length > 2 ? args[2] : "app/assets");
        AssetProvider provider = new AssetProvider() {
            public byte[] read(String path) throws IOException {
                File f = new File(root, path);
                if (!f.isFile()) {
                    return null;
                }
                FileInputStream in = new FileInputStream(f);
                try {
                    return readAll(in);
                } finally {
                    closeQuietly(in);
                }
            }
        };
        Hub hub = new Hub(port, key, provider);
        hub.start();
        log("assets=" + root.getAbsolutePath());
        synchronized (hub) {
            hub.wait();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}