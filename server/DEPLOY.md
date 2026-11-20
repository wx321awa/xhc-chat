# PrivChat 公网中继部署说明（VPS 202.189.15.98）

> 契约：`../docs/PROTOCOL.md` v1.0（WS 协议）＋`../docs/ARCH.md` v1.0（架构）。
> 本文件只讲 **Windows Server 侧**怎么放上去；通行码不写在这里（见同目录 `PORT.json`，
> VPS 上落在 `C:\PrivChat-Hub\config.json`，不进公开文档）。

---

## 0. 一览

| 项 | 值 |
|---|---|
| 宿主机 | 202.189.15.98（Windows Server，PowerShell 5.1，administrator） |
| 连接方式 | SSH 66 端口（本机 `/root/workspace/sshtool/wssh '<PS命令>'`，私钥 `/root/workspace/.ssh/phone_key`） |
| 程序目录 | `C:\PrivChat-Hub\`（**固定，不要改**） |
| 监听 | `0.0.0.0:21001`（TCP，明文 ws://，无 TLS） |
| WS 路径 | `/ws`（固定） |
| 说明页 | `http://202.189.15.98:21001/` |
| 客户端地址 | `ws://202.189.15.98:21001/ws`（同 `PORT.json` 的 `endpoint`） |
| 运行时 | Node v22 LTS **免安装**（zip 解压到 `C:\PrivChat-Hub\node\`） |
| 计划任务 | `\PrivChat-Hub`（开机自启，SYSTEM，最高权限） |
| 防火墙规则 | `PrivChat-Hub`（入站 TCP 21001，**只加这一条**） |
| 历史落盘 | `C:\PrivChat-Hub\data\messages.jsonl` |
| 日志 | `C:\PrivChat-Hub\logs\hub.log` |

目录结构（部署完成后）：

```
C:\PrivChat-Hub\
├─ node\                 node.exe 及配套（解压而来）
├─ server.mjs            中继程序（零 npm 依赖，只 import node:http / node:crypto / node:fs / node:path）
├─ start.cmd             计划任务的启动壳（处理工作目录与日志重定向）
├─ config.json           {"port":21001,"key":"<12位通行码>"}
├─ data\
│   └─ messages.jsonl    历史（追加写，>20MB 自动裁剪保留最新 2000 条）
└─ logs\
    └─ hub.log           运行日志（stdout+stderr）
