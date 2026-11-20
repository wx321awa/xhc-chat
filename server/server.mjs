/**
 * PrivChat 公网中继（relay）v1.2 —— 零 npm 依赖（只用 node:http/fs/path/crypto）
 * 契约：../docs/PROTOCOL.md v1.2（唯一权威）；部署：./DEPLOY.md
 *
 * v1.2（§14）：welcome.server.caps / server.group / 头像 peer-info / 群名 group
 *              + POST /upload 与 GET /m/<id>（图片 ≤4MiB、视频 ≤16MiB，流式落盘）
 *
 * 用法：
 *   node server.mjs                     # 读同目录 config.json
 *   node server.mjs --config <path>      # 指定配置
 *   node server.mjs --port 21001 --key K # 命令行覆盖
 *
 * config.json（UTF-8）：
 *   {"port":21001,"host":"0.0.0.0","key":"<12位通行码>","dataDir":"data","publicHost":"202.189.15.98"}
 * key 为 null / "" 时不校验通行码（不建议公网这样跑）。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const VER = '1';

const MAX_PAYLOAD = 1048576; // 1 MiB，单帧与分片重组后的总长
const MAX_HISTORY = 5000; // 内存里保留的历史条数
const HISTORY_MAX_BYTES = 20 * 1024 * 1024; // JSONL 超过 20MB 触发重写
const HISTORY_KEEP = 2000; // 重写时保留的条数
const MAX_PENDING = 200; // 每人离线队列上限
const HELLO_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 60000;
const PING_IDLE_MS = 25000;
const SWEEP_MS = 5000;
const DEDUPE_MAX = 5000;
const ID_RE = /^[0-9a-f]{32}$/;
const MID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/* v1.2（§14） */
const CAPS = ['avatar', 'group', 'media', 'gavatar'];
const DEFAULT_GROUP = '群聊（全部）';
const AVATAR_PREFIX = 'data:image/jpeg;base64,';
const AVATAR_MAX = 48000; // 整串（含前缀）上限
const MAX_BODY_IMAGE = 4 * 1024 * 1024; // 4 MiB
const MAX_BODY_VIDEO = 16 * 1024 * 1024; // 16 MiB
const MEDIA_ID_RE = /^[0-9a-f]{16}$/;
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const MEDIA_MAX_ITEMS = 2000; // 上传历史条目上限（超出按最旧清理）

// CORS：公网模式下页面来自 http://127.0.0.1:<Hub 端口>，上传/取媒体打到本中继属跨域，
// 浏览器会先发 OPTIONS 预检；自定义头 X-Key/X-Kind/X-Name 必须显式放行。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'X-Key,X-Kind,X-Name,Content-Type',
  'Access-Control-Max-Age': '86400',
};
const GROUP_MAX = 24;

function isValidGroupName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= GROUP_MAX;
}

function mediaExt(mime) {
  const m = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  };
  return m[mime] || '.bin';
}

function sniffMime(buf, kind) {
  if (buf.length < 12) return null;
  const hex = buf.slice(0, 12).toString('hex');
  if (kind === 'image') {
    if (hex.startsWith('ffd8ff')) return 'image/jpeg';
    if (hex.startsWith('89504e47')) return 'image/png';
    if (hex.startsWith('474946')) return 'image/gif';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return null;
  }
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (buf.slice(4, 8).toString('ascii') === 'moov' || buf.slice(4, 8).toString('ascii') === 'mdat') return 'video/quicktime';
  return null;
}

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID, 'utf8').digest('base64');
}

function ts() {
  return new Date().toISOString();
}
function log(...args) {
  console.log('[' + ts() + ']', ...args);
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function isValidName(name) {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (!t) return false;
  return [...t].length <= 24;
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.id = null;
    this.name = null;
    this.authed = false;
    this.closed = false;
    this.lastSeen = Date.now();
    this.lastPing = 0;
    this.helloAt = Date.now();
    this.remote = (socket.remoteAddress || '?') + ':' + (socket.remotePort || 0);
  }
}

