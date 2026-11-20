/**
 * PrivChat 中继单测（零依赖）—— 覆盖 docs/PROTOCOL.md §11 全部可自动断言项
 *
 * 跑法：  node test/unit.mjs
 * 期望：  全部 PASS，退出码 0（任何失败 → 非零）
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRelay, acceptKey } from '../server.mjs';

const KEY = 'TESTKEY12345';
const ID_A = 'a'.repeat(31) + '1';
const ID_B = 'b'.repeat(31) + '2';
const ID_C = 'c'.repeat(31) + '3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'privchat-test-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clientFrame(opcode, payload, { fin = true, masked = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = (masked ? 0x80 : 0) | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!masked) return Buffer.concat([header, body]);
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < len; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

class Client {
  constructor(label) {
    this.label = label;
    this.frames = [];
    this.cursor = 0;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.closeCode = null;
  }

  open(port) {
    return new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error(this.label + ' 握手 5s 未完成（服务端没回 101 或端口不通）')), 5000);
      const key = crypto.randomBytes(16).toString('base64');
      this.expectedAccept = acceptKey(key);
      this.socket = net.connect(port, '127.0.0.1', () => {
        this.socket.write(
          'GET /ws HTTP/1.1\r\n' +
            'Host: 127.0.0.1:' +
            port +
            '\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: ' +
            key +
            '\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let handshaken = false;
      this.socket.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!handshaken) {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buf.subarray(0, idx).toString('utf8');
          this.buf = this.buf.subarray(idx + 4);
          assert.match(head, /^HTTP\/1\.1 101 /, this.label + ' 握手状态行: ' + head.split('\r\n')[0]);
          assert.match(head, new RegExp('Sec-WebSocket-Accept:\\s*' + escapeRe(this.expectedAccept), 'i'), this.label + ' accept');
          handshaken = true;
          clearTimeout(watchdog);
          resolve();
        }
        this.drain();
      });
      this.socket.on('close', () => {
        this.closed = true;
        this.closedResolve && this.closedResolve();
      });
      this.socket.on('error', (e) => {
        if (!handshaken) {
          clearTimeout(watchdog);
          reject(e);
        }
      });
    });
  }

  drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const b0 = b[0];
      const b1 = b[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = b.readUInt32BE(6);
        off = 10;
      }
      assert.equal(b1 & 0x80, 0, '服务端帧不得掩码');
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (opcode === 0x1) {
        let obj;
        try {
          obj = JSON.parse(payload.toString('utf8'));
        } catch (e) {
          throw new Error(this.label + ' 收到非 JSON 文本帧: ' + payload.toString('utf8').slice(0, 80));
        }
        this.frames.push(obj);
      } else if (opcode === 0x8) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.frames.push({ t: '__close', code: this.closeCode });
      } else if (opcode === 0x9) {
        this.frames.push({ t: '__ping' });
      }
      
    }
  }

  sendRaw(buf) {
    this.socket.write(buf);
  }

  send(obj) {
    this.sendRaw(clientFrame(0x1, JSON.stringify(obj)));
  }

  async waitFor(pred, label, timeoutMs = 4000) {
    const t0 = Date.now();
    for (;;) {
      while (this.cursor < this.frames.length) {
        const f = this.frames[this.cursor++];
        if (pred(f)) return f;
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          this.label + ' 等待「' + (label || '?') + '」超时；最近帧: ' + JSON.stringify(this.frames.slice(-6)),
        );
      }
      await sleep(20);
    }
  }

  async waitClose(label, timeoutMs = 4000) {
    const f = await this.waitFor((x) => x.t === '__close', label || 'close', timeoutMs);
    return f.code;
  }

  hello(id, name, key) {
    this.send({ t: 'hello', key, user: { id, name } });
  }

  close() {
    try {
      this.socket.write(clientFrame(0x8, Buffer.from([0x03, 0xe8])));
    } catch (_) {}
    setTimeout(() => {
      try {
        this.socket.destroy();
      } catch (_) {}
    }, 100);
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS  ' + name);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 行号级信息：把断言所在文件行打印出来（跳过本函数与 node:internal 帧）
    const where = String((e && e.stack) || '')
      .split('\n')
      .filter((l) => /\/privchat\/server\//.test(l) || /unit\.mjs:/.test(l))
      .slice(0, 4)
      .map((l) => l.trim())
      .join(' | ');
    failures.push(name + ' :: ' + msg + (where ? '  @ ' + where : ''));
    console.log('FAIL  ' + name + ' :: ' + msg);
    if (where) console.log('      位置: ' + where);
  }
}

const relay = createRelay({ port: 0, key: KEY, dataDir: TMP, publicHost: '202.189.15.98' });
const { port } = await relay.start();
console.log('中继已起: 127.0.0.1:' + port + '（临时数据 ' + TMP + '）\n');

await test('§1.3 握手测试向量 acceptKey 正确', async () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

await test('GET / 状态页含「PrivChat 中继已运行」与 ws 地址', async () => {
  const page = await httpGet(port, '/');
  assert.match(page.status, /200/);
  assert.match(page.body, /PrivChat 中继已运行/);
  assert.match(page.body, new RegExp('ws://202\\.189\\.15\\.98:' + port + '/ws'));
  assert.doesNotMatch(page.body, new RegExp(KEY));
  const notFound = await httpGet(port, '/nope');
  assert.match(notFound.status, /404/);
});

await test('§1.3 Sec-WebSocket-Version≠13 → 400（不升级）', async () => {
  const res = await rawHandshake(port, [
    'GET /ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 8',
    '',
    '',
  ]);
  assert.match(res.status, / 400 /, '版本不是 13 必须 400，实际: ' + res.status);
});

await test('§1.3 缺 Upgrade 头 → 400（不升级）', async () => {
  const res = await rawHandshake(port, [
    'GET /ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ]);
  assert.match(res.status, / 400 /, '缺 Upgrade 必须 400，实际: ' + res.status);
});

const A = new Client('A');
const B = new Client('B');
await A.open(port);
await B.open(port);

await test('§3.1/3.3 A hello → welcome（me/mode/ver）', async () => {
  A.hello(ID_A, '老大', KEY);
  const w = await A.waitFor((f) => f.t === 'welcome', 'A welcome');
  assert.equal(w.me.id, ID_A);
  assert.equal(w.me.name, '老大');
  assert.equal(w.server.mode, 'relay');
  assert.equal(w.server.ver, '1');
  assert.deepEqual(w.peers, []);
});

await test('§3.1/3.4 B hello → 双方 peers 互相可见', async () => {
  B.hello(ID_B, '小鱼', KEY);
  const wb = await B.waitFor((f) => f.t === 'welcome', 'B welcome');
  assert.equal(wb.me.id, ID_B);
  assert.ok(wb.peers.some((p) => p.id === ID_A && p.name === '老大'), 'B welcome peers 应含 A');
  const pa = await A.waitFor((f) => f.t === 'peers' && f.peers.some((p) => p.id === ID_B), 'A peers(B)');
  assert.ok(!pa.peers.some((p) => p.id === ID_A), 'peers 不含自己');
});

await test('§4.2/4.3 A send to=B → B 收 msg、A 收自身副本 + ack', async () => {
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '只给你看', mid: 'm-dm-1', ts: 1 });
  const got = await B.waitFor((f) => f.t === 'msg' && f.mid === 'm-dm-1', 'B msg');
  assert.equal(got.from, ID_A);
  assert.equal(got.fromName, '老大');
  assert.equal(got.to, ID_B);
  assert.equal(got.text, '只给你看');
  assert.ok(typeof got.ts === 'number' && got.ts > 1600000000000, 'ts 由服务端重写');
  const self = await A.waitFor((f) => f.t === 'msg' && f.mid === 'm-dm-1', 'A 自身副本');
  assert.equal(self.ts, got.ts, '发送者副本与服务端投递 ts 一致');
  const ack = await A.waitFor((f) => f.t === 'ack' && f.mid === 'm-dm-1', 'A ack');
  assert.equal(ack.ts, got.ts);
});

await test('§4.2/4.4 A send to=all → B 收、A 收副本 + ack', async () => {
  A.send({ t: 'send', to: 'all', kind: 'text', text: '大家好', mid: 'm-all-1' });
  const got = await B.waitFor((f) => f.t === 'msg' && f.mid === 'm-all-1', 'B 广播');
  assert.equal(got.to, 'all');
  assert.equal(got.from, ID_A);
  await A.waitFor((f) => f.t === 'msg' && f.mid === 'm-all-1', 'A 广播副本');
  await A.waitFor((f) => f.t === 'ack' && f.mid === 'm-all-1', 'A 广播 ack');
});

await test('§4.4 bad_to（发给自己）/ bad_kind 不关连接', async () => {
  A.send({ t: 'send', to: ID_A, kind: 'text', text: 'x', mid: 'm-badto' });
  const e1 = await A.waitFor((f) => f.t === 'error' && f.code === 'bad_to', 'bad_to');
  assert.ok(e1);
  A.send({ t: 'send', to: 'all', kind: 'sticker', text: 'x', mid: 'm-badkind' });
  const e2 = await A.waitFor((f) => f.t === 'error' && f.code === 'bad_kind', 'bad_kind');
  assert.ok(e2);
  assert.equal(A.closed, false, 'bad_to/bad_kind 不应断线');
});

await test('§4.1/§8 mid 缺失或非法 → bad_mid，保持连接且不投递', async () => {
  // v1.1：服务端不得自造 mid
  A.send({ t: 'send', to: 'all', kind: 'text', text: '无 mid 的消息' });
  const e1 = await A.waitFor((f) => f.t === 'error' && f.code === 'bad_mid', 'bad_mid 缺失');
  assert.equal(e1.code, 'bad_mid', '缺 mid 必须回 bad_mid');
  A.send({ t: 'send', to: 'all', kind: 'text', text: '坏 mid 的消息', mid: 'bad mid!!' });
  await A.waitFor((f) => f.t === 'error' && f.code === 'bad_mid', 'bad_mid 非法');
  A.send({ t: 'send', to: 'all', kind: 'text', text: '超长 mid', mid: 'x'.repeat(65) });
  await A.waitFor((f) => f.t === 'error' && f.code === 'bad_mid', 'bad_mid 超长');

  // 不投递、不入库、不回 ack/自身副本
  assert.equal(A.closed, false, 'bad_mid 不应断线');
  assert.equal(
    A.frames.filter((f) => f.t === 'msg' && /无 mid|坏 mid|超长 mid/.test(f.text || '')).length,
    0,
    'bad_mid 不应给发送者自身副本',
  );
  assert.equal(
    B.frames.filter((f) => f.t === 'msg' && /无 mid|坏 mid|超长 mid/.test(f.text || '')).length,
    0,
    'bad_mid 不应广播给他人',
  );

  // 连接仍可用：紧接着发一条合法 mid，必须正常投递 + ack
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '命令之后仍可用', mid: 'm-after-badmid-1' });
  const ok = await B.waitFor((f) => f.t === 'msg' && f.mid === 'm-after-badmid-1', 'bad_mid 后仍可发');
  assert.equal(ok.text, '命令之后仍可用');
  await A.waitFor((f) => f.t === 'ack' && f.mid === 'm-after-badmid-1', 'bad_mid 后 ack');
});

await test('§14.4 未知 t → 静默忽略、不断线、不回 error', async () => {
  const before = A.frames.length;
  A.send({ t: 'nope', mid: 'x' });
  await new Promise((r) => setTimeout(r, 150));
  const fresh = A.frames.slice(before).filter((f) => f.t === 'error');
  assert.equal(fresh.length, 0, '未知 t 不应回 error: ' + JSON.stringify(fresh));
  assert.equal(A.closed, false);
  A.send({ t: 'ping' });
  await A.waitFor((f) => f.t === 'pong', '未知 t 之后 ping/pong 正常');
});

await test('§8 错 key → error bad_key + close 1008', async () => {
  const X = new Client('X');
  await X.open(port);
  X.hello(ID_C, '入侵者', 'WRONGKEY0000');
  await X.waitFor((f) => f.t === 'error' && f.code === 'bad_key', 'bad_key');
  assert.equal(await X.waitClose('bad_key close'), 1008);
});

await test('§3.1 非法 user.id → bad_user + close 1008', async () => {
  const X = new Client('X2');
  await X.open(port);
  X.send({ t: 'hello', key: KEY, user: { id: 'XYZ', name: '短' } });
  await X.waitFor((f) => f.t === 'error' && f.code === 'bad_user', 'bad_user');
  assert.equal(await X.waitClose('bad_user close'), 1008);
});

await test('§3.1 首帧不是 hello → not_hello + close 1008', async () => {
  const X = new Client('X3');
  await X.open(port);
  X.send({ t: 'send', to: 'all', kind: 'text', text: 'x', mid: 'n1' });
  await X.waitFor((f) => f.t === 'error' && f.code === 'not_hello', 'not_hello');
  assert.equal(await X.waitClose('not_hello close'), 1008);
});

await test('§6.2 B 离线时 A 定向发送 → A 收副本+ack；B 重连收 pending 且不重复', async () => {
  B.close();
  await A.waitFor((f) => f.t === 'peers' && !f.peers.some((p) => p.id === ID_B), 'A peers 无 B');
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '你不在时发的', mid: 'm-off-1' });
  await A.waitFor((f) => f.t === 'msg' && f.mid === 'm-off-1', 'A 离线副本');
  await A.waitFor((f) => f.t === 'ack' && f.mid === 'm-off-1', 'A 离线 ack');
  const B2 = new Client('B2');
  await B2.open(port);
  B2.hello(ID_B, '小鱼', KEY);
  await B2.waitFor((f) => f.t === 'welcome', 'B2 welcome');
  const pending = await B2.waitFor((f) => f.t === 'pending', 'B2 pending');
  assert.equal(pending.msgs.length, 1);
  assert.equal(pending.msgs[0].mid, 'm-off-1');
  assert.equal(pending.msgs[0].from, ID_A);
  assert.equal(pending.msgs[0].t, 'msg');
  await sleep(300);
  const dup = B2.frames.slice(B2.cursor).filter((f) => f.t === 'msg' && f.mid === 'm-off-1');
  assert.equal(dup.length, 0, 'pending 之后不得再以 msg 重发');
  globalThis.__B2 = B2;
});

await test('§3.2 同 id 重连顶替 → 旧连接 close 4001', async () => {
  const B3 = new Client('B3');
  await B3.open(port);
  B3.hello(ID_B, '小鱼', KEY);
  await B3.waitFor((f) => f.t === 'welcome', 'B3 welcome');
  const old = globalThis.__B2;
  assert.equal(await old.waitClose('旧连接被顶替'), 4001);
  globalThis.__B3 = B3;
});

await test('§5 history with=B 升序 ≤limit；with=all 只含广播', async () => {
  const B3 = globalThis.__B3;
  A.send({ t: 'history', with: ID_B, limit: 100 });
  const h = await A.waitFor((f) => f.t === 'history', 'history(B)');
  assert.equal(h.with, ID_B);
  assert.ok(h.msgs.length >= 2, '至少含 m-dm-1 与 m-off-1，实际 ' + h.msgs.length);
  assert.ok(h.msgs.length <= 100);
  let last = -1;
  for (const m of h.msgs) {
    assert.equal(m.t, 'msg');
    assert.ok((m.from === ID_A && m.to === ID_B) || (m.from === ID_B && m.to === ID_A), '只含双向，不含广播');
    assert.ok(m.ts >= last, 'ts 升序');
    last = m.ts;
  }
  A.send({ t: 'history', with: 'all', limit: 10 });
  const hall = await A.waitFor((f) => f.t === 'history' && f.with === 'all', 'history(all)');
  assert.ok(hall.msgs.length >= 1);
  assert.ok(hall.msgs.every((m) => m.to === 'all'), 'with=all 不含 1:1');
});

await test('§1.4 分片重组（两片 ping 文本）→ pong', async () => {
  A.sendRaw(clientFrame(0x1, '{"t":"pi', { fin: false }));
  A.sendRaw(clientFrame(0x0, 'ng"}', { fin: true }));
  const pong = await A.waitFor((f) => f.t === 'pong', 'pong');
  assert.ok(typeof pong.ts === 'number');
});

await test('§1.4 未掩码客户端帧 → bad_frame + close 1002', async () => {
  const U = new Client('U');
  await U.open(port);
  U.sendRaw(clientFrame(0x1, '{"t":"hello"}', { masked: false }));
  await U.waitFor((f) => f.t === 'error' && f.code === 'bad_frame', 'bad_frame');
  assert.equal(await U.waitClose('bad_frame close'), 1002);
});

await test('§1.4 二进制帧 → close 1003', async () => {
  const V = new Client('V');
  await V.open(port);
  V.sendRaw(clientFrame(0x2, Buffer.from([1, 2, 3])));
  assert.equal(await V.waitClose('binary close'), 1003);
});

await test('§1.4 超 1 MiB → too_large + close 1009', async () => {
  const W = new Client('W');
  await W.open(port);
  const len = 1048577;
  const h = Buffer.alloc(10);
  h[0] = 0x81;
  h[1] = 0x80 | 127;
  h.writeUInt32BE(0, 2);
  h.writeUInt32BE(len, 6);
  W.sendRaw(Buffer.concat([h, crypto.randomBytes(4)]));
  await W.waitFor((f) => f.t === 'error' && f.code === 'too_large', 'too_large');
  assert.equal(await W.waitClose('too_large close'), 1009);
});

await test('§4.4 同一 (from,mid) 重发 → 再回 ack，不重复入库', async () => {
  const before = (await historyCount(A, ID_B)) || 0;
  A.send({ t: 'send', to: ID_B, kind: 'text', text: '重复', mid: 'm-dm-1' });
  await A.waitFor((f) => f.t === 'ack' && f.mid === 'm-dm-1', '重复 ack');
  const after = (await historyCount(A, ID_B)) || 0;
  assert.equal(after, before, '重复 mid 不应新增历史');
});

await test('§7 应用层 ping → pong', async () => {
  A.send({ t: 'ping' });
  const pong = await A.waitFor((f) => f.t === 'pong', 'pong2');
  assert.ok(pong.ts > 0);
});

await test('§6.1 read 无应答、不断线', async () => {
  A.send({ t: 'read', with: ID_B });
  await sleep(200);
  assert.equal(A.closed, false);
});

/* ---- 收尾 ---- */

