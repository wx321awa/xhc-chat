/**
 * PrivChat 公网中继探针（零依赖）—— 验收 ③/④ 用
 *
 * 跑法：
 *   node server/test/pubcheck.mjs                       # 读 server/PORT.json
 *   node server/test/pubcheck.mjs ws://1.2.3.4:21001/ws <通行码>
 *
 * 动作：TCP 连 → WS 握手（校验 101 + Sec-WebSocket-Accept）→ hello
 *       → 等 welcome（校验 me/server.mode=relay/ver=1）→ 发一条 to=all
 *       → 必须收到自己的 msg 副本（from=自己、ts 被服务端重写）与 ack
 *
 * 成功打印 PUBLIC-WS-OK 并 exit 0；失败打印 PUBLIC-WS-FAIL: 原因 并 exit 1。
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (k) => crypto.createHash('sha1').update(k + WS_GUID, 'utf8').digest('base64');

function readPortJson() {
  const f = path.join(HERE, '..', 'PORT.json');
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return {};
  }
}

function parseEndpoint(ep) {
  const u = new URL(ep);
  const secure = u.protocol === 'wss:';
  return {
    host: u.hostname,
    port: Number(u.port || (secure ? 443 : 80)),
    path: u.pathname || '/ws',
    secure,
  };
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < len; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

const portJson = readPortJson();
const endpoint = process.argv[2] || portJson.endpoint || 'ws://202.189.15.98:21001/ws';
const key = process.argv[3] !== undefined ? process.argv[3] : portJson.key || '';
const target = parseEndpoint(endpoint);
const me = { id: crypto.randomBytes(16).toString('hex'), name: 'probe' };
const mid = 'probe-' + Date.now().toString(36);

if (target.secure) {
  console.log('PUBLIC-WS-FAIL: 本探针只支持明文 ws://（协议 v1 无 TLS）');
  process.exit(1);
}

console.log('探针目标: ' + endpoint + '（host=' + target.host + ' port=' + target.port + ' path=' + target.path + '）');
console.log('身份: ' + me.id.slice(0, 8) + '… 通行码: ' + (key ? key.length + ' 位' : '（空）'));

const t0 = Date.now();
const elapsed = () => String(Date.now() - t0) + 'ms';
let done = false;
const fails = [];
const fail = (why) => {
  fails.push(why);
  console.log('  ✗ ' + why);
};

function stop(code) {
  if (done) return;
  done = true;
  try {
    sock.destroy();
  } catch (_) {}
  if (fails.length) {
    console.log('\nPUBLIC-WS-FAIL: ' + fails.join(' / '));
    process.exit(1);
  }
  console.log('\nPUBLIC-WS-OK（' + elapsed() + '）');
  process.exit(0);
}

let expectAccept = '';
const sock = net.connect(target.port, target.host, () => {
  const k = crypto.randomBytes(16).toString('base64');
  expectAccept = acceptKey(k);
  console.log('[' + elapsed() + '] TCP 已连，发握手');
  sock.write(
    'GET ' + target.path + ' HTTP/1.1\r\n' +
      'Host: ' + target.host + ':' + target.port + '\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + k + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
});

let handshaken = false;
let buf = Buffer.alloc(0);
let gotWelcome = false;
let gotMsg = false;
let gotAck = false;

sock.setTimeout(8000, () => {
  fail('8s 内未完成（最后阶段: ' + (gotWelcome ? '已 welcome' : handshaken ? '已握手' : '未握手') + '）');
  stop();
});

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    const head = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 4);
    const status = head.split('\r\n')[0];
    console.log('[' + elapsed() + '] ' + status);
    if (!/^HTTP\/1\.1 101 /.test(status)) {
      fail('握手未升级（预期 101，实际 ' + status + '）');
      return stop();
    }
    const m = head.match(/Sec-WebSocket-Accept:\s*(\S+)/i);
    if (!m || m[1] !== expectAccept) {
      fail('Sec-WebSocket-Accept 不匹配（实际 ' + (m ? m[1] : '缺失') + '）');
      return stop();
    }
    handshaken = true;
    console.log('[' + elapsed() + '] 握手 OK（accept 校验通过）→ 发 hello');
    sock.write(frame({ t: 'hello', key, user: me }));
  }
  for (;;) {
    if (buf.length < 2) return;
    const b0 = buf[0];
    const b1 = buf[1];
    const op = b0 & 0x0f;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = buf.readUInt32BE(6);
      off = 10;
    }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (op === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      fail('服务端发 close ' + code + '（' + payload.subarray(2).toString('utf8') + '）');
      return stop();
    }
    if (op === 0x9) {
      const mask = crypto.randomBytes(4);
      const pong = Buffer.from(payload);
      for (let i = 0; i < pong.length; i++) pong[i] ^= mask[i & 3];
      sock.write(Buffer.concat([Buffer.from([0x8a, 0x80 | pong.length]), mask, pong]));
      continue;
    }
    if (op !== 0x1) continue;
    let o;
    try {
      o = JSON.parse(payload.toString('utf8'));
    } catch (_) {
      fail('收到非 JSON 文本帧: ' + payload.toString('utf8').slice(0, 100));
      return stop();
    }
    console.log('[' + elapsed() + '] RECV ' + JSON.stringify(o).slice(0, 160));
    if (o.t === 'error') {
      fail('服务端 error: ' + o.code + (o.msg ? ' / ' + o.msg : ''));
      if (o.code === 'bad_key' || o.code === 'bad_user' || o.code === 'not_hello') return stop();
      continue;
    }
    if (o.t === 'welcome') {
      gotWelcome = true;
      if (!o.me || o.me.id !== me.id) fail('welcome.me.id 不是自己');
      if (!o.server || o.server.mode !== 'relay') fail('welcome.server.mode 不是 relay');
      if (!o.server || o.server.ver !== '1') fail('welcome.server.ver 不是 "1"');
      if (Array.isArray(o.peers) && o.peers.some((p) => p.id === me.id)) fail('welcome.peers 不应含自己');
      console.log('[' + elapsed() + '] welcome 校验完成 → 发 to=all');
      sock.write(frame({ t: 'send', to: 'all', kind: 'text', mid, text: 'probe ' + elapsed() }));
    } else if (o.t === 'msg' && o.mid === mid) {
      gotMsg = true;
      if (o.from !== me.id) fail('msg.from 不是自己');
      if (o.to !== 'all') fail('msg.to 被改写成 ' + o.to);
      if (typeof o.ts !== 'number' || o.ts < 1600000000000) fail('msg.ts 未由服务端重写（' + o.ts + '）');
      if (o.ts === 1) fail('msg.ts 仍是客户端原始值');
    } else if (o.t === 'ack' && o.mid === mid) {
      gotAck = true;
    }
    if (gotWelcome && gotMsg && gotAck) stop();
  }
});

sock.on('error', (e) => {
  fail('TCP 错误: ' + e.message + (e.code ? ' [' + e.code + ']' : ''));
  stop();
});

sock.on('close', () => {
  if (!done) {
    fail('连接被关闭（' + (gotWelcome ? '已 welcome' : handshaken ? '已握手' : '未握手') + '）');
    stop();
  }
});