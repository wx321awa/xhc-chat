# PrivChat 协议 v1（WebSocket JSON 房间协议）

> 本文是 **唯一契约**。Java 端内嵌 Hub（`app/java/com/xxhh/xhc/Hub.java`，任务 t3）、Node 端公网中继（`server/server.mjs`，任务 t7）、前端（`app/assets/app.js`，任务 t4）三方实现必须逐字节对齐本文。
> 文档版本：**v1.2**（2026-11-20）。协议版本字段：`server.ver = "1"`（v1.1 增 `bad_mid`；v1.2 增头像/群名/图片视频，见 §14；能力由 `welcome.server.caps` 声明）。
> 实现期发现任何与本文不一致的地方：**先回写本文第 12 节并列出 diff，再改代码**，不允许只改代码不改文档。

---

## 0. 一屏速览

| 方向 | `t` | 作用 | 服务端是否必回 |
|---|---|---|---|
| C→S | `hello` | 入场（通行码 + 身份） | 回 `welcome`（错则 `error`+关闭） |
| S→C | `welcome` | 入场快照（me / peers / server） | — |
| S→C | `peers` | 房内成员变化广播 | — |
| C→S | `send` | 发消息（广播或定向） | 发送者收自身 `msg` + `ack` |
| S→C | `msg` | 一条消息（含发送者自己的副本） | — |
| S→C | `ack` | 确认 `send` 已被服务端接受 | — |
| C→S | `history` | 拉历史 | 回 `history` |
| S→C | `history` | 历史消息数组 | — |
| C→S | `read` | 标记某会话已读 | 不回（v1） |
| S→C | `pending` | 重连后补发离线消息 | — |
| C→S | `ping` | 应用层心跳，20s 一次 | 回 `pong` |
| S→C | `pong` | 心跳应答 | — |
| S→C | `error` | 统一错误 | — |

约定：C=客户端（手机 App 前端），S=服务端（内嵌 Hub 或公网中继）。所有帧都是 **UTF-8 JSON 对象**，顶层必须有字符串字段 `t`。

---

## 1. 连接层（RFC6455）

### 1.1 地址与路径

- WebSocket 地址：`ws://<host>:<port>/ws`
- **路径固定为 `/ws`**，区分大小写；其它路径不做升级。
- v1 **只支持明文 `ws://`**，不支持 `wss://`（没有 TLS；见 ARCH.md 安全边界）。
- 默认端口 `21001`（内嵌 Hub 与公网中继都用它；测试可用随机高位端口）。
- 公网中继：`ws://202.189.15.98:21001/ws`
- 本机 Hub（手机 A 自己）：`ws://127.0.0.1:21001/ws`
- 本机 Hub（手机 B 连手机 A）：`ws://<A 的局域网 IP>:21001/ws`

### 1.2 HTTP 行为（升级之前的普通请求）

| 服务端 | 请求 | 响应 |
|---|---|---|
| Hub | `GET /` | `200` + `assets/index.html`（`text/html; charset=utf-8`） |
| Hub | `GET /<静态文件>` | `200` + 对应 assets 文件（js/css/图片），路径不得越出 assets（拒绝 `..`、绝对路径） |
| Hub | `GET /ws` + 升级头 | `101 Switching Protocols` |
| Hub | 其它 | `404 text/plain` |
| Hub | 非 GET/HEAD | `405` |
| 中继 | `GET /` | `200` + 一段说明页 HTML（证明中继在跑：标题、监听端口、ws 地址） |
| 中继 | `GET /ws` + 升级头 | `101 Switching Protocols` |
| 中继 | 其它 | `404 text/plain` |

两种服务端对普通 HTTP 响应都必须带 `Cache-Control: no-store`；必须带正确的 `Content-Length`。

### 1.3 握手

请求头（标准 RFC6455）：

```
GET /ws HTTP/1.1
Host: 202.189.15.98:21001
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

应答（101）：

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: <accept>
```

计算：
```
accept = base64( sha1( Sec-WebSocket-Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11" ) )
```
**测试向量（必须能通过）**：
```
key    = dGhlIHNhbXBsZSBub25jZQ==
accept = s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```
缺少 `Upgrade: websocket`、`Sec-WebSocket-Version` 不是 `13`、或 `Sec-WebSocket-Key` 非法 base64（解码后非 16 字节）：回 `400` 并关闭，不做升级。服务端不校验 `Origin`；不协商任何扩展（**不启用 permessage-deflate**）。