```

### 铁律（违反即事故）
- **不许**碰 `C:\XXHH-Chat`、`Desktop\XXHHbot-live`、MC 服务端（Purpur）目录及其计划任务。
- **不许**占用已监听端口：22, 66, 3011, 3389, 6501, 6800, 7451, 8080, 8899, 20241, 25566, 25575, 30383。
- 防火墙**只新增** `PrivChat-Hub` 这一条入站规则，不改既有规则、不动既有服务。

---

## 1. 装 Node（免安装）

PowerShell 5.1 没有 `&&`，用 `;` 串联；中文输出先设编码。

```powershell
[Console]::OutputEncoding=[Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path C:\PrivChat-Hub,C:\PrivChat-Hub\data,C:\PrivChat-Hub\logs | Out-Null

# 1) 先看镜像站里 v22 的最新版本号（浏览器打开也行）：
#    https://npmmirror.com/mirrors/node/latest-v22.x/
$ver = 'v22.14.0'          # 换成上一步看到的最新 v22.x
$zip = "https://npmmirror.com/mirrors/node/$ver/node-$ver-win-x64.zip"

# 2) 下载 + 解压（解出来是 node-v22.x.x-win-x64\ 一层）
Invoke-WebRequest -UseBasicParsing $zip -OutFile C:\PrivChat-Hub\node.zip
Expand-Archive -Path C:\PrivChat-Hub\node.zip -DestinationPath C:\PrivChat-Hub\_x -Force
Move-Item (Get-ChildItem C:\PrivChat-Hub\_x -Directory | Select-Object -First 1).FullName C:\PrivChat-Hub\node

# 3) 清理 + 验证
Remove-Item C:\PrivChat-Hub\_x,C:\PrivChat-Hub\node.zip -Recurse -Force
C:\PrivChat-Hub\node\node.exe -v
```

要求最后一行打印 `v22.x.x`（VPS 与手机 v24 的差异不影响本程序，Node 18+ 都可跑）。
若下载慢，可换 `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/` 同版本 zip。

---

## 2. 上传程序

本机（Linux，`/root/workspace/privchat/server/`）→ VPS `C:\PrivChat-Hub\`：

```bash
# 在本机执行：用 /root/workspace/sshtool 里现成的 ssh2 sftp 脚本（见该目录 *.js 文件头的用法），
# 把下面三个文件推到对应目录（不要拼成超长单行命令）：
#   /root/workspace/privchat/server/server.mjs        -> C:\PrivChat-Hub\server.mjs
#   /root/workspace/privchat/server/start.cmd         -> C:\PrivChat-Hub\start.cmd   （或用第 3 节的 PowerShell 现场生成）
#   /root/workspace/privchat/server/config.json       -> C:\PrivChat-Hub\config.json （通行码，见第 3 节）
ls /root/workspace/sshtool/*.js
```

文件校验（PowerShell）：

```powershell
(Get-FileHash C:\PrivChat-Hub\server.mjs -Algorithm SHA256).Hash
(Get-Item C:\PrivChat-Hub\server.mjs).Length
```

与本机 `sha256sum server.mjs` 对照一致即可。

---

## 3. 写 config.json 与 start.cmd

**通行码来源**：本机 `PORT.json` 的 `key` 字段（12 位 `A-Za-z0-9`）。
在 VPS 上写入（把 `<12位通行码>` 换成 `PORT.json` 里的值，**别贴到聊天/文档里**）：

```powershell
$cfg = '{"port":21001,"host":"0.0.0.0","key":"<12位通行码>","publicHost":"202.189.15.98"}'
[IO.File]::WriteAllText('C:\PrivChat-Hub\config.json', $cfg, (New-Object Text.UTF8Encoding($false)))
Get-Content C:\PrivChat-Hub\config.json
```

`start.cmd`（计划任务的工作目录与日志重定向都靠它）：

```powershell
$cmd = @'
@echo off
cd /d C:\PrivChat-Hub
if not exist logs mkdir logs
"C:\PrivChat-Hub\node\node.exe" "C:\PrivChat-Hub\server.mjs" >> "C:\PrivChat-Hub\logs\hub.log" 2>&1
'@
[IO.File]::WriteAllText('C:\PrivChat-Hub\start.cmd', $cmd, (New-Object Text.UTF8Encoding($false)))
```

`config.json` 也可省略 `host`/`publicHost`（默认 `0.0.0.0`，说明页会用请求的 Host 头拼地址）。

---

## 4. 防火墙放行（只加这一条）

```powershell
netsh advfirewall firewall add rule name="PrivChat-Hub" dir=in action=allow protocol=TCP localport=21001
netsh advfirewall firewall show rule name="PrivChat-Hub"
```

确认没有改动其它规则（部署前后各存一份快照对比）：

```powershell
netsh advfirewall firewall show rule name=all > C:\PrivChat-Hub\logs\fw-before.txt
# ... 加规则 ...
netsh advfirewall firewall show rule name=all > C:\PrivChat-Hub\logs\fw-after.txt
Compare-Object (Get-Content C:\PrivChat-Hub\logs\fw-before.txt) (Get-Content C:\PrivChat-Hub\logs\fw-after.txt)
```

> 若云厂商还有安全组/云防火墙，需在控制台另放行 TCP 21001。放行不了就按序试空闲端口
> 8443 → 443 → 80（先用 `netstat -ano | findstr :8443` 确认空闲），然后同步改
> `config.json` 的 `port`、`start.cmd`、防火墙规则与本机 `PORT.json` 的 `endpoint`。

---

## 5. 计划任务（开机自启）

```powershell
schtasks /create /tn "\PrivChat-Hub" /tr "C:\PrivChat-Hub\start.cmd" /sc onstart /ru SYSTEM /rl HIGHEST /f
schtasks /query /tn "\PrivChat-Hub" /v /fo LIST
```

`/sc onstart` = 开机即跑；`/ru SYSTEM` 免密码且不随用户注销退出。
（若坚持用 administrator 运行：`/ru administrator /rp "<密码>"`。）

手动起停 / 重启：

```powershell
schtasks /run   /tn "\PrivChat-Hub"      # 启动
schtasks /end   /tn "\PrivChat-Hub"      # 停止
schtasks /run   /tn "\PrivChat-Hub"      # 再启动（等价于"重启后仍可连"验证）
```

状态确认（`Running` 才算成功）：

```powershell
schtasks /query /tn "\PrivChat-Hub" /fo LIST | Select-String "Status","状态","TaskName","任务名"
netstat -ano | findstr :21001
Get-Content C:\PrivChat-Hub\logs\hub.log -Tail 20
```

期望：`Status: Running`、`TCP 0.0.0.0:21001 ... LISTENING`、日志含 `PrivChat 中继 listening` 与 `mode=relay`。

---

## 6. 验收（5 条，全部要贴真实输出）

### ① 本机单测 exit 0（在 Linux 开发机跑，不占 VPS）

```bash
cd /root/workspace/privchat
node server/test/unit.mjs; echo "EXIT=$?"
```

期望：逐条 `PASS ...`，结尾 `ALL PASS`，`EXIT=0`。失败会打印
`FAIL <用例> :: <原因>` 与 `位置: <unit.mjs:行>`。

### ② 计划任务存在且 Running

```powershell
schtasks /query /tn "\PrivChat-Hub" /fo LIST
```

### ③ 公网 ws 握手 + 收发（真做，本机 Linux 侧执行）

```bash
cd /root/workspace/privchat
node server/test/pubcheck.mjs; echo "EXIT=$?"
```

探针自己读 `server/PORT.json` 的 `endpoint` + `key`，动作是：
TCP 连 → WS 握手（校验 101 与 `Sec-WebSocket-Accept`）→ `hello` → 等 `welcome`
（校验 `me.id`、`server.mode=relay`、`server.ver="1"`、`peers` 不含自己）
→ 发一条 `to=all` → 必须收到自己的 `msg` 副本（`from`=自己、`ts` 被服务端重写）与 `ack`。

期望输出（节选）：

```
探针目标: ws://202.189.15.98:21001/ws（host=202.189.15.98 port=21001 path=/ws）
[3ms] TCP 已连，发握手
[120ms] HTTP/1.1 101 Switching Protocols
[121ms] 握手 OK（accept 校验通过）→ 发 hello
[210ms] RECV {"t":"welcome","me":{...},"peers":[],"server":{"mode":"relay","ver":"1"}}
[211ms] welcome 校验完成 → 发 to=all
[260ms] RECV {"t":"msg","from":"<自己>","fromName":"probe","to":"all","kind":"text","text":"probe 211ms","mid":"probe-...","ts":1761...}
[261ms] RECV {"t":"ack","mid":"probe-...","ts":1761...}

PUBLIC-WS-OK（261ms）
EXIT=0
```

也可先用浏览器打开 `http://202.189.15.98:21001/` 看说明页（应含「PrivChat 中继已运行」与客户端地址）。

失败判读：`PUBLIC-WS-FAIL: ...` 会直接说明卡在哪一步（握手未升级 / accept 不匹配 /
`error bad_key` / 8s 超时 / 连接被关闭）。

### ④ 重启任务后再连成功

```powershell
schtasks /end /tn "\PrivChat-Hub"; Start-Sleep -Seconds 2
netstat -ano | findstr :21001        # 应无输出（已停）
schtasks /run /tn "\PrivChat-Hub"; Start-Sleep -Seconds 2
netstat -ano | findstr :21001        # 重新 LISTENING
```

然后重跑 ③ 的探测脚本，仍要 `PUBLIC-WS-OK`。

### ⑤ 防火墙规则存在

```powershell
netsh advfirewall firewall show rule name="PrivChat-Hub"
```

---

## 7. 回滚（三步，干净）

```powershell
schtasks /end /tn "\PrivChat-Hub"
schtasks /delete /tn "\PrivChat-Hub" /f
netsh advfirewall firewall delete rule name="PrivChat-Hub"
Remove-Item C:\PrivChat-Hub -Recurse -Force
```

回滚后确认既有服务未受影响：

```powershell
netstat -ano | findstr "LISTENING" | findstr ":66 :3011 :3389 :6501 :8080 :8899 :25566"
schtasks /query /fo LIST | Select-String "XXHH","Purpur","MC"
```

---

## 8. 排障

| 现象 | 检查 |
|---|---|
| 端口没监听 | `Get-Content C:\PrivChat-Hub\logs\hub.log -Tail 50`；常见 `EADDRINUSE`（换端口）、`config.json` 解析失败（BOM/引号） |
| 本机 curl 通、公网不通 | 云安全组未放行 21001；`netsh advfirewall firewall show rule name="PrivChat-Hub"` 是否 `Enabled: Yes` |
| 握手 400 | 客户端没带 `Upgrade: websocket` / `Sec-WebSocket-Version: 13` / Key 不是 16 字节 base64 |
| 连上就被 close 1008 | `bad_key`（通行码不一致）或 `bad_user`（id 非 32 位小写 hex / 昵称为空或超 24 码点）或 `not_hello`（首帧不是 hello） |
| 发消息收到 `bad_mid` | `send.mid` 缺失或不合规（1–64 位 `A-Za-z0-9_.:-`）。v1.1 起服务端**不自造 mid**（否则客户端"发送中"气泡按本地 mid 匹配不上）；连接不受影响，改好重发即可 |
| 首帧后 10s 被踢 | `hello_timeout`：握手后必须 10s 内发 hello |
| 60s 静默掉线 | 客户端需 20s 发 WS ping 或应用层 `{"t":"ping"}` |
| 收不到离线消息 | `pending` 只在 relogin 的 welcome 之后一次性下发一次，不重发 |
| 历史为空 | 中继的 `history` 读 `data\messages.jsonl`；`with:"all"` 只含广播、`with:<peerId>` 只含双向 |
| 日志太大 | 程序不自动轮转 logs；`data\messages.jsonl` 会自裁（>20MB 保留最新 2000 条） |

---

## 9. 与既有服务共存核对清单

部署前先在 VPS 上跑一次，留档：

```powershell
netstat -ano | findstr LISTENING | Sort-Object
schtasks /query /fo LIST /v | Select-String "TaskName","任务名","Status","状态"
```

部署后再跑一次，`Compare-Object` 应只有 `:21001` 与 `\PrivChat-Hub` 两项新增。