for (const c of [A, globalThis.__B3]) {
  if (c) c.close();
}
await sleep(200);
await relay.stop();
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n== 结果: ' + passed + ' 通过, ' + failures.length + ' 失败 ==');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);

/* ---------- 辅助 ---------- */

function httpGet(p, pth) {
  return new Promise((resolve, reject) => {
    const req = net.connect(p, '127.0.0.1', () => {
      req.write('GET ' + pth + ' HTTP/1.1\r\nHost: 127.0.0.1:' + p + '\r\nConnection: close\r\n\r\n');
    });
    let raw = '';
    req.on('data', (d) => (raw += d.toString('utf8')));
    req.on('close', () => {
      const idx = raw.indexOf('\r\n\r\n');
      resolve({ status: raw.split('\r\n')[0] || '', body: idx >= 0 ? raw.slice(idx + 4) : '' });
    });
    req.on('error', reject);
    setTimeout(() => {
      try {
        req.destroy();
      } catch (_) {}
    }, 2000);
  });
}

async function historyCount(A2, withId) {
  A2.send({ t: 'history', with: withId, limit: 100 });
  const h = await A2.waitFor((f) => f.t === 'history' && f.with === withId, 'history count');
  return h.msgs.length;
}

function rawHandshake(port, lines) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(lines.join('\r\n') + '\r\n'));
    let raw = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ status: raw.split('\r\n')[0] || '', raw });
    };
    s.on('data', (d) => (raw += d.toString('utf8')));
    s.on('close', done);
    s.on('error', reject);
    setTimeout(() => {
      try {
        s.destroy();
      } catch (_) {}
      done();
    }, 800);
  });
}