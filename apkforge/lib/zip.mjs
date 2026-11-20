// minimal deterministic ZIP writer/reader (no deps) for APK assembly — CAPTAIN VERSION (do not overwrite)
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// fixed timestamp: 2026-01-01 00:00:00
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function buildZip(entries) {
  // entries: [{ name, data:Buffer, store?, align? }]
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = e.data;
    const store = e.store || (e.align && e.align > 1);
    const method = store ? 0 : 8;
    const comp = store ? data : deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    let extraLen = 0;
    if (e.align && e.align > 1) {
      const base = offset + 30 + nameBuf.length;
      extraLen = 4 + ((e.align - ((base + 4) % e.align)) % e.align);
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(extraLen, 28);
    let extra = Buffer.alloc(0);
    if (extraLen) {
      extra = Buffer.alloc(extraLen);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(extraLen - 4, 2);
    }
    const localOffset = offset;
    parts.push(lh, nameBuf, extra, comp);
    offset += lh.length + nameBuf.length + extra.length + comp.length;

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const zip = Buffer.concat([...parts, cd, eocd]);
  return { zip, cdOffset: offset, cdSize: cd.length, eocdOffset: offset + cd.length, entries: entries.map((e, i) => ({ name: e.name, index: i })) };
}

export function readZip(buf) {
  const eocdSig = 0x06054b50;
  let p = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === eocdSig) { p = i; break; }
  }
  if (p < 0) throw new Error("EOCD not found");
  const count = buf.readUInt16LE(p + 10);
  const cdSize = buf.readUInt32LE(p + 12);
  const cdOff = buf.readUInt32LE(p + 16);
  const out = [];
  let q = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(q) !== 0x02014b50) throw new Error("bad central header @" + q);
    const method = buf.readUInt16LE(q + 10);
    const crc = buf.readUInt32LE(q + 16);
    const csize = buf.readUInt32LE(q + 20);
    const usize = buf.readUInt32LE(q + 24);
    const nlen = buf.readUInt16LE(q + 28);
    const elen = buf.readUInt16LE(q + 30);
    const clen = buf.readUInt16LE(q + 32);
    const lho = buf.readUInt32LE(q + 42);
    const name = buf.slice(q + 46, q + 46 + nlen).toString("utf8");
    const lnameLen = buf.readUInt16LE(lho + 26);
    const lextra = buf.readUInt16LE(lho + 28);
    const dstart = lho + 30 + lnameLen + lextra;
    const raw = buf.slice(dstart, dstart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error("unsupported method " + method);
    if (crc32(data) !== crc) throw new Error("crc mismatch for " + name);
    if (data.length !== usize) throw new Error("size mismatch for " + name);
    out.push({ name, method, csize, usize, data, localOffset: lho, dataOffset: dstart });
    q += 46 + nlen + elen + clen;
  }
  if (q - cdOff !== cdSize) throw new Error("central dir size mismatch");
  return { entries: out, eocdOffset: p };
}