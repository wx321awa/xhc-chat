# PrivChat 架构说明（XHC APK）

> 配合 [`docs/PROTOCOL.md`](PROTOCOL.md) 阅读。协议是契约，本文解释“东西放在哪、跑在哪、怎么改”。
> 版本：v1.0（2026-11-20）；App 显示名 **XHC**，包名 `com.xxhh.xhc`。

---

## 1. 一句话架构

**每个 App 内部都跑一个纯 JDK 的 HTTP + WebSocket 服务（Hub），WebView 永远从 `http://127.0.0.1:21001/` 加载前端；前端再决定把 WebSocket 连到「自己手机里的 Hub」还是「公网中继」。**

这样同一份前端、同一套协议，既能在**同一 WiFi 内直连**（不用公网服务器），也能在**跨网络**时走 VPS 中继。

```
前端 (WebView, assets/index.html + app.js)
   │ ① HTTP GET http://127.0.0.1:21001/   ← 永远走本机内嵌 Hub 取页面
   │ ② WebSocket 二选一：
   │      ws://127.0.0.1:21001/ws           （本机 Hub 模式）
   │      ws://<对方局域网IP>:21001/ws       （本机 Hub 模式，对方当主机）
   │      ws://202.189.15.98:21001/ws        （公网中继模式）
   ▼
本机正向代理？没有。就是一条 ws 长连接。
```

---

## 2. 公网中继模式（跨网络，不同 WiFi / 4G 也能聊）

```
                       ┌──────────────────────────────────────────┐
                       │ 公网 VPS  202.189.15.98 (Windows Server) │
                       │                                          │
                       │  C:\PrivChat-Hub\                        │
                       │   ├ node\node.exe        （免安装 Node） │
                       │   ├ server.mjs           （零依赖中继）  │
                       │   ├ config.json          （端口 + 通行码）│
                       │   ├ data\messages.jsonl  （历史，滚动）  │
                       │   └ logs\hub.log                        │
                       │                                          │
                       │  监听 0.0.0.0:21001                      │
                       │   GET /    → 状态说明页                  │
                       │   GET /ws  → RFC6455 握手 + 单房间协议   │
                       │   防火墙入站规则 "PrivChat-Hub" TCP 21001│
                       │   计划任务 \PrivChat-Hub 开机自启        │
                       └───────▲───────────────────────▲─────────┘
                               │                       │
              ws://202.189.15.98:21001/ws   ws://202.189.15.98:21001/ws
                （hello: key=通行码）          （hello: key=通行码）
                               │                       │
                 ┌─────────────┴───────┐   ┌───────────┴─────────────┐
                 │ 手机 A  XHC APK     │   │ 手机 B  XHC APK         │
                 │                     │   │                         │
                 │ WebView ──HTTP──┐   │   │ WebView ──HTTP──┐       │
                 │                 ▼   │   │                 ▼       │
                 │ 内嵌 Hub (Hub.java) │   │ 内嵌 Hub (Hub.java)     │
                 │ 127.0.0.1:21001     │   │ 127.0.0.1:21001         │
                 │ 只负责发静态页      │   │ 只负责发静态页          │
                 │ （本机 /ws 空闲）   │   │ （本机 /ws 空闲）       │
                 └─────────────────────┘   └─────────────────────────┘
```

跨网络时，消息路径：`A 前端 → ws → VPS 中继 → ws → B 前端`。两端的内嵌 Hub 只当“本地静态服务器”，不参与聊天，因此**不需要公网 IP、不需要端口映射**。

### 2.1 时序（定向消息 + 离线）

```
A 前端              VPS 中继                  B 前端
  │ hello(key,id) ───▶ │                         │
  │ ◀── welcome+peers  │                         │
  │ send{to:B,mid:m1}─▶│                         │
  │ ◀── msg(自身副本)  │ ── msg(from:A,ts:srv) ─▶│   （B 在线时）
  │ ◀── ack{mid:m1}    │                         │
  │                    │  （B 离线：入队 ≤200/人）│
  │                    │ ◀──── hello (B 重连) ───│
  │                    │ ── welcome ────────────▶│
  │                    │ ── pending{msgs:[m1]} ─▶│   （一次性，不再单独重发）
  │                    │ ── peers ──────────────▶│
```