class Relay {
  constructor(opts = {}) {
    this.port = opts.port === undefined ? 21001 : opts.port;
    this.host = opts.host || '0.0.0.0';
    this.key = opts.key === undefined ? null : opts.key;
    this.publicHost = opts.publicHost || '';
    this.dataDir = opts.dataDir || path.join(HERE, 'data');
    this.historyFile = path.join(this.dataDir, 'messages.jsonl');

    this.server = null;
    this.sweepTimer = null;
    this.openConns = new Set();
    this.conns = new Map(); // id -> Conn（已入场）
    this.history = []; // 内存历史（msg 对象，按写入顺序）
    this.pending = new Map(); // id -> [msg]
    this.lastRead = new Map(); // id -> Map(with -> ts)
    this.seen = new Map(); // "from|mid" -> ts（重发去重）
    this.appendCount = 0;

    /* v1.2（§14）状态 */
    this.caps = CAPS.slice();
    this.groupName = DEFAULT_GROUP;
    this.gavatar = null;
    this.avatars = new Map(); // id -> data string（null 表示已清除，不存）
    this.media = new Map(); // mediaId -> {mime,size,name,ts,ext}
    this.mediaDir = path.join(this.dataDir, 'media');
    this.avatarsFile = path.join(this.dataDir, 'avatars.json');
    this.roomFile = path.join(this.dataDir, 'room.json');
    this.mediaFile = path.join(this.dataDir, 'media.json');
  }

  /* ---------- 生命周期 ---------- */

