# XHC 1.0 构建报告

> 状态：**定稿（数值由 captain 2026-11-20 23:34 CST 实测回填）**。
> 生成方：core（骨架）→ captain（实测回填）；t5 由 captain 收尾。

## 1. 交付物

| 项 | 值 |
|---|---|
| 产物 | `dist/XHC-1.0.apk`（= `dist/XHC-1.0-unsigned-signed.apk` 的副本，已签名） |
| 手机交付路径 | `/sdcard/Download/DSH-Go/XHC-1.0.apk` |
| 大小 | 49,741 字节（48.6 KB）/ zip 内 9 条目 |
| SHA-256 | `e5c6c120853295d8e27a987822bffbff728be7b0856bdd5b0be692b6f88b1e37` |
| 包名 / 版本 | `com.xxhh.xhc` / versionName `1.0` / versionCode `1` |
| minSdk / targetSdk | 23 / 33 |
| 显示名 | XHC |
| 签名 | uber-apk-signer debug 证书（v1 + v2 + v3），仅供自用安装 |
| 构建时间 | 2026-11-20 23:34:44 CST（Asia/Shanghai） |

## 2. 组件版本

| 组件 | 版本 | 位置 |
|---|---|---|
| JDK（javac/java） | Temurin 17.0.21+9 (aarch64) | `vendor/jdk/` |
| android.jar | platform-33_r02 | `vendor/android.jar` |
| R8 / D8 | 9.5.33 | `vendor/r8.jar` |
| uber-apk-signer | 1.3.0 | `vendor/uber-apk-signer.jar` |
| Node.js | v24.22.1 | 系统 `node` |
| 打包器 | `apkforge/build.mjs`（javac→D8→手写二进制 AXML→自写 ZIP→签名） | `apkforge/` |
| 协议 | `docs/PROTOCOL.md` **v1.1**（v1 + bad_mid），`server.ver="1"` | `docs/` |
| 前端 | `app/assets/`（index.html / app.js / style.css / config.js） | 打进 APK `assets/` |
| 中继 | `server/server.mjs`（零 npm 依赖，Node 18+） | 公网 VPS |

## 3. 构建与校验命令（实测输出尾部）

```bash
cd /root/workspace/privchat
# 1) 构建（未签名 XHC-1.0-unsigned.apk + 签名 XHC-1.0-unsigned-signed.apk）
node apkforge/build.mjs --src app --out dist/XHC-1.0-unsigned.apk
# 2) 命名为交付物
cp dist/XHC-1.0-unsigned-signed.apk dist/XHC-1.0.apk
# 3) 静态校验（必须 ok、exit 0）
node apkforge/verify.mjs dist/XHC-1.0.apk --package com.xxhh.xhc --min-sdk 23 --target-sdk 33 --label XHC
```

实测（captain，2026-11-20 23:34）：
```
[i] classes.jar: 14 classes, 25.7KB
[ok] d8 -> classes.dex (1352ms)
[i] AndroidManifest.xml 1604B, root=<manifest package="com.xxhh.xhc" label="XHC">
[i] apk written: dist/XHC-1.0-unsigned.apk 39.9KB, 6 entries
[ok] uber-apk-signer (543ms)
[i] signed apk: dist/XHC-1.0-unsigned-signed.apk 48.6KB

APK: dist/XHC-1.0.apk  (48.6KB, 9 entries)
  package=com.xxhh.xhc versionName=1.0 code=1
  label=XHC theme=undefined minSdk=23 targetSdk=33
  launcher=com.xxhh.xhc.MainActivity exported=true
  dex: 035 30580B, 14 classDef, adler32/sha1 ok
  signing: v1=true v2/v3=true stored=0 aligned=true
  permissions=android.permission.INTERNET, android.permission.ACCESS_NETWORK_STATE
  ok
```

## 4. APK 内容自检

要求：`assets/index.html`、`assets/app.js`、`assets/style.css`、`assets/config.js` 四件齐全；`assets/test/**`、`selfcheck.html` 不得进包；`classes.dex` 内可查到 `com/xxhh/xhc/MainActivity`。