---

## 3. 本机 Hub 模式（同一 WiFi，无需公网）

```
                 同一 WiFi（或手机 A 开热点给 B 连）
 ┌──────────────────────────────────────┐        ┌────────────────────────────┐
 │ 手机 A（主机）                        │        │ 手机 B（客人）              │
 │                                      │        │                            │
 │ WebView ──GET http://127.0.0.1:21001 │        │ WebView                    │
 │    │                                 │        │   │ 连接面板填写：          │
 │    │ ws://127.0.0.1:21001/ws         │        │   │ ws://192.168.1.23:21001/ws│
 │    ▼                                 │        │   ▼                        │
 │ 内嵌 Hub 0.0.0.0:21001               │◀──ws───│ 直连 A 的内嵌 Hub          │
 │  ├ GET /  → assets 静态页            │  WiFi  │ （B 自己的内嵌 Hub 只发页） │
 │  ├ GET /ws → 房间（单房间）           │        │                            │
 │  └ key=null → 不校验通行码（v1）      │        │                            │
 └──────────────────────────────────────┘        └────────────────────────────┘
```

- A 点「本机当主机」→ 前端把 endpoint 切到 `ws://127.0.0.1:21001/ws`（UI 里还会提示“别人连 `ws://<你的IP>:21001/ws`”）。
- B 需要手动把服务器地址改成 A 的局域网 IP（App 里有输入框；IP 在 A 的连接面板显示，或从系统 WiFi 设置看）。
- 本机 Hub 的通行码 v1 为 `null`（不校验）；要加校验见 §5。
- 本机 Hub **不存历史、不做离线队列**：`history` 恒回空数组，`pending` 永不发；历史只在前端 `localStorage`。
- 手机 A 熄屏/杀后台 → Hub 停 → B 掉线（v1 不做前台 Service）。

---

## 4. 端口、路径与进程

| 进程 | 监听 | 路径 | 作用 |
|---|---|---|---|
| App 内嵌 Hub（每台手机） | `0.0.0.0:21001`（`ServerSocket`，`SO_REUSEADDR`） | `/`、静态文件、`/ws` | 给 WebView 发页面；本机模式下兼作聊天房间 |
| VPS 中继 `server.mjs` | `0.0.0.0:21001` | `/`、`/ws` | 跨网络中继、历史、离线队列 |
| WebView | — | `http://127.0.0.1:21001/` | 唯一前端入口（不使用 `file://`） |

端口在 Hub 构造参数里传入（测试用随机高位端口），中继从 `config.json` 读。

---

## 5. 通行码（key）：存在哪、怎么改

| 形态 | 存在哪 | 谁校验 | 怎么改 |
|---|---|---|---|
| **客户端（APK 内默认值）** | `app/assets/config.js` 的 `window.PRIVCHAT_DEFAULT = {endpoint,key}`；构建时由 `server/PORT.json` 注入 | — | 改 `server/PORT.json` 后重新打包；或 App 连接面板里手改（存 `localStorage`，优先于默认值） |
| **客户端（用户手填）** | WebView `localStorage`：`privchat.key` | — | 连接面板输入框，断开 → 改 → 重连 |
| **VPS 中继** | `C:\PrivChat-Hub\config.json` 的 `{"port":21001,"key":"<12位>"}` | 中继 | 编辑 `config.json` → `schtasks /end /tn "\PrivChat-Hub"` → `schtasks /run /tn "\PrivChat-Hub"`；把新 key 通知用户（手填或重打包） |
| **本机 Hub** | Android `SharedPreferences` 文件 `xhc_prefs`（`/data/data/com.xxhh.xhc/shared_prefs/xhc_prefs.xml`），键 `room_key`；v1 默认空 = `null` 不校验 | Hub（key 非 null 时） | 代码/设置写入 `room_key` 后重启 Hub；v1 未做 UI 修改入口（见 §5.1） |
| **测试/打包产物** | `server/PORT.json`：`{"endpoint":"ws://202.189.15.98:21001/ws","key":"..."}` | — | 改了要重新打包（packager 负责注入） |