### 1.4 帧规则

| 项 | 客户端→服务端 | 服务端→客户端 |
|---|---|---|
| MASK 位 | **必须为 1**（帧必掩码，4 字节 masking-key） | **必须为 0**（不掩码） |
| 文本帧 | opcode `0x1`，负载即 JSON | 同 |
| 二进制帧 | `0x2`：**不支持**，服务端关闭 `1003` | 服务端不得发送 |
| ping | `0x9`，负载 ≤125 字节 | 收到必须回 `0xA` pong（原样负载） |
| pong | `0xA`，收到忽略（只当活帧） | — |
| close | `0x8`，收到回 close 后关闭 TCP | 主动关闭前发 close |
| RSV1/2/3 | 必须为 0 | 必须为 0 |
| 单帧负载上限 | **1 MiB = 1,048,576 字节**，含分片重组后的总长 | 同 |
| 分片 | 必须支持重组：`FIN=0` + `opcode=0` continuation，控制帧可穿插；总长超限立即 `1009` | 服务端建议不分片 |

违例处理：客户端帧未掩码 / RSV 非零 / 非法 opcode → 服务端关闭 `1002`；负载超限 → `1009`。关闭前尽量发一帧 `{"t":"error","code":"too_large"|"bad_frame"}`（能发则发，发不出直接关）。

close 帧的 code 必须合法（1000–1011 应用可用白名单，见 §9）；`Sec-WebSocket-Key` 校验失败等 HTTP 阶段错误不走 close 帧，直接 400。

### 1.5 连接的三个时限

| 时限 | 规则 | 违约动作 |
|---|---|---|
| 握手后 10s | 必须完成 `hello` | 发 `{"t":"error","code":"hello_timeout"}` 后 close `1008` |
| 心跳 20s | 客户端每 20s 发一帧 `{"t":"ping"}`（或 WS ping） | — |
| 静默 60s | 服务端 60s 内没收到该连接 **任何**帧（含 WS pong/ping/应用帧）→ 判掉线 | close `1001`，从房间移除并广播 `peers` |

客户端侧：连续 2 次 `{"t":"ping"}` 无 `pong`（≈45s）可主动断开重连，避免半开连接。

---

## 2. 身份与字段规范

| 字段 | 规则 |
|---|---|
| `user.id` | **32 位小写 hex**（16 字节），客户端首次启动用 `crypto` 随机生成并持久化，永不变 |
| `user.name` | 昵称，去掉首尾空白后 **1–24 个 Unicode 字符**（码点计）；非法 → `bad_user` |
| `mid` | 客户端生成的消息 id，**1–64 字符**，`[A-Za-z0-9_.:-]`；同一发送者重发必须复用同一 `mid`（便于去重） |
| `ts` | 毫秒时间戳，整数（JS 安全整数范围）。**发送方给的值只作参考，服务端必须用自己时钟重写** |
| `key` | 通行码，服务端配置的字符串；Hub 的 key 为 `null` 时不校验（本机模式） |
| 未知字段 | 收发双方都必须忽略（前向兼容） |
| 未知 `t` | 客户端忽略；服务端回 `{"t":"error","code":"unknown_type"}` 但**保持连接** |

`peer` 对象：`{"id":"<32hex>","name":"<昵称>"}`。`peers` 数组**不含接收者自己**。

---

## 3. hello → welcome（入场）

### 3.1 客户端发 hello（必须是连接后的第一帧）

```json
{"t":"hello","key":"K7f2Qp9xLm3A","user":{"id":"9f86d081884c7d659a2feaa0c55ad015","name":"老大"}}
```

规则：
- 必须是首帧；此前收到任何其它帧 → `{"t":"error","code":"not_hello"}` + close `1008`。
- `key` 与服务端配置不符 → `{"t":"error","code":"bad_key","msg":"通行码错误"}` 后 close `1008`。**不得**下发任何房间信息。
- `user.id` 不合法或 `name` 不合法 → `{"t":"error","code":"bad_user"}` + close `1008`。
- `key` 字段缺失按空串处理（Hub 的 key 为 null 时忽略该字段）。

### 3.2 同 id 重连顶替

