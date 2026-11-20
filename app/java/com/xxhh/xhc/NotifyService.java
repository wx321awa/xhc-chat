package com.xxhh.xhc;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 后台提醒服务（微信式）。
 *
 * 为什么是前台服务：目标 SDK 33 的进程一旦退到后台，WebSocket 会被系统冻结/杀掉，
 * 拿不到消息自然也就不会有提醒。这里用一个常驻前台服务自己维护到中继的连接，
 * 前台通知常驻（不可划掉），App 回到前台时本服务会被停掉。
 *
 * 逻辑：
 *  - MainActivity 在 onPause 且用户开着「后台提醒」时 startForegroundService(Intent)；
 *  - 服务读 SharedPreferences 里的 endpoint / key / name / id，连上后 hello；
 *  - 收到别人的 msg（from != 自己）就发通知（会话内的消息不重复：只挑非自己）；
 *  - 20s 一次 ping；断开按 2/4/8/15s 退避重连；
 *  - onResume 时 MainActivity 停掉服务并清掉通知。
 */
public class NotifyService extends Service {

    private static final String TAG = "XHC-notify";
    private static final String CH_BG = "xhc_bg";
    private static final String CH_MSG = "xhc_msg";
    private static final int NOTI_BG = 1001;
    private static final int NOTI_MSG = 1002;
    /** 补拉时只推这么新的消息（更旧的不打扰，只推进已读进度） */
    private static final long CATCHUP_MAX_AGE_MS = 60L * 60 * 1000;

    /** App 在前台时由 MainActivity 置 true：服务只是保活，不再弹消息通知。 */
    public static volatile boolean appVisible = false;

    /** 后台服务当前状态，供 App 显示（已连接 / 重连中 / 被拒）。 */
    public static volatile String lastState = "未启动";

    private PowerManager.WakeLock wakeLock;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WSClient client;
    private volatile boolean stopping;
    private Runnable pendingRetry;
    private String connectedUrl = "";
    private int retryIdx;
    private long lastPing;
    private final List<String> inboxTitles = new ArrayList<String>();
    private final List<String> inboxLines = new ArrayList<String>();
    private String myId = "";
    private String myName = "";
    private String endpoint = "";
    private String roomKey = "";
    private String groupName = "群聊（全部）";
    /** 已经通知过的消息时间戳（服务重启后靠它补拉断线期间的消息） */
    private long lastSeenTs = 0L;
    private long lastPongAt = 0L;
    private final java.util.Set<String> seenMids = new java.util.HashSet<String>();

    /** 记录已处理的 mid，超过上限就清空（避免常驻服务里无限增长）。 */
    private boolean seenOnce(String mid) {
        if (mid == null) {
            return true;
        }
        if (seenMids.size() > 500) {
            seenMids.clear();
        }
        return seenMids.add(mid);
    }