  start() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.loadHistory();
    this.loadState();
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.server.on('clientError', (err, socket) => {
      try {
        socket.destroy();
      } catch (_) {}
    });
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
    return new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      this.server.once('error', onErr);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onErr);
        this.port = this.server.address().port;
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const conn of [...this.openConns]) this.closeConn(conn, 4002, 'shutdown');
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      setTimeout(resolve, 1500);
    });
  }

  /* ---------- HTTP ---------- */

  onRequest(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://relay').pathname;
    } catch (_) {}
    const method = req.method || 'GET';
    const head = (status, body, type) => {
      const buf = Buffer.from(body, 'utf8');
      res.writeHead(status, Object.assign({
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
        Connection: 'close',
      }, CORS));
      if (method === 'HEAD') res.end();
      else res.end(buf);
    };
    if (method === 'OPTIONS') {
      res.writeHead(204, Object.assign({ 'Content-Length': '0', Connection: 'close' }, CORS));
      return res.end();
    }
    if (method === 'POST' && pathname === '/upload') return this.handleUpload(req, res);
    if (pathname.startsWith('/m/')) return this.serveMedia(req, res, pathname, head);
    if (method !== 'GET' && method !== 'HEAD') return head(405, 'Method Not Allowed');
    if (pathname === '/') return head(200, this.statusPage(), 'text/html; charset=utf-8');
    // /ws without upgrade headers: PROTOCOL §1.3 requires 400, not 404
    if (pathname === '/ws') return head(400, 'Bad Request');
    return head(404, 'Not Found');
  }

  statusPage() {
    const hostname = this.publicHost || '127.0.0.1';
    const endpoint = 'ws://' + hostname + ':' + this.port + '/ws';
    const n = this.conns.size;
    return [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>PrivChat 中继</title>',
      '<style>body{font:15px/1.7 -apple-system,Segoe UI,sans-serif;max-width:640px;margin:40px auto;padding:0 18px;color:#222}',
      'code{background:#f4f4f4;padding:2px 6px;border-radius:4px}.ok{color:#0a0}th,td{text-align:left;padding:4px 10px 4px 0}</style>',
      '</head><body>',
      '<h1>PrivChat 中继已运行</h1>',
      '<p class="ok">● 服务正常</p>',
      '<table>',
      '<tr><th>监听</th><td><code>0.0.0.0:' + this.port + '</code></td></tr>',
      '<tr><th>客户端地址</th><td><code>' + endpoint + '</code></td></tr>',
      '<tr><th>协议</th><td>WebSocket JSON v' + VER + '（mode=relay）</td></tr>',
      '<tr><th>在线</th><td>' + n + ' 人</td></tr>',
      '</table>',
      '<h2>自测</h2>',
      '<p>把上面的 <code>ws://…/ws</code> 填进 XHC App 的连接面板，通行码填中继 <code>config.json</code> 里的 key；',
      '或直接本机跑 <code>node server/test/pubcheck.mjs</code>（探针会自己读 PORT.json）。</p>',
      '<p>本页只证明中继在跑，不显示通行码。</p>',
      '</body></html>',
    ].join('\n');
  }

  /* ---------- 升级 ---------- */

  /* ---------- v1.2 状态（头像 / 群名 / 媒体） ---------- */

  loadState() {
    const readJson = (file, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        return fallback;
      }
    };
    const av = readJson(this.avatarsFile, null);
    if (av && typeof av === 'object' && !Array.isArray(av)) {
      for (const [id, data] of Object.entries(av)) {
        if (ID_RE.test(id) && typeof data === 'string' && data.length <= AVATAR_MAX && data.startsWith(AVATAR_PREFIX)) {
          this.avatars.set(id, data);
        }
      }
    }
    const room = readJson(this.roomFile, null);
    if (room && typeof room.group === 'string' && isValidGroupName(room.group)) this.groupName = room.group.trim();
    if (room && typeof room.gavatar === 'string' && room.gavatar.startsWith(AVATAR_PREFIX) && room.gavatar.length <= AVATAR_MAX) {
      this.gavatar = room.gavatar;
    }
    const media = readJson(this.mediaFile, null);
    if (media && typeof media === 'object' && !Array.isArray(media)) {
      for (const [id, m] of Object.entries(media)) {
        if (!MEDIA_ID_RE.test(id) || !m || typeof m !== 'object') continue;
        if (typeof m.mime !== 'string' || typeof m.ext !== 'string' || !Number.isFinite(m.size)) continue;
        if (!fs.existsSync(path.join(this.mediaDir, id + m.ext))) continue;
        this.media.set(id, { mime: m.mime, size: m.size, name: String(m.name || ''), ts: Number(m.ts) || 0, ext: m.ext });
      }
    }
    log('state: 头像 ' + this.avatars.size + '，媒体 ' + this.media.size + '，群名「' + this.groupName + '」，群头像 ' + (this.gavatar ? this.gavatar.length + 'B' : '无'));
  }

  saveState(kind) {
    try {
      if (!kind || kind === 'avatars') {
        const obj = {};
        for (const [id, data] of this.avatars) if (data) obj[id] = data;
        fs.writeFileSync(this.avatarsFile, JSON.stringify(obj));
      }
      if (!kind || kind === 'room') {
        fs.writeFileSync(this.roomFile, JSON.stringify({ group: this.groupName, gavatar: this.gavatar, ts: Date.now() }));
      }
      if (!kind || kind === 'media') {
        const obj = {};
        for (const [id, m] of this.media) obj[id] = m;
        fs.writeFileSync(this.mediaFile, JSON.stringify(obj));
      }
    } catch (e) {
      log('saveState failed: ' + e.message);
    }
  }

  json(res, status, obj, extraHeaders) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const headers = Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      Connection: 'close',
    }, CORS, extraHeaders || {});
    res.writeHead(status, headers);
    res.end(buf);
  }

  handleUpload(req, res) {
    if (this.key !== null && this.key !== '' && String(req.headers['x-key'] || '') !== this.key) {
      req.resume();
      return this.json(res, 403, { ok: false, code: 'bad_key' });
    }
    const kind = String(req.headers['x-kind'] || '').toLowerCase();
    if (kind !== 'image' && kind !== 'video') {
      req.resume();
      return this.json(res, 400, { ok: false, code: 'bad_kind' });
    }
    const limit = kind === 'image' ? MAX_BODY_IMAGE : MAX_BODY_VIDEO;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limit) {
      req.resume();
      return this.json(res, 400, { ok: false, code: 'too_large' });
    }
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        over = true;
        chunks.length = 0;
      } else if (!over) {
        chunks.push(c);
      }
    });
    req.on('error', () => {
      try {
        res.destroy();
      } catch (_) {}
    });
    req.on('end', () => {
      if (over) return this.json(res, 400, { ok: false, code: 'too_large' });
      if (!n) return this.json(res, 400, { ok: false, code: 'empty' });
      const buf = Buffer.concat(chunks, n);
      const mime = sniffMime(buf, kind);
      if (!mime) return this.json(res, 400, { ok: false, code: 'bad_kind' });
      const id = crypto.randomBytes(8).toString('hex');
      const ext = mediaExt(mime);
      const orig = String(req.headers['x-name'] || '');
      let name = '';
      try {
        name = decodeURIComponent(orig).slice(0, 120);
      } catch (_) {
        name = orig.slice(0, 120);
      }
      try {
        fs.writeFileSync(path.join(this.mediaDir, id + ext), buf);
      } catch (e) {
        log('upload write failed: ' + e.message);
        return this.json(res, 500, { ok: false, code: 'io' });
      }
      const rec = { mime, size: n, name, ts: Date.now(), ext };
      this.media.set(id, rec);
      if (this.media.size > MEDIA_MAX_ITEMS) {
        const oldest = [...this.media.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, this.media.size - MEDIA_MAX_ITEMS);
        for (const [mid, m] of oldest) {
          this.media.delete(mid);
          try {
            fs.unlinkSync(path.join(this.mediaDir, mid + m.ext));
          } catch (_) {}
        }
      }
      this.saveState('media');
      log('upload ' + kind + ' ' + id + ' ' + n + 'B ' + mime);
      return this.json(res, 200, { ok: true, id, path: '/m/' + id, mime, size: n });
    });
  }

  serveMedia(req, res, pathname, headFallback) {
    const id = pathname.slice(3);
    const m = MEDIA_ID_RE.test(id) ? this.media.get(id) : null;
    if (!m) return headFallback(404, 'Not Found');
    const file = path.join(this.mediaDir, id + m.ext);
    let data;
    try {
      data = fs.readFileSync(file);
    } catch (_) {
      this.media.delete(id);
      return headFallback(404, 'Not Found');
    }
    res.writeHead(200, Object.assign({
      'Content-Type': m.mime,
      'Content-Length': String(data.length),
      'Cache-Control': CACHE_IMMUTABLE,
      'Accept-Ranges': 'none',
      Connection: 'close',
    }, CORS));
    if ((req.method || 'GET') === 'HEAD') res.end();
    else res.end(data);
  }

  handleAvatar(conn, msg) {
    const data = msg.data;
    if (data === null || data === '') {
      this.avatars.delete(conn.id);
      this.saveState('avatars');
      this.broadcastPeerInfo(conn.id);
      return this.send(conn, { t: 'peer-info', id: conn.id, name: conn.name, avatar: null });
    }
    if (typeof data !== 'string' || !data.startsWith(AVATAR_PREFIX) || data.length > AVATAR_MAX) {
      return this.err(conn, 'bad_avatar', '头像需为 data:image/jpeg;base64,... 且整串 ≤48000');
    }
    this.avatars.set(conn.id, data);
    this.saveState('avatars');
    this.broadcastPeerInfo(conn.id);
    log('avatar ' + conn.id.slice(0, 8) + ' ' + data.length + 'B');
  }

  /* §14.6：改名（不动连接、不动历史，只更新房间内显示名） */
  handleProfile(conn, msg) {
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    if (!name || [...name].length > 24) {
      return this.err(conn, 'bad_name', '昵称需为 1-24 个字符');
    }
    conn.name = name;
    this.broadcastPeerInfo(conn.id);
    log('rename ' + conn.id.slice(0, 8) + ' → ' + name);
  }

  handleGroup(conn, msg) {
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    if (!isValidGroupName(name)) return this.err(conn, 'bad_group', '群名 1-24 字符');
    this.groupName = name;
    this.saveState('room');
    const frame = { t: 'group', name, by: conn.id, ts: Date.now() };
    for (const [id, c] of this.conns) if (c.authed && !c.closed) this.send(c, frame);
    log('group -> ' + name);
  }

  handleGavatar(conn, msg) {
    const raw = msg.data;
    if (raw === null || raw === undefined || raw === '') {
      this.gavatar = null;
      this.saveState('room');
      const cleared = { t: 'gavatar', data: null, by: conn.id, ts: Date.now() };
      for (const [id, c] of this.conns) if (c.authed && !c.closed) this.send(c, cleared);
      log('gavatar cleared by ' + conn.id.slice(0, 8));
      return;
    }
    if (typeof raw !== 'string' || !raw.startsWith(AVATAR_PREFIX) || raw.length > AVATAR_MAX) {
      return this.err(conn, 'bad_gavatar', '群头像需为 data:image/jpeg;base64,... 且整串 ≤48000');
    }
    this.gavatar = raw;
    this.saveState('room');
    const frame = { t: 'gavatar', data: raw, by: conn.id, ts: Date.now() };
    for (const [id, c] of this.conns) if (c.authed && !c.closed) this.send(c, frame);
    log('gavatar ' + raw.length + 'B by ' + conn.id.slice(0, 8));
  }

  broadcastPeerInfo(changedId) {
    const frame = { t: 'peer-info', id: changedId, name: this.conns.get(changedId)?.name || '', avatar: this.avatars.get(changedId) || null };
    for (const [id, c] of this.conns) if (c.authed && !c.closed) this.send(c, frame);
  }

  onUpgrade(req, socket, head) {
    const bad = (code, text) => {
      try {
        socket.write(
          'HTTP/1.1 ' +
            code +
            ' ' +
            text +
            '\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n',
        );
      } catch (_) {}
      try {
        socket.end();
      } catch (_) {}
    };
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://relay').pathname;
    } catch (_) {}
    if (pathname !== '/ws') return bad(404, 'Not Found');

    const h = req.headers || {};
    const upgrade = String(h.upgrade || '').toLowerCase();
    const connection = String(h.connection || '').toLowerCase();
    const version = String(h['sec-websocket-version'] || '');
    const key = String(h['sec-websocket-key'] || '');
    let keyOk = false;
    try {
      keyOk = key.length > 0 && Buffer.from(key, 'base64').length === 16;
    } catch (_) {
      keyOk = false;
    }
    const connOk = connection.split(',').map((s) => s.trim()).includes('upgrade');
    if (upgrade !== 'websocket' || !connOk || version !== '13' || !keyOk) return bad(400, 'Bad Request');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        acceptKey(key) +
        '\r\n\r\n',
    );
    if (socket.setNoDelay) socket.setNoDelay(true);

    const conn = new Conn(socket);
    this.openConns.add(conn);
    socket.on('data', (d) => this.onData(conn, d));
    socket.on('close', () => this.drop(conn));
    socket.on('end', () => this.drop(conn));
    socket.on('error', () => this.drop(conn));
    if (head && head.length) this.onData(conn, head);
  }

  /* ---------- 帧解析 ---------- */

  onData(conn, chunk) {
    if (conn.closed) return;
    conn.lastSeen = Date.now();
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    for (;;) {
      const buf = conn.buf;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (rsv !== 0) return this.fatal(conn, 1002, 'bad_frame', 'RSV 非零');
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this.fatal(conn, 1009, 'too_large', '负载过大');
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (opcode >= 0x8 && (len > 125 || !fin)) return this.fatal(conn, 1002, 'bad_frame', '控制帧非法');
      if (len > MAX_PAYLOAD) return this.fatal(conn, 1009, 'too_large', '负载过大');
      if (!masked) return this.fatal(conn, 1002, 'bad_frame', '客户端帧必须掩码');
      const need = off + 4 + len;
      if (buf.length < need) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
      conn.buf = buf.subarray(need);
      this.onFrame(conn, fin, opcode, payload);
      if (conn.closed) return;
    }
  }

  onFrame(conn, fin, opcode, payload) {
    if (opcode === 0x8) {
      let code = 1000;
      if (payload.length >= 2) code = payload.readUInt16BE(0);
      this.closeConn(conn, code, '');
      return;
    }
    if (opcode === 0x9) {
      this.raw(conn, 0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong 只当活帧
    if (opcode === 0x2) return this.fatal(conn, 1003, 'bad_frame', '不支持二进制帧');
    if (opcode === 0x1) {
      if (conn.frag) return this.fatal(conn, 1002, 'bad_frame', '分片未结束又来新数据帧');
      if (fin) return this.onText(conn, payload);
      conn.frag = { opcode, chunks: [payload], len: payload.length };
      return;
    }
    if (opcode === 0x0) {
      if (!conn.frag) return this.fatal(conn, 1002, 'bad_frame', '孤立的 continuation');
      conn.frag.chunks.push(payload);
      conn.frag.len += payload.length;
      if (conn.frag.len > MAX_PAYLOAD) return this.fatal(conn, 1009, 'too_large', '负载过大');
      if (!fin) return;
      const full = Buffer.concat(conn.frag.chunks, conn.frag.len);
      conn.frag = null;
      return this.onText(conn, full);
    }
    return this.fatal(conn, 1002, 'bad_frame', '未知 opcode');
  }

  onText(conn, payload) {
    const text = payload.toString('utf8');
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return this.fatal(conn, 1002, 'bad_json', '不是 JSON');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || !msg.t) {
      return this.fatal(conn, 1002, 'bad_json', '缺 t');
    }
    if (!conn.authed) {
      if (msg.t !== 'hello') return this.fatal(conn, 1008, 'not_hello', '首帧必须是 hello');
      return this.handleHello(conn, msg);
    }
    switch (msg.t) {
      case 'send':
        return this.handleSend(conn, msg);
      case 'history':
        return this.handleHistory(conn, msg);
      case 'read':
        return this.handleRead(conn, msg);
      case 'gavatar':
        this.handleGavatar(conn, msg);
        break;
      case 'avatar':
        return this.handleAvatar(conn, msg);
      case 'group':
        return this.handleGroup(conn, msg);
      case 'profile':
        return this.handleProfile(conn, msg);
      case 'ping':
        return this.send(conn, { t: 'pong', ts: Date.now() });
      default:
        // PROTOCOL §14.4：未知类型静默忽略（保持连接，不回 error）
        return;
    }
  }

  /* ---------- 发送 / 关闭 ---------- */

  raw(conn, opcode, payload) {
    if (!conn || conn.closed || !conn.socket.writable) return;
    try {
      conn.socket.write(encodeFrame(opcode, payload || Buffer.alloc(0)));
    } catch (_) {}
  }

  send(conn, obj) {
    if (!conn || conn.closed || !conn.socket.writable) return;
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    try {
      conn.socket.write(encodeFrame(0x1, payload));
    } catch (_) {}
  }

  err(conn, code, msg) {
    this.send(conn, msg ? { t: 'error', code, msg } : { t: 'error', code });
  }

  fatal(conn, closeCode, errCode, msg) {
    this.err(conn, errCode, msg);
    this.closeConn(conn, closeCode, errCode);
  }

  closeConn(conn, code, reason) {
    if (!conn || conn.closed) return;
    const why = reason || '';
    const payload = Buffer.alloc(2 + Buffer.byteLength(why, 'utf8'));
    payload.writeUInt16BE(code, 0);
    if (why) payload.write(why, 2, 'utf8');
    try {
      if (conn.socket.writable) conn.socket.write(encodeFrame(0x8, payload));
    } catch (_) {}
    conn.closed = true;
    const s = conn.socket;
    setTimeout(() => {
      try {
        s.end();
      } catch (_) {}
      setTimeout(() => {
        try {
          s.destroy();
        } catch (_) {}
      }, 400);
    }, 80);
    this.drop(conn);
  }

  drop(conn) {
    if (!conn) return;
    conn.closed = true;
    this.openConns.delete(conn);
    if (conn.id && this.conns.get(conn.id) === conn) {
      this.conns.delete(conn.id);
      this.broadcastPeers();
    }
  }

  /* ---------- 房间 ---------- */

  peerList(exceptId) {
    const list = [];
    for (const [id, c] of this.conns) {
      if (!c.authed || c.closed || id === exceptId) continue;
      list.push({ id, name: c.name, avatar: this.avatars.get(id) || null });
    }
    return list;
  }

  broadcastPeers() {
    for (const [id, c] of this.conns) {
      if (!c.authed || c.closed) continue;
      this.send(c, { t: 'peers', peers: this.peerList(id) });
    }
  }

  handleHello(conn, msg) {
    const user = msg.user && typeof msg.user === 'object' ? msg.user : {};
    const id = typeof user.id === 'string' ? user.id : '';
    const name = typeof user.name === 'string' ? user.name.trim() : '';
    if (!ID_RE.test(id) || !isValidName(name)) {
      return this.fatal(conn, 1008, 'bad_user', 'id 需 32 位小写 hex，昵称 1-24 字符');
    }
    if (this.key !== null && this.key !== '') {
      const got = msg.key === undefined || msg.key === null ? '' : String(msg.key);
      if (got !== this.key) return this.fatal(conn, 1008, 'bad_key', '通行码错误');
    }

    const old = this.conns.get(id);
    conn.id = id;
    conn.name = name;
    conn.authed = true;
    this.conns.set(id, conn);
    if (old && old !== conn) this.closeConn(old, 4001, 'replaced');

    this.send(conn, {
      t: 'welcome',
      me: { id, name, avatar: this.avatars.get(id) || null },
      peers: this.peerList(id),
      server: { mode: 'relay', ver: VER, caps: this.caps, group: this.groupName, gavatar: this.gavatar },
    });
    const queue = this.pending.get(id);
    if (queue && queue.length) {
      this.pending.delete(id);
      this.send(conn, { t: 'pending', msgs: queue });
      log('pending -> ' + id.slice(0, 8) + ' x' + queue.length);
    }
    this.broadcastPeers();
    log('hello ' + id.slice(0, 8) + ' (' + name + ') from ' + conn.remote + '，在线 ' + this.conns.size);
  }

  knownDedupe(from, mid) {
    const k = from + '|' + mid;
    if (this.seen.has(k)) return true;
    this.seen.set(k, Date.now());
    if (this.seen.size > DEDUPE_MAX) {
      const first = this.seen.keys().next();
      if (!first.done) this.seen.delete(first.value);
    }
    return false;
  }

  handleSend(conn, msg) {
    const to = msg.to;
    if (to === 'all') {
      // ok
    } else if (typeof to === 'string' && ID_RE.test(to)) {
      if (to === conn.id) return this.err(conn, 'bad_to', '不能发给自己');
    } else {
      return this.err(conn, 'bad_to', 'to 需为 all 或 32 位小写 hex');
    }
    if (msg.kind !== 'text' && msg.kind !== 'image' && msg.kind !== 'video') return this.err(conn, 'bad_kind', 'kind 需为 text / image / video');
    // PROTOCOL v1.1 §4.1 / §8：mid 必填，缺失或格式非法 → bad_mid（保持连接、不发 ack、不自造 mid）
    if (typeof msg.mid !== 'string' || !MID_RE.test(msg.mid)) {
      return this.err(conn, 'bad_mid', 'mid 需为 1-64 位 [A-Za-z0-9_.:-]');
    }
    const mid = msg.mid;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const tsNow = Date.now();
    const frame = {
      t: 'msg',
      from: conn.id,
      fromName: conn.name,
      to,
      kind: msg.kind,
      text,
      mid,
      ts: tsNow,
    };
    // §14.3：图片/视频消息原样透传 meta（服务端不改写），其它 kind 忽略 meta
    if (msg.kind !== 'text' && msg.meta && typeof msg.meta === 'object' && !Array.isArray(msg.meta)) frame.meta = msg.meta;

    if (this.knownDedupe(conn.id, mid)) {
      // 重发（同一 mid）：只重发自身副本 + ack，不重复投递/入库
      this.send(conn, frame);
      this.send(conn, { t: 'ack', mid, ts: tsNow });
      return;
    }

    if (to === 'all') {
      for (const [cid, c] of this.conns) {
        if (cid === conn.id || !c.authed || c.closed) continue;
        this.send(c, frame);
      }
    } else {
      const dst = this.conns.get(to);
      // 写不进去（半死连接/背压）也当离线处理，重连后由 pending 补投，别直接把消息吞掉
      if (dst && dst.authed && !dst.closed && dst.socket.writable) this.send(dst, frame);
      else this.enqueue(to, frame);
    }
    this.send(conn, frame);
    this.send(conn, { t: 'ack', mid, ts: tsNow });
    this.record(frame);
  }

  enqueue(targetId, frame) {
    let q = this.pending.get(targetId);
    if (!q) {
      q = [];
      this.pending.set(targetId, q);
    }
    q.push(frame);
    while (q.length > MAX_PENDING) q.shift();
  }

  handleHistory(conn, msg) {
    const w = msg.with;
    const ok = w === 'all' || (typeof w === 'string' && ID_RE.test(w));
    if (!ok) return this.err(conn, 'bad_to', 'with 需为 all 或 32 位小写 hex');
    let limit = Number(msg.limit);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const me = conn.id;
    const rows =
      w === 'all'
        ? this.history.filter((m) => m.to === 'all')
        : this.history.filter((m) => (m.from === me && m.to === w) || (m.from === w && m.to === me));
    this.send(conn, { t: 'history', with: w, msgs: rows.slice(-limit) });
  }

  handleRead(conn, msg) {
    const w = msg.with;
    if (!(w === 'all' || (typeof w === 'string' && ID_RE.test(w)))) return; // v1 无应答
    let m = this.lastRead.get(conn.id);
    if (!m) {
      m = new Map();
      this.lastRead.set(conn.id, m);
    }
    m.set(w, Date.now());
  }

  /* ---------- 历史落盘 ---------- */

  record(frame) {
    this.history.push(frame);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    try {
      fs.appendFileSync(this.historyFile, JSON.stringify(frame) + '\n', 'utf8');
      this.appendCount += 1;
      if (this.appendCount % 200 === 0) {
        const st = fs.statSync(this.historyFile);
        if (st.size > HISTORY_MAX_BYTES) this.rewriteHistory();
      }
    } catch (e) {
      log('history append failed: ' + e.message);
    }
  }

  rewriteHistory() {
    try {
      const keep = this.history.slice(-HISTORY_KEEP);
      const tmp = this.historyFile + '.tmp';
      fs.writeFileSync(tmp, keep.map((m) => JSON.stringify(m) + '\n').join(''), 'utf8');
      fs.renameSync(tmp, this.historyFile);
      log('history 滚动重写，保留 ' + keep.length + ' 条');
    } catch (e) {
      log('history rewrite failed: ' + e.message);
    }
  }

  loadHistory() {
    try {
      if (!fs.existsSync(this.historyFile)) return;
      const st = fs.statSync(this.historyFile);
      const rows = [];
      for (const line of fs.readFileSync(this.historyFile, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m && m.t === 'msg') rows.push(m);
        } catch (_) {}
      }
      this.history = rows.slice(-MAX_HISTORY);
      if (st.size > HISTORY_MAX_BYTES) this.rewriteHistory();
      log('历史载入 ' + this.history.length + ' 条（' + st.size + ' B）');
    } catch (e) {
      log('history load failed: ' + e.message);
    }
  }

  /* ---------- 心跳 / 超时 ---------- */

  sweep() {
    const now = Date.now();
    for (const conn of [...this.openConns]) {
      if (conn.closed) continue;
      if (!conn.authed && now - conn.helloAt > HELLO_TIMEOUT_MS) {
        this.fatal(conn, 1008, 'hello_timeout', '入场超时');
        continue;
      }
      if (now - conn.lastSeen > IDLE_TIMEOUT_MS) {
        this.closeConn(conn, 1001, 'idle');
        continue;
      }
      if (now - conn.lastSeen > PING_IDLE_MS && now - conn.lastPing > PING_IDLE_MS) {
        conn.lastPing = now;
        this.raw(conn, 0x9, Buffer.from(String(now), 'utf8'));
      }
    }
  }
}

