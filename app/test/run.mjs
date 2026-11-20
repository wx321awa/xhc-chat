#!/usr/bin/env node
/**
 * app/test/run.mjs —— 内嵌 Hub 的 WebSocket 协议集成测试（零 npm 依赖，只用 node:net / node:crypto）。
 *
 * 前置（由 captain 执行）：
 *   vendor/jdk/bin/javac -source 17 -target 17 -cp vendor/android.jar -d app/build/classes $(find app/java -name '*.java')
 *   node app/test/run.mjs
 *
 * 断言（对应 t3 验收）：
 *   0) RFC6455 握手测试向量 + 真实握手 accept 校验（客户端自算，服务端不一致即失败）
 *   1) A/B hello → welcome（me/peers/server.mode=hub,ver=1）且 peers 互相可见
 *   2) send to=B → B 收到 from=A/fromName；A 收到自身副本；A 收到 ack(mid)
 *   3) send to=all → B 收到；A 收到自身副本 + ack
 *   4) 错 key → error(code=bad_key) 后连接被关闭
 *   5) B 断开 → A 收到 peers（不含 B）
 *   6) history → msgs:[]（本机 Hub 不持久化）
 *   7) v1.2 §14：welcome.caps/group/avatar；avatar 合法→peer-info（含自己）、超长→bad_avatar；
 *      group 非法→bad_group、合法→全房广播；video kind + meta 原样透传、text 忽略 meta、
 *      未知 kind→bad_kind；POST /upload 200 + GET /m/<id> 字节一致/长缓存；错 key 上传 → 403 bad_key
 * 退出码：0=全过，1=有失败。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const JAVA = process.env.JAVA_BIN || path.join(ROOT, 'vendor', 'jdk', 'bin', 'java');
const CLASSES = path.join(ROOT, 'app', 'build', 'classes');
const ASSETS = path.join(ROOT, 'app', 'assets');
const HOST = '127.0.0.1';
const PORT = 32000 + Math.floor(Math.random() * 20000);
const KEY = 'TESTKEY123456';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (extra ? '  [' + extra + ']' : ''));
  } else {
    fail++;
    console.error('  FAIL ' + name + (extra ? '  [' + extra + ']' : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 普通 HTTP 请求（v1.2 §14.3 的 /upload 与 /m/<id>）。 */
function httpReq(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

class WS {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.msgs = [];
    this.closed = false;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const s = net.connect({ host: HOST, port: PORT });
      this.sock = s;
      let hs = Buffer.alloc(0);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('connect timeout'));
      }, timeoutMs);
      const onData = (chunk) => {
        hs = Buffer.concat([hs, chunk]);
        const idx = hs.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = hs.subarray(0, idx).toString('utf8');
        const rest = hs.subarray(idx + 4);
        s.removeListener('data', onData);
        clearTimeout(timer);
        const lines = head.split('\r\n');
        let accept = null;
        for (const line of lines.slice(1)) {
          const i = line.indexOf(':');
          if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'sec-websocket-accept') {
            accept = line.slice(i + 1).trim();
          }
        }
        if (!lines[0] || lines[0].indexOf('101') < 0 || accept !== expected) {
          s.destroy();
          reject(new Error('bad handshake: ' + lines[0] + ' accept=' + accept));
          return;
        }
        s.on('data', (c) => this._data(c));
        s.on('close', () => { this.closed = true; });
        s.on('error', () => { this.closed = true; });
        if (rest.length) this._data(rest);
        resolve();
      };
      s.on('data', onData);
      s.on('error', (e) => { clearTimeout(timer); reject(e); });
      s.once('connect', () => {
        s.write('GET /ws HTTP/1.1\r\n' +
          'Host: ' + HOST + ':' + PORT + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n');
      });
    });
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2);
        const lo = this.buf.readUInt32BE(6);
        len = hi * 4294967296 + lo;
        off = 10;
      }
      if (b1 & 0x80) off += 4; // 服务端本不应掩码；容错
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      const op = b0 & 0x0f;
      if (op === 0x1) {
        try {
          this.msgs.push(JSON.parse(payload.toString('utf8')));
        } catch (e) {
          console.error('  WARN server sent non-JSON text frame');
        }
      } else if (op === 0x8) {
        this.closed = true;
        try { this.sock.end(); } catch (e) { /* ignore */ }
      }
    }
  }

  send(obj) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  sendFrame(op, payload) {
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | op, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  close(code = 1000) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    try { this.sendFrame(0x8, b); } catch (e) { /* ignore */ }
    setTimeout(() => { try { this.sock.destroy(); } catch (e) { /* ignore */ } }, 100);
  }

  take(filter) {
    for (let i = 0; i < this.msgs.length; i++) {
      if (filter(this.msgs[i])) return this.msgs.splice(i, 1)[0];
    }
    return null;
  }

  async next(filter = () => true, ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = this.take(filter);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error('timeout waiting for message');
  }
}