- 房内已有相同 `id` 的连接：新连接生效，旧连接收到 `close 4001`（reason `replaced`）后被移除。
- 若昵称变化，需要广播 `peers`；若不变也允许广播（客户端需幂等）。
- 顶替不产生系统消息，不写历史。

### 3.3 服务端发 welcome（紧跟 hello 成功后）

```json
{"t":"welcome",
 "me":{"id":"9f86d081884c7d659a2feaa0c55ad015","name":"老大"},
 "peers":[{"id":"0123456789abcdef0123456789abcdef","name":"小鱼"}],
 "server":{"mode":"hub","ver":"1"}}
```

- `me` 回显服务端认可的身份（`name` 已 trim）。
- `peers` 是**当前快照**（不含自己），顺序不保证。
- `server.mode`：`"hub"`（手机内嵌 Hub）或 `"relay"`（公网中继）；`server.ver` 固定 `"1"`。
- 顺序：`welcome` → （中继若有离线消息则）`pending` → 正常收发。客户端在 `welcome` 之前不得发消息。

### 3.4 peers 广播

房内成员集合变化（加入 / 断开 / 顶替改名）时，服务端**向所有连接**广播：

```json
{"t":"peers","peers":[{"id":"0123456789abcdef0123456789abcdef","name":"小鱼"}]}
```

- 每个接收者收到的数组都不含自己。
- 新连接也会收到（内容可能与自己 `welcome` 里的 `peers` 相同）——客户端必须幂等覆盖，不得把重复广播当成“某人重生”。
- 只广播变化后的全量数组，不做增量 diff。

---

## 4. send / msg / ack（核心）

### 4.1 客户端发 send

```json
{"t":"send","to":"all","kind":"text","text":"在吗","mid":"c1a2b3-1732118400123","ts":1732118400123}
```

```json
{"t":"send","to":"0123456789abcdef0123456789abcdef","kind":"text","text":"只给你看","mid":"c1a2b3-1732118400456","ts":1732118400456}
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `to` | 是 | `"all"` 或 32hex peer id；**不允许等于自己**（→ `bad_to`） |
| `kind` | 是 | `"text"` 或 `"image"`；其它值 → `bad_kind`（**不关连接**） |
| `text` | 是 | `kind=text`：正文（前端建议 ≤4000 字符）；`kind=image`：图片 URL 或 `data:image/...;base64,...`（整帧受 1MB 限制） |
| `mid` | 是 | 见 §2；服务端原样回填；缺失/非法 → `bad_mid`（**不关连接**） |
| `ts` | 否 | 客户端时间，仅参考 |

### 4.2 服务端投递 msg

服务端对**每个接收者**（`to=all` 时含除发送者外所有在线成员；`to=<peerId>` 时只有该 peer 和发送者自己）下发：

```json
{"t":"msg",
 "from":"9f86d081884c7d659a2feaa0c55ad015",
 "fromName":"老大",
 "to":"all",
 "kind":"text",
 "text":"在吗",
 "mid":"c1a2b3-1732118400123",
 "ts":1732118400200}
```

- `from` / `fromName` **由服务端填充**，客户端在 `send` 里带的一律忽略。
- `ts` **由服务端钟重写**（所有接收者看到同一个 ts）。
- `to` 保留原始目标（`"all"` 或目标 id），发送者副本也保留原 `to`。
- `to=all` **不投给发送者以外的离线者**（广播不排队）；`to=peerId` 见 §6 离线队列。
- 发送者自己的副本与其他人的副本内容一致（同样的 `from`/`ts`），客户端据此回填本地“发送中”气泡。

### 4.3 服务端回 ack（只给发送者，紧跟在自身 msg 之后）

```json
{"t":"ack","mid":"c1a2b3-1732118400123","ts":1732118400200}
```

- `ack` 表示服务端**已接受**（已投递/已入队），不代表对端已读。
- 顺序：发送者先收到自己的 `msg`，再收到 `ack`（同一 TCP 连接内顺序保证）。
- 失败（`bad_to` / `bad_kind` / `no_peer`）不发 `ack`，只发 `error`（建议带 `ref: mid`）。

### 4.4 投递矩阵

| 目标 | 目标在线（Hub/中继） | 目标离线（中继） | 目标离线（Hub） |
|---|---|---|---|
| `to=all` | 除发送者外所有在线者各收一份；发送者收自身副本 + ack | 不排队 | 同左 |
| `to=<peerId>` | 该 peer 收一份；发送者收自身副本 + ack | 入离线队列（≤200 条），发送者仍收自身副本 + ack | 回 `{"t":"error","code":"no_peer","ref":mid}`，**不发 ack、不留副本** |

`to=<peerId>` 的 id 格式非法 → `bad_to`（Hub 与中继一致）。

---

## 5. history

### 5.1 请求

```json
{"t":"history","with":"all","limit":50}
{"t":"history","with":"0123456789abcdef0123456789abcdef","limit":100}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `with` | 是 | `"all"` 或 32hex peer id |
| `limit` | 否 | 默认 `50`，取值 1–100，越界按边界截断 |

