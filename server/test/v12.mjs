#!/usr/bin/env node
// v1.2 relay smoke test: caps / avatar / group / upload+serve media / video kind.
// usage: node server/test/v12.mjs [--port 21091]
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 21091;
const { createRelay } = await import('../server.mjs');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('PASS  ' + msg); }
  else { fail++; console.log('FAIL  ' + msg + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
};

const dataDir = mkdtempSync(join(tmpdir(), 'relay12-'));
const relay = createRelay({ port: PORT, host: '127.0.0.1', key: 'testkey123', dataDir, publicHost: '127.0.0.1' });
await relay.start();
const BASE = 'http://127.0.0.1:' + relay.port;

function connect(id, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + relay.port + '/ws');
    const frames = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data)));
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', key: 'testkey123', user: { id, name } })));
    ws.addEventListener('error', reject);
    const cli = {
      ws, frames,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor: async (pred, label, ms = 2000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const f = frames.find(pred);
          if (f) return f;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('timeout waiting ' + label + ' :: ' + JSON.stringify(frames).slice(0, 400));
      },
      close: () => ws.close(),
    };
    resolve(cli);
  });
}

const A = await connect('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', '老大');
const wA = await A.waitFor((f) => f.t === 'welcome', 'A welcome');
ok(Array.isArray(wA.server?.caps) && ['avatar', 'group', 'media'].every((c) => wA.server.caps.includes(c)), 'welcome.server.caps 含 avatar/group/media', wA.server);
ok(typeof wA.server?.group === 'string' && wA.server.group.length > 0, 'welcome.server.group 有默认群名', wA.server);

const B = await connect('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', '路人鱼');
const wB = await B.waitFor((f) => f.t === 'welcome', 'B welcome');
ok(wB.server?.group === wA.server.group, 'B 看到同一默认群名');
const peersA = await A.waitFor((f) => f.t === 'peers' && f.peers.some((p) => p.id.startsWith('bbbb')), 'A peers 含 B');
ok(peersA.peers.every((p) => 'avatar' in p), 'peers 条目带 avatar 字段', peersA.peers);

// --- avatar ---------------------------------------------------------------
const AV = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]).toString('base64');
A.send({ t: 'avatar', data: AV });
const info = await B.waitFor((f) => f.t === 'peer-info' && f.id.startsWith('aaaa'), 'B 收到 peer-info');
ok(info.avatar === AV, 'peer-info 带头像数据', { got: info.avatar && info.avatar.slice(0, 40), want: AV.slice(0, 40) });
A.send({ t: 'avatar', data: 'data:image/png;base64,AAAA' });
const badAv = await A.waitFor((f) => f.t === 'error' && f.code === 'bad_avatar', 'bad_avatar');
ok(!!badAv, '非 jpeg 前缀 → bad_avatar');

// --- group ----------------------------------------------------------------
B.send({ t: 'group', name: '  花花的小窝  ' });
const gA = await A.waitFor((f) => f.t === 'group' && f.name === '花花的小窝', 'A 收到 group');
ok(gA.by === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', 'group 帧带 by', gA);
B.send({ t: 'group', name: '' });
ok(!!(await B.waitFor((f) => f.t === 'error' && f.code === 'bad_group', 'bad_group')), '空群名 → bad_group');

// --- upload + serve -------------------------------------------------------
function post(pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: relay.port, path: pathname, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
const up = await post('/upload', { 'X-Key': 'testkey123', 'X-Kind': 'image', 'X-Name': encodeURIComponent('测试 图.png'), 'Content-Length': String(PNG.length) }, PNG);
const upJson = JSON.parse(up.body.toString());
ok(up.status === 200 && upJson.ok && /^[0-9a-f]{16}$/.test(upJson.id) && upJson.path === '/m/' + upJson.id, 'POST /upload 200 + id/path', upJson);
ok(upJson.mime === 'image/png' && upJson.size === PNG.length, 'upload 回 mime/size', upJson);

const got = await new Promise((resolve, reject) => {
  http.get(BASE + upJson.path, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});
ok(got.status === 200 && got.body.equals(PNG), 'GET /m/<id> 原字节返回', { status: got.status, len: got.body.length });
ok(/immutable/.test(String(got.headers['cache-control'] || '')), '媒体响应带 immutable 长缓存', got.headers['cache-control']);
ok(got.headers['content-type'] === 'image/png', '媒体 Content-Type 正确', got.headers['content-type']);

const badKey = await post('/upload', { 'X-Key': 'nope', 'X-Kind': 'image', 'Content-Length': '10' }, Buffer.alloc(10));
ok(badKey.status === 403 && JSON.parse(badKey.body).code === 'bad_key', '错 key → 403 bad_key');
const badKind = await post('/upload', { 'X-Key': 'testkey123', 'X-Kind': 'doc', 'Content-Length': '10' }, Buffer.alloc(10));
ok(badKind.status === 400 && JSON.parse(badKind.body).code === 'bad_kind', '错 kind → 400 bad_kind');
const badMime = await post('/upload', { 'X-Key': 'testkey123', 'X-Kind': 'image', 'Content-Length': '2' }, Buffer.from('hi'));
ok(badMime.status === 400 && JSON.parse(badMime.body).code === 'bad_kind', '非图片内容 → 400 bad_kind');
const miss = await new Promise((resolve) => http.get(BASE + '/m/ffffffffffffffff', (res) => resolve({ status: res.statusCode })).on('error', () => resolve({ status: 0 })));
ok(miss.status === 404, '未知媒体 id → 404');

// --- video kind 投递 -------------------------------------------------------
A.send({ t: 'send', to: 'all', kind: 'video', text: '/m/abcdef0123456789', mid: 'm-video-1', meta: { name: 'a.mp4', size: 1234, dur: 3 } });
const vmsg = await B.waitFor((f) => f.t === 'msg' && f.mid === 'm-video-1', 'B 收到视频消息');
ok(vmsg.kind === 'video' && vmsg.text === '/m/abcdef0123456789' && vmsg.meta && vmsg.meta.dur === 3, 'video kind 与 meta 原样投递', vmsg);

// --- 状态持久化 & 重启 -----------------------------------------------------
await relay.stop();
const relay2 = createRelay({ port: PORT, host: '127.0.0.1', key: 'testkey123', dataDir, publicHost: '127.0.0.1' });
await relay2.start();
const A2 = await connect('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', '老大');
const w2 = await A2.waitFor((f) => f.t === 'welcome', 'A2 welcome');
ok(w2.server.group === '花花的小窝', '重启后群名保留', w2.server.group);
ok(w2.me.avatar === AV, '重启后头像保留', { got: (w2.me.avatar || '').slice(0, 30) });
const got2 = await new Promise((resolve) => http.get('http://127.0.0.1:' + relay2.port + upJson.path, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
}).on('error', () => resolve({ status: 0, body: Buffer.alloc(0) })));
ok(got2.status === 200 && got2.body.equals(PNG), '重启后媒体仍可下载');
A2.close();
await relay2.stop();

console.log('\n== v1.2 结果: ' + pass + ' 通过, ' + fail + ' 失败 ==');
process.exit(fail ? 1 : 0);