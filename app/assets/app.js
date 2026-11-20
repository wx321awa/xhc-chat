/* =============================================================
 * 私人聊天 · 前端逻辑（纯 ES5，零依赖，离线可用）
 * 通信严格实现 docs/PROTOCOL.md v1：
 *   hello → welcome / peers / send → msg + ack / history / pending
 *   read（无应答）/ ping → pong / error
 * ============================================================= */
(function () {
  'use strict';

  /* ------------------------------ 常量 ------------------------------ */
  var CFG = (window.PRIVCHAT_DEFAULT && typeof window.PRIVCHAT_DEFAULT === 'object')
    ? window.PRIVCHAT_DEFAULT : {};
  var FALLBACK_ENDPOINT = 'ws://127.0.0.1:21001/ws';
  var DEFAULT_ENDPOINT = typeof CFG.endpoint === 'string' && CFG.endpoint
    ? CFG.endpoint : FALLBACK_ENDPOINT;
  var LOCAL_ENDPOINT = typeof CFG.localEndpoint === 'string' && CFG.localEndpoint
    ? CFG.localEndpoint : 'ws://127.0.0.1:21001/ws';
  var DEFAULT_KEY = typeof CFG.key === 'string' ? CFG.key : '';

  var HEARTBEAT_MS = 20000;    // 每 20s 发一次 ping
  var PONG_TIMEOUT_MS = 45000; // 45s 无 pong 主动断开（连续 2 次心跳无回应）
  var HELLO_TIMEOUT_MS = 10000;
  var ACK_TIMEOUT_MS = 15000;
  var BACKOFF = [1, 2, 4, 8, 15]; // 秒，封顶 15s
  var MAX_MSGS = 500;           // 每个会话本地最多留 500 条
  var MAX_TEXT = 4000;
  var GROUP_ID = 'all';
  var GROUP_DEFAULT = '群聊（全部）';

  /* v1.2（协议 §14）：能力声明 / 头像 / 图片视频 */
  var CAPS_HINT = '服务端不支持（部署新版中继即可）';
  var AVATAR_LIMIT = 48000;        // 服务端限制：整串 data URL ≤ 48000
  var AVATAR_SIZES = [128, 96, 72]; // 超限时逐级缩小
  var AVATAR_QUALITY = 0.82;
  var IMAGE_MAX_EDGE = 1600;       // 图片最长边
  var IMAGE_QUALITY = 0.85;
  var THUMB_MAX_EDGE = 320;        // 视频首帧缩略图最长边
  var THUMB_QUALITY = 0.7;
  var THUMB_MAX_CHARS = 8000;      // 协议：thumb ≤ 8000 字符
  var MAX_UPLOAD_IMAGE = 4 * 1024 * 1024;
  var MAX_UPLOAD_VIDEO = 16 * 1024 * 1024;

  var LS = {
    id: 'privchat.id',
    name: 'privchat.name',
    endpoint: 'privchat.endpoint',
    key: 'privchat.key',
    host: 'privchat.hostMode',
    remote: 'privchat.remoteEndpoint',
    remoteKey: 'privchat.remoteKey',
    avatar: 'privchat.avatar',   // 只缓存自己的头像（≤48KB），不存聊天正文
    notify: 'privchat.notify',   // 后台提醒开关（'1'/'0'），只是个用户偏好，不含聊天数据
    hist: 'privchat.hist.'
  };

  /**
   * 历史归属策略：默认「正文只存服务端」。
   *  - HIST_LOCAL=false：localStorage 只留会话索引（对方 id / 昵称 / 最后时间），
   *    消息正文一律不写手机；每次连上/打开会话都向服务端拉 history。
   *  - 旧版本把正文写在 privchat.hist.* 里，boot 时会清掉。
   */
  var HIST_LOCAL = CFG.localHistory === true;
  var INDEX_KEY = 'privchat.index.v1';

  /**
   * 当前连接是否把正文留在手机。
   * 公网中继模式（默认）→ false：正文只在服务端；
   * 「本机当主机」或连 127.0.0.1/localhost → true：本机 Hub 不持久化，只能靠手机留底。
   */
  function localHistOn() {
    if (HIST_LOCAL) return true;
    if (state.hostMode) return true;
    return /^ws:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(state.endpoint || '');
  }

  var PALETTE = ['#5b8def', '#f2994a', '#eb5757', '#9b51e0',
    '#2d9cdb', '#27ae60', '#e0a800', '#56ccf2', '#c774e8', '#7f8c8d'];

  var USE_MOCK = /(?:^|[?&])mock=1(?:&|$)/.test(location.search) ||
    location.hash === '#mock';

  /* ------------------------------ 小工具 ------------------------------ */
  function $(id) { return document.getElementById(id); }
  function nowMs() { return Date.now(); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function store(key, val) {
    try {
      if (val === null || val === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(val));
    } catch (e) { /* 隐私模式忽略 */ }
  }
  function load(key) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? null : v;
    } catch (e) { return null; }
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 2400);
  }

  function randHex(n) {
    var out = '';
    var i;
    var bytes;
    try {
      bytes = new Uint8Array(n);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      for (i = 0; i < n; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    } catch (e) {
      for (i = 0; i < n; i++) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
    }
    return out;
  }

  /** 32 位 hex 身份，保存在 localStorage，重连复用同一个 id（协议要求） */
  function ensureMyId() {
    var id = load(LS.id);
    if (!id || !/^[0-9a-f]{32}$/.test(id)) {
      id = randHex(16);
      store(LS.id, id);
    }
    return id;
  }

  /** 按 Unicode 码点截断到 24 个字符（协议：昵称 1–24 个码点） */
  function clampName(s) {
    s = String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim();
    if (!s) return '';
    var out = '';
    var n = 0;
    var i = 0;
    while (i < s.length && n < 24) {
      var ch = s.charAt(i);
      if (s.codePointAt) {
        var cp = s.codePointAt(i);
        if (cp > 0xffff) ch = String.fromCodePoint(cp);
      }
      out += ch;
      i += ch.length;
      n++;
    }
    return out;
  }

  /** 取昵称第一个字符（emoji 也按整个码点取），用作头像文字 */
  function firstChar(s) {
    var t = String(s || '').replace(/\s+/g, '');
    if (!t) return '';
    if (t.codePointAt) {
      var cp = t.codePointAt(0);
      if (cp > 0xffff) return String.fromCodePoint(cp);
    }
    return t.charAt(0);
  }

  function avatarChar(name, fallback) {
    var ch = firstChar(name);
    return ch || fallback || '?';
  }

  function colorFor(seed) {
    var s = String(seed || '');
    var h = 0;
    var i;
    for (i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
    return PALETTE[h % PALETTE.length];
  }

  function shortId(id) {
    if (!id) return '';
    return id.length > 10 ? id.slice(0, 6) + '…' + id.slice(-2) : id;
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  /** 会话列表右侧时间 */
  function fmtListTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    if (isSameDay(d, now)) return fmtClock(ts);
    var yest = new Date(now.getTime() - 86400000);
    if (isSameDay(d, yest)) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  /** 聊天页中间的时间分隔 */
  function fmtSep(ts) {
    var d = new Date(ts);
    var now = new Date();
    if (isSameDay(d, now)) return fmtClock(ts);
    var yest = new Date(now.getTime() - 86400000);
    if (isSameDay(d, yest)) return '昨天 ' + fmtClock(ts);
    if (d.getFullYear() === now.getFullYear()) {
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + fmtClock(ts);
    }
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + fmtClock(ts);
  }

  function normalizeEndpoint(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    if (!/^wss?:\/\//i.test(s)) s = 'ws://' + s;
    var rest = s.replace(/^wss?:\/\//i, '');
    if (rest.indexOf('/') < 0) s += '/ws';
    return s;
  }

  /* ------------------------------ 状态 ------------------------------ */
  var state = {
    view: 'list',
    activeConv: GROUP_ID,
    conn: 'idle',          // idle | connecting | connected | reconnecting | error
    dead: false,           // 被顶替 / 通行码错 / 身份错：不再自动重连
    manualClose: false,
    me: { id: ensureMyId(), name: '', avatar: '' },
    server: { mode: '', ver: '', group: '', caps: null },
    /* v1.2：能力位（缺省全 false → 入口灰掉并提示）；群名；对端头像只在内存里 */
    caps: { avatar: false, group: false, media: false },
    groupName: GROUP_DEFAULT,
    groupAvatar: null,
    bgPaused: false,
    avatars: {},
    uploading: 0,
    name: '',
    endpoint: DEFAULT_ENDPOINT,
    key: DEFAULT_KEY,
    hostMode: false,
    convs: {},
    ws: null,
    mock: USE_MOCK,
    retryIdx: 0,
    retryTimer: 0,
    helloTimer: 0,
    pingTimer: 0,
    lastPong: 0,
    seq: 0
  };

  function convList() {
    var out = [];
    var k;
    for (k in state.convs) {
      if (Object.prototype.hasOwnProperty.call(state.convs, k)) out.push(state.convs[k]);
    }
    return out;
  }

  function histKey(id) { return LS.hist + id; }

  function newConv(id, name) {
    return {
      id: id,
      name: name || (id === GROUP_ID ? '群聊（全部）' : shortId(id)),
      online: false,
      unread: 0,
      lastReadTs: 0,
      lastTs: 0,
      msgs: []
    };
  }

  function loadHist(c) {
    if (!localHistOn()) return;       // 正文只在服务端：手机不读本地副本
    var raw = load(histKey(c.id));
    if (!raw) return;
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { return; }
    if (!arr || !arr.length) return;
    var i;
    for (i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || !m.mid) continue;
      c.msgs.push({
        from: m.from || '',
        fromName: m.fromName || '',
        to: m.to || '',
        kind: m.kind === 'image' ? 'image' : 'text',
        text: String(m.text == null ? '' : m.text),
        mid: String(m.mid),
        ts: Number(m.ts) || 0,
        state: 'sent'
      });
    }
    c.msgs.sort(function (a, b) { return a.ts - b.ts; });
    if (c.msgs.length > MAX_MSGS) c.msgs = c.msgs.slice(-MAX_MSGS);
    c.lastTs = c.msgs.length ? c.msgs[c.msgs.length - 1].ts : 0;
  }

  function saveHist(c) {
    if (!localHistOn()) { saveIndex(); return; }   // 只写索引，不写正文
    var out = [];
    var start = Math.max(0, c.msgs.length - MAX_MSGS);
    var i;
    for (i = start; i < c.msgs.length; i++) {
      var m = c.msgs[i];
      out.push({
        from: m.from, fromName: m.fromName, to: m.to,
        kind: m.kind, text: m.text, mid: m.mid, ts: m.ts
      });
    }
    store(histKey(c.id), JSON.stringify(out));
  }

  /* ------------------ 服务端模式：只存会话索引（无正文） ------------------ */
  function saveIndex() {
    if (HIST_LOCAL) return;
    var db = {};
    var list = convList();
    var i;
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c.msgs.length && !c.lastTs && !c.name) continue;
      if (!c.lastTs && !c.lastReadTs) continue;
      db[c.id] = { name: c.name || '', ts: c.lastTs || 0, read: c.lastReadTs || 0 };
    }
    store(INDEX_KEY, JSON.stringify(db));
  }

  function loadIndex() {
    var raw = load(INDEX_KEY);
    if (!raw) return;
    var db;
    try { db = JSON.parse(raw); } catch (e) { return; }
    if (!db) return;
    var k;
    for (k in db) {
      if (!Object.prototype.hasOwnProperty.call(db, k)) continue;
      if (!k) continue;
      var c = ensureConv(k, (db[k] && db[k].name) || '');
      if (c && db[k] && db[k].ts) c.lastTs = Number(db[k].ts) || 0;
      if (c && db[k] && db[k].read) c.lastReadTs = Number(db[k].read) || 0;
    }
  }

  /** 清掉旧版本留在手机的正文副本（升级后第一次启动执行） */
  function purgeLocalMsgHist() {
    try {
      var keys = [];
      var i;
      for (i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(LS.hist) === 0) keys.push(k);
      }
      for (i = 0; i < keys.length; i++) localStorage.removeItem(keys[i]);
    } catch (e) {}
  }

  function ensureConv(id, name) {
    if (!id) return null;
    var c = state.convs[id];
    if (!c) {
      c = newConv(id, name);
      state.convs[id] = c;
      loadHist(c);
      // 正文只在服务端：新出现的会话立刻向服务端要历史
      if (!localHistOn() && id !== GROUP_ID && state.conn === 'connected') {
        sendFrame({ t: 'history', with: id, limit: HISTORY_LIMIT });
      }
    } else if (name && c.name !== name && id !== GROUP_ID) {
      c.name = name;
    }
    return c;
  }

  /* ------------------------------ 消息仓库 ------------------------------ */
  function findMsg(c, from, mid) {
    var i;
    for (i = c.msgs.length - 1; i >= 0; i--) {
      if (c.msgs[i].mid === mid && c.msgs[i].from === from) return c.msgs[i];
    }
    return null;
  }

  /**
   * 收/发消息落库。返回该消息对象（重复则返回已存在的对象）。
   * opts.mine = 我发的；opts.state = sending|sent|failed
   */
  function putMsg(convId, msg, opts) {
    var c = ensureConv(convId);
    if (!c) return null;
    opts = opts || {};
    var old = findMsg(c, msg.from, msg.mid);
    if (old) {
      if (msg.ts && msg.ts !== old.ts) old.ts = msg.ts;
      if (opts.state) old.state = opts.state;
      if (!old.fromName && msg.fromName) old.fromName = msg.fromName;
      c.msgs.sort(function (a, b) { return a.ts - b.ts; });
      saveHist(c);
      return old;
    }
    var item = {
      from: msg.from,
      fromName: msg.fromName || '',
      to: msg.to || '',
      kind: (msg.kind === 'image' || msg.kind === 'video') ? msg.kind : 'text',
      text: String(msg.text == null ? '' : msg.text),
      meta: msg.meta && typeof msg.meta === 'object' ? msg.meta : null,
      mid: String(msg.mid || ''),
      ts: Number(msg.ts) || nowMs(),
      state: opts.state || 'sent'
    };
    c.msgs.push(item);
    if (c.msgs.length > MAX_MSGS) c.msgs = c.msgs.slice(-MAX_MSGS);
    c.msgs.sort(function (a, b) { return a.ts - b.ts; });
    if (item.ts > c.lastTs) c.lastTs = item.ts;
    saveHist(c);

    var isOwn = item.from === state.me.id;
    var isOpen = state.view === 'chat' && state.activeConv === convId;
    if (isOpen || isOwn) {
      // 正在看这条会话（或自己发的）：已读时间直接推进，避免下次拉历史又变未读
      if (item.ts > c.lastReadTs) { c.lastReadTs = item.ts; saveIndex(); }
    } else if (!opts.replay && item.ts > (c.lastReadTs || 0)) {
      c.unread++;
      renderList();
    }
    touchConversation(convId);
    return item;
  }

  function touchConversation(convId) {
    if (state.view === 'chat' && state.activeConv === convId) renderChat(true);
    else renderList();
  }

  /* ------------------------------ 连接状态 UI ------------------------------ */
  function setConn(kind) {
    state.conn = kind;
    updateUI();
  }

  function connLabel() {
    switch (state.conn) {
      case 'connected': return '已连接';
      case 'connecting': return '连接中…';
      case 'reconnecting': return '重连中…';
      case 'error': return '未连接';
      default: return '未连接';
    }
  }

  function connClass() {
    switch (state.conn) {
      case 'connected': return 'status-pill is-online';
      case 'connecting':
      case 'reconnecting': return 'status-pill is-wait';
      case 'error': return 'status-pill is-error';
      default: return 'status-pill';
    }
  }

  function updateUI() {
    var pills = [$('status-pill'), $('status-pill-2')];
    var i;
    for (i = 0; i < pills.length; i++) {
      if (!pills[i]) continue;
      pills[i].className = connClass();
    }
    var texts = [$('status-text'), $('status-text-2')];
    for (i = 0; i < texts.length; i++) {
      if (texts[i]) texts[i].textContent = connLabel();
    }

    var on = state.conn === 'connected';
    var busy = state.conn === 'connecting' || state.conn === 'reconnecting';
    var input = $('composer-input');
    var send = $('btn-send');
    if (input) {
      input.disabled = !on;
      input.placeholder = on ? '说点什么…' : '未连接，无法发送';
    }
    if (send) send.disabled = !on;

    var banner = $('offline-banner');
    if (banner) {
      banner.hidden = on;
      banner.textContent = busy
        ? '当前未连接，消息发不出去 · 正在自动重连…'
        : '当前未连接，请到设置里连上服务器';
    }

    var bc = $('btn-connect');
    var bd = $('btn-disconnect');
    if (bc) {
      bc.textContent = on ? '重新连接' : '连接';
      bc.disabled = busy;
    }
    if (bd) bd.hidden = !(on || busy);

    var myId = $('my-id');
    if (myId) myId.textContent = state.me.id || '—';
    var chatSub = $('chat-sub');
    if (chatSub) chatSub.textContent = chatSubtitle();
    var np = $('peer-endpoint');
    if (np) np.textContent = peerEndpointHint();

    // 列表标题：连上后显示「在线 N 人」（N = 在线对端数，不含自己）
    var title = $('list-title');
    if (title) title.textContent = on ? '在线 ' + onlinePeers() + ' 人' : '私人聊天';

    // 未连接时露出「连接」入口条
    var cta = $('connect-cta');
    if (cta) cta.hidden = on;

    // 底部 tab：聊天页隐藏；「我」页高亮第二个
    var tb = $('tabbar');
    if (tb) tb.hidden = (state.view === 'chat');
    var t1 = $('tab-list');
    var t2 = $('tab-me');
    if (t1) t1.className = 'tab' + (state.view === 'me' ? '' : ' active');
    if (t2) t2.className = 'tab' + (state.view === 'me' ? ' active' : '');

    // 「我」页 profile 卡
    var lbl = $('me-name-label');
    if (lbl) lbl.textContent = state.me.name || '未设置昵称';
    var av = $('me-avatar');
    if (av) paintAvatar(av, state.me.id, state.me.name || '', '我');
    avatarHintText();

    renderList();
  }

  /* 在线对端数（不含自己、不含群聊） */
  function onlinePeers() {
    var n = 0;
    var k;
    for (k in state.convs) {
      if (Object.prototype.hasOwnProperty.call(state.convs, k) && k !== GROUP_ID && state.convs[k].online) n++;
    }
    return n;
  }

  function chatSubtitle() {
    if (state.activeConv === GROUP_ID) {
      var n = 0;
      var k;
      for (k in state.convs) {
        if (Object.prototype.hasOwnProperty.call(state.convs, k) && k !== GROUP_ID && state.convs[k].online) n++;
      }
      return n > 0 ? '群聊 · 在线 ' + n + ' 人' : '群聊 · 全部人';
    }
    var c = state.convs[state.activeConv];
    if (!c) return '';
    return (c.online ? '在线' : '离线') + ' · ' + shortId(c.id);
  }

  function peerEndpointHint() {
    var host = location.hostname;
    var ip = (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '') ? host : '<你的IP>';
    return 'ws://' + ip + ':21001/ws';
  }

  /* ------------------------------ WebSocket ------------------------------ */
  function sendFrame(obj) {
    var s = state.ws;
    if (!s || s.readyState !== 1) return false;
    try {
      s.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearTimers() {
    if (state.helloTimer) { clearTimeout(state.helloTimer); state.helloTimer = 0; }
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = 0; }
  }

  function clearReconnect() {
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = 0; }
  }

  function hardClose() {
    var s = state.ws;
    state.ws = null;
    if (s) {
      try { s.onopen = s.onmessage = s.onclose = s.onerror = null; } catch (e) {}
      try { s.close(1000, 'bye'); } catch (e2) {}
    }
  }

  function connect() {
    if (state.conn === 'connected' || state.conn === 'connecting') return;
    clearReconnect();
    clearTimers();
    state.dead = false;
    state.manualClose = false;

    var url = normalizeEndpoint(state.endpoint);
    if (!url) { toast('服务器地址不能为空'); return; }
    state.endpoint = url;
    if (!state.hostMode) store(LS.endpoint, url);
    var epInput = $('inp-endpoint');
    if (epInput) epInput.value = url;

    var wantName = clampName(state.name);
    if (wantName && wantName !== state.me.name) {
      state.me.name = wantName;
      state.name = wantName;
      store(LS.name, wantName);
    }
    if (!state.me.name) {
      state.me.name = '我' + randHex(1).toUpperCase();
      state.name = state.me.name;
      store(LS.name, state.name);
    }
    var nameInput = $('inp-name');
    if (nameInput) nameInput.value = state.me.name;

    // 协议 v1.1：hello.key 必填，缺失直接不发 hello（服务端会 not_hello / bad_key 踢掉）
    var helloKey = state.key || DEFAULT_KEY;
    if (!helloKey) {
      setConn('error');
      showConnError('bad_key', 'hello.key 必填：请在「我」页填写通行码后重试');
      toast('请先填通行码（见「我」页）');
      return;
    }
    state.key = helloKey;

    setConn('connecting');

    var sock;
    try {
      sock = state.mock ? new MockSocket(url) : new WebSocket(url);
    } catch (e) {
      setConn('error');
      toast('地址格式不对：' + url);
      return;
    }
    state.ws = sock;

    sock.onopen = function () {
      if (state.ws !== sock) return;
      state.lastPong = nowMs();
      // v1.1：本机 Hub 与公网中继用同一份 key，所以这里恒定发 state.key
      var helloKey = state.key || DEFAULT_KEY;
      sendFrame({
        t: 'hello',
        key: helloKey,
        user: { id: state.me.id, name: state.me.name }
      });
      showConnError(null);
      state.helloTimer = setTimeout(function () {
        if (state.ws === sock && state.conn !== 'connected') {
          toast('服务器没有回应 welcome，重试中…');
          try { sock.close(4000, 'hello timeout'); } catch (e) {}
        }
      }, HELLO_TIMEOUT_MS);
    };

    sock.onmessage = function (ev) {
      if (state.ws !== sock) return;
      var frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      if (!frame || typeof frame !== 'object') return;
      onFrame(frame);
    };

    sock.onerror = function () { /* onclose 里统一处理 */ };

    sock.onclose = function (ev) {
      if (state.ws !== sock) return;
      state.ws = null;
      clearTimers();
      var code = ev && ev.code;

      if (state.manualClose) {
        setConn('idle');
        return;
      }
      if (code === 4001) {
        state.dead = true;
        setConn('error');
        toast('连接被顶替：这个身份已经在别处上线了');
        return;
      }
      if (code === 4002) {
        state.dead = true;
        setConn('error');
        toast('服务器拒绝了这个连接（4002）');
        return;
      }
      if (state.dead) {
        setConn('error');
        return;
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (state.bgPaused) return;
    if (state.manualClose || state.dead) return;
    var idx = Math.min(state.retryIdx, BACKOFF.length - 1);
    var delay = BACKOFF[idx];
    state.retryIdx++;
    setConn('reconnecting');
    clearReconnect();
    state.retryTimer = setTimeout(function () {
      state.retryTimer = 0;
      if (state.manualClose || state.dead) return;
      state.conn = 'idle'; // 允许 connect() 继续
      connect();
    }, delay * 1000);
  }

  function disconnect() {
    state.manualClose = true;
    state.dead = false;
    clearReconnect();
    clearTimers();
    var s = state.ws;
    state.ws = null;
    if (s) {
      try { s.onclose = null; } catch (e) {}
      try { s.close(1000, 'bye'); } catch (e2) {}
    }
    state.retryIdx = 0;
    setConn('idle');
  }

  /* ------------------------------ 协议处理 ------------------------------ */
  function onFrame(f) {
    switch (f.t) {
      case 'welcome': onWelcome(f); break;
      case 'peers': onPeers(f.peers || []); break;
      case 'msg': onMsg(f); break;
      case 'ack': onAck(f); break;
      case 'history': onHistory(f); break;
      case 'pending': onPending(f); break;
      case 'pong': state.lastPong = nowMs(); break;
      case 'peer-info': onPeerInfo(f); break;
      case 'group': onGroup(f); break;
      case 'gavatar': onGavatar(f); break;
      case 'error': onError(f); break;
      default: break; // 未知类型忽略，保持前向兼容
    }
  }

  function onWelcome(f) {
    clearTimers();
    state.retryIdx = 0;
    state.dead = false;
    if (f.me && f.me.id) state.me.id = String(f.me.id);
    if (f.me && f.me.name) {
      state.me.name = clampName(f.me.name) || state.me.name;
      store(LS.name, state.me.name);
      var nameInput = $('inp-name');
      if (nameInput) nameInput.value = state.me.name;
    }
    if (f.server) {
      state.server = { mode: f.server.mode || '', ver: String(f.server.ver || ''), group: String(f.server.group || '') };
      if (f.server.group) state.groupName = clampGroupName(f.server.group) || GROUP_DEFAULT;
      state.groupAvatar = (typeof f.server.gavatar === 'string' && f.server.gavatar) ? f.server.gavatar : null;
      if (state.groupAvatar) state.avatars[GROUP_ID] = state.groupAvatar;
      else delete state.avatars[GROUP_ID];
      var gav = $('px-group-avatar');
      if (gav) gav.hidden = !(f.server.caps && f.server.caps.indexOf && f.server.caps.indexOf('gavatar') >= 0);
      var caps = f.server.caps;
      state.caps = {
        avatar: !!(caps && caps.indexOf && caps.indexOf('avatar') >= 0),
        group: !!(caps && caps.indexOf && caps.indexOf('group') >= 0),
        media: !!(caps && caps.indexOf && caps.indexOf('media') >= 0),
        gavatar: !!(caps && caps.indexOf && caps.indexOf('gavatar') >= 0)
      };
    }
    if (f.me && typeof f.me.avatar === 'string' && f.me.avatar) {
      // 服务器有记录就以服务器为准（换手机/清缓存也能拿回头像）
      state.me.avatar = f.me.avatar;
      store(LS.avatar, f.me.avatar);
    }
    if (state.me.avatar) {
      state.avatars[state.me.id] = state.me.avatar;
      // 重连后把头像再推一次：服务器重启、清了 avatars.json 也能自愈
      sendFrame({ t: 'avatar', data: state.me.avatar });
    }
    setConn('connected');
    showConnError(null);
    startHeartbeat();
    onPeers(f.peers || []);
    requestAllHistory();
    // 连上就回到会话列表（微信式：连上直接看消息）
    if (state.view === 'me') showScreen('list');
    updateUI();
    pushNativeConfig();
    toast('已连接');
  }

  function onPeers(peers) {
    var i;
    for (i = 0; i < peers.length; i++) {
      var p = peers[i];
      if (!p || !p.id || p.id === state.me.id) continue;
      var c = ensureConv(p.id, clampName(p.name) || shortId(p.id));
      c.online = true;
      if (typeof p.avatar === 'string' && p.avatar) state.avatars[p.id] = p.avatar;
      else if (p.avatar === null || p.avatar === undefined) delete state.avatars[p.id];
    }
    var all = convList();
    for (i = 0; i < all.length; i++) {
      if (all[i].id === GROUP_ID) continue;
      var found = false;
      var j;
      for (j = 0; j < peers.length; j++) {
        if (peers[j] && peers[j].id === all[i].id) { found = true; break; }
      }
      all[i].online = found;
    }
    updateUI();  // 标题「在线 N 人」+ 群聊副标题都在这里重绘
    if (state.view === 'chat') renderChat(false);
  }

  /** 把一条服务端规范化的 msg 放进正确的会话 */
  function routeConvId(m) {
    if (m.to === GROUP_ID) return GROUP_ID;
    if (m.to === state.me.id) return m.from;
    if (m.from === state.me.id) return m.to; // 自己发的定向消息
    return null; // 别人的定向消息：与我无关，忽略
  }

  function onMsg(f) {
    var cid = routeConvId(f);
    if (!cid) return;
    var item = putMsg(cid, f, { state: 'sent' });
    if (!item) return;
    // 我自己的消息（服务端回了一份）→ 真正的“已发送”状态
    if (f.from === state.me.id) {
      item.state = 'sent';
      clearAckTimer(f.mid);
    }
    touchConversation(cid);
  }

  function onAck(f) {
    if (!f || !f.mid) return;
    var list = convList();
    var i;
    for (i = 0; i < list.length; i++) {
      var m = findMsg(list[i], state.me.id, String(f.mid));
      if (m) {
        m.state = 'sent';
        if (f.ts) { m.ts = Number(f.ts) || m.ts; }
        saveHist(list[i]);
        if (state.view === 'chat' && state.activeConv === list[i].id) renderChat(false);
        else renderList();
        break;
      }
    }
    clearAckTimer(f.mid);
  }

  /** 按「已读时间」重算未读数（历史/离线补发之后调用，避免每次进 App 全部变红点） */
  function recountUnread(c) {
    if (!c) return;
    var i, n = 0;
    for (i = 0; i < c.msgs.length; i++) {
      var m = c.msgs[i];
      if (m.from !== state.me.id && m.ts > (c.lastReadTs || 0)) n++;
    }
    c.unread = n;
    saveIndex();
  }

  function onHistory(f) {
    var withId = f.with === GROUP_ID ? GROUP_ID : String(f.with || '');
    if (!withId) return;
    var c = ensureConv(withId);
    var msgs = f.msgs || [];
    var i;
    for (i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || !m.mid) continue;
      putMsg(withId, m, { state: 'sent', replay: true });
    }
    if (c) { saveHist(c); recountUnread(c); }
    if (state.view === 'chat') renderChat(true);
    else renderList();
  }

  function onPending(f) {
    var msgs = f.msgs || [];
    var i;
    for (i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || !m.mid) continue;
      var cid = routeConvId(m);
      if (!cid) continue;
      putMsg(cid, m, { state: 'sent', replay: true });
    }
    var j;
    for (j = 0; j < msgs.length; j++) {
      var pc = state.convs[routeConvId(msgs[j])];
      if (pc) recountUnread(pc);
    }
    if (msgs.length) {
      toast('收到 ' + msgs.length + ' 条离线消息');
      if (state.view !== 'chat') renderList();
    }
  }

  /* 在「我」页显示服务端拒绝的 error.code 与原因（code=null 时清掉） */
  function showConnError(code, reason) {
    var el = $('conn-error');
    if (!el) return;
    if (!code) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = '';
    var b = document.createElement('b');
    b.textContent = '服务端拒绝：';
    el.appendChild(b);
    var c = document.createElement('span');
    c.className = 'err-code';
    c.textContent = code;
    el.appendChild(c);
    if (reason) {
      var r = document.createElement('span');
      r.textContent = ' · ' + reason;
      el.appendChild(r);
    }
  }

  var ERR_TIPS = {
    bad_key: '通行码不对（hello.key 与服务端不一致）',
    bad_user: '身份不合规：user.id 必须是 32 位小写 hex，昵称 1–24 字符',
    not_hello: '必须先发 hello 帧',
    hello_timeout: '连上后 10s 内没发 hello，被服务端断开',
    bad_json: '发出的帧不是合法 JSON',
    bad_frame: '帧结构不对',
    too_large: '这一帧太大了（服务端有上限）',
    bad_to: '接收方 id 不合法（必须 32 位 hex 或 "all"）',
    bad_kind: 'kind 只能是 text / image',
    bad_mid: 'mid 缺失或不合法（1–64 位 [A-Za-z0-9_.:-]）',
    no_peer: '对方不在线，这条消息没有投递',
    rate_limited: '发得太快了，缓一下再发',
    internal: '服务端内部错误'
  };

  function onError(f) {
    var code = String(f.code || 'unknown');
    var msg = String(f.msg || '');
    var fatal = (code === 'bad_key' || code === 'bad_user' || code === 'not_hello');
    var tip = ERR_TIPS[code] || msg || '未知错误';
    if (fatal) {
      state.dead = true;
      state.manualClose = true;
      setConn('error');
      showConnError(code, tip);
      toast(code + ' · ' + tip);
      return;
    }
    toast(code + ' · ' + tip);
  }

  function startHeartbeat() {
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.lastPong = nowMs();
    state.pingTimer = setInterval(function () {
      if (state.conn !== 'connected') return;
      if (nowMs() - state.lastPong > PONG_TIMEOUT_MS) {
        toast('心跳超时，正在重连…');
        var s = state.ws;
        state.ws = null;
        if (s) { try { s.close(4000, 'ping timeout'); } catch (e) {} }
        scheduleReconnect();
        return;
      }
      sendFrame({ t: 'ping' });
    }, HEARTBEAT_MS);
  }

  var HISTORY_LIMIT = (typeof CFG.historyLimit === 'number' && CFG.historyLimit > 0)
    ? Math.min(100, Math.floor(CFG.historyLimit)) : 50;

  function requestAllHistory() {
    sendFrame({ t: 'history', with: GROUP_ID, limit: HISTORY_LIMIT });
    var list = convList();
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].id === GROUP_ID) continue;
      sendFrame({ t: 'history', with: list[i].id, limit: HISTORY_LIMIT });
    }
  }

  /* ------------------------------ 发送 ------------------------------ */
  /* v1.1：mid 必填，服务端不自造；必须匹配 ^[A-Za-z0-9_.:-]{1,64}$
   * 形如 1a2b3c4d-1-x8k2m9qp，重发同一条消息必须复用同一个 mid */
  function nextMid() {
    state.seq++;
    var mid = nowMs().toString(36) + '-' + state.seq.toString(36) + '-' +
      Math.random().toString(36).slice(2, 10);
    return mid.slice(0, 64);
  }

  function ackTimers() {
    if (!ackTimers.map) ackTimers.map = {};
    return ackTimers.map;
  }

  function armAckTimer(mid, convId) {
    var map = ackTimers();
    if (map[mid]) clearTimeout(map[mid]);
    map[mid] = setTimeout(function () {
      delete map[mid];
      var c = state.convs[convId];
      if (!c) return;
      var m = findMsg(c, state.me.id, mid);
      if (!m || m.state !== 'sending') return;
      m.state = 'failed';
      saveHist(c);
      if (state.view === 'chat' && state.activeConv === convId) renderChat(false);
    }, ACK_TIMEOUT_MS);
  }

  function clearAckTimer(mid) {
    var map = ackTimers();
    if (map[mid]) { clearTimeout(map[mid]); delete map[mid]; }
  }

  function sendText() {
    var input = $('composer-input');
    if (!input) return;
    var text = String(input.value || '');
    if (!text.trim()) return;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    if (state.conn !== 'connected') { toast('还没连上服务器'); return; }

    var convId = state.activeConv || GROUP_ID;
    var to = convId === GROUP_ID ? GROUP_ID : convId;
    var mid = nextMid();
    var msg = {
      from: state.me.id,
      fromName: state.me.name,
      to: to,
      kind: 'text',
      text: text,
      mid: mid,
      ts: nowMs()
    };
    input.value = '';
    input.focus();

    putMsg(convId, msg, { state: 'sending' });
    var ok = sendFrame({ t: 'send', to: to, kind: 'text', text: text, mid: mid });
    if (!ok) {
      var c = state.convs[convId];
      var m = c ? findMsg(c, state.me.id, mid) : null;
      if (m) m.state = 'failed';
      if (c) saveHist(c);
      toast('发送失败：连接已断开');
    } else {
      armAckTimer(mid, convId);
    }
    if (state.view === 'chat') renderChat(true);
    else renderList();
  }

  function retryMessage(convId, mid) {
    var c = state.convs[convId];
    if (!c) return;
    var m = findMsg(c, state.me.id, mid);
    if (!m) return;
    if (state.conn !== 'connected') { toast('还没连上服务器'); return; }
    m.state = 'sending';
    saveHist(c);
    renderChat(false);
    var ok = sendFrame({ t: 'send', to: c.id === GROUP_ID ? GROUP_ID : c.id, kind: m.kind, text: m.text, mid: m.mid });
    if (ok) armAckTimer(m.mid, convId);
  }

  /* ------------------------------ 渲染：会话列表 ------------------------------ */
  function renderList() {
    var listEl = $('conv-list');
    var emptyEl = $('empty-state');
    if (!listEl) return;
    var rows = [];
    var i;
    var all = convList();
    for (i = 0; i < all.length; i++) {
      var c = all[i];
      if (c.msgs.length > 0 || c.id === GROUP_ID || c.online) rows.push(c);
    }
    rows.sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0); });

    listEl.textContent = '';
    for (i = 0; i < rows.length; i++) {
      listEl.appendChild(buildRow(rows[i]));
    }
    if (emptyEl) emptyEl.hidden = rows.length > 0;
  }

  function previewOf(c) {
    if (!c.msgs.length) {
      return c.id === GROUP_ID ? '和房间里的所有人聊天' : '还没有聊过，打个招呼吧';
    }
    var m = c.msgs[c.msgs.length - 1];
    var body = m.kind === 'image' ? '[图片]' : (m.kind === 'video' ? '[视频]' : m.text);
    var isOwn = m.from === state.me.id;
    var prefix = '';
    if (isOwn) prefix = '我: ';
    else if (c.id === GROUP_ID && m.fromName) prefix = m.fromName + ': ';
    else if (m.state === 'failed') prefix = '';
    return prefix + body;
  }

  function buildRow(c) {
    var li = document.createElement('li');
    li.className = 'conv-item';
    li.setAttribute('data-conv', c.id);
    if (state.view === 'chat' && state.activeConv === c.id) li.setAttribute('aria-current', 'true');

    var av = document.createElement('div');
    av.className = 'avatar' + (c.id === GROUP_ID ? ' avatar-group' : '');
    if (c.id === GROUP_ID) {
      if (state.groupAvatar) {
        paintAvatar(av, GROUP_ID, groupName(), '群');
      } else {
        av.textContent = '群';
        av.style.background = 'linear-gradient(135deg,#07c160,#06ad56)';
      }
    } else {
      paintAvatar(av, c.id, c.name, '?');
      var dot = document.createElement('i');
      dot.className = 'avatar-dot' + (c.online ? ' on' : '');
      av.appendChild(dot);
    }

    var main = document.createElement('div');
    main.className = 'conv-main';

    var l1 = document.createElement('div');
    l1.className = 'conv-line1';
    var nm = document.createElement('div');
    nm.className = 'conv-name';
    nm.textContent = c.id === GROUP_ID ? groupName() : c.name;
    var tm = document.createElement('div');
    tm.className = 'conv-time';
    tm.textContent = fmtListTime(c.lastTs);
    l1.appendChild(nm);
    l1.appendChild(tm);

    var l2 = document.createElement('div');
    l2.className = 'conv-line2';
    var pv = document.createElement('div');
    pv.className = 'conv-preview';
    pv.textContent = previewOf(c);
    l2.appendChild(pv);
    if (c.unread > 0) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = c.unread > 99 ? '99+' : String(c.unread);
      l2.appendChild(badge);
    }

    main.appendChild(l1);
    main.appendChild(l2);

    li.appendChild(av);
    li.appendChild(main);
    li.addEventListener('click', function () { openConv(c.id); });
    return li;
  }

  /* ------------------------------ 渲染：聊天页 ------------------------------ */
  function renderChat(scrollToBottom) {
    var wrap = $('msg-list');
    if (!wrap) return;
    var convId = state.activeConv || GROUP_ID;
    var c = ensureConv(convId);
    var title = $('chat-title');
    if (title) title.textContent = convId === GROUP_ID ? groupName() : (c ? c.name : '聊天');
    updateChatAvatar(c, convId);
    var sub = $('chat-sub');
    if (sub) sub.textContent = chatSubtitle();

    wrap.textContent = '';
    if (!c || !c.msgs.length) {
      var hint = document.createElement('div');
      hint.className = 'time-sep';
      hint.textContent = convId === GROUP_ID
        ? '这里发出去的消息，房间里所有人都能收到'
        : '还没有消息，说句话试试';
      wrap.appendChild(hint);
      if (scrollToBottom !== false) scrollChatBottom();
      return;
    }

    var msgs = c.msgs;
    var lastTs = 0;
    var lastFrom = '';
    var i;
    for (i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!lastTs || m.ts - lastTs > 5 * 60 * 1000) {
        var sep = document.createElement('div');
        sep.className = 'time-sep';
        sep.textContent = fmtSep(m.ts);
        wrap.appendChild(sep);
        lastFrom = '';
      }
      wrap.appendChild(buildBubble(c, m, lastFrom === m.from && (m.ts - lastTs) < 2 * 60 * 1000));
      lastFrom = m.from;
      lastTs = m.ts;
    }
    if (scrollToBottom !== false) scrollChatBottom();
  }

  function buildBubble(c, m, grouped) {
    var mine = m.from === state.me.id;
    var row = document.createElement('div');
    row.className = 'msg-row ' + (mine ? 'me' : 'them') + (grouped ? ' grouped' : '');

    var av = document.createElement('div');
    av.className = 'msg-avatar';
    var sender = mine ? state.me.name : (m.fromName || (c.id === GROUP_ID ? shortId(m.from) : c.name));
    paintAvatar(av, mine ? state.me.id : m.from, sender, mine ? '我' : '?');
    row.appendChild(av);

    var body = document.createElement('div');
    body.className = 'msg-body';

    if (!mine && c.id === GROUP_ID) {
      var who = document.createElement('div');
      who.className = 'msg-sender';
      who.textContent = m.fromName || shortId(m.from);
      body.appendChild(who);
    }

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (!grouped) bubble.className += ' tail';
    if (mine && m.state === 'sending') bubble.className += ' is-sending';
    if (mine && m.state === 'failed') bubble.className += ' is-failed';
    if (m.kind === 'image' || m.kind === 'video') {
      bubble.className += ' bubble-media';
      if (!m.text) {
        bubble.className += ' is-pending-media';
        bubble.textContent = (m.state === 'uploading' ? '正在上传…' : (m.kind === 'video' ? '[视频]' : '[图片]'));
      } else if (m.kind === 'image') {
        var mimg = document.createElement('img');
        mimg.className = 'bubble-img';
        mimg.alt = (m.meta && m.meta.name) ? String(m.meta.name) : '图片';
        mimg.src = mediaUrl(m.text);
        (function (src) {
          mimg.addEventListener('click', function () {
            if (m.state && m.state !== 'sent') return;
            openLightbox(src);
          });
        })(mediaUrl(m.text));
        bubble.appendChild(mimg);
      } else {
        var mvid = document.createElement('video');
        mvid.className = 'bubble-video';
        mvid.src = mediaUrl(m.text);
        mvid.controls = true;
        mvid.preload = 'metadata';
        mvid.setAttribute('playsinline', 'playsinline');
        if (m.meta && m.meta.thumb) mvid.setAttribute('poster', String(m.meta.thumb));
        bubble.appendChild(mvid);
      }
    } else {
      bubble.textContent = m.text;
    }
    body.appendChild(bubble);

    if (mine && m.state && m.state !== 'sent') {
      var meta = document.createElement('div');
      meta.className = 'msg-meta';
      if (m.state === 'sending') {
        meta.textContent = '发送中…';
      } else if (m.state === 'uploading') {
        meta.textContent = '上传中…';
      } else {
        var span = document.createElement('span');
        span.textContent = '发送失败';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'retry';
        btn.textContent = '重发';
        var mid = m.mid;
        var cid = c.id;
        btn.addEventListener('click', function () { retryMessage(cid, mid); });
        meta.appendChild(span);
        meta.appendChild(btn);
      }
      body.appendChild(meta);
    }

    row.appendChild(body);
    return row;
  }

  function scrollChatBottom() {
    var sc = $('chat-scroll');
    if (!sc) return;
    var go = function () { sc.scrollTop = sc.scrollHeight; };
    go();
    if (window.requestAnimationFrame) window.requestAnimationFrame(go);
    setTimeout(go, 60);
  }

  /* ------------------------------ 导航 ------------------------------ */
  function showScreen(name) {
    var ids = { list: 'screen-list', chat: 'screen-chat', me: 'screen-me' };
    var k;
    for (k in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, k)) continue;
      var el = $(ids[k]);
      if (el) el.className = 'screen' + (k === name ? ' active' : '');
    }
    state.view = name;
    var tb = $('tabbar');
    if (tb) tb.hidden = (name === 'chat');
    var t1 = $('tab-list');
    var t2 = $('tab-me');
    if (t1) t1.className = 'tab' + (name === 'me' ? '' : ' active');
    if (t2) t2.className = 'tab' + (name === 'me' ? ' active' : '');
    if (name !== 'chat') renderList();
  }

  function openConv(id) {
    state.activeConv = id;
    var c = ensureConv(id);
    if (c) {
      c.unread = 0;
      if (c.msgs.length) {
        var newest = c.msgs[c.msgs.length - 1].ts;
        if (newest > c.lastReadTs) c.lastReadTs = newest;
      }
      saveIndex();
      if (state.conn === 'connected') {
        sendFrame({ t: 'read', with: id });
        // 正文只在服务端：本地没有气泡时补拉一次
        if (!localHistOn() && !c.msgs.length) {
          sendFrame({ t: 'history', with: id, limit: HISTORY_LIMIT });
        }
      }
    }
    showScreen('chat');
    renderChat(true);
    renderList();
    var input = $('composer-input');
    if (input && state.conn === 'connected') {
      // 手机上不强制弹键盘，桌面端点一下就能打字
      if (!('ontouchstart' in window)) input.focus();
    }
  }

  function backToList() {
    showScreen('list');
    renderList();
  }

  /* ------------------------------ 设置页 ------------------------------ */
  function syncSettingsUI() {
    var n = $('inp-name');
    if (n) n.value = state.name || '';
    var e = $('inp-endpoint');
    if (e) {
      e.value = state.hostMode ? LOCAL_ENDPOINT : state.endpoint;
      e.disabled = state.hostMode;
    }
    var k = $('inp-key');
    if (k) {
      // v1.1：本机 Hub 用同一份 key 校验，所以开关切过去也照样要填
      k.value = state.key || '';
      k.disabled = false;
      k.placeholder = '必填 · 本机 Hub 与公网共用这一份';
    }
    var sw = $('sw-host');
    if (sw) sw.checked = !!state.hostMode;
    var nf = $('net-fields');
    if (nf) nf.hidden = false;
    var myId = $('my-id');
    if (myId) myId.textContent = state.me.id || '—';
    var np = $('peer-endpoint');
    if (np) np.textContent = peerEndpointHint();
  }

  function applyHostMode(on) {
    on = !!on;
    if (on && !state.hostMode) {
      // 记住公网侧地址和通行码，关掉开关时还原
      store(LS.remote, state.endpoint);
      store(LS.remoteKey, state.key);
    }
    state.hostMode = on;
    store(LS.host, on ? '1' : '0');
    if (on) {
      state.endpoint = LOCAL_ENDPOINT;
      // 本机 Hub 用同一份 key，不动 state.key
    } else {
      var r = load(LS.remote);
      state.endpoint = r ? normalizeEndpoint(r) : DEFAULT_ENDPOINT;
      var rk = load(LS.remoteKey);
      state.key = rk === null ? DEFAULT_KEY : rk;
      store(LS.endpoint, state.endpoint);
    }
    syncSettingsUI();
  }

  /* ------------------------------ 初始化 ------------------------------ */
  function init() {
    var savedName = load(LS.name);
    var savedEp = load(LS.endpoint);
    var savedKey = load(LS.key);
    var savedHost = load(LS.host);

    state.name = savedName === null ? '' : clampName(savedName);
    state.me.name = state.name;
    state.endpoint = savedEp ? normalizeEndpoint(savedEp) : DEFAULT_ENDPOINT;
    state.key = savedKey === null ? DEFAULT_KEY : savedKey;
    state.hostMode = savedHost === '1';
    state.me.avatar = load(LS.avatar) || '';
    if (state.me.avatar) {
      state.avatars[state.me.id] = state.me.avatar;
    }
    if (state.hostMode) state.endpoint = LOCAL_ENDPOINT;
    if (!state.name && state.mock) {
      // 无服务端自检模式下给个默认昵称，截图更像真实使用
      state.name = '花花';
      state.me.name = state.name;
    }

    // 预加载本地历史会话：HIST_LOCAL 时读正文副本，否则只恢复索引并从服务端拉
    if (localHistOn()) {
      var probe = load(LS.hist + GROUP_ID);
      if (probe) ensureConv(GROUP_ID);
      var hi;
      try {
        for (hi = 0; hi < localStorage.length; hi++) {
          var hk = localStorage.key(hi);
          if (hk && hk.indexOf(LS.hist) === 0) ensureConv(hk.slice(LS.hist.length));
        }
      } catch (e) {}
    } else {
      purgeLocalMsgHist();   // 旧版留在手机的正文副本，一次性清掉
    }
    loadIndex();             // 本机模式也要恢复已读位置，否则重进又亮红点
    ensureConv(GROUP_ID);

    if (state.mock) {
      var badge = $('mock-badge');
      if (badge) badge.hidden = false;
    }

    syncSettingsUI();
    showScreen('list');
    renderList();
    updateUI();
    bindEvents();
    bindV12Events();

    // 首次打开先让用户填昵称；已有昵称则自动连一次
    if (state.mock || state.name) {
      setTimeout(connect, 200);
    } else {
      showScreen('me');
      var inp = $('inp-name');
      if (inp && !('ontouchstart' in window)) inp.focus();
    }
  }

  function bindEvents() {
    // 底部 tab：消息 / 我
    var tabList = $('tab-list');
    if (tabList) tabList.addEventListener('click', function () {
      showScreen('list');
      renderList();
    });

    var tabMe = $('tab-me');
    if (tabMe) tabMe.addEventListener('click', function () {
      syncSettingsUI();
      showScreen('me');
    });

    // 未连接时的「连接」入口条 → 直接去「我」页
    var cta = $('connect-cta');
    if (cta) cta.addEventListener('click', function () {
      syncSettingsUI();
      showScreen('me');
    });

    var back = $('btn-back');
    if (back) back.addEventListener('click', backToList);

    var info = $('btn-chat-info');
    if (info) info.addEventListener('click', function () {
      var c = state.convs[state.activeConv];
      if (!c) return;
      toast(state.activeConv === GROUP_ID
        ? '群聊（全部）· 本机 ' + shortId(state.me.id)
        : (c.online ? '在线 · ' : '离线 · ') + c.id);
    });

    var composer = $('composer');
    if (composer) composer.addEventListener('submit', function (ev) {
      ev.preventDefault();
      sendText();
    });

    var input = $('composer-input');
    if (input) input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        sendText();
      }
    });

    var nameInput = $('inp-name');
    if (nameInput) {
      nameInput.addEventListener('input', function () {
        var v = clampName(nameInput.value);
        state.name = v;
        state.me.name = v;          // 立刻生效：不再等重新连接
        store(LS.name, v);
        updateUI();
        if (state.conn === 'connected' && v) {
          // §14.6：把新名字同步给房间里的其他人
          sendFrame({ t: 'profile', name: v });
        }
      });
      nameInput.addEventListener('blur', function () {
        nameInput.value = state.name;
        pushNativeConfig();
      });
    }

    var ep = $('inp-endpoint');
    if (ep) {
      ep.addEventListener('input', function () {
        if (state.hostMode) return;
        state.endpoint = ep.value;
        store(LS.endpoint, state.endpoint);
      });
      ep.addEventListener('blur', function () {
        if (state.hostMode) return;
        var n = normalizeEndpoint(ep.value);
        if (n) { state.endpoint = n; store(LS.endpoint, n); }
        ep.value = state.hostMode ? LOCAL_ENDPOINT : state.endpoint;
      });
    }

    var keyInput = $('inp-key');
    if (keyInput) {
      keyInput.addEventListener('input', function () {
        // v1.1：本机模式也用同一份 key，两种模式都保存
        state.key = keyInput.value;
        store(LS.key, state.key);
        if (state.hostMode) showConnError(null);
      });
      keyInput.addEventListener('blur', function () {
        keyInput.value = state.key || '';
      });
    }

    var sw = $('sw-host');
    if (sw) sw.addEventListener('change', function () {
      applyHostMode(sw.checked);
      if (state.conn === 'connected') {
        toast('已切换地址，点“连接”生效');
      }
    });

    var btnConnect = $('btn-connect');
    if (btnConnect) btnConnect.addEventListener('click', function () {
      if (state.conn === 'connected' || state.conn === 'connecting') disconnect();
      state.conn = 'idle';
      state.retryIdx = 0;
      state.dead = false;
      state.manualClose = false;
      showConnError(null);
      connect();
      updateUI();
      if (state.conn !== 'error') showScreen('list');
    });

    var btnDisconnect = $('btn-disconnect');
    if (btnDisconnect) btnDisconnect.addEventListener('click', function () {
      disconnect();
      toast('已断开');
    });

    window.addEventListener('online', function () {
      if (state.conn !== 'connected' && !state.manualClose) {
        state.conn = 'idle';
        connect();
      }
    });
    window.addEventListener('offline', function () {
      if (state.conn === 'connected') toast('网络断开了');
    });
    window.addEventListener('pagehide', function () {
      // 页面被系统回收前把连接关干净，服务端能立刻更新 peers
      state.manualClose = true;
      clearReconnect();
      clearTimers();
      var s = state.ws;
      state.ws = null;
      if (s) {
        try { s.onclose = null; } catch (e) {}
        try { s.close(1000, 'pagehide'); } catch (e2) {}
      }
    });
  }

  /* =============================================================
   * MockSocket：仅在 ?mock=1 时启用，用于无服务端时的界面自检/截图
   * ============================================================= */

  /* ===================== v1.2：头像 / 群名 / 图片视频 ===================== */

  /** 群名规则（PROTOCOL §14.2）：trim 后 1–24 个码点，越界返回空串 */
  function clampGroupName(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var n = Array.from ? Array.from(s).length : s.length;
    if (n > 24) return '';
    return s;
  }

  function groupName() {
    return clampGroupName(state.groupName) || GROUP_DEFAULT;
  }

  /** 头像：有 data-URL 就贴图，否则退回首字色块 */
  function paintAvatar(el, id, name, fallback) {
    if (!el) return;
    var data = id ? state.avatars[id] : '';
    var usable = typeof data === 'string' && data && /^(data:image\/|\/m\/|https?:)/i.test(data);
    var img = el.querySelector('img.avatar-img');
    if (usable) {
      if (!img) {
        img = document.createElement('img');
        img.className = 'avatar-img';
        img.alt = '';
      }
      el.textContent = '';
      el.style.backgroundImage = '';
      el.classList.add('has-img');
      img.src = mediaUrl(data);
      el.appendChild(img);
    } else {
      if (img && img.parentNode === el) el.removeChild(img);
      el.classList.remove('has-img');
      el.style.backgroundImage = '';
      el.textContent = avatarChar(name, fallback || '?');
    }
  }

  function updateChatAvatar(c, convId) {
    var av = $('px-chat-avatar');
    if (!av) return;
    if (convId === GROUP_ID) {
      av.hidden = false;
      av.classList.remove('is-group');
      if (state.groupAvatar) paintAvatar(av, GROUP_ID, groupName(), '群');
      else {
        if (av.querySelector('img.avatar-img')) paintAvatar(av, '', groupName(), '群');
        else paintAvatar(av, '', groupName(), '群');
      }
    } else if (c) {
      av.hidden = false;
      paintAvatar(av, c.id, c.name, '?');
    } else {
      av.hidden = true;
    }
  }

  /** ws 地址 → 同源 http 基址（上传/取图都走它） */
  function httpBase() {
    var ep = normalizeEndpoint(state.endpoint || DEFAULT_ENDPOINT);
    var m = /^(wss?):\/\/([^\/]+)/i.exec(ep);
    if (!m) return 'http://127.0.0.1:21001';
    return (m[1].toLowerCase() === 'wss:' ? 'https://' : 'http://') + m[2];
  }

  function mediaUrl(p) {
    var s = String(p == null ? '' : p);
    if (!s) return '';
    if (/^(https?:|data:|blob:)/i.test(s)) return s;
    if (s.charAt(0) !== '/') s = '/m/' + s;
    return httpBase() + s;
  }

  function uploadBlob(blob, kind, name) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', httpBase() + '/upload', true);
      try {
        xhr.setRequestHeader('X-Key', String(state.key || ''));
        xhr.setRequestHeader('X-Kind', kind);
        xhr.setRequestHeader('X-Name', encodeURIComponent(String(name || '')));
      } catch (e) {}
      xhr.timeout = 180000;
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e2) {}
        if (xhr.status === 200 && data && data.path) resolve(data);
        else reject({ status: xhr.status, code: (data && (data.error || data.code)) || ('http_' + xhr.status) });
      };
      xhr.onerror = function () { reject({ status: 0, code: 'network' }); };
      xhr.ontimeout = function () { reject({ status: 0, code: 'timeout' }); };
      xhr.send(blob);
    });
  }

  function uploadErrorText(code) {
    switch (String(code || '')) {
      case 'too_large': return '文件太大';
      case 'bad_kind': return '不支持这个类型';
      case 'empty': return '文件是空的';
      case 'bad_key': return '通行码不对';
      case 'timeout': return '上传超时';
      case 'network': return '上传失败：网络不通';
      default: return '上传失败（' + (code || 'unknown') + '）';
    }
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('read')); };
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.readAsDataURL(file);
    });
  }

  /** 居中裁成正方形再转 JPEG（头像用） */
  function squareJpeg(url, size, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onerror = function () { reject(new Error('decode')); };
      img.onload = function () {
        try {
          var w = img.width || img.naturalWidth;
          var h = img.height || img.naturalHeight;
          var side = Math.min(w, h);
          var cv = document.createElement('canvas');
          cv.width = size;
          cv.height = size;
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
          resolve(cv.toDataURL('image/jpeg', quality || 0.8));
        } catch (e) {
          reject(e);
        }
      };
      img.src = url;
    });
  }

  function sendAvatarFile(file) {
    if (!file) return;
    if (!/^image\//.test(String(file.type || ''))) { toast('请选一张图片'); return; }
    if (!state.caps || !state.caps.avatar) { toast('服务器不支持换头像'); return; }
    if (state.conn !== 'connected') { toast('还没连上服务器'); return; }
    readAsDataUrl(file)
      .then(function (url) { return squareJpeg(url, 160, 0.8); })
      .then(function (dataUrl) {
        if (dataUrl.length <= 48000) return dataUrl;
        return squareJpeg(dataUrl, 96, 0.6);
      })
      .then(function (dataUrl) {
        if (!dataUrl || dataUrl.length > 48000) { toast('图片太大，换一张试试'); return; }
        if (!sendFrame({ t: 'avatar', data: dataUrl })) { toast('还没连上服务器'); return; }
        state.me.avatar = dataUrl;
        state.avatars[state.me.id] = dataUrl;
        store(LS.avatar, dataUrl);
        updateUI();
        if (state.view === 'chat') renderChat(false);
        toast('头像已更新');
      })
      .catch(function () { toast('读取图片失败'); });
  }

  function startUpload(file, kind) {
    if (!file) return;
    if (!state.caps || !state.caps.media) { toast('服务器不支持图片/视频'); return; }
    if (state.conn !== 'connected') { toast('还没连上服务器'); return; }
    var limit = kind === 'video' ? MAX_UPLOAD_VIDEO : MAX_UPLOAD_IMAGE;
    if (file.size > limit) { toast(kind === 'video' ? '视频最大 16MB' : '图片最大 4MB'); return; }
    if (!file.size) { toast('文件是空的'); return; }

    var convId = state.activeConv || GROUP_ID;
    var to = convId === GROUP_ID ? GROUP_ID : convId;
    var mid = nextMid();
    var name = String(file.name || (kind === 'video' ? 'video.mp4' : 'image.jpg'));

    putMsg(convId, {
      from: state.me.id, fromName: state.me.name, to: to, kind: kind,
      text: '', mid: mid, ts: nowMs()
    }, { state: 'uploading' });
    state.uploading = (state.uploading || 0) + 1;
    if (state.view === 'chat') renderChat(true);
    else renderList();
    updateUI();

    uploadBlob(file, kind, name).then(function (res) {
      var c = state.convs[convId];
      var m = c ? findMsg(c, state.me.id, mid) : null;
      var path = String(res.path || '');
      var meta = {
        name: name,
        size: Number(res.size) || (file.size || 0),
        mime: String(res.mime || file.type || '')
      };
      if (m) {
        m.text = path;
        m.meta = meta;
        m.state = 'sending';
        if (c) saveHist(c);
      }
      var ok = sendFrame({ t: 'send', to: to, kind: kind, text: path, meta: meta, mid: mid });
      if (ok) armAckTimer(mid, convId);
      else if (m) {
        m.state = 'failed';
        if (c) saveHist(c);
        toast('发送失败：连接已断开');
      }
    }).catch(function (e) {
      var c = state.convs[convId];
      var m = c ? findMsg(c, state.me.id, mid) : null;
      if (m) { m.state = 'failed'; if (c) saveHist(c); }
      toast(uploadErrorText(e && e.code));
    }).then(function () {
      state.uploading = Math.max(0, (state.uploading || 0) - 1);
      updateUI();
      if (state.view === 'chat') renderChat(false);
      else renderList();
    });
  }

  function sendMediaFile(file, kind) {
    try { startUpload(file, kind); }
    catch (e) { toast('发送失败'); }
  }


  function openGroupModal() {
    var modal = $('px-group-modal');
    var inp = $('px-group-input');
    if (!modal || !inp) return;
    inp.value = groupName();
    modal.hidden = false;
    updateGroupCount();
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 30);
  }

  function closeGroupModal() {
    var modal = $('px-group-modal');
    if (modal) modal.hidden = true;
  }

  function updateGroupCount() {
    var inp = $('px-group-input');
    var el = $('px-group-count');
    if (!el) return;
    var v = inp ? String(inp.value || '').trim() : '';
    var n = Array.from ? Array.from(v).length : v.length;
    el.textContent = String(n);
    if (el.parentNode) {
      if (n > 24) el.parentNode.classList.add('over');
      else el.parentNode.classList.remove('over');
    }
  }

  function sendGroupName() {
    var inp = $('px-group-input');
    var name = clampGroupName(inp ? inp.value : '');
    if (!name) { toast('群名 1–24 个字'); return; }
    if (!state.caps || !state.caps.group) { toast('服务器不支持改群名'); return; }
    if (!sendFrame({ t: 'group', name: name })) { toast('还没连上服务器'); return; }
    state.groupName = name;
    closeGroupModal();
    updateUI();
    if (state.view === 'chat' && (state.activeConv || GROUP_ID) === GROUP_ID) renderChat(false);
    else renderList();
    toast('群名已更新');
  }

  function openLightbox(src) {
    var box = $('px-lightbox');
    var body = $('px-lightbox-body');
    if (!box || !body) return;
    body.textContent = '';
    var img = document.createElement('img');
    img.src = src;
    img.alt = '图片';
    body.appendChild(img);
    box.hidden = false;
  }

  function closeLightbox() {
    var box = $('px-lightbox');
    if (box) box.hidden = true;
  }

  function onPeerInfo(f) {
    if (!f || !f.id) return;
    if (f.avatar === null || f.avatar === undefined || f.avatar === '') delete state.avatars[f.id];
    else if (typeof f.avatar === 'string') state.avatars[f.id] = f.avatar;
    if (f.id === state.me.id) {
      state.me.avatar = state.avatars[f.id] || '';
      store(LS.avatar, state.me.avatar);
    }
    if (f.name && f.id !== state.me.id) {
      var conv = state.convs[f.id];
      if (conv) { conv.name = clampName(f.name) || conv.name; saveIndex(); }
    }
    updateUI();
    if (state.view === 'chat') renderChat(false);
    else renderList();
  }

  function onGroup(f) {
    var name = clampGroupName(f && f.name);
    if (!name) return;
    state.groupName = name;
    updateUI();
    if (state.view === 'chat' && (state.activeConv || GROUP_ID) === GROUP_ID) renderChat(false);
    else renderList();
    toast('群名改成「' + name + '」了');
  }

  function onGavatar(f) {
    var data = (typeof f.data === 'string' && f.data) ? f.data : null;
    state.groupAvatar = data;
    if (data) state.avatars[GROUP_ID] = data;
    else delete state.avatars[GROUP_ID];
    updateUI();
    if (state.view === 'chat' && (state.activeConv || GROUP_ID) === GROUP_ID) renderChat(false);
    else renderList();
    var mine = f.by && f.by === state.me.id;
    toast(mine ? (data ? '群头像已更新' : '群头像已清除') : (data ? '群名头像换了' : '群头像被清除了'));
  }

  function sendGroupAvatarFile(file) {
    if (!file) return;
    if (!/^image\//.test(String(file.type || ''))) { toast('请选一张图片'); return; }
    if (!state.caps || !state.caps.gavatar) { toast('服务器不支持改群头像'); return; }
    if (state.conn !== 'connected') { toast('还没连上服务器'); return; }
    readAsDataUrl(file)
      .then(function (url) { return squareJpeg(url, 160, 0.8); })
      .then(function (dataUrl) {
        if (dataUrl.length <= 48000) return dataUrl;
        return squareJpeg(dataUrl, 96, 0.6);
      })
      .then(function (dataUrl) {
        if (!dataUrl || dataUrl.length > 48000) { toast('图片太大，换一张试试'); return; }
        if (!sendFrame({ t: 'gavatar', data: dataUrl })) { toast('还没连上服务器'); return; }
        state.groupAvatar = dataUrl;
        state.avatars[GROUP_ID] = dataUrl;
        closeGroupModal();
        updateUI();
        if (state.view === 'chat' && (state.activeConv || GROUP_ID) === GROUP_ID) renderChat(false);
        else renderList();
        toast('群头像已更新');
      })
      .catch(function () { toast('读取图片失败'); });
  }

  function clearGroupAvatar() {
    if (!state.caps || !state.caps.gavatar) { toast('服务器不支持改群头像'); return; }
    if (!sendFrame({ t: 'gavatar', data: null })) { toast('还没连上服务器'); return; }
    state.groupAvatar = null;
    delete state.avatars[GROUP_ID];
    updateUI();
    if (state.view === 'chat' && (state.activeConv || GROUP_ID) === GROUP_ID) renderChat(false);
    else renderList();
    toast('群头像已清除');
  }

  /** 设置页头像那行的提示文案（服务器不支持时明说） */
  function avatarHintText() {
    var el = $('px-avatar-hint');
    if (!el) return;
    if (state.caps && state.caps.avatar) el.textContent = '点头像换一张';
    else el.textContent = '这个服务器不支持换头像';
  }

  /* ------------------------------ 后台提醒（微信式） ------------------------------ */
  function notifyEnabled() {
    return load(LS.notify) === '1';
  }

  function syncNotifyUI() {
    var el = $('sw-notify');
    if (el) el.checked = notifyEnabled();
    var sub = $('notify-sub');
    if (!sub) return;
    if (!(window.XHC && window.XHC.setNotify)) {
      sub.textContent = '网页里没有系统通知，装 APK 才能后台提醒';
      return;
    }
    if (!notifyEnabled()) {
      sub.textContent = '关掉后后台收不到消息';
      return;
    }
    var st = '', batt = true;
    try { st = window.XHC.bgState ? String(window.XHC.bgState()) : ''; } catch (e) {}
    try { batt = window.XHC.batteryOk ? !!window.XHC.batteryOk() : true; } catch (e) {}
    var head = st && st !== '未启动' ? ('后台服务：' + st) : '后台服务未在跑（回到桌面后才启动）';
    sub.textContent = head + (batt ? '' : ' · 建议允许忽略电池优化');
  }

  /** 设置页每 3 秒刷新一次后台状态，方便排查「收不到」 */
  function startNotifyPoll() {
    if (window.__notifyPoll) return;
    window.__notifyPoll = setInterval(function () {
      if (state.view === 'me') syncNotifyUI();
    }, 3000);
  }

  /** 把连接参数推给原生层（服务要自己连中继，拿不到 WebView 的状态） */
  function pushNativeConfig() {
    if (!(window.XHC && window.XHC.configure)) return;
    try {
      window.XHC.configure(state.endpoint || '', state.key || '', state.name || '', state.me.id || '');
      if (window.XHC.setNotify) window.XHC.setNotify(notifyEnabled());
    } catch (e) {}
  }

  function toggleNotify(on) {
    store(LS.notify, on ? '1' : '0');
    if (!(window.XHC && window.XHC.setNotify)) {
      toast('网页里没有系统通知，装 APK 才能后台提醒');
      return;
    }
    try {
      if (on && window.XHC.canNotify && !window.XHC.canNotify()) window.XHC.requestPermission();
      window.XHC.setNotify(on);
      if (on) {
        var batt = true;
        try { batt = window.XHC.batteryOk ? !!window.XHC.batteryOk() : true; } catch (e) {}
        if (!batt && window.XHC.requestIgnoreBattery) window.XHC.requestIgnoreBattery();
      }
    } catch (e) {}
    if (on) syncNotifyUI();
    toast(on ? '后台提醒已开：锁屏也能收到消息' : '后台提醒已关');
  }

  window.onNativeNotifyPermission = function (granted) {
    if (!granted) {
      store(LS.notify, '0');
      syncNotifyUI();
      toast('系统没给通知权限，后台提醒已关');
    } else {
      toast('通知权限已允许');
    }
  };

  function bindV12Events() {
    startNotifyPoll();
    var el;
    var sheet = $('px-media-sheet');

    el = $('px-avatar-open');
    if (el) el.addEventListener('click', function () {
      if (nativePick('avatar')) return;
      var f = $('px-avatar-file');
      if (f) f.click();
    });

    el = $('px-avatar-file');
    if (el) el.addEventListener('change', function () {
      var files = el.files;
      if (files && files[0]) {
        try {
          sendAvatarFile(files[0]);
        } catch (e) {
          toast('头像处理失败：' + (e && e.message ? e.message : e));
        }
      } else {
        toast('没有读到文件');
      }
      el.value = '';
    });

    el = $('px-avatar-clear');
    if (el) el.addEventListener('click', function () {
      if (!sendFrame({ t: 'avatar', data: null })) { toast('还没连上服务器'); return; }
      state.me.avatar = '';
      delete state.avatars[state.me.id];
      store(LS.avatar, '');
      updateUI();
      toast('已恢复默认头像');
    });

    el = $('px-plus');
    if (el) el.addEventListener('click', function () {
      if (!state.caps || !state.caps.media) { toast('服务器不支持图片/视频'); return; }
      if (sheet) sheet.hidden = false;
    });

    if (sheet) sheet.addEventListener('click', function (ev) {
      if (ev.target === sheet) sheet.hidden = true;
    });

    el = $('px-media-cancel');
    if (el) el.addEventListener('click', function () { if (sheet) sheet.hidden = true; });

    el = $('px-pick-image');
    if (el) el.addEventListener('click', function () {
      if (sheet) sheet.hidden = true;
      if (nativePick('image')) return;
      var f = $('px-file-image');
      if (f) f.click();
    });

    el = $('px-pick-video');
    if (el) el.addEventListener('click', function () {
      if (sheet) sheet.hidden = true;
      if (nativePick('video')) return;
      var f = $('px-file-video');
      if (f) f.click();
    });

    el = $('px-file-image');
    if (el) el.addEventListener('change', function () {
      var files = el.files;
      if (files && files[0]) {
        try {
          sendMediaFile(files[0], 'image');
        } catch (e) {
          toast('发送失败：' + (e && e.message ? e.message : e));
        }
      } else {
        toast('没有读到文件');
      }
      el.value = '';
    });

    el = $('px-file-video');
    if (el) el.addEventListener('change', function () {
      var files = el.files;
      if (files && files[0]) {
        try {
          sendMediaFile(files[0], 'video');
        } catch (e) {
          toast('发送失败：' + (e && e.message ? e.message : e));
        }
      } else {
        toast('没有读到文件');
      }
      el.value = '';
    });

    el = $('chat-title');
    var titleRow = el && el.parentNode ? el.parentNode : null;
    if (titleRow) titleRow.addEventListener('click', function () {
      if ((state.activeConv || GROUP_ID) !== GROUP_ID) return;
      if (!state.caps || !state.caps.group) { toast('服务器不支持改群名'); return; }
      openGroupModal();
    });

    el = $('px-group-avatar');
    if (el) el.addEventListener('click', function () {
      if (nativePick('gavatar')) return;
      var pf = $('px-group-avatar-file');
      if (pf) pf.click();
    });
    el = $('px-group-avatar-file');
    if (el) el.addEventListener('change', function () {
      var pf = el.files && el.files[0];
      el.value = '';
      sendGroupAvatarFile(pf);
    });
    el = $('px-group-avatar-clear');
    if (el) el.addEventListener('click', function () { clearGroupAvatar(); });

    el = $('px-group-input');
    if (el) {
      el.addEventListener('input', updateGroupCount);
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); sendGroupName(); }
        else if (ev.key === 'Escape') closeGroupModal();
      });
    }

    el = $('px-group-ok');
    if (el) el.addEventListener('click', sendGroupName);

    el = $('px-group-cancel');
    if (el) el.addEventListener('click', closeGroupModal);

    el = $('px-group-modal');
    if (el) el.addEventListener('click', function (ev) {
      if (ev.target === el) closeGroupModal();
    });

    el = $('px-lightbox-close');
    if (el) el.addEventListener('click', closeLightbox);

    el = $('px-lightbox');
    if (el) el.addEventListener('click', function (ev) {
      if (ev.target === el) closeLightbox();
    });

    el = $('sw-notify');
    if (el) {
      el.addEventListener('change', function () { toggleNotify(!!el.checked); });
    }
    syncNotifyUI();

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (sheet && !sheet.hidden) { sheet.hidden = true; return; }
      var modal = $('px-group-modal');
      if (modal && !modal.hidden) { closeGroupModal(); return; }
      var box = $('px-lightbox');
      if (box && !box.hidden) closeLightbox();
    });
  }

  /* 调试/自测出口：本机页面（127.0.0.1）里给脚本一点内部状态，方便无头测试 */
  // ---- 原生选择器 / 原生上传的回调 -----------------------------------------
  function nativePick(kind) {
    var X = window.XHC;
    if (!X || typeof X.pickMedia !== 'function') return false;
    if (state.conn !== 'connected') { toast('还没连上服务器'); return true; }
    if (kind === 'avatar' && (!state.caps || !state.caps.avatar)) { toast('服务器不支持换头像'); return true; }
    if (kind === 'gavatar' && (!state.caps || !state.caps.gavatar)) { toast('服务器不支持改群头像'); return true; }
    if (kind !== 'avatar' && kind !== 'gavatar' && (!state.caps || !state.caps.media)) { toast('服务器不支持图片/视频'); return true; }
    try {
      X.pickMedia(kind, httpBase(), String(state.key || ''));
    } catch (e) {
      toast('打不开选择器：' + (e && e.message ? e.message : e));
      return true;
    }
    return true;
  }

  window.onNativeAvatar = function (dataUrl) {
    if (!dataUrl) { toast('图片处理失败'); return; }
    if (!sendFrame({ t: 'avatar', data: dataUrl })) { toast('还没连上服务器'); return; }
    state.me.avatar = dataUrl;
    state.avatars[state.me.id] = dataUrl;
    store(LS.avatar, dataUrl);
    updateUI();
    if (state.view === 'chat') renderChat(false);
    toast('头像已更新');
  };

  window.onNativeMedia = function (kind, path, mime, size) {
    if (!path) { toast('上传失败'); return; }
    if (!sendFrame) return;
    var convId = state.activeConv || GROUP_ID;
    var to = convId === GROUP_ID ? GROUP_ID : convId;
    var mid = nextMid();
    var meta = { name: '', size: Number(size) || 0, mime: String(mime || '') };
    putMsg(convId, {
      from: state.me.id, fromName: state.me.name, to: to, kind: kind,
      text: path, meta: meta, mid: mid, ts: nowMs()
    });
    var ok = sendFrame({ t: 'send', to: to, kind: kind, text: path, meta: meta, mid: mid });
    var c = state.convs[convId];
    var m = c ? findMsg(c, state.me.id, mid) : null;
    if (ok) {
      if (m) m.state = 'sending';
      armAckTimer(mid, convId);
      toast('已发送');
    } else if (m) {
      m.state = 'failed';
      toast('发送失败：连接已断开');
    }
    if (state.view === 'chat') renderChat(true);
    else renderList();
    updateUI();
  };

  window.onNativeGroupAvatar = function (dataUrl) {
    if (!dataUrl) { toast('图片处理失败'); return; }
    if (!sendFrame({ t: 'gavatar', data: dataUrl })) { toast('还没连上服务器'); return; }
    state.groupAvatar = dataUrl;
    state.avatars[GROUP_ID] = dataUrl;
    closeGroupModal();
    updateUI();
    if (state.view === 'chat' && (state.activeConv || GROUP_ID) === GROUP_ID) renderChat(false);
    else renderList();
    toast('群头像已更新');
  };

  window.onNativePickError = function (msg) {
    toast('选择文件失败：' + String(msg || '未知原因'));
  };

  // ---- 前后台切换：同一个身份只能占一条连接，页面要让位给后台服务 -----------
  // 中继对同一 id 的新连接会踢掉旧连接（4001 replaced）。若页面在后台仍自动重连，
  // 就会和 NotifyService 抢同一条身份、互相顶掉，表现就是「收到一条消息后就断开」。
  window.XHC_PAUSE = function () {
    state.bgPaused = true;
    state.manualClose = true;
    clearReconnect();
    clearTimers();
    var s = state.ws;
    state.ws = null;
    if (s) {
      try { s.onclose = null; } catch (e) {}
      try { s.close(1000, 'background'); } catch (e2) {}
    }
    setConn('idle');
    updateUI();
  };

  window.XHC_RESUME = function () {
    state.bgPaused = false;
    state.manualClose = false;
    if (state.conn === 'connected' || state.conn === 'connecting') return;
    connect();
  };

  // 真机上没有控制台，把脚本错误冒泡成 toast，便于远程定位
  window.addEventListener('error', function (ev) {
    try {
      var m = ev && ev.message ? ev.message : '脚本错误';
      toast('运行出错：' + String(m).slice(0, 60));
    } catch (e) {}
  });

  window.__xhc = { state: state, sendFrame: sendFrame, sendMediaFile: sendMediaFile, sendAvatarFile: sendAvatarFile, connect: connect };

  function MockSocket(url) {
    var self = this;
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._closed = false;
    this._timers = [];
    setTimeout(function () {
      if (self._closed) return;
      self.readyState = 1;
      if (self.onopen) self.onopen({});
    }, 120);
  }

  MockSocket.prototype._emit = function (obj) {
    if (this._closed) return;
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  };

  MockSocket.prototype._later = function (fn, ms) {
    var self = this;
    var t = setTimeout(function () {
      if (self._closed) return;
      fn();
    }, ms);
    this._timers.push(t);
  };

  MockSocket.prototype.send = function (raw) {
    var self = this;
    var f;
    try { f = JSON.parse(raw); } catch (e) { return; }
    this._later(function () { self._handle(f); }, 40);
  };

  MockSocket.prototype.close = function () {
    var self = this;
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    var i;
    for (i = 0; i < this._timers.length; i++) clearTimeout(this._timers[i]);
    setTimeout(function () {
      if (self.onclose) self.onclose({ code: 1000, reason: 'mock', wasClean: true });
    }, 10);
  };

  MockSocket.prototype._handle = function (f) {
    var self = this;
    var peers = MockSocket.PEERS;
    if (f.t === 'hello') {
      self._emit({
        t: 'welcome',
        me: { id: f.user.id, name: f.user.name },
        peers: peers.map(function (p) { return { id: p.id, name: p.name }; }),
        server: { mode: 'hub', ver: '1' }
      });
      self._later(function () { seedMockData(f.user.name); }, 260);
      return;
    }
    if (f.t === 'ping') { self._emit({ t: 'pong', ts: nowMs() }); return; }
    if (f.t === 'history') {
      var c = state.convs[f.with];
      var msgs = [];
      if (c) {
        var i;
        for (i = 0; i < c.msgs.length; i++) {
          if (c.msgs[i].state === 'sending') continue;
          var m = c.msgs[i];
          msgs.push({
            t: 'msg', from: m.from, fromName: m.fromName, to: m.to,
            kind: m.kind, text: m.text, mid: m.mid, ts: m.ts
          });
        }
      }
      self._emit({ t: 'history', with: f.with, msgs: msgs.slice(-100) });
      return;
    }
    if (f.t === 'send') {
      var ts = nowMs();
      var echo = {
        t: 'msg', from: state.me.id, fromName: state.me.name,
        to: f.to === 'all' ? 'all' : f.to, kind: f.kind, text: f.text,
        mid: f.mid, ts: ts
      };
      self._emit(echo);
      self._later(function () { self._emit({ t: 'ack', mid: f.mid, ts: ts }); }, 60);
      if (f.to !== 'all') {
        var p = null;
        var j;
        for (j = 0; j < peers.length; j++) if (peers[j].id === f.to) p = peers[j];
        if (p) {
          self._later(function () {
            self._emit({
              t: 'msg', from: p.id, fromName: p.name, to: state.me.id,
              kind: 'text', text: MockSocket.reply(f.text), mid: 'r' + mid(),
              ts: nowMs()
            });
          }, 900 + Math.floor(Math.random() * 600));
        }
      }
      return;
    }
  };

  function mid() { return nowMs().toString(36) + randHex(2); }

  MockSocket.PEERS = [
    { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: '老大' },
    { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: '小鱼' }
  ];

  MockSocket.reply = function (text) {
    var replies = [
      '在的，刚看到',
      '收到啦，我这边显示正常',
      '嗯嗯，同一 WiFi 直连挺快的',
      '这条是从本机 Hub 转过来的吗',
      '好，晚上再细说'
    ];
    var h = 0;
    var i;
    for (i = 0; i < String(text).length; i++) h = (h + text.charCodeAt(i)) % replies.length;
    return replies[h];
  };

  function seedMockData(myName) {
    var now = nowMs();
    var A = MockSocket.PEERS[0].id;
    var B = MockSocket.PEERS[1].id;
    var g = ensureConv(GROUP_ID);
    var ca = ensureConv(A, MockSocket.PEERS[0].name);
    var cb = ensureConv(B, MockSocket.PEERS[1].name);

    if (!g.msgs.length) {
      putMsg(GROUP_ID, {
        from: A, fromName: '老大', to: 'all', kind: 'text', mid: 'seed-g-1',
        text: '都连上了吗？这个房间不用公网服务器', ts: now - 1000 * 60 * 34
      }, { state: 'sent' });
      putMsg(GROUP_ID, {
        from: B, fromName: '小鱼', to: 'all', kind: 'text', mid: 'seed-g-2',
        text: '连上了，手机和电脑都在同一个 WiFi 里', ts: now - 1000 * 60 * 31
      }, { state: 'sent' });
      putMsg(GROUP_ID, {
        from: state.me.id, fromName: myName, to: 'all', kind: 'text', mid: 'seed-g-3',
        text: '速度很快，群聊也能收到', ts: now - 1000 * 60 * 29
      }, { state: 'sent' });
    }
    if (!ca.msgs.length) {
      putMsg(A, {
        from: A, fromName: '老大', to: state.me.id, kind: 'text', mid: 'seed-a-1',
        text: '晚上八点群里碰一下？', ts: now - 1000 * 60 * 12
      }, { state: 'sent' });
      putMsg(A, {
        from: state.me.id, fromName: myName, to: A, kind: 'text', mid: 'seed-a-2',
        text: '好，我先把 APK 装到手机上试一下', ts: now - 1000 * 60 * 11
      }, { state: 'sent' });
      putMsg(A, {
        from: A, fromName: '老大', to: state.me.id, kind: 'text', mid: 'seed-a-3',
        text: '装完把连接地址改成 127.0.0.1:21001 就是本机当主机',
        ts: now - 1000 * 60 * 10
      }, { state: 'sent' });
    }
    if (!cb.msgs.length) {
      putMsg(B, {
        from: B, fromName: '小鱼', to: state.me.id, kind: 'text', mid: 'seed-b-1',
        text: '气泡样式对齐微信了吗 (￣^￣)',
        ts: now - 1000 * 60 * 4
      }, { state: 'sent' });
    }
    var list = [g, ca, cb];
    var i;
    for (i = 0; i < list.length; i++) list[i].unread = 0;
    renderList();
    updateUI();
    if (state.view === 'chat') renderChat(true);
  }

  /* ------------------------------ 起跑 ------------------------------ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 供调试/自动化测试读取（不影响正常使用）
  window.PRIVCHAT_UI = {
    state: state,
    connect: connect,
    disconnect: disconnect,
    sendText: sendText,
    openConv: openConv,
    showScreen: showScreen,
    showConnError: showConnError,
    toast: toast,
    version: '1.1.0'
  };
})();