### 5.2 应答

```json
{"t":"history","with":"0123456789abcdef0123456789abcdef","msgs":[
  {"t":"msg","from":"0123456789abcdef0123456789abcdef","fromName":"小鱼","to":"9f86d081884c7d659a2feaa0c55ad015","kind":"text","text":"在的","mid":"d1e2f3-1732118500000","ts":1732118500000}
]}
```

- `msgs` 元素与实时 `{t:"msg"}` **结构完全相同**（含 `t:"msg"`），按 `ts` **升序**；取最新 `limit` 条。
- `with=<peerId>`：只返回我与该 peer 的双向消息（`from=我,to=peer` 与 `from=peer,to=我`），**不含广播**。
- `with="all"`：只返回广播消息（`to="all"`），**不含 1:1**。
- **本机 Hub：永远回 `{"t":"history","with":<原样>,"msgs":[]}`**（Hub 无持久化，前端只能靠 localStorage）。
- 公网中继：返回真实历史（JSONL 落盘，见 ARCH.md）。
- 不存在的 `with` 不报错，回空数组。
- 客户端在 `welcome` 之后按需请求（每个会话首次打开、或重连后合并），不得在 `welcome` 前发。

---

## 6. read / pending（已读与离线）

### 6.1 read

```json
{"t":"read","with":"0123456789abcdef0123456789abcdef"}
```

- `with` = peer id 或 `"all"`。
- v1 **无应答**；服务端只更新内存里的 `lastRead[user][with]=now`（中继持久化可选，Hub 直接忽略）。
- 客户端在打开会话、或会话可见时收到新消息后发送；用于 v2 的未读数，v1 不影响投递。

### 6.2 pending（仅中继）

目标用户重连并收到 `welcome` 之后，中继立刻下发一次：

```json
{"t":"pending","msgs":[
  {"t":"msg","from":"0123456789abcdef0123456789abcdef","fromName":"小鱼","to":"9f86d081884c7d659a2feaa0c55ad015","kind":"text","text":"昨晚发的","mid":"e1-1732032000000","ts":1732032000000}
]}
```

- 内容：该用户离线期间别人发给他的 **定向** 消息，按 `ts` 升序，**≤200 条**；超出丢弃最旧的。
- 下发后队列**清空**；这些消息**不会再**以单独 `msg` 帧重发（客户端把 `msgs` 合并进本地历史即可，禁止重复渲染）。
- 没有离线消息时**不发** `pending`（不是发空数组）。
- 广播（`to=all`）永不出现在 pending。
- 本机 Hub：永不发 `pending`。

---

## 7. 心跳

客户端每 **20s** 发：

```json
{"t":"ping"}
```

服务端立即回：

```json
{"t":"pong","ts":1732118500200}
```

- `ts`（服务端毫秒）可选，客户端可用于 RTT 测量，不参与逻辑。
- 服务端也允许主动发 WS ping（浏览器/客户端自动回 pong），两者都算“活帧”。
- 60s 无任何帧 → 服务端 close `1001` 并广播 `peers`；客户端看到断开后按 §10 重连。

---

## 8. error 与关闭

统一错误帧：

```json
{"t":"error","code":"bad_key","msg":"通行码错误"}
```

`code` 表（v1 全集）：

