// resources.arsc (ResTable) minimal writer + reader — no aapt, no Android SDK.
// Layout follows AOSP ResourceTypes.h:
//   RES_TABLE_TYPE (header 12)
//     ResStringPool (table value strings, UTF-8)
//     RES_TABLE_PACKAGE_TYPE (header 288)
//       ResStringPool (type strings)
//       ResStringPool (key strings)
//       RES_TABLE_TYPE_SPEC_TYPE (id, entryCount, flags[])
//       RES_TABLE_TYPE_TYPE      (id, entryCount, entriesStart, config, offsets[], entries[])
// Only the pieces PackageManager needs to resolve one launcher icon are emitted: one type
// ("drawable"), one key, one default-config entry holding a TYPE_STRING path.
import { buildStringPool } from "./axml.mjs";

const TABLE = 0x0002, PACKAGE = 0x0200, TYPESPEC = 0x0202, TYPE = 0x0201, STRING_POOL = 0x0001;
const TYPE_STRING = 0x03;
const PKG_ID = 0x7f, DRAWABLE_TYPE_ID = 1;
const CONFIG_SIZE = 0x40; // ResTable_config size as aapt writes it (64B); density at offset 14
const CONFIG_DENSITY_OFF = 14;
const UTF16 = (s) => Buffer.from(s, "utf16le");
const u16 = (b, o, v) => b.writeUInt16LE(v & 0xffff, o);
const u32 = (b, o, v) => b.writeUInt32LE(v >>> 0, o);

function chunk(type, headerSize, size, body = Buffer.alloc(0)) {
  const b = Buffer.alloc(headerSize + body.length);
  u16(b, 0, type); u16(b, 2, headerSize); u32(b, 4, size + body.length);
  if (body.length) body.copy(b, headerSize);
  return b;
}

/** id: full resource id of entry 0 (e.g. 0x7f010000). */
export function entryId(typeId, entryIdx) {
  return ((PKG_ID << 24) | (typeId << 16) | entryIdx) >>> 0;
}

/**
 * @param {{package?:string, files:{type:string,name:string,path:string}[]}} spec
 * @returns {{arsc:Buffer, ids:Map<string,number>}} ids maps "type/name" -> resource id
 */
export function buildArsc(spec) {
  const files = spec.files || [];
  if (!files.length) throw new Error("buildArsc: no files");
  // group by type; v1 supports a single type so ids stay contiguous
  const byType = new Map();
  for (const f of files) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(f);
  }
  const typeNames = [...byType.keys()];
  if (typeNames.length !== 1) throw new Error("buildArsc v1 supports exactly one resource type, got " + typeNames.join(","));
  const typeName = typeNames[0];
  const items = byType.get(typeName);
  const typeId = DRAWABLE_TYPE_ID;

  const valueStrings = items.map((f) => f.path);          // TYPE_STRING payloads
  const keyStrings = items.map((f) => f.name);

  const tablePool = buildStringPool(valueStrings);
  const typePool = buildStringPool([typeName]);
  const keyPool = buildStringPool(keyStrings);

  // ResTable_typeSpec: 16B header (id, res0/res1, entryCount) + entryCount u32 flags
  const typeSpecLen = 4 * items.length;
  const typeSpec = Buffer.alloc(16 + typeSpecLen);
  u16(typeSpec, 0, TYPESPEC); u16(typeSpec, 2, 16); u32(typeSpec, 4, typeSpec.length);
  typeSpec.writeUInt8(typeId, 8); typeSpec.writeUInt8(0, 9); u16(typeSpec, 10, 0);
  u32(typeSpec, 12, items.length);            // flags[] all zero = default config only

  // ResTable_type: 8 hdr + id(1) flags(1) reserved(2) entryCount(4) entriesStart(4) config(56)
  const headerSize = 20 + CONFIG_SIZE;
  const offsetsLen = 4 * items.length;
  const entriesStart = headerSize + offsetsLen;
  const typeChunk = Buffer.alloc(entriesStart + 16 * items.length);
  u16(typeChunk, 0, TYPE); u16(typeChunk, 2, headerSize); u32(typeChunk, 4, typeChunk.length);
  typeChunk.writeUInt8(typeId, 8); typeChunk.writeUInt8(0, 9); u16(typeChunk, 10, 0);
  u32(typeChunk, 12, items.length); u32(typeChunk, 16, entriesStart);
  u32(typeChunk, 20, CONFIG_SIZE);            // config.size; rest of config zero = default
  u16(typeChunk, 20 + CONFIG_DENSITY_OFF, 0); // 0 = default density (matches aapt)
  items.forEach((f, i) => {
    const o = entriesStart + i * 16;
    u32(typeChunk, headerSize + i * 4, i * 16);            // entry offset from entriesStart
    u16(typeChunk, o, 8); u16(typeChunk, o + 2, 0); u32(typeChunk, o + 4, i);  // ResTable_entry
    u16(typeChunk, o + 8, 8); typeChunk.writeUInt8(0, o + 10); typeChunk.writeUInt8(TYPE_STRING, o + 11);
    u32(typeChunk, o + 12, i);                             // Res_value.data = index into table pool
  });

  const pkgName = spec.package || "com.xxhh.xhc";
  const pkgHeader = Buffer.alloc(288);
  pkgHeader.writeUInt8(PACKAGE & 0xff, 0); pkgHeader.writeUInt8((PACKAGE >> 8) & 0xff, 1);
  u16(pkgHeader, 2, 288);
  // id (4B) at offset 8
  u32(pkgHeader, 8, PKG_ID);
  // name[128] UTF-16 at offset 12
  const nameBuf = Buffer.from(pkgName, "utf16le");
  if (nameBuf.length > 256) throw new Error("package name too long for arsc");
  nameBuf.copy(pkgHeader, 12);
  const typeStringsOff = 288;
  const keyStringsOff = 288 + typePool.length;
  u32(pkgHeader, 268, typeStringsOff);
  u32(pkgHeader, 272, 0);              // lastPublicType (aapt 写 0)
  u32(pkgHeader, 276, keyStringsOff);
  u32(pkgHeader, 280, 0);              // lastPublicKey (aapt 写 0)
  u32(pkgHeader, 284, 0);              // typeIdOffset

  const pkgSize = 288 + typePool.length + keyPool.length + typeSpec.length + typeChunk.length;
  u32(pkgHeader, 4, pkgSize);
  const pkg = Buffer.concat([pkgHeader, typePool, keyPool, typeSpec, typeChunk]);

  const tableHeader = Buffer.alloc(12);
  u16(tableHeader, 0, TABLE); u16(tableHeader, 2, 12);
  u32(tableHeader, 4, 12 + tablePool.length + pkg.length);

  const ids = new Map();
  items.forEach((f, i) => ids.set(`${f.type}/${f.name}`, entryId(typeId, i)));
  return { arsc: Buffer.concat([tableHeader, tablePool, pkg]), ids };
}