生成规则：**12 位随机**，字符集 `A-Za-z0-9`（示例 `K7f2Qp9xLm3A`），不写入任何公开文档/日志。`bad_key` 错误只回 `{"t":"error","code":"bad_key"}`，不回显正确 key。

### 5.1 本机 Hub 想启用通行码

`MainActivity` 启动 Hub 时把 `SharedPreferences.getString("room_key", null)` 传给 `Hub(port, key, assetProvider)`。要打开校验：写入一个非空 `room_key`（例如在连接面板增加“本机通行码”输入，或 adb 改 prefs）。B 端在连接面板填同一个 key。v1 默认关闭是为了“同一 WiFi 即连即用”。

---

## 6. 存储与数据

| 数据 | 位置 | 生命周期 | 上限 |
|---|---|---|---|
| 我的 id（32hex） | `localStorage["privchat.id"]` | 首次启动生成，永久 | — |
| 我的昵称 | `localStorage["privchat.name"]` | 用户改 | ≤24 字符 |
| 服务器地址 / 通行码 | `localStorage["privchat.endpoint"]` / `["privchat.key"]` | 用户改 | — |
| 每个会话历史 | `localStorage["privchat.hist.<peerId>"]`（广播用 `privchat.hist.all`） | 随聊天增长 | 每会话 500 条（超出裁最旧） |
| VPS 历史 | `C:\PrivChat-Hub\data\messages.jsonl`（每行一个 msg JSON，追加写） | 手动清理/滚动 | 建议 ≤20MB，超了裁旧（实现按文件行数/大小滚动） |
| VPS 离线队列 | 中继进程内存，键 `to` peer id | 进程重启即丢 | 每人 ≤200 条 |
| VPS 已读 | 中继内存 `lastRead` | 重启即丢 | v1 不影响投递 |

> 注意：中继的历史与离线队列是**两套东西**——历史只用于 `history` 查询；`pending` 只补“离线期间没送到的定向消息”，下发后清空，不会因为历史还在而重发。

---

## 7. 启动链路

```
Android 启动 App
  └─ MainActivity.onCreate
       ├─ 去标题栏；new Hub(21001, roomKey, AssetProvider(assets))
       ├─ Hub 线程启动：ServerSocket → 接受连接 → HTTP / 或 /ws
       └─ WebView.loadUrl("http://127.0.0.1:21001/")
             └─ assets/index.html + app.js + style.css + config.js
                   └─ app.js: 取 localStorage id/name/endpoint/key → open ws
                         ├─ 本机当主机 → ws://127.0.0.1:21001/ws
                         └─ 否则 → config.js 的 endpoint（或手填）
```

VPS 启动：

```
schtasks \PrivChat-Hub（开机）
  └─ C:\PrivChat-Hub\node\node.exe C:\PrivChat-Hub\server.mjs >> logs\hub.log 2>&1
       ├─ 读 config.json（port/key）
       ├─ http.createServer：GET / 状态页；upgrade /ws
       └─ 帧解析 → 房间状态（Map<id, conn>）→ 投递/历史/队列
```

---

## 8. 双模式差异（实现必须心里有数）

| 能力 | 本机 Hub（`server.mode="hub"`） | 公网中继（`"relay"`） |
|---|---|---|
| 谁跑服务 | 手机 A 自己（Java，纯 JDK） | VPS（Node，零依赖） |
| 通行码 | v1 `null` 不校验（可配置） | 必须校验 `config.json` 的 key |
| `history` | **恒回空数组** | 真实历史（JSONL，按 with 过滤，limit≤100） |
| 离线队列 / `pending` | 不做；`to=<id>` 目标不在线 → `no_peer` | 做；≤200/人，重连补发一次 |
| 广播 `to=all` | 只投在线者 | 同左（不排队） |
| 持久化 | 无 | `messages.jsonl` |
| 心跳/顶替/peers/错误码 | 完全同协议 | 完全同协议 |
| 页面来源 | 本机 Hub `/` | 仍是本机 Hub `/`（只是 ws 指向 VPS） |