export function createRelay(opts) {
  return new Relay(opts);
}

function readConfigFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(txt);
  } catch (e) {
    log('config.json 读取失败: ' + e.message);
    return {};
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data') out.dataDir = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfgPath = args.config || path.join(HERE, 'config.json');
  const cfg = readConfigFile(cfgPath);
  const opts = {
    port: args.port !== undefined ? args.port : cfg.port !== undefined ? cfg.port : 21001,
    host: args.host || cfg.host || '0.0.0.0',
    key: args.key !== undefined ? args.key : cfg.key === undefined ? null : cfg.key,
    publicHost: cfg.publicHost || '',
    dataDir: args.dataDir || (cfg.dataDir ? path.resolve(HERE, cfg.dataDir) : path.join(HERE, 'data')),
  };
  const relay = createRelay(opts);
  relay
    .start()
    .then(({ port, host }) => {
      log('PrivChat 中继已运行 0.0.0.0:' + port + '  ws://' + (opts.publicHost || host) + ':' + port + '/ws');
      log('key 校验：' + (opts.key ? '开启' : '关闭') + '；数据目录 ' + opts.dataDir);
    })
    .catch((e) => {
      log('启动失败: ' + (e && e.stack ? e.stack : e));
      process.exit(1);
    });
  const bye = () => {
    relay.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('uncaughtException', (e) => {
    log('uncaught: ' + (e && e.stack ? e.stack : e));
  });
  process.on('unhandledRejection', (e) => {
    log('unhandledRejection: ' + (e && e.stack ? e.stack : e));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();