实测条目（python3 zipfile）：`AndroidManifest.xml, classes.dex, assets/app.js, assets/config.js, assets/index.html, assets/style.css, META-INF/ANDROIDD.SF, META-INF/ANDROIDD.RSA, META-INF/MANIFEST.MF`（无 assets/test/**、无 selfcheck.html）；`dex 30580 MainActivity True`、`hub-in-dex True`。

## 5. 安装

1. 手机打开「设置 → 应用 → 特殊权限 → 安装未知应用」，允许文件管理器/浏览器安装。
2. 用文件管理器打开 `/sdcard/Download/DSH-Go/XHC-1.0.apk` 安装（或 `adb install -r XHC-1.0.apk`）。
3. 首次启动会拉起 App 内嵌 Hub（`0.0.0.0:21001`）并载入本机页面；若 21001 被占用，首页会空白，先关掉占用进程再重开。
4. 桌面图标为系统默认占位图（本版无自定义图标）。

## 6. 两种用法

### A. 公网中继（默认，跨网络可用）

```
手机A ──ws──► 公网 VPS 202.189.15.98:21001 (Node 中继，单房间) ◄──ws── 手机B
```

- 地址：`ws://202.189.15.98:21001/ws`（前端 `config.js` 的 `endpoint`，已注入）
- 通行码：`<redacted>`（= `server/PORT.json` 的 `key`，12 位、大小写敏感）
- 两台手机都填同一通行码即可互相看到；离线消息由中继排队（每人 ≤200 条），重连一次性补发。

### B. 本机 Hub 模式（同一 WiFi / 热点，无需公网）

```
手机A(App 内嵌 Hub 21001) ◄──ws── 手机B(填 A 的局域网 IP)     同 WiFi
```

- A：打开「我」页 → 打开「本机当主机」→ 自动改连 `ws://127.0.0.1:21001/ws`，key 照发（本机 Hub 默认不校验，`room_key` 为空）。
- B：地址填 `ws://<A 的局域网 IP>:21001/ws`，通行码随意填同一个（Hub 不校验即忽略）。
- A 的 IP 在手机「设置 → WLAN → 当前网络」里看；两台设备必须在同一网段，路由器若开了「AP 隔离」会连不上。
- 注意：本机 Hub 的历史恒为空（`history` 返回 `msgs: []`），聊天记录只存在各自手机 localStorage。

## 7. 通行码在哪、怎么改

| # | 位置 | 作用 | 修改方式 |
|---|---|---|---|
| 1 | 公网 VPS：`C:\PrivChat-Hub\config.json`（部署时 `server/PORT.json` 对应的服务端配置） | 中继校验的 key | 改完重启计划任务 `\PrivChat-Hub`（`schtasks /end /tn \PrivChat-Hub` → `/run`） |
| 2 | 仓库：`server/PORT.json` → 打包注入 `app/assets/config.js` | APK 默认 key | 改 `PORT.json.key`，同步 `config.js` 的 `key`，重新走第 3 节构建 |
| 3 | App 内「我」页 → 通行码输入框 | 当前设备实际使用的 key | 直接改，存 `localStorage` 的 `privchat.key`（公网）、`privchat.remoteKey`（切本机前的远端备份） |
| 4 | 本机 Hub：`SharedPreferences("xhc_prefs")` 的 `room_key` | 本机模式下 Hub 是否校验 key（默认空 = 不校验） | 需 root/调试写入；普通使用不用改 |
| 5 | 前端默认：`app/assets/config.js` 的 `window.PRIVCHAT_DEFAULT.key` | 首次启动默认值 | 改文件后重新打包（assets 已锁定，改后须重跑构建） |

改 key 的完整顺序：先改 1（VPS）→ 再改 2（PORT.json + config.js）→ 重新构建 → 两台手机在「我」页把通行码改成新值（或重装 APK 用新默认值）。

## 8. 已知限制（本版）

- 只支持**文字消息**：协议有 `kind:"image"`，但前端没有选图/上传入口，服务端也不存二进制。
- **无自定义图标**：manifest 未带 icon，桌面显示系统默认图。
- **debug 签名**：uber-apk-signer 的 debug 证书，可安装可升级同签名版本，但不能上架、换机可能提示「未知来源」。
- **中继单房间**：所有持同一通行码的人在同一房间，`to:"all"` 会广播给所有人；无好友/权限粒度。
- 明文 `ws://`（无 TLS）：只适合私人小范围使用，公网内容可被同网段抓包看到。
- 中继离线队列每人 ≤200 条、历史 `limit` ≤100；超出部分不补发。
- 本机 Hub 无持久化历史（重启即空）；公网中继历史存 VPS 的 JSONL。

## 9. 排障速查

| 现象 | 排查 |
|---|---|
| 打开 App 白屏 | 21001 被占用 / Hub 未起来：看 `adb logcat | grep xhc`，或先杀占用进程重开 |
| 「我」页一直「未连接」 | 地址是否 `ws://…:21001/ws`；手机是否能访问该 IP（先用浏览器开 `http://IP:21001/` 看说明页） |
| 提示 bad_key | 通行码不一致（12 位、大小写敏感），对照第 7 节位置 1/2/3 |
| 对方看不到自己 | 是否同一通行码 + 同一服务器；`to=all` 才广播，定向只在会话里 |
| 离线消息没补 | 每人队列上限 200，超出丢弃；或重连后只补一次（pending 一次性） |
| 安装失败「解析包错误」 | 传输被截断，重新拷一次并核对第 1 节 SHA-256 |
---

## v1.1（2026-11-20 23:5x）数据归属改版：正文只落服务端

需求（用户）：手机不留聊天数据，正文只存在 VPS。

改动：
- `app/assets/config.js`：新增 `localHistory: false`（默认关闭手机本地正文）。
- `app/assets/app.js`：
  - 新增 `localHistOn()`：公网中继模式 → false；`state.hostMode` 或 endpoint 为 127.0.0.1/localhost → true（本机 Hub 不持久化，只能靠手机留底）。
  - `saveHist()` 在关掉时只写会话索引 `privchat.index.v1`（对方 id / 昵称 / 最后时间，无正文）；`loadHist()` 直接跳过。
  - 启动时 `purgeLocalMsgHist()` 清掉旧版本留下的 `privchat.hist.*` 副本，`loadIndex()` 恢复会话列表。
  - `ensureConv()` / `openConv()`：公网模式下新会话或空会话自动向服务端发 `history`（limit 50）补拉。
- `app/android/manifest.json`：versionCode 2 / versionName 1.1。

测试（captain）：
- `.tools/t8.mjs`（公网中继端到端）：发消息后 localStorage 无 `privchat.hist.*`；重开 App 用同一 id 连公网 → 从服务端拉回 VPSONLY-A1/A2/PEER-VPS-3，且拉回后仍不写本地副本 → **ALL-PASS**。
- `.tools/t9.mjs`（loopback 主机模式）：本机 Hub 模式下仍保留正文（155B）→ **ALL-PASS**。
- 回归：`node app/test/run.mjs` 23 passed / `node server/test/unit.mjs` 24 通过。
- `apkforge/verify.mjs`：versionName=1.1 code=2，dex 14 classDef，v1+v2/v3，aligned，ok。

产物：`dist/XHC-1.1.apk` 49,741 字节，sha256 `c4310050d3fddc8f741830c324207c3d9d552c234be8465d0b370b983dc7de7b`；
已拷 `/sdcard/Download/DSH-Go/XHC-1.1.apk`（旧 1.0 已删）。

数据实况（VPS）：清空测试记录后 `C:\PrivChat-Hub\data\messages.jsonl` 归零；公网探测 118ms 正常。

## v1.3（后台提醒 + 图标/头像/群名/图片视频）
- 构建：2026-11-21 00:19 CST；javac 5 file / 25 classes 48.8KB / d8 1320ms / resources.arsc 572B（icon=0x7f010000）/ AndroidManifest.xml 2184B（含 `<service com.xxhh.xhc.NotifyService exported=false>` + 5 权限）/ unsigned 120.1KB 8 entries / signer 529ms → 128.7KB
- `dist/XHC-1.3.apk` 131,795B，sha256 `9dba46e5a260d6f8d6b317bee02ea1315c4fc66e357988bb8c548ca73d13b17a`（= XHC-1.3-signed.apk）
- verify：package com.xxhh.xhc / 1.3 / code 4 / label XHC / theme 16974124 / minSdk 23 / target 33 / launcher exported / dex 035 54872B 25 classDef / v1+v2+v3 / aligned / icon 60,795B PNG / ok
- 新增源码：`WSClient.java`（纯 java RFC6455 客户端，供 NotifyService 用）、`NotifyService.java`（前台常驻 + 通知）；`MainActivity` 加 JS Bridge `XHC`、生命周期绑定服务
- 前端：头像/群名/图片视频/大图预览/后台提醒开关/by xxhh. 署名/调试出口 `window.__xhc`
- 测试：`node app/test/run.mjs` 45 passed；`node server/test/unit.mjs` 24 通过；`node server/test/v12.mjs` 21 通过；`node .tools/e2e.mjs` 11 passed（真 Hub + jsdom：caps/在线人数/群名广播/图片上传渲染）

## v1.6（2026-11-21 00:30 CST，真机安装通过）

- 版本：versionCode 7 / versionName 1.6；产物 `XHC-1.6-signed.apk` 131,795B，sha256 `3c75d87844bc746f5615ae4710e51b481a01d7f5…`；手机上装到 `/sdcard/Download/DSH-Go/XHC-1.6.apk`，**用户确认「装上了，图标也对」**。
- 根因（1.3–1.5 全部「解析软件包时出现问题」）：自制 `resources.arsc` 的字节布局不被 Android 资源解析器接受（手写 type/typeSpec 布局与 aapt 产物有细微差异，另加 config 尺寸 56→64、arsc 必须 stored+4 对齐、AXML resource map 必须按 attr id 升序）。
- 解法：`apkforge/lib/arsc-tpl.mjs` 用一台真机能装的真包（校园网自登录 v1.4，其资源表恰好只有 `drawable/ic_launcher → res/drawable/ic_launcher.png`）当底板，只改 package chunk 里 128 字符的包名字段，其余字节原样；`build.mjs` 优先走模板，手写 `arsc.mjs` 仅兜底。`arsc.mjs` 的读取器同时支持 UTF-8 与 UTF-16 字符串池。
- verify：`icon=0x7f010000 res/drawable/ic_launcher.png 60795B 89504e47`、`stored=1 aligned=true`、`v1+v2/v3`、dex 035 54872B 25 classDef、`ok`。
- 公网中继复验：`PUBLIC-WS-OK（106ms）`。

## 3.2（code 23）—— 红点每次都重新出现

- 症状：每次冷启动，群聊/私聊又亮「未读 36」等红点。
- 根因：未读数只在内存里，启动时从服务端拉最近 50 条历史，`putMsg` 把每条「别人的」消息都当成新消息 +1，于是每次重进全部变未读。
- 修法：
  1. 会话增加 `lastReadTs`，随 `privchat.index.v1` 落盘（`read` 字段），群聊与私聊都存。
  2. `putMsg` 增加 `replay` 语义：历史/离线补发的帧不再 `unread++`；新增 `recountUnread(c)` 按 `lastReadTs` 重算。
  3. 正在浏览的会话（或自己发的消息）直接推进 `lastReadTs`，避免「看过的又变未读」。
  4. `openConv` 清红点时同步推进 `lastReadTs` 并落盘。
  5. `init` 里 `loadIndex()` 移出「仅公网模式」分支——本机模式也要恢复已读位置。
- 验证：`/tmp/unread.mjs`（真中继 + jsdom）5 条全过：首次 3 条未读=3 → 点进去清零 → 索引落盘含 `read` → 同 localStorage 重建页面未读=0 → 新消息播报后=1。