| code | 触发 | 连接 |
|---|---|---|
| `bad_key` | hello.key 不符 | 发完 close `1008` |
| `bad_user` | id 非 32hex / 昵称为空或 >24 字符 | 发完 close `1008` |
| `not_hello` | 首帧不是 hello | 发完 close `1008` |
| `hello_timeout` | 10s 内没 hello | 发完 close `1008` |
| `bad_json` | 帧不是 UTF-8 JSON 对象 / 无 `t` | close `1002` |
| `bad_frame` | 掩码/RSV/opcode 违例 | close `1002` |
| `too_large` | 帧或重组消息 >1 MiB | close `1009` |
| `unknown_type` | 未知 `t` | **保持连接** |
| `bad_to` | `to` 非法或等于自己 | 保持连接 |
| `bad_kind` | `kind` 非 text/image | 保持连接 |
| `bad_mid` | `send.mid` 缺失或不符合 §2 格式 | 保持连接 |
| `no_peer` | Hub 模式下目标不在房间（仅 `to=<peerId>`） | 保持连接 |
| `rate_limited` | （可选）发送过快 | 保持连接 |
| `internal` | 服务端异常 | close `1011` |

close code（v1 白名单）：

| code | 含义 |
|---|---|
| `1000` | 正常关闭（客户端主动 disconnect） |
| `1001` | 服务端超时/下线 |
| `1002` | 协议错误 |
| `1003` | 不支持的数据（二进制帧） |
| `1008` | 策略违规（bad_key / bad_user / not_hello / hello_timeout） |
| `1009` | 负载过大 |
| `1011` | 服务端内部错误 |
| `4001` | 同 id 被新连接顶替（reason `replaced`） |
| `4002` | 服务端重启/关闭（可选） |

---

## 9. 投递语义与一致性

- **顺序**：单条 TCP 连接内，服务端发出的帧顺序 = 服务端处理顺序；发送者一定先收自身 `msg` 再收 `ack`。不同发送者之间的全局顺序**不保证**，以 `ts` 排序展示。
- **去重**：客户端按 `(from, mid)` 去重（历史合并、pending、重发都可能重复）。服务端不强制去重，但中继对同 `(from,mid)` 的重复 `send` 建议直接重发 ack 不重复入库（可选）。
- **时钟**：展示时间一律用服务端回写的 `ts`；客户端本地时间只用于“发送中”占位。
- **在线集合**：`peers` 是唯一权威来源；客户端不得自行猜测在线状态。
- **广播不排队**、**定向排队（仅中继）**、**Hub 不排队** —— 三方必须严格一致，否则会出现“Hub 里收到、中继里丢”的错觉。
- **单房间**：v1 所有连接同处一个房间，没有房间 id、没有私聊隔离（`to=<id>` 也只是投递定向，服务端仍能看到明文）。

---

## 10. 客户端实现要求（前端契约）

1. 生成并持久化 `id`（32hex）与昵称；`id` 跨重启不变。
2. 连接流程：`open ws` → 立即 `hello` → 等 `welcome` → 允许输入；`welcome` 前输入框禁用。
3. 心跳：连上后每 20s `{"t":"ping"}`；45s 无 `pong` 主动断开重连。
4. 重连：断开后按 `1s,2s,4s,8s,15s,15s…` 退避，重连成功重发 `hello`（同 id），然后对每个已知会话发 `history` 合并。
5. 发送：本地先插入“发送中”气泡（用本地 `mid`）；收到自身 `msg` 按 `mid` 回填真实 `ts`/服务端副本；收到 `ack` 标记“已发送”。超时（15s 无 ack）标红可重发（复用同 `mid`）。
6. 接收：`msg` 按 `to` 归入会话（`to="all"` → 群聊/全部；`to=我` → 与 `from` 的会话；`to=别人` 的帧理论上不会来，忽略）。
7. 历史：`localStorage` 按会话存，键 `privchat.hist.<peerId>`（广播用 `privchat.hist.all`），每个会话 ≤500 条；`history` 返回与本地按 `(from,mid)` 合并。
8. `pending`：合并进对应会话，标未读；**不得**重复渲染。
9. `peers`：整表覆盖；会话列表里离线的人保留但显示“离线”。
10. 未知 `t` / 未知字段：忽略，不报错、不断线。
11. 断开状态：显示状态点“未连接/重连中”，输入禁用，提示文案不暴露通行码。

前端 `config.js` 约定（打包时注入）：

```js
window.PRIVCHAT_DEFAULT = { endpoint: "ws://202.189.15.98:21001/ws", key: "K7f2Qp9xLm3A" };
```

---

## 11. 最小对接测试（t3 / t7 的测试脚本必须覆盖）