    private final Runnable pingTask = new Runnable() {
        public void run() {
            if (stopping) {
                return;
            }
            if (client != null && client.isOpen()) {
                long now = System.currentTimeMillis();
                // 半死的连接不会报 close：45 秒没有 pong 就自己掐掉重连，避免静默丢消息
                if (lastPongAt > 0 && now - lastPongAt > 45000) {
                    Log.w(TAG, "pong timeout, reconnect");
                    setState("连接无响应，正在重连");
                    final WSClient dead = client;
                    client = null;
                    if (dead != null) dead.close("pong timeout");
                    return;
                }
                client.sendText("{\"t\":\"ping\",\"ts\":" + now + "}");
                ui.postDelayed(this, 20000);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels();
        startForeground(NOTI_BG, buildBgNotification());
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "XHC:bg");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "wakelock: " + e);
        }
        setState("正在连接…");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences sp = getSharedPreferences("xhc_prefs", MODE_PRIVATE);
        endpoint = sp.getString("endpoint", "");
        roomKey = sp.getString("key", "");
        myName = sp.getString("name", "我");
        myId = sp.getString("id", "");
        if (intent != null) {
            if (intent.hasExtra("endpoint")) endpoint = intent.getStringExtra("endpoint");
            if (intent.hasExtra("key")) roomKey = intent.getStringExtra("key");
            if (intent.hasExtra("name")) myName = intent.getStringExtra("name");
            if (intent.hasExtra("id")) myId = intent.getStringExtra("id");
        }
        stopping = false;
        lastSeenTs = sp.getLong("bgLastTs", 0L);
        // 已经连着同一个地址时别为一次重启把连接掐了（避免每条消息都开个空窗）
        if (client != null && client.isOpen() && endpoint != null && endpoint.equals(connectedUrl)) {
            return START_STICKY;
        }
        if (endpoint == null || endpoint.isEmpty()) {
            Log.w(TAG, "no endpoint configured, stop");
            stopSelf();
            return START_NOT_STICKY;
        }
        connect();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        setState("未启动");
        ui.removeCallbacksAndMessages(null);
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception e) {
        }
        wakeLock = null;
        if (client != null) {
            client.close("service destroyed");
            client = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void connect() {
        if (stopping) {
            return;
        }
        if (pendingRetry != null) {
            ui.removeCallbacks(pendingRetry);
            pendingRetry = null;
        }
        if (client != null) {
            client.close("reconnect");
            client = null;
        }
        final String url = endpoint;
        client = new WSClient(url, new WSClient.Listener() {
            public void onOpen() {
                Log.i(TAG, "connected " + url);
                retryIdx = 0;
                connectedUrl = url;
                setState("已连接 · 收消息中");
                lastPongAt = System.currentTimeMillis();
                Hello();
            }

            public void onText(String text) {
                onFrame(text);
            }

            public void onClose(String why) {
                if ("reconnect".equals(why) || "service destroyed".equals(why)) {
                    return;
                }
                if (why != null && why.indexOf("bad_key") >= 0) setState("连接被拒：通行码不对");
                else if (why != null && why.indexOf("bad_user") >= 0) setState("连接被拒：身份不对");
                else setState("断线，准备重连");
                Log.i(TAG, "closed: " + why);
                if (stopping) {
                    return;
                }
                scheduleRetry();
            }
        });
        try {
            client.connect();
        } catch (Exception e) {
            Log.w(TAG, "connect failed: " + e.getMessage());
            scheduleRetry();
        }
    }

    private void scheduleRetry() {
        if (stopping) {
            return;
        }
        int[] backoff = {2, 4, 8, 15};
        int sec = backoff[Math.min(retryIdx, backoff.length - 1)];
        retryIdx++;
        setState("重连中（第 " + retryIdx + " 次，" + sec + " 秒后）");
        if (pendingRetry != null) {
            ui.removeCallbacks(pendingRetry);
        }
        pendingRetry = new Runnable() {
            public void run() {
                pendingRetry = null;
                connect();
            }
        };
        ui.postDelayed(pendingRetry, sec * 1000L);
    }

    private void Hello() {
        String id = ensureId();
        String name = clampName(myName);
        StringBuilder b = new StringBuilder(180);
        b.append("{\"t\":\"hello\",\"key\":").append(Json.quote(roomKey == null ? "" : roomKey))
                .append(",\"user\":{\"id\":").append(Json.quote(id))
                .append(",\"name\":").append(Json.quote(name))
                .append("}}");
        client.sendText(b.toString());
        lastPing = System.currentTimeMillis();
        ui.removeCallbacks(pingTask);
        ui.postDelayed(pingTask, 20000);
    }

    /** 协议 §3.1：id 必须 32 位小写 hex；服务端启动时可能还没拿到前端给的 id。 */
    private String ensureId() {
        if (myId != null && myId.length() == 32) {
            boolean goodId = true;
            int i;
            for (i = 0; i < 32; i++) {
                char ch = myId.charAt(i);
                if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) {
                    goodId = false;
                    break;
                }
            }
            if (goodId) {
                return myId;
            }
        }
        StringBuilder b = new StringBuilder(32);
        byte[] raw = new byte[16];
        new java.security.SecureRandom().nextBytes(raw);
        int i;
        for (i = 0; i < raw.length; i++) {
            b.append(Character.forDigit((raw[i] >> 4) & 0xf, 16));
            b.append(Character.forDigit(raw[i] & 0xf, 16));
        }
        myId = b.toString();
        getSharedPreferences("xhc_prefs", MODE_PRIVATE).edit().putString("id", myId).apply();
        return myId;
    }

    /** 昵称 1–24 个码点（协议 §3.1），越界就用「我」。 */
    private static String clampName(String raw) {
        String s = raw == null ? "" : raw.trim().replaceAll("\\s+", " ");
        if (s.isEmpty()) {
            return "我";
        }
        int count = s.codePointCount(0, s.length());
        if (count > 24) {
            s = s.substring(0, s.offsetByCodePoints(0, 24));
        }
        return s;
    }

    private void onFrame(String text) {
        try {
            onFrameInner(text);
        } catch (RuntimeException e) {
            Log.w(TAG, "frame handled with error: " + e);
        }
    }

    private void onFrameInner(String text) {
        Object parsed;
        try {
            parsed = Json.parse(text);
        } catch (RuntimeException e) {
            return;
        }
        if (!(parsed instanceof Map)) {
            return;
        }
        Map<String, Object> f;
        try {
            f = Json.asObject(parsed);
        } catch (RuntimeException e) {
            return;
        }
        String t = Json.str(f.get("t"));
        if (t == null) {
            return;
        }
        if ("welcome".equals(t)) {
            Map<String, Object> me = mapOf(f.get("me"));
            if (me != null) {
                String id = Json.str(me.get("id"));
                if (id != null && !id.isEmpty()) {
                    myId = id;
                }
            }
            Map<String, Object> server = mapOf(f.get("server"));
            if (server != null) {
                String g = Json.str(server.get("group"));
                if (g != null && !g.isEmpty()) {
                    groupName = g;
                }
            }
            // 断线/被杀期间可能漏消息：连上就补拉最近 30 条，按 lastSeenTs 只通知没见过的
            try {
                if (client != null) {
                    client.sendText("{\"t\":\"history\",\"with\":\"all\",\"limit\":30}");
                }
            } catch (RuntimeException e) {
            }
        } else if ("pending".equals(t)) {
            Object list = f.get("msgs");
            if (list instanceof java.util.List) {
                int sent = 0;
                for (Object o : (java.util.List<?>) list) {
                    Map<String, Object> m = mapOf(o);
                    if (m == null) {
                        continue;
                    }
                    String from = Json.str(m.get("from"));
                    if (from == null || from.equals(myId)) {
                        continue;
                    }
                    if (!seenOnce(Json.str(m.get("mid")))) {
                        continue;
                    }
                    Number tsn = (Number) (m.get("ts") instanceof Number ? m.get("ts") : null);
                    if (tsn != null) {
                        markSeen(tsn.longValue());
                    }
                    if (sent >= 5) {
                        continue;
                    }
                    String kind = Json.str(m.get("kind"));
                    String body = Json.str(m.get("text"));
                    String line = "image".equals(kind) ? "[图片]" : ("video".equals(kind) ? "[视频]" : (body == null ? "" : body));
                    String fromName = Json.str(m.get("fromName"));
                    String who = fromName == null || fromName.isEmpty() ? from : fromName;
                    try {
                        notifyMessage(who + "（离线消息）", line);
                    } catch (RuntimeException e) {
                        Log.w(TAG, "pending notify failed: " + e);
                    }
                    sent++;
                }
            }
        } else if ("pong".equals(t)) {
            lastPongAt = System.currentTimeMillis();
        } else if ("history".equals(t)) {
            Object list = f.get("msgs");
            if (list instanceof java.util.List) {
                int sent = 0;
                long newest = lastSeenTs;
                long cutoff = System.currentTimeMillis() - CATCHUP_MAX_AGE_MS;
                for (Object o : (java.util.List<?>) list) {
                    Map<String, Object> m = mapOf(o);
                    if (m == null) {
                        continue;
                    }
                    Number tsn = (Number) (m.get("ts") instanceof Number ? m.get("ts") : null);
                    long ts = tsn == null ? 0L : tsn.longValue();
                    if (ts > newest) {
                        newest = ts;
                    }
                    String from = Json.str(m.get("from"));
                    if (from == null || from.equals(myId) || ts <= lastSeenTs || ts < cutoff) {
                        continue;
                    }
                    if (sent >= 5) {
                        continue;
                    }
                    String mid = Json.str(m.get("mid"));
                    if (!seenOnce(mid)) {
                        continue;
                    }
                    String kind = Json.str(m.get("kind"));
                    String body = Json.str(m.get("text"));
                    String line = "image".equals(kind) ? "[图片]" : ("video".equals(kind) ? "[视频]" : (body == null ? "" : body));
                    String fromName = Json.str(m.get("fromName"));
                    String who = fromName == null || fromName.isEmpty() ? from : fromName;
                    try {
                        notifyMessage(groupName + " · " + who + "（补）", line);
                    } catch (RuntimeException e) {
                        Log.w(TAG, "catch-up notify failed: " + e);
                    }
                    sent++;
                }
                markSeen(newest);
            }
        } else if ("group".equals(t)) {
            String g = Json.str(f.get("name"));
            if (g != null && !g.isEmpty()) {
                groupName = g;
            }
        } else if ("msg".equals(t)) {
            String from = Json.str(f.get("from"));
            if (from == null || from.equals(myId)) {
                return;
            }
            String mid = Json.str(f.get("mid"));
            if (!seenOnce(mid)) {
                return;
            }
            Number tsn = (f.get("ts") instanceof Number ? (Number) f.get("ts") : null);
            if (tsn != null) {
                markSeen(tsn.longValue());
            }
            String fromName = Json.str(f.get("fromName"));
            String kind = Json.str(f.get("kind"));
            String body = Json.str(f.get("text"));
            String to = Json.str(f.get("to"));
            boolean toGroup = to == null || "all".equals(to) || to.startsWith("*");
            String line;
            if ("image".equals(kind)) {
                line = "[图片]";
            } else if ("video".equals(kind)) {
                line = "[视频]";
            } else {
                line = body == null ? "" : body;
            }
            String who = fromName == null || fromName.isEmpty() ? from : fromName;
            String title = toGroup ? groupName + " · " + who : who;
            try {
                notifyMessage(title, line);
            } catch (RuntimeException e) {
                Log.w(TAG, "notify failed: " + e);
            }
        }
    }

    private static Map<String, Object> mapOf(Object o) {
        if (!(o instanceof Map)) {
            return null;
        }
        try {
            return Json.asObject(o);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        NotificationChannel bg = new NotificationChannel(CH_BG, "后台在线", NotificationManager.IMPORTANCE_MIN);
        bg.setDescription("保持连接以便收到新消息提醒");
        bg.setShowBadge(false);
        bg.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        nm.createNotificationChannel(bg);

        NotificationChannel msg = new NotificationChannel(CH_MSG, "新消息", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("有人发来新消息时提醒");
        msg.enableVibration(true);
        msg.setShowBadge(true);
        msg.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(msg);
    }

    /** 记住「已通知到哪一条」并落盘，服务被杀/重启后不会重复补发。 */
    private void markSeen(long ts) {
        if (ts <= lastSeenTs) {
            return;
        }
        lastSeenTs = ts;
        try {
            getSharedPreferences("xhc_prefs", MODE_PRIVATE).edit().putLong("bgLastTs", ts).apply();
        } catch (RuntimeException e) {
        }
    }

    /** 更新状态：写静态字段并刷新常驻通知文案。 */
    private void setState(String st) {
        lastState = st;
        if (stopping) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTI_BG, buildBgNotification());
        } catch (Exception e) {
            Log.w(TAG, "notify bg: " + e);
        }
    }

    private Notification buildBgNotification() {
        Notification.Builder b = newBuilder(CH_BG);
        b.setContentTitle("XHC 后台在线")
                .setContentText(lastState + " · 有新消息会提醒")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(openApp())
                .setCategory(Notification.CATEGORY_SERVICE);
        return finish(b);
    }

    private Notification.Builder newBuilder(String channel) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(this, channel);
        }
        return new Notification.Builder(this);
    }

    private Notification finish(Notification.Builder b) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            return b.build();
        }
        return b.getNotification();
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private void notifyMessage(String title, String line) {
        if (appVisible) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !nm.areNotificationsEnabled()) {
            return;
        }
        inboxTitles.add(0, title == null ? "新消息" : title);
        inboxLines.add(0, line == null ? "" : line);
        while (inboxLines.size() > 6) {
            inboxLines.remove(inboxLines.size() - 1);
            inboxTitles.remove(inboxTitles.size() - 1);
        }
        Notification.Builder b = newBuilder(CH_MSG);
        b.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title == null ? "新消息" : title)
                .setContentText(line == null ? "" : line)
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .setWhen(System.currentTimeMillis())
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setLights(Color.parseColor("#07C160"), 800, 1200);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            Notification.InboxStyle style = new Notification.InboxStyle();
            style.setBigContentTitle(inboxLines.size() + " 条新消息");
            int i;
            for (i = 0; i < inboxLines.size() && i < 6; i++) {
                String tt = inboxTitles.get(i);
                style.addLine((tt == null ? "" : tt + "：") + inboxLines.get(i));
            }
            b.setStyle(style);
        }
        b.setNumber(inboxLines.size());
        nm.notify(NOTI_MSG, finish(b));
    }
}
