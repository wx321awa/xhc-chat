// Android binary XML (AXML) writer + reader, no Android SDK needed — CAPTAIN VERSION (do not overwrite)
// Layout follows AOSP ResourceTypes.h: RES_XML_TYPE -> string pool -> resource map -> node stream.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RES = JSON.parse(readFileSync(join(HERE, "android-attrs.json"), "utf8"));

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const ANDROID_PREFIX = "android";

// canonical attribute order for the resource map (stable, matches android.R.attr ids)
const ATTR_ORDER = [
  "name", "label", "icon", "versionCode", "versionName", "minSdkVersion", "targetSdkVersion",
  "exported", "theme", "allowBackup", "usesCleartextTraffic", "hardwareAccelerated",
  "launchMode", "screenOrientation", "supportsRtl", "configChanges", "extractNativeLibs",
  "debuggable", "enabled", "permission", "process", "taskAffinity", "windowSoftInputMode",
  "foregroundServiceType",
];

const CHUNK = {
  XML: 0x0003, STRING_POOL: 0x0001, RESOURCE_MAP: 0x0180,
  START_NAMESPACE: 0x0100, END_NAMESPACE: 0x0101, START_ELEMENT: 0x0102, END_ELEMENT: 0x0103,
};
const TYPE = { reference: 0x01, string: 0x03, integer: 0x10, boolean: 0x12 };
const ORIENT = { landscape: 0, portrait: 1, user: 2, behind: 3, sensor: 4, nosensor: 5, unspecified: -1, fullSensor: 10 };
const LAUNCH_MODE = { standard: 0, singleTop: 1, singleTask: 2, singleInstance: 3 };

function putU16(buf, off, v) { buf.writeUInt16LE(v & 0xffff, off); }
function putU32(buf, off, v) { buf.writeUInt32LE(v >>> 0, off); }

function varint(len) {
  if (len < 0x80) return Buffer.from([len]);
  return Buffer.from([((len >> 8) & 0xff) | 0x80, len & 0xff]);
}

export function buildStringPool(strings) {
  const items = strings.map((s) => {
    const utf8 = Buffer.from(s, "utf8");
    return Buffer.concat([varint(s.length), varint(utf8.length), utf8, Buffer.from([0])]);
  });
  const dataLen = items.reduce((a, b) => a + b.length, 0);
  const headerSize = 28;
  const offsetsLen = 4 * items.length;
  const bodyLen = offsetsLen + dataLen;
  const size = headerSize + bodyLen + ((4 - (bodyLen % 4)) % 4);
  const buf = Buffer.alloc(size);
  putU16(buf, 0, CHUNK.STRING_POOL);
  putU16(buf, 2, headerSize);
  putU32(buf, 4, size);
  putU32(buf, 8, items.length);
  putU32(buf, 12, 0);
  putU32(buf, 16, 0x00000100); // UTF-8
  putU32(buf, 20, headerSize + offsetsLen);
  putU32(buf, 24, 0);
  let off = 0;
  items.forEach((it, i) => {
    putU32(buf, headerSize + i * 4, off);
    it.copy(buf, headerSize + offsetsLen + off);
    off += it.length;
  });
  return buf;
}