---

## 9. 安全与已知限制（必须让用户知道）

1. **明文 `ws://`**：没有 TLS，同一 WiFi/同一运营商链路上可被嗅探；VPS 上也是明文。私人小圈子可用，别传敏感信息。
2. **通行码不是强认证**：只挡“误连”，挡不住抓包重放；`user.id` 是客户端自报，可伪造、可顶替（同 id 会踢掉旧连接）。单房间内所有人互相可见。
3. **单房间**：没有多群、没有房间隔离，`to=<id>` 只是定向投递，服务端仍持有明文。
4. **Hub 无持久化**：手机 A 杀后台/熄屏省电可能断；B 的历史只剩本地 500 条。
5. **中继是单点**：VPS 挂了跨网络就断（同 WiFi 模式不受影响）；进程重启丢离线队列。
6. **debug 签名**：uber-apk-signer 的调试证书，不适合上架；安装时可能提示“未知来源”。
7. **无图标/无前台服务**（v1 取舍）：通知栏没有常驻通知，后台存活依赖系统策略。

---

## 10. 目录与责任

```
privchat/
├─ docs/PROTOCOL.md         协议契约（core, t6）
├─ docs/ARCH.md             本文（core, t6）
├─ vendor/                  JDK17 / android.jar / r8 / uber-apk-signer（toolchain, t1）
├─ apkforge/                javac→d8→AXML→zip→签名 构建链（toolchain, t2）
├─ app/
│  ├─ java/com/xxhh/xhc/    Hub.java / MainActivity.java（core, t3）
│  ├─ android/manifest.json manifest 定义（core, t3）
│  ├─ assets/               index.html / app.js / style.css / config.js（ui, t4）
│  └─ test/run.mjs          WS 集成测试（core, t3）
├─ server/                  server.mjs / config 样例 / PORT.json / DEPLOY.md（vps, t7）
└─ dist/                    XHC-1.0.apk / BUILD-REPORT.md（packager, t5）
```

交付：`/sdcard/Download/DSH-Go/XHC-1.0.apk`（packager, t5）。

---

## 11. 排障对照

| 现象 | 先查 | 处理 |
|---|---|---|
| 打开 App 白屏/404 | 内嵌 Hub 是否起来（`adb logcat`/logcat 里 `System.err`）、`assets/index.html` 是否在 APK 内 | 确认 Hub 监听 21001、WebView 加载 `127.0.0.1:21001` |
| 连不上中继 | VPS 任务是否 Running、防火墙 21001、`config.json` 端口 | `schtasks /query /tn "\PrivChat-Hub"`、`netsh advfirewall show rule`、浏览器开 `http://202.189.15.98:21001/` |
| 一直“重连中” | 地址是否 `ws://.../ws`（漏 `/ws` 会 404）、key 是否一致 | 看 `error` code：`bad_key` → 改通行码 |
| 发出去对方收不到（同 WiFi） | B 的地址是不是 A 的局域网 IP、两台在同一网段、A 的 Hub 是否被系统杀 | 用浏览器在 B 上开 `http://<A-IP>:21001/` 验证 |
| 自己被踢下线 | close code `4001` = 同 id 顶替（另一台设备用了同一个 id） | 不同设备要各自生成 id（v1 前端按设备 localStorage 生成） |
| 重连后看不到离线消息 | 中继是否重启过（内存队列丢）、是否 `to=all`（广播不排队） | 用 `to=<id>` 定向发；确认 `pending` 到达 |
| 历史为空 | 本机 Hub 模式本来就不存；中继模式查 `data/messages.jsonl` | 正常现象，见 §8 |

---

## 12. 变更记录

与 PROTOCOL.md 第 12 节同步维护；任何架构偏离（端口、key 位置、存储路径、双模式语义）都必须先在此登记再改代码。当前 **v1.0，无分歧**。