# XHC · 私人聊天

一个「像微信」的自建私聊 App：单个 Android APK（WebView 前端 + 内嵌 Java 服务），
配一台自己的服务器跑零依赖 Node 中继，聊天记录只落在服务器上。

- **APK**：`dist/XHC-3.0-signed.apk`（136.7KB，minSdk 23 / targetSdk 33）
- **协议**：`docs/PROTOCOL.md`（v1.4，WebSocket JSON 房间协议，唯一契约）
- **架构**：`docs/ARCH.md`

## 下载 / 构建

本仓库**不提供**安装包（`dist/*.apk` 已被忽略），请自己按下面的「构建 APK」从源码打包，
或直接找作者要私人版本。构建产物在 `dist/XHC-*-signed.apk`。

## 功能

| 功能 | 说明 |
|---|---|
| 文字聊天 | 群聊 + 私聊，气泡/已读/时间分隔 |
| 图片 / 视频 | 原生选图器 → 上传到中继 → 气泡内展示、点击放大 |
| 头像 / 群头像 | 原生裁切成 200px JPEG 后随 `avatar` / `gavatar` 帧同步 |
| 改群名 / 昵称 | 即时生效，服务端广播 `group` / `peer-info` |
| 后台提醒 | 前台服务 + WebSocket，锁屏也能收；断线补拉「（补）」通知 |
| 数据归属 | 聊天正文只存服务器（`data/messages.jsonl`），手机只留会话索引 |
| 通行码 | 仓库里**不含**默认通行码，首次启动在「我 → 通行码」填你自己中继的 key |
| 双模式 | 连公网中继，或「本机当主机」直连（同 WiFi 不经公网） |
| 应用图标 | 自带 resources.arsc，自定义图标 |

## 目录

```
app/             Android 端（纯 Java，无 Gradle / 无 Android SDK）
  java/com/xxhh/xhc/   MainActivity / Hub（内嵌 HTTP+WS）/ WSClient / NotifyService / Json
  assets/              WebView 前端（index.html / app.js / style.css / config.js）
  android/manifest.json  清单源文件（apkforge 编译成二进制 AXML）
  res/drawable/ic_launcher.png
  test/run.mjs        Hub 协议测试（55 条）
apkforge/        自建 APK 构建链（手写 AXML / resources.arsc / ZIP / 签名）
server/          公网中继（零 npm 依赖，Node 18+）
  test/unit.mjs      协议单测（24 条）
  test/v12.mjs       头像·群名·媒体单测（21 条）
  test/pubcheck.mjs  公网探针
docs/            协议与架构文档
dist/            构建产物与 BUILD-REPORT.md
vendor/setup.mjs 工具链下载脚本（JDK / android.jar / r8 / uber-apk-signer）
```

## 构建 APK

宿主机可以是任意 aarch64/arm64 Linux（不需要 Android SDK）：

```bash
node vendor/setup.mjs                     # 下载 JDK17 + android.jar + r8 + uber-apk-signer
vendor/jdk/bin/javac -source 11 -target 11 -cp vendor/android.jar \
  -d app/build/classes $(find app/java -name '*.java')
node apkforge/build.mjs --src app --out dist/XHC.apk
node apkforge/verify.mjs dist/XHC-signed.apk
```

`apkforge` 自己实现 zip（crc32/deflate/对齐）、二进制 AXML、resources.arsc（用 aapt 产物的
字节底板做模板）、并调用 uber-apk-signer 签 v1+v2+v3。之所以不用 aapt2：官方只有 x86_64 版。

## 跑中继

```bash
node server/server.mjs --port 21001 --key <通行码> --data ./data
```

VPS 上常驻见 `server/DEPLOY.md`（Windows 用 schtasks 而不是 Start-Process，否则 SSH 断开就被杀）。

## 测试

```bash
node app/test/run.mjs        # Hub
node server/test/unit.mjs    # 中继协议
node server/test/v12.mjs     # 头像/群名/媒体
node server/test/pubcheck.mjs --url ws://<host>:21001/ws --key <通行码>   # 公网探针
```

## 安全说明

- 只支持明文 `ws://`（无 TLS），通行码是唯一门槛：**放到公网请自己换成强随机串**，
  仓库里的 `app/assets/config.js` 已把 `key` 置空，APK 首次启动会让你自己填。
- 中继把消息写入 `data/messages.jsonl`（>20MB 自动压缩为最近 2000 条），媒体存 `data/media/`。
- 前端不写历史正文到 localStorage（仅保留会话索引），正文只在服务器。