export function parseStringPool(buf, base) {
  if (buf.readUInt16LE(base) !== CHUNK.STRING_POOL) throw new Error("not a string pool @" + base);
  const headerSize = buf.readUInt16LE(base + 2);
  const count = buf.readUInt32LE(base + 8);
  const flags = buf.readUInt32LE(base + 16);
  const stringsStart = buf.readUInt32LE(base + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    let p = base + stringsStart + buf.readUInt32LE(base + headerSize + i * 4);
    if (utf8) {
      let u16len = buf[p++];
      if (u16len & 0x80) u16len = ((u16len & 0x7f) << 8) | buf[p++];
      let bytelen = buf[p++];
      if (bytelen & 0x80) bytelen = ((bytelen & 0x7f) << 8) | buf[p++];
      out.push(buf.slice(p, p + bytelen).toString("utf8"));
    } else {
      let u16len = buf.readUInt16LE(p);
      p += 2;
      if (u16len & 0x8000) { u16len = ((u16len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 4; }
      out.push(buf.slice(p, p + u16len * 2).toString("utf16le"));
    }
  }
  return { strings: out };
}

class Pool {
  constructor() { this.list = []; this.idx = new Map(); this.map = []; }
  add(s) {
    s = String(s);
    if (this.idx.has(s)) return this.idx.get(s);
    const i = this.list.length;
    this.list.push(s);
    this.idx.set(s, i);
    return i;
  }
  get(s) { return this.idx.get(String(s)); }
}

function collectStrings(root, pool) {
  const present = new Set();
  (function walk(n) {
    for (const a of n.attrs || []) if (a.ns === "android") present.add(a.name);
    for (const c of n.children || []) walk(c);
  })(root);
  // AOSP 的 ResXMLTree 对 resource map 做二分查找，所以属性名必须按 android.R.attr id 升序占用
  // 字符串池的前段，map[i] = id（aapt 也是这么排的）。
  const ids = [...present].map((n) => {
    const id = RES.attr[n];
    if (!id) throw new Error("unknown android attribute: " + n);
    return [id, n];
  }).sort((a, b) => a[0] - b[0]);
  for (const [id, name] of ids) {
    const i = pool.add(name);
    pool.map[i] = id;
  }
  for (const name of present) if (!ATTR_ORDER.includes(name)) throw new Error("android attribute not in ATTR_ORDER: " + name);
  // 框架里是 int/flags 的属性必须写成对应数值类型，否则 PackageParser 解析失败（装机报「解析软件包时出现问题」）
  const INT_ONLY = {
    foregroundServiceType: "i", versionCode: "i", minSdkVersion: "i", targetSdkVersion: "i",
    theme: "r", icon: "r", launchMode: "i", screenOrientation: "i", configChanges: "i",
  };
  (function check(n) {
    for (const at of n.attrs || []) {
      const want = INT_ONLY[at.name];
      if (want && at.type !== want) {
        throw new Error("android:" + at.name + " 必须是 " + want + " 类型（收到 " + at.type + "，值 " + String(at.value) + "）");
      }
    }
    for (const c of n.children || []) check(c);
  })(root);
  for (const at of []) {
    const want = INT_ONLY[at.name];
    if (want && at.type !== want) {
      throw new Error("android:" + at.name + " 必须是 " + want + " 类型（收到 " + at.type + "，值 " + String(at.value) + "）");
    }
  }
  pool.add(ANDROID_PREFIX);
  pool.add(ANDROID_NS);
  (function walk(n) {
    pool.add(n.tag);
    for (const a of n.attrs || []) {
      if (a.ns !== "android") pool.add(a.name);
      if (a.type === "s") pool.add(a.value);
    }
    for (const c of n.children || []) walk(c);
  })(root);
}

function emitElement(node, pool) {
  const children = (node.children || []).map((c) => emitElement(c, pool));
  const attrSize = 20;
  const attrCount = (node.attrs || []).length;
  const startTotal = 16 + 20 + attrCount * attrSize; // node header + attrExt + attrs only
  const childLen = children.reduce((a, b) => a + b.length, 0);
  const buf = Buffer.alloc(startTotal + childLen + 24);
  putU16(buf, 0, CHUNK.START_ELEMENT);
  putU16(buf, 2, 16);
  putU32(buf, 4, startTotal);
  putU32(buf, 8, 1); // lineNumber
  putU32(buf, 12, 0xffffffff); // comment
  putU32(buf, 16, 0xffffffff); // element ns (none)
  putU32(buf, 20, pool.get(node.tag));
  putU16(buf, 24, 20); // attributeStart
  putU16(buf, 26, attrSize);
  putU16(buf, 28, attrCount);
  putU16(buf, 30, 0); // idIndex
  putU16(buf, 32, 0); // classIndex
  putU16(buf, 34, 0); // styleIndex
  let p = 36;
  for (const a of node.attrs || []) {
    putU32(buf, p, a.ns === "android" ? pool.get(ANDROID_NS) : 0xffffffff);
    putU32(buf, p + 4, pool.get(a.name));
    let raw = 0xffffffff;
    let dType, data;
    if (a.type === "s") { raw = pool.get(a.value); dType = TYPE.string; data = raw; }
    else if (a.type === "i") { dType = TYPE.integer; data = a.value | 0; }
    else if (a.type === "b") { dType = TYPE.boolean; data = a.value ? 0xffffffff : 0; }
    else if (a.type === "r") { dType = TYPE.reference; data = a.value >>> 0; }
    else throw new Error("bad attr type " + a.type);
    putU32(buf, p + 8, raw);
    putU16(buf, p + 12, 8);
    buf[p + 14] = 0;
    buf[p + 15] = dType;
    putU32(buf, p + 16, data);
    p += 20;
  }
  let q = p;
  for (const c of children) { c.copy(buf, q); q += c.length; }
  if (q !== buf.length - 24) throw new Error(`element <${node.tag}> wrote ${q} of ${buf.length - 24} bytes`);
  // end element
  putU16(buf, q, CHUNK.END_ELEMENT);
  putU16(buf, q + 2, 16);
  putU32(buf, q + 4, 24);
  putU32(buf, q + 8, 1);
  putU32(buf, q + 12, 0xffffffff);
  putU32(buf, q + 16, 0xffffffff);
  putU32(buf, q + 20, pool.get(node.tag));
  return buf;
}

export function buildXml(root) {
  const pool = new Pool();
  collectStrings(root, pool);
  const poolBuf = buildStringPool(pool.list);
  const mapCount = pool.map.length;
  const map = Buffer.alloc(8 + mapCount * 4);
  putU16(map, 0, CHUNK.RESOURCE_MAP);
  putU16(map, 2, 8);
  putU32(map, 4, map.length);
  for (let i = 0; i < mapCount; i++) putU32(map, 8 + i * 4, pool.map[i] || 0);

  const nsStart = Buffer.alloc(24);
  putU16(nsStart, 0, CHUNK.START_NAMESPACE);
  putU16(nsStart, 2, 16);
  putU32(nsStart, 4, 24);
  putU32(nsStart, 8, 1);
  putU32(nsStart, 12, 0xffffffff);
  putU32(nsStart, 16, pool.get(ANDROID_PREFIX));
  putU32(nsStart, 20, pool.get(ANDROID_NS));

  const nsEnd = Buffer.alloc(24);
  putU16(nsEnd, 0, CHUNK.END_NAMESPACE);
  putU16(nsEnd, 2, 16);
  putU32(nsEnd, 4, 24);
  putU32(nsEnd, 8, 1);
  putU32(nsEnd, 12, 0xffffffff);
  putU32(nsEnd, 16, pool.get(ANDROID_PREFIX));
  putU32(nsEnd, 20, pool.get(ANDROID_NS));

  const body = Buffer.concat([nsStart, emitElement(root, pool), nsEnd]);
  const header = Buffer.alloc(8);
  putU16(header, 0, CHUNK.XML);
  putU16(header, 2, 8);
  putU32(header, 4, 8 + poolBuf.length + map.length + body.length);
  return Buffer.concat([header, poolBuf, map, body]);
}

export function parseXml(buf) {
  if (buf.readUInt16LE(0) !== CHUNK.XML) throw new Error("not AXML");
  const total = buf.readUInt32LE(4);
  if (total !== buf.length) throw new Error(`axml size mismatch: header ${total} vs actual ${buf.length}`);
  let p = 8;
  let strings = [];
  let resmap = [];
  const root = { tag: "#document", attrs: [], children: [] };
  const stack = [root];
  while (p < buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size <= 0) throw new Error("bad chunk size at " + p);
    if (type === CHUNK.STRING_POOL) {
      strings = parseStringPool(buf, p).strings;
    } else if (type === CHUNK.RESOURCE_MAP) {
      const n = (size - 8) / 4;
      for (let i = 0; i < n; i++) resmap.push(buf.readUInt32LE(p + 8 + i * 4));
    } else if (type === CHUNK.START_ELEMENT) {
      const nameIdx = buf.readUInt32LE(p + 20);
      const attrStart = buf.readUInt16LE(p + 24);
      const attrSize = buf.readUInt16LE(p + 26);
      const attrCount = buf.readUInt16LE(p + 28);
      const node = { tag: strings[nameIdx], attrs: [], children: [] };
      for (let i = 0; i < attrCount; i++) {
        const ap = p + 16 + attrStart + i * attrSize;
        const nsIdx = buf.readUInt32LE(ap);
        const anIdx = buf.readUInt32LE(ap + 4);
        const rawIdx = buf.readUInt32LE(ap + 8);
        const dType = buf[ap + 15];
        const data = buf.readUInt32LE(ap + 16);
        node.attrs.push({
          ns: nsIdx === 0xffffffff ? null : strings[nsIdx],
          name: strings[anIdx],
          resId: resmap[anIdx] || 0,
          raw: rawIdx === 0xffffffff ? null : strings[rawIdx],
          type: Object.keys(TYPE).find((k) => TYPE[k] === dType) || dType,
          value:
            dType === TYPE.string
              ? strings[data]
              : dType === TYPE.boolean
                ? data !== 0
                : data,
        });
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (type === CHUNK.END_ELEMENT) {
      if (stack.length < 2) throw new Error("unbalanced end element");
      stack.pop();
    } else if (type === CHUNK.START_NAMESPACE || type === CHUNK.END_NAMESPACE) {
      if (strings[buf.readUInt32LE(p + 20)] !== ANDROID_NS) throw new Error("bad android ns uri");
    } else {
      throw new Error("unexpected chunk type 0x" + type.toString(16) + " at " + p);
    }
    p += size;
  }
  if (p !== buf.length) throw new Error("trailing bytes after chunks");
  if (stack.length !== 1) throw new Error("unclosed elements");
  if (root.children.length !== 1) throw new Error("expected exactly one root element");
  return root.children[0];
}

export function attrOf(node, name, ns = "android") {
  if (!node) return undefined;
  const want = ns === "android" ? ANDROID_NS : ns;
  const a = (node.attrs || []).find((x) => x.name === name && x.ns === want);
  return a ? a.value : undefined;
}

export function childrenOf(node, tag) {
  return (node.children || []).filter((c) => c.tag === tag);
}

// ---- manifest builder -------------------------------------------------------
export function buildManifest(spec) {
  const app = spec.application || {};
  const label = spec.label || app.label;
  const minSdk = spec.minSdk ?? spec.minSdkVersion;
  const targetSdk = spec.targetSdk ?? spec.targetSdkVersion;

  const rootAttrs = [{ ns: null, name: "package", type: "s", value: spec.package }];
  if (spec.versionCode) rootAttrs.push({ ns: "android", name: "versionCode", type: "i", value: spec.versionCode });
  if (spec.versionName) rootAttrs.push({ ns: "android", name: "versionName", type: "s", value: spec.versionName });

  const children = [];
  if (minSdk || targetSdk) {
    const ua = [];
    if (minSdk) ua.push({ ns: "android", name: "minSdkVersion", type: "i", value: minSdk });
    if (targetSdk) ua.push({ ns: "android", name: "targetSdkVersion", type: "i", value: targetSdk });
    children.push({ tag: "uses-sdk", attrs: ua, children: [] });
  }
  for (const perm of spec.permissions || []) {
    const name = typeof perm === "string" ? perm : perm.name;
    children.push({ tag: "uses-permission", attrs: [{ ns: "android", name: "name", type: "s", value: name }], children: [] });
  }
  for (const feat of spec.features || []) {
    children.push({ tag: "uses-feature", attrs: [{ ns: "android", name: "name", type: "s", value: feat }], children: [] });
  }

  const appAttrs = [];
  if (label) appAttrs.push({ ns: "android", name: "label", type: "s", value: label });
  if (spec.iconRes) appAttrs.push({ ns: "android", name: "icon", type: "r", value: spec.iconRes });
  if (spec.themeStyle) appAttrs.push({ ns: "android", name: "theme", type: "r", value: RES.style[spec.themeStyle] });
  if (app.allowBackup !== undefined) appAttrs.push({ ns: "android", name: "allowBackup", type: "b", value: !!app.allowBackup });
  if (app.debuggable !== undefined) appAttrs.push({ ns: "android", name: "debuggable", type: "b", value: !!app.debuggable });
  if (app.hardwareAccelerated !== undefined) appAttrs.push({ ns: "android", name: "hardwareAccelerated", type: "b", value: !!app.hardwareAccelerated });
  if (app.usesCleartextTraffic !== undefined) appAttrs.push({ ns: "android", name: "usesCleartextTraffic", type: "b", value: !!app.usesCleartextTraffic });
  if (app.supportsRtl !== undefined) appAttrs.push({ ns: "android", name: "supportsRtl", type: "b", value: !!app.supportsRtl });

  const appChildren = [];
  for (const act of spec.activities || []) {
    const a = [{ ns: "android", name: "name", type: "s", value: act.name }];
    if (act.label) a.push({ ns: "android", name: "label", type: "s", value: act.label });
    if (act.exported !== undefined) a.push({ ns: "android", name: "exported", type: "b", value: !!act.exported });
    if (act.launchMode) {
      const lm = LAUNCH_MODE[act.launchMode];
      if (lm === undefined) throw new Error("unknown launchMode " + act.launchMode);
      a.push({ ns: "android", name: "launchMode", type: "i", value: lm });
    }
    if (act.orientation && ORIENT[act.orientation] !== undefined && ORIENT[act.orientation] >= 0) {
      a.push({ ns: "android", name: "screenOrientation", type: "i", value: ORIENT[act.orientation] });
    }
    const kids = [];
    const filters = [];
    if (act.launcher) filters.push({ actions: ["android.intent.action.MAIN"], categories: ["android.intent.category.LAUNCHER"] });
    for (const f of act.intentFilters || []) filters.push(f);
    for (const f of filters) {
      const fc = [];
      for (const x of f.actions || []) fc.push({ tag: "action", attrs: [{ ns: "android", name: "name", type: "s", value: x }], children: [] });
      for (const x of f.categories || []) fc.push({ tag: "category", attrs: [{ ns: "android", name: "name", type: "s", value: x }], children: [] });
      kids.push({ tag: "intent-filter", attrs: [], children: fc });
    }
    appChildren.push({ tag: "activity", attrs: a, children: kids });
  }
  for (const svc of spec.services || []) {
    const a = [{ ns: "android", name: "name", type: "s", value: svc.name }];
    if (svc.exported !== undefined) a.push({ ns: "android", name: "exported", type: "b", value: !!svc.exported });
    const sa = svc.attrs || {};
    if (sa.foregroundServiceType) a.push({ ns: "android", name: "foregroundServiceType", type: "s", value: String(sa.foregroundServiceType) });
    if (sa.process) a.push({ ns: "android", name: "process", type: "s", value: String(sa.process) });
    appChildren.push({ tag: "service", attrs: a, children: [] });
  }
  children.push({ tag: "application", attrs: appAttrs, children: appChildren });

  return buildXml({ tag: "manifest", attrs: rootAttrs, children });
}