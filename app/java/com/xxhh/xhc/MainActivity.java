package com.xxhh.xhc;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.view.Window;
import org.json.JSONObject;

import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.io.IOException;
import java.io.InputStream;

/**
 * XHC 主界面：不加载 XML 布局。
 *  - 先起内嵌 Hub（assets 作为静态资源、可选通行码），
 *  - 再把 WebView 指向 http://127.0.0.1:21001/，
 *  - 前端自己决定 WebSocket 连本机 Hub 还是公网中继（见 docs/ARCH.md）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "XHC";
    /** 内嵌 Hub 端口；前端默认地址也写死这个（app/assets/config.js 可覆盖）。 */
    public static final int PORT = 21001;

    private static final int REQ_NOTIFY = 4201;
    private static final int REQ_FILE = 4202;
    private static final int REQ_PICK = 4203;
    private String pickKind;
    private String pickHttp;
    private String pickKey;
    private ValueCallback<Uri[]> pendingFile;

    private WebView web;
    private Hub hub;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        // v1：本机 Hub 默认不校验通行码（room_key 为空）；要开启就写入非空 room_key。
        String roomKey = getSharedPreferences("xhc_prefs", MODE_PRIVATE)
                .getString("room_key", null);
        try {
            hub = new Hub(PORT, roomKey, new Hub.AssetProvider() {
                public byte[] read(String path) throws IOException {
                    InputStream in = null;
                    try {
                        in = getAssets().open(path);
                        ByteArrayOutputStream out = new ByteArrayOutputStream(16 * 1024);
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                        }
                        return out.toByteArray();
                    } catch (IOException e) {
                        return null;
                    } finally {
                        if (in != null) {
                            try {
                                in.close();
                            } catch (IOException ignored) {
                                // ignore
                            }
                        }
                    }
                }
            });
            hub.start();
        } catch (IOException e) {
            Log.e(TAG, "hub start failed on port " + PORT, e);
        }

        prefs = getSharedPreferences("xhc_prefs", MODE_PRIVATE);

        web = new WebView(this);
        web.addJavascriptInterface(new Bridge(), "XHC");
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        // 必须开 content 访问：文件选择器返回的是 content:// URI，关掉它 WebView 读不到选中的文件，
        // 表现就是“能弹出选择器、选完没反应”。
        s.setAllowContentAccess(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                // Android WebView 默认不实现文件选择器，不覆盖这个方法的话 <input type=file> 点击等于没反应
                if (pendingFile == null) {
                    try {
                        Intent i = params.createIntent();
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        pendingFile = cb;
                        startActivityForResult(i, REQ_FILE);
                        return true;
                    } catch (Exception e) {
                        pendingFile = null;
                        return false;
                    }
                }
                cb.onReceiveValue(null);
                return false;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 只允许本机页面；外部链接交回系统（返回 true 表示我们自己不加载）
                return url == null || !url.startsWith("http://127.0.0.1:" + PORT);
            }
        });
        setContentView(web);
        web.loadUrl("http://127.0.0.1:" + PORT + "/");
    }

    @Override
    protected void onResume() {
        super.onResume();
        NotifyService.appVisible = true;
        stopBgService();
        if (web != null) {
            web.onResume();
            // 前台恢复：让页面重新占用这条身份（后台服务刚被停掉）
            evalJs("(window.XHC_RESUME||function(){})()");
        }
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        // 进后台：页面必须先放手（同一个 id 只能有一条连接），再把班交给 NotifyService
        evalJs("(window.XHC_PAUSE||function(){})()");
        NotifyService.appVisible = false;
        if (prefs != null && prefs.getBoolean("notify", false)) {
            startBgService();
        }
        super.onPause();
    }

    /* ------------------------- 后台提醒：服务与权限 ------------------------- */

    private void evalJs(final String code) {
        if (web == null) {
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    web.evaluateJavascript(code, null);
                } catch (Exception e) {
                    // 页面还没准备好，忽略
                }
            }
        });
    }

    private void startBgService() {
        Intent i = new Intent(this, NotifyService.class);
        i.putExtra("endpoint", prefs.getString("endpoint", ""));
        i.putExtra("key", prefs.getString("key", ""));
        i.putExtra("name", prefs.getString("name", "我"));
        i.putExtra("id", prefs.getString("id", ""));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i);
            } else {
                startService(i);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "start notify service failed: " + e.getMessage());
        }
    }

    private void stopBgService() {
        try {
            stopService(new Intent(this, NotifyService.class));
        } catch (RuntimeException e) {
            Log.w(TAG, "stop notify service failed: " + e.getMessage());
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.cancel(1002);
        }
    }

    private boolean notifyAllowed() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private void requestNotifyPermission() {
        if (Build.VERSION.SDK_INT >= 33 && !notifyAllowed()) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PICK) {
            handleNativePick(data);
            return;
        }
        if (req != REQ_FILE) {
            return;
        }
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) {
                    out[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
        }
        if (pendingFile != null) {
            pendingFile.onReceiveValue(out);
            pendingFile = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req != REQ_NOTIFY) {
            return;
        }
        boolean granted = notifyAllowed();
        if (web != null) {
            web.evaluateJavascript("window.onNativeNotifyPermission && window.onNativeNotifyPermission("
                    + (granted ? "true" : "false") + ")", null);
        }
    }

    // ---- 原生选文件 + 原生上传 -------------------------------------------------
    // WebView 的 <input type=file> 在部分机型上会把选中的文件“吃掉”（files 为空），
    // 所以头像/图片/视频改由原生选择器读取并直接上传，再把结果回给页面。

    private void handleNativePick(Intent data) {
        final Uri uri = data == null ? null : data.getData();
        final String kind = pickKind;
        final String http = pickHttp;
        final String key = pickKey;
        pickKind = null;
        if (uri == null) {
            js("window.onNativePickError && window.onNativePickError('没有选中文件')");
            return;
        }
        new Thread(() -> {
            try {
                byte[] raw = readAll(uri);
                if (raw == null || raw.length == 0) {
                    js("window.onNativePickError && window.onNativePickError('文件是空的')");
                    return;
                }
                String name = displayName(uri);
                if ("avatar".equals(kind) || "gavatar".equals(kind)) {
                    String dataUrl = avatarDataUrl(raw);
                    if (dataUrl == null) {
                        js("window.onNativePickError && window.onNativePickError('图片无法解码')");
                        return;
                    }
                    String cb = "gavatar".equals(kind) ? "onNativeGroupAvatar" : "onNativeAvatar";
                    js("window." + cb + " && window." + cb + "(" + JSONObject.quote(dataUrl) + ")");
                    return;
                }
                JSONObject res = upload(http, key, kind, name, raw);
                js("window.onNativeMedia && window.onNativeMedia(" + JSONObject.quote(kind) + ", "
                        + JSONObject.quote(res.getString("path")) + ", "
                        + JSONObject.quote(res.optString("mime", "")) + ", "
                        + res.optInt("size", raw.length) + ")");
            } catch (Exception e) {
                String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                js("window.onNativePickError && window.onNativePickError(" + JSONObject.quote(msg) + ")");
            }
        }).start();
    }

    private byte[] readAll(Uri uri) throws IOException {
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) return null;
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            try { in.close(); } catch (IOException e) {}
        }
    }

    private String displayName(Uri uri) {
        String name = "file";
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) {
                    String v = c.getString(i);
                    if (v != null && !v.isEmpty()) name = v;
                }
            }
        } catch (Exception e) {
        } finally {
            if (c != null) c.close();
        }
        return name;
    }

    /** 压成 400px 内的方形 JPEG，保证 data URL 不超过协议上限 48000 字符。 */
    private String avatarDataUrl(byte[] raw) {
        Bitmap src = BitmapFactory.decodeByteArray(raw, 0, raw.length);
        if (src == null) return null;
        int side = Math.min(src.getWidth(), src.getHeight());
        int x = (src.getWidth() - side) / 2, y = (src.getHeight() - side) / 2;
        Bitmap crop = Bitmap.createBitmap(src, x, y, side, side);
        int px = Math.min(200, side);
        Bitmap scaled = Bitmap.createScaledBitmap(crop, px, px, true);
        for (int q : new int[]{60, 45, 32}) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, q, bos);
            String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            String url = "data:image/jpeg;base64," + b64;
            if (url.length() <= 14000) return url;
        }
        return null;
    }

    private JSONObject upload(String http, String key, String kind, String name, byte[] data) throws Exception {
        String base = http == null || http.isEmpty() ? "http://127.0.0.1:21001" : http;
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/upload").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(120000);
        c.setFixedLengthStreamingMode(data.length);
        c.setRequestProperty("Content-Type", "application/octet-stream");
        if (key != null && !key.isEmpty()) c.setRequestProperty("X-Key", key);
        c.setRequestProperty("X-Kind", kind);
        c.setRequestProperty("X-Name", URLEncoder.encode(name == null ? "" : name, "UTF-8"));
        try {
            c.getOutputStream().write(data);
            c.getOutputStream().flush();
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
            }
            String body = out.toString("UTF-8");
            if (code != 200) throw new IOException("HTTP " + code + " " + body);
            return new JSONObject(body);
        } finally {
            c.disconnect();
        }
    }

    private void js(final String code) {
        runOnUiThread(() -> {
            try {
                if (web != null) web.evaluateJavascript(code, null);
            } catch (Exception e) {
            }
        });
    }

    /** 前端（window.XHC）调用的桥：只暴露后台提醒相关的最小面。 */
    private final class Bridge {

        @JavascriptInterface
        public String bgState() {
            return NotifyService.lastState;
        }

        @JavascriptInterface
        public boolean batteryOk() {
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
            } catch (Exception e) {
                return false;
            }
        }

        /** 弹系统「忽略电池优化」授权，锁屏/Doze 时才不会被掐断。 */
        @JavascriptInterface
        public void requestIgnoreBattery() {
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                        i.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(i);
                    } catch (Exception e) {
                        try {
                            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                        } catch (Exception e2) {
                        }
                    }
                }
            });
        }

        @JavascriptInterface
        public String notifyState() {
            return prefs.getBoolean("notify", false) ? "on" : "off";
        }

        @JavascriptInterface
        public void pickMedia(String kind, String httpBase, String key) {
            runOnUiThread(() -> {
                pickKind = kind;
                pickHttp = httpBase;
                pickKey = key;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.setType("video".equals(kind) ? "video/*" : "image/*");
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivityForResult(i, REQ_PICK);
                } catch (Exception e) {
                    pickKind = null;
                    js("window.onNativePickError && window.onNativePickError('打不开文件选择器')");
                }
            });
        }

        @JavascriptInterface
        public boolean canNotify() {
            return notifyAllowed();
        }

        @JavascriptInterface
        public void requestPermission() {
            runOnUiThread(new Runnable() {
                public void run() {
                    requestNotifyPermission();
                }
            });
        }

        @JavascriptInterface
        public void setNotify(final boolean on) {
            prefs.edit().putBoolean("notify", on).apply();
            runOnUiThread(new Runnable() {
                public void run() {
                    if (on) {
                        if (!notifyAllowed()) {
                            requestNotifyPermission();
                            return;
                        }
                        if (web != null && web.hasWindowFocus()) {
                            // App 还在前台：先不启服务，等 onPause 再起
                        }
                    }
                    if (!on) {
                        stopBgService();
                    }
                }
            });
        }

        @JavascriptInterface
        public void configure(String endpoint, String key, String name, String id) {
            SharedPreferences.Editor ed = prefs.edit();
            ed.putString("endpoint", endpoint == null ? "" : endpoint);
            ed.putString("key", key == null ? "" : key);
            ed.putString("name", name == null ? "" : name);
            ed.putString("id", id == null ? "" : id);
            ed.apply();
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (hub != null) {
            hub.stop();
            hub = null;
        }
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}