// ---------------------------------------------------------------- reader ----
function readHeader(b, o) {
  const type = b.readUInt16LE(o), headerSize = b.readUInt16LE(o + 2), size = b.readUInt32LE(o + 4);
  if (size < headerSize || o + size > b.length) throw new Error(`bad chunk at ${o} (type=${type} hs=${headerSize} size=${size})`);
  return { type, headerSize, size };
}

function readPool(b, o) {
  const h = readHeader(b, o);
  const count = b.readUInt32LE(o + 8), flags = b.readUInt32LE(o + 16), stringsStart = b.readUInt32LE(o + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    const p0 = o + stringsStart + b.readUInt32LE(o + h.headerSize + i * 4);
    if (utf8) {
      let p = p0;
      const readLen = () => (b[p++] & 0x80 ? ((b[p - 1] & 0x7f) << 8) | b[p++] : b[p - 1]);
      readLen();                                // UTF-16 char length
      const bytes = readLen();
      out.push(b.slice(p, p + bytes).toString("utf8"));
    } else {
      const chars = b.readUInt16LE(p0);         // UTF-16 池：长度单位是字符
      out.push(b.slice(p0 + 2, p0 + 2 + chars * 2).toString("utf16le"));
    }
  }
  return { strings: out, end: o + h.size };
}

export function parseArsc(buf) {
  const h = readHeader(buf, 0);
  if (h.type !== TABLE) throw new Error("not a resources.arsc (type " + h.type + ")");
  const valuePool = readPool(buf, h.headerSize);
  const pkg = readHeader(buf, valuePool.end);
  if (pkg.type !== PACKAGE) throw new Error("no package chunk (type " + pkg.type + ")");
  const pkgStart = valuePool.end;
  const pkgId = buf.readUInt32LE(pkgStart + 8);
  const typeStringsOff = buf.readUInt32LE(pkgStart + 268);
  const keyStringsOff = buf.readUInt32LE(pkgStart + 276);
  const types = readPool(buf, pkgStart + typeStringsOff);
  const keys = readPool(buf, pkgStart + keyStringsOff);
  const out = [];
  let p = Math.max(types.end, keys.end);
  const pkgEnd = pkgStart + pkg.size;
  while (p + 8 <= pkgEnd) {
    const c = readHeader(buf, p);
    if (c.type === TYPE) {
      const typeId = buf.readUInt8(p + 8), entryCount = buf.readUInt32LE(p + 12);
      const entriesStart = buf.readUInt32LE(p + 16);
      const cfgSize = buf.readUInt32LE(p + 20);
      const density = buf.readUInt16LE(p + 20 + 14);
      for (let i = 0; i < entryCount; i++) {
        const off = buf.readUInt32LE(p + 20 + cfgSize + i * 4);
        const eo = p + entriesStart + off;
        const key = keys.strings[buf.readUInt32LE(eo + 4)];
        const vSize = buf.readUInt16LE(eo + 8), vType = buf.readUInt8(eo + 11), vData = buf.readUInt32LE(eo + 12);
        out.push({
          id: entryId(typeId, i),
          type: types.strings[Math.max(0, typeId - 1)],
          name: key, density: density || 0, valueType: vType, valueSize: vSize,
          path: vType === TYPE_STRING ? valuePool.strings[vData] : null,
        });
      }
    }
    p += c.size;
  }
  return { packageId: pkgId, entries: out };
}

// self-test: node apkforge/lib/arsc.mjs --selftest
if (process.argv[2] === "--selftest") {
  const { arsc, ids } = buildArsc({
    package: "com.xxhh.xhc",
    files: [{ type: "drawable", name: "ic_launcher", path: "res/drawable/ic_launcher.png" }],
  });
  const back = parseArsc(arsc);
  console.log("arsc bytes", arsc.length, "ids", [...ids].map(([k, v]) => k + "=" + v.toString(16)).join(" "));
  console.log(JSON.stringify(back, null, 1));
  const ok = back.packageId === 0x7f && back.entries.length === 1 &&
    back.entries[0].path === "res/drawable/ic_launcher.png" && back.entries[0].name === "ic_launcher" &&
    back.entries[0].id === [...ids.values()][0];
  console.log(ok ? "ARSC-SELFTEST-OK" : "ARSC-SELFTEST-FAIL");
  if (!ok) process.exit(1);
}