function startHub() {
  return new Promise((resolve, reject) => {
    const p = spawn(JAVA, ['-cp', CLASSES, 'com.xxhh.xhc.Hub', String(PORT), KEY, ASSETS], {
      cwd: ROOT,
    });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        p.kill();
        reject(new Error('hub start timeout (10s)'));
      }
    }, 10000);
    p.stderr.on('data', (d) => {
      const s = d.toString();
      if (process.env.PRIVCHAT_TEST_DEBUG) process.stderr.write('[hub] ' + s);
      if (!done && s.indexOf('listening on') >= 0) {
        done = true;
        clearTimeout(timer);
        resolve(p);
      }
    });
    p.on('exit', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error('hub exited early, code=' + code));
      }
    });
    p.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

async function run() {
  // 0) RFC6455 官方测试向量（同时校验本仓库文档里的向量）
  const rfc = crypto.createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==' + GUID).digest('base64');
  ok('RFC6455 accept vector', rfc === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', rfc);

  const A = new WS();
  await A.connect();
  ok('A handshake 101 + accept', true);

  A.send({ t: 'hello', key: KEY, user: { id: ID_A, name: '老大' } });
  const wa = await A.next((m) => m.t === 'welcome');
  ok('A welcome.me', wa.me && wa.me.id === ID_A && wa.me.name === '老大');
  ok('A welcome.server', wa.server && wa.server.mode === 'hub' && wa.server.ver === '1',
    JSON.stringify(wa.server));
  ok('A welcome.peers empty', Array.isArray(wa.peers) && wa.peers.length === 0);

  const B = new WS();
  await B.connect();
  B.send({ t: 'hello', key: KEY, user: { id: ID_B, name: '小鱼' } });
  const wb = await B.next((m) => m.t === 'welcome');
  ok('B welcome peers contains A', wb.peers.some((p) => p.id === ID_A && p.name === '老大'));
  const peersA = await A.next((m) => m.t === 'peers' && m.peers.some((p) => p.id === ID_B));
  ok('A peers broadcast contains B', peersA.peers.some((p) => p.id === ID_B));

  // 2) 定向消息
  const mid1 = 'm1-' + Date.now();
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '在吗', mid: mid1, ts: 1 });
  const bMsg = await B.next((m) => m.t === 'msg' && m.mid === mid1);
  ok('B recv msg.from', bMsg.from === ID_A);
  ok('B recv msg.fromName', bMsg.fromName === '老大');
  ok('B recv msg.to', bMsg.to === ID_B);
  ok('B recv msg.kind/text', bMsg.kind === 'text' && bMsg.text === '在吗');
  ok('server rewrote ts', typeof bMsg.ts === 'number' && bMsg.ts !== 1 && bMsg.ts > 1000000000000);

  const aCopy = await A.next((m) => m.t === 'msg' && m.mid === mid1);
  ok('A own copy', aCopy.from === ID_A && aCopy.to === ID_B && aCopy.text === '在吗');
  const aAck = await A.next((m) => m.t === 'ack' && m.mid === mid1);
  ok('A ack mid', aAck.mid === mid1);

  // 3) 广播
  const mid2 = 'm2-' + Date.now();
  A.send({ t: 'send', to: 'all', kind: 'text', text: '大家好', mid: mid2, ts: 2 });
  const bAll = await B.next((m) => m.t === 'msg' && m.mid === mid2);
  ok('B recv to=all', bAll.to === 'all' && bAll.text === '大家好');
  const aAllCopy = await A.next((m) => m.t === 'msg' && m.mid === mid2);
  ok('A own to=all copy', aAllCopy.to === 'all');
  await A.next((m) => m.t === 'ack' && m.mid === mid2);
  ok('A ack to=all', true);

  // 6) history（Hub 恒空）
  A.send({ t: 'history', with: 'all', limit: 5 });
  const hist = await A.next((m) => m.t === 'history');
  ok('Hub history empty', Array.isArray(hist.msgs) && hist.msgs.length === 0 && hist.with === 'all');

  // 4b) bad_mid（v1.1）：缺 mid → error bad_mid，连接保持；随后 ping → pong
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '忘了带 mid' });
  const eMid = await A.next((m) => m.t === 'error' && m.code === 'bad_mid');
  ok('bad_mid error', eMid.code === 'bad_mid');
  A.send({ t: 'ping' });
  await A.next((m) => m.t === 'pong');
  ok('ping/pong after error (conn kept)', true);

  // 7) v1.2 §14：caps / 群名 / 头像 / 媒体
  ok('welcome.server.caps', Array.isArray(wa.server.caps) &&
    wa.server.caps.join(',') === 'avatar,group,media,gavatar', JSON.stringify(wa.server.caps));
  ok('welcome.server.group default', wa.server.group === '群聊（全部）', wa.server.group);
  ok('welcome.me.avatar null', wa.me.avatar === null, String(wa.me.avatar));

  const avatarData = 'data:image/jpeg;base64,' + 'A'.repeat(200);
  A.send({ t: 'avatar', data: avatarData });
  const aSelf = await A.next((m) => m.t === 'peer-info' && m.id === ID_A);
  ok('avatar → own peer-info', aSelf.avatar === avatarData && aSelf.name === '老大');
  const bInfo = await B.next((m) => m.t === 'peer-info' && m.id === ID_A);
  ok('avatar → peer B peer-info', bInfo.avatar === avatarData);

  A.send({ t: 'avatar', data: 'data:image/jpeg;base64,' + 'A'.repeat(48000) });
  const eAvatar = await A.next((m) => m.t === 'error' && m.code === 'bad_avatar');
  ok('avatar too long → bad_avatar', eAvatar.code === 'bad_avatar');
  A.send({ t: 'ping' });
  await A.next((m) => m.t === 'pong');
  ok('conn kept after bad_avatar', true);

  A.send({ t: 'group', name: '   ' });
  const eGroup = await A.next((m) => m.t === 'error' && m.code === 'bad_group');
  ok('group blank → bad_group', eGroup.code === 'bad_group');

  A.send({ t: 'group', name: '摸鱼小群' });
  const gA = await A.next((m) => m.t === 'group' && m.name === '摸鱼小群');
  ok('group broadcast to sender (by/ts)', gA.by === ID_A && typeof gA.ts === 'number');
  const gB = await B.next((m) => m.t === 'group' && m.name === '摸鱼小群');
  ok('group broadcast to peer B', gB.name === '摸鱼小群');

  // §14.6 改名：广播 peer-info 给所有人（含自己）、空名/超长 → bad_name、连接保持
  A.send({ t: 'profile', name: '  改过的老大  ' });
  const pInfoA = await A.next((m) => m.t === 'peer-info' && m.id === ID_A);
  ok('profile → own peer-info renamed', pInfoA.name === '改过的老大', pInfoA.name);
  const pInfoB = await B.next((m) => m.t === 'peer-info' && m.id === ID_A && m.name === '改过的老大');
  ok('profile → peer B sees new name', pInfoB.name === '改过的老大');
  A.send({ t: 'profile', name: '   ' });
  const eName = await A.next((m) => m.t === 'error' && m.code === 'bad_name');
  ok('profile blank → bad_name', eName.code === 'bad_name');
  A.send({ t: 'profile', name: 'x'.repeat(30) });
  const eName2 = await A.next((m) => m.t === 'error' && m.code === 'bad_name');
  ok('profile too long → bad_name', eName2.code === 'bad_name');
  A.send({ t: 'ping' });
  await A.next((m) => m.t === 'pong');
  ok('conn kept after bad_name', true);

  // §14.5 群头像：广播给所有人（含自己）、错前缀 → bad_gavatar、data:null 清除
  const gav = 'data:image/jpeg;base64,' + 'G'.repeat(300);
  A.send({ t: 'gavatar', data: gav });
  const gavA = await A.next((m) => m.t === 'gavatar');
  ok('gavatar broadcast to sender', gavA.data === gav && gavA.by === ID_A && typeof gavA.ts === 'number');
  const gavB = await B.next((m) => m.t === 'gavatar');
  ok('gavatar broadcast to peer', gavB.data === gav);
  A.send({ t: 'gavatar', data: 'https://evil.example/x.png' });
  const eGav = await A.next((m) => m.t === 'error' && m.code === 'bad_gavatar');
  ok('gavatar bad prefix → bad_gavatar', eGav.code === 'bad_gavatar');
  A.send({ t: 'gavatar', data: null });
  const gavClear = await A.next((m) => m.t === 'gavatar' && m.data === null);
  ok('gavatar clear broadcast', gavClear.data === null);
  A.send({ t: 'ping' });
  await A.next((m) => m.t === 'pong');
  ok('conn kept after gavatar ops', true);

  // v1.2 §14.3：video kind + meta 原样透传；text 忽略 meta；未知 kind → bad_kind 不断线
  const videoMeta = {
    name: 'clip.mp4', size: 3145728, w: 1280, h: 720, dur: 12.4,
    thumb: 'data:image/jpeg;base64,QUJD',
  };
  const midV = 'mv-' + Date.now();
  A.send({ t: 'send', to: ID_B, kind: 'video', text: '/m/0123456789abcdef', mid: midV, meta: videoMeta });
  const bVideo = await B.next((m) => m.t === 'msg' && m.mid === midV);
  ok('video msg kind/text', bVideo.kind === 'video' && bVideo.text === '/m/0123456789abcdef',
    bVideo.kind + ' ' + bVideo.text);
  ok('video msg meta passthrough',
    JSON.stringify(bVideo.meta) === JSON.stringify(videoMeta), JSON.stringify(bVideo.meta));
  const aVideo = await A.next((m) => m.t === 'msg' && m.mid === midV);
  ok('video own copy + meta', aVideo.kind === 'video' &&
    JSON.stringify(aVideo.meta) === JSON.stringify(videoMeta));
  await A.next((m) => m.t === 'ack' && m.mid === midV);
  ok('video ack', true);

  const midT = 'mt-' + Date.now();
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '无 meta', mid: midT, meta: { evil: 1 } });
  const bText = await B.next((m) => m.t === 'msg' && m.mid === midT);
  ok('text msg drops meta', bText.kind === 'text' && bText.meta === undefined);
  await A.next((m) => m.t === 'msg' && m.mid === midT);
  await A.next((m) => m.t === 'ack' && m.mid === midT);

  A.send({ t: 'send', to: ID_B, kind: 'sticker', text: 'x', mid: 'ms-' + Date.now() });
  const eKind = await A.next((m) => m.t === 'error' && m.code === 'bad_kind');
  ok('unknown kind → bad_kind', eKind.code === 'bad_kind');
  A.send({ t: 'ping' });
  await A.next((m) => m.t === 'pong');
  ok('conn kept after bad_kind', true);

  // 媒体：POST /upload → GET /m/<id>
  const img = Buffer.from('fake-jpeg-bytes-' + 'x'.repeat(100), 'utf8');
  const up = await httpReq('POST', '/upload', {
    'X-Key': KEY, 'X-Kind': 'image', 'X-Name': 'tiny.jpg',
    'Content-Length': String(img.length),
  }, img);
  ok('upload 200', up.status === 200,
    'status=' + up.status + ' body=' + up.body.toString().slice(0, 120));
  let upJson = {};
  try { upJson = JSON.parse(up.body.toString('utf8')); } catch (e) { /* ignore */ }
  ok('upload ok/id/path/size/mime', upJson.ok === true && /^[0-9a-f]{16}$/.test(upJson.id) &&
    upJson.path === '/m/' + upJson.id && upJson.size === img.length && upJson.mime === 'image/jpeg',
    JSON.stringify(upJson));
  const got = await httpReq('GET', upJson.path || '/m/0000000000000000');
  ok('GET /m/<id> 200 bytes match', got.status === 200 && got.body.equals(img));
  ok('GET /m/<id> immutable cache + mime',
    got.headers['content-type'] === 'image/jpeg' &&
    got.headers['cache-control'] === 'public, max-age=31536000, immutable',
    JSON.stringify({ ct: got.headers['content-type'], cc: got.headers['cache-control'] }));

  const badUp = await httpReq('POST', '/upload', {
    'X-Key': 'WRONG', 'X-Kind': 'image', 'Content-Length': '3',
  }, Buffer.from('abc'));
  let badJson = {};
  try { badJson = JSON.parse(badUp.body.toString('utf8')); } catch (e) { /* ignore */ }
  ok('upload wrong key 403 bad_key', badUp.status === 403 && badJson.error === 'bad_key',
    badUp.status + ' ' + JSON.stringify(badJson));

  // 4) 错 key
  const C = new WS();
  await C.connect();
  C.send({ t: 'hello', key: 'WRONG-KEY', user: { id: ID_C, name: '坏人' } });
  const cErr = await C.next((m) => m.t === 'error');
  ok('bad key error code', cErr.code === 'bad_key', cErr.code);
  await sleep(400);
  ok('bad key connection closed', C.closed === true);

  // 5) B 断开 → A peers 更新
  const mid3 = 'm3-' + Date.now();
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '最后一句', mid: mid3 });
  await B.next((m) => m.t === 'msg' && m.mid === mid3);
  B.close();
  await sleep(400);
  const peersAfter = await A.next(
    (m) => m.t === 'peers' && !m.peers.some((p) => p.id === ID_B),
    4000
  );
  ok('A peers without B after disconnect', peersAfter.peers.length === 0);

  A.close();
}

let hubProc = null;
try {
  console.log('privchat Hub 集成测试：port=' + PORT + ' key=' + KEY);
  hubProc = await startHub();
  await run();
} catch (e) {
  fail++;
  console.error('FATAL ' + (e && e.stack ? e.stack : e));
} finally {
  if (hubProc) {
    try { hubProc.kill(); } catch (e) { /* ignore */ }
  }
  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}