脚本可用 Node 手写 WS 客户端（不引第三方库），断言：

1. **握手向量**：`key=dGhlIHNhbXBsZSBub25jZQ==` → `accept=s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`（RFC6455 §1.3 官方示例）。
2. 客户端 A、B 先后 `hello` → 各自收到 `welcome`（`me` 正确、`server.mode` 正确），且 `peers` 互相能看到对方。
3. A `send to=B` → B 收到 `msg`（`from`/`fromName` 被服务端填充、`ts` 被重写），A 收到自身副本（`to` 保留 B 的 id，`from` 是 A）+ `ack`（`mid` 一致）。
4. A `send to=all` → B 收到，A 收到自身副本 + ack；C（若存在）也收到。
5. 错 `key` → 收到 `{"t":"error","code":"bad_key"}` 后连接被关（close 1008）。
6. B 断开 → A 收到 `peers`（不再含 B）；B 重连（同 id）→ A 又收到含 B 的 `peers`。
7. （中继）B 离线时 A `send to=B` → A 仍收自身副本 + ack；B 重连后在 `welcome` 后收到 `pending`，且该消息不在 pending 之后重复以 `msg` 出现。
8. （中继）`history with=B limit=100` → 返回双向消息升序、≤100 条；（Hub）→ `msgs:[]`。
9. 分片帧重组、1 MiB+1 帧 → `1009`；未掩码客户端帧 → `1002`。

---

## 12. 变更记录（实现期分歧必须回写）

**当前版本 v1.1（2026-11-20）：仅登记 1 条实现期补充（`bad_mid`），帧格式与消息名与 v1.0 完全兼容；`server.ver` 仍为 `"1"`。**

规则：任何一方实现时发现本文歧义或必须偏离，先在此登记 diff（旧 → 新 + 理由 + 影响方），由 captain（或 core）确认后升级为 v1.1，再改代码。禁止只改代码不改本表。

| 日期 | 提出方 | 位置 | 旧（v1.0） | 新（v1.1） | 理由 | 影响 |
|---|---|---|---|---|---|---|
| 2026-11-20 | core（t3 Hub 实现） | §4.1 / §8 | `send.mid` 必填但未规定非法时服务端行为；t3 初版实现曾“服务端自造 srv-mid” | 新增错误码 `bad_mid`：`mid` 缺失或不符合 §2 格式 → `{"t":"error","code":"bad_mid","msg":...}`，**保持连接、不发 ack**；服务端不再自造 mid | 自造 mid 会让客户端的“发送中气泡”按本地 mid 匹配不上，且破坏 §9 去重键 `(from,mid)`；报错比静默改写安全 | t3 Hub 已按新规则实现；t7 中继须同样校验并回 `bad_mid`；t4 前端保证 mid 合法即可（但可展示错误） |

示例格式（不是真实条目）：

```
§4.3 ack
- 旧：ack 只含 mid、ts
- 新：ack 增加 "queued":true|false
- 理由：前端需区分“已离线入队”
- 影响：t3 Hub 恒 false；t7 中继按实际情况；t4 可忽略
```

---

## 13. 明确不做（v1 边界）

- 无 TLS / 无端到端加密；通行码不是强认证，明文可被同网段嗅探。
- 无多房间、无群成员管理、无撤回/引用/语音/视频（`kind=image` 只保留协议位，前端 v1 可只发 text）。
- 无服务端账号体系；`id` 是客户端自报，可伪造（单房间私人用途可接受）。
- 无消息持久化保证：Hub 完全不存；中继存 JSONL 但可能被清理（滚动上限见 ARCH.md）。
- 无 `wss`、无压缩扩展、无二进制帧。
---

## 14. v1.2 追加：头像 / 群名 / 图片视频

本版**不改既有帧语义**，只增新帧与 HTTP 端点；`server.ver` 仍为 `"1"`，能力用 `welcome.server.caps` 声明（`["avatar","group","media"]`）。客户端必须先看 caps 再显示对应入口。

### 14.1 头像

| 方向 | 帧 |
|---|---|
| C→S | `{"t":"avatar","data":"data:image/jpeg;base64,…"}` 或 `data: null`（清除） |
| S→C | `{"t":"peer-info","id":"<32hex>","name":"昵称","avatar":"data:image/jpeg;base64,…" \| null}` |
| S→C | `welcome` 扩展：`me.avatar`、`peers[i].avatar` |

- 客户端发送前必须把图缩到 **≤128×128** 的 JPEG（`canvas.toDataURL("image/jpeg",0.82)`）。
- 服务端校验：`data` 为 null，或以 `data:image/jpeg;base64,` 开头且整串长度 ≤ **48000**；否则 `error{code:"bad_avatar"}`（保持连接、不广播、不落库）。
- 广播对象：房内所有人（**包括发送者自己**，用于确认）。`name` 取该连接当前昵称。
- 落库：中继写 `data/avatars.json`（`{id: data}`，启动时载入）；Hub 仅内存。

### 14.2 群名

| 方向 | 帧 |
|---|---|
| C→S | `{"t":"group","name":"新群名"}` |
| S→C | `{"t":"group","name":"新群名","by":"<32hex>","ts":<ms>}` |

- 校验：`trim(name)` 长度 1–24；否则 `error{code:"bad_group"}`。
- 广播给房内所有人；`welcome.server.group` 带上当前群名（默认 `"群聊（全部）"`）。
- 落库：中继写 `data/room.json`（`{"group":"…"}`）；Hub 仅内存。

### 14.3 图片与视频

上传走 **HTTP**（不用 WS，避免大帧）：

- `POST /upload`
  - 头：`X-Key: <通行码>`、`X-Kind: image|video`、`X-Name: <URL 编码的文件名>`（可选）
  - Body：原始字节；`image` ≤ 4 MiB、`video` ≤ 16 MiB
  - `200` → `{"ok":true,"id":"<16位小写hex>","path":"/m/<id>","mime":"image/jpeg","size":12345}`
  - `403` → `{"ok":false,"error":"bad_key"}`；`400` → `{"ok":false,"error":"bad_kind"|"too_large"|"empty"}`
- `GET /m/<id>` → 原始字节，`Content-Type` 用上传的 mime，`Cache-Control: public, max-age=31536000, immutable`；不存在 → `404 text/plain`。id 不可猜，本版不做额外鉴权。
- 存储：中继 `data/media/<id>.<ext>` + `data/media.json` 索引；Hub 内存（总量上限 32 MiB，LRU 淘汰）。

WS 投递（复用 `send` / `msg`）：`kind` 允许 `image` / `video`，`text` 放 `path`（例如 `/m/1a2b3c4d5e6f7890`），可选 `meta`：

```json
{"name":"视频.mp4","size":3145728,"w":1280,"h":720,"dur":12.4,"thumb":"data:image/jpeg;base64,…"}
```

- `thumb` 是视频首帧，≤ 8000 字符 base64，仅供 `poster` 用；无则客户端画灰底播放键。
- 服务端**不改写** `kind`/`text`/`meta`，只做 `mid`/`to` 校验与投递；未知 `kind` 一律按 `text` 处理（前端同样）。
- 展示：`image` → `<img src="{text}" loading="lazy">`；`video` → `<video controls preload="metadata" poster="{meta.thumb}">`，点击在站内浮层播放（不跳浏览器）。

### 14.4 兼容与失败

- 未知帧类型：服务端与前端都**忽略**（不报错、不断线）。
- 老服务端没有 `caps`：前端按 `["avatar","group"]` 之外处理——即不显示图片视频入口，但头像/群名仍可尝试（失败静默）。
- 上传失败：前端在气泡上标「发送失败」并提供重试（重试必须**复用同一个 mid**，与 §12 一致）。

---

## 14.6 改名（profile）

| 方向 | `t` | 字段 | 说明 |
|---|---|---|---|
| C→S | `profile` | `name` | 房间内改名，**不动连接、不动历史** |

- `name`：`string`，`trim()` 后按 **码点** 计 1–24；否则 `error{bad_name}`（保持连接、不改名）。
- 成功后服务端更新该连接的显示名，并向房内所有人（含自己）广播
  `{"t":"peer-info","id":<id>,"name":<新名>,"avatar":<头像或null>}`。
- 与 `avatar` 帧相互独立：改名不碰头像，换头像不碰名字。二者都用同一份 `peer-info` 广播。
- 客户端收到 `peer-info` 后应按 `id` 更新对端昵称；若 `id` 是自己的，则同步自己的显示名。
- 连接断开后名字回到该连接 hello 时的值（名字不持久化；只影响房间内显示）。
