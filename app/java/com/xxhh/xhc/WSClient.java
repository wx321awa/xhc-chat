package com.xxhh.xhc;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 极简 WebSocket 客户端（RFC6455，仅文本帧 + ping/pong/close）。
 * 给后台提醒服务用：它必须在 App 进程里保持一条到中继的连接，
 * 又不希望拖进 OkHttp 这类依赖，所以这里手写握手与帧。
 * 只用 java.* API，因此可以在桌面 JVM 里跑测试（见 app/test/wsclient.mjs）。
 */
public final class WSClient {

    public interface Listener {
        void onOpen();
        void onText(String text);
        void onClose(String why);
    }

    private static final SecureRandom RAND = new SecureRandom();

    private final String url;
    private final Listener listener;
    private Socket sock;
    private InputStream in;
    private OutputStream out;
    private volatile boolean alive;
    private volatile boolean closedByUser;
    private Thread reader;

    public WSClient(String url, Listener listener) {
        this.url = url;
        this.listener = listener;
    }

    public boolean isOpen() {
        return alive;
    }

    public void connect() throws IOException {
        URI u;
        try {
            u = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new IOException("bad url: " + url);
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (!"ws".equals(scheme)) {
            throw new IOException("only ws:// supported: " + url);
        }
        String host = u.getHost();
        int port = u.getPort() > 0 ? u.getPort() : 80;
        String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        if (u.getRawQuery() != null) {
            path = path + "?" + u.getRawQuery();
        }

        byte[] keyBytes = new byte[16];
        RAND.nextBytes(keyBytes);
        String key = Base64.getEncoder().encodeToString(keyBytes);

        Socket s = new Socket();
        s.connect(new InetSocketAddress(host, port), 15000);
        s.setSoTimeout(0);
        s.setTcpNoDelay(true);
        InputStream si = new BufferedInputStream(s.getInputStream(), 16384);
        OutputStream so = s.getOutputStream();

        String req = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + host + ":" + port + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "User-Agent: XHC-android\r\n\r\n";
        so.write(req.getBytes("UTF-8"));
        so.flush();

        String statusLine = readLine(si);
        if (statusLine == null || statusLine.indexOf(" 101 ") < 0) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
            throw new IOException("handshake failed: " + (statusLine == null ? "(no response)" : statusLine.trim()));
        }
        String line;
        boolean upgraded = false;
        while ((line = readLine(si)) != null) {
            if (line.isEmpty()) {
                break;
            }
            String lower = line.toLowerCase();
            if (lower.startsWith("upgrade:")) {
                upgraded = lower.indexOf("websocket") > 0;
            }
        }
        if (!upgraded) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
            throw new IOException("handshake lacked Upgrade: websocket");
        }

        sock = s;
        in = si;
        out = so;
        alive = true;
        closedByUser = false;
        reader = new Thread(new Runnable() {
            public void run() {
                pump();
            }
        }, "xhc-ws-reader");
        reader.setDaemon(true);
        reader.start();
        listener.onOpen();
    }

    public synchronized void sendText(String text) {
        if (!alive) {
            return;
        }
        try {
            byte[] payload = text.getBytes("UTF-8");
            writeFrame(0x1, payload);
        } catch (IOException e) {
            close("send failed: " + e.getMessage());
        }
    }

    public void close(String why) {
        if (!alive && sock == null) {
            return;
        }
        closedByUser = true;
        alive = false;
        try {
            if (out != null) {
                writeFrame(0x8, new byte[0]);
            }
        } catch (IOException ignored) {
        }
        try {
            if (sock != null) {
                sock.close();
            }
        } catch (IOException ignored) {
        }
        sock = null;
        listener.onClose(why == null ? "closed" : why);
    }

    private synchronized void writeFrame(int opcode, byte[] payload) throws IOException {
        if (out == null) {
            throw new IOException("not connected");
        }
        ByteArrayOutputStream h = new ByteArrayOutputStream(payload.length + 14);
        h.write(0x80 | opcode);                       // FIN + opcode
        int len = payload.length;
        if (len < 126) {
            h.write(0x80 | len);                      // mask bit + length
        } else if (len < 65536) {
            h.write(0x80 | 126);
            h.write((len >>> 8) & 0xff);
            h.write(len & 0xff);
        } else {
            h.write(0x80 | 127);
            long l = len;
            int i;
            for (i = 7; i >= 0; i--) {
                h.write((int) ((l >>> (8 * i)) & 0xff));
            }
        }
        byte[] mask = new byte[4];
        RAND.nextBytes(mask);
        h.write(mask, 0, 4);
        byte[] body = new byte[len];
        int i;
        for (i = 0; i < len; i++) {
            body[i] = (byte) (payload[i] ^ mask[i & 3]);
        }
        h.write(body, 0, len);
        out.write(h.toByteArray());
        out.flush();
    }

    private void pump() {
        try {
            while (alive) {
                int b0 = in.read();
                if (b0 < 0) {
                    break;
                }
                int b1 = in.read();
                if (b1 < 0) {
                    break;
                }
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) {
                    len = ((long) readByte() << 8) | readByte();
                } else if (len == 127) {
                    len = 0;
                    int i;
                    for (i = 0; i < 8; i++) {
                        len = (len << 8) | readByte();
                    }
                }
                byte[] mask = new byte[4];
                if (masked) {
                    readFully(mask, 4);
                }
                ByteArrayOutputStream buf = new ByteArrayOutputStream((int) Math.min(len, 1 << 20));
                byte[] chunk = new byte[4096];
                long left = len;
                while (left > 0) {
                    int want = (int) Math.min(chunk.length, left);
                    int n = in.read(chunk, 0, want);
                    if (n < 0) {
                        throw new IOException("eof in payload");
                    }
                    buf.write(chunk, 0, n);
                    left -= n;
                }
                byte[] payload = buf.toByteArray();
                if (masked) {
                    int i;
                    for (i = 0; i < payload.length; i++) {
                        payload[i] = (byte) (payload[i] ^ mask[i & 3]);
                    }
                }
                if (opcode == 0x1) {
                    if (fin) {
                        listener.onText(new String(payload, "UTF-8"));
                    }
                } else if (opcode == 0x9) {
                    try {
                        writeFrame(0xA, payload);
                    } catch (IOException e) {
                        break;
                    }
                } else if (opcode == 0x8) {
                    break;
                }
            }
        } catch (IOException e) {
            if (alive) {
                alive = false;
                if (!closedByUser) {
                    listener.onClose("io: " + e.getMessage());
                }
            }
            return;
        }
        if (alive) {
            alive = false;
            listener.onClose("eof");
        }
    }

    private int readByte() throws IOException {
        int b = in.read();
        if (b < 0) {
            throw new IOException("eof");
        }
        return b;
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

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') {
                break;
            }
            if (c != '\r') {
                b.write(c);
            }
        }
        if (c < 0 && b.size() == 0) {
            return null;
        }
        return new String(b.toByteArray(), "UTF-8");
    }
}
