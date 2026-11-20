#!/usr/bin/env node
// apkforge/verify.mjs — static correctness check for a built APK (no Android SDK needed).
// usage: node apkforge/verify.mjs <apk> [--package com.foo] [--min-sdk 23] [--target-sdk 33] [--label XHC] [--json]
import fs from "node:fs";
import crypto from "node:crypto";
import { readZip } from "./lib/zip.mjs";
import { parseXml, attrOf, childrenOf } from "./lib/axml.mjs";
import { parseArsc } from "./lib/arsc.mjs";

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node apkforge/verify.mjs <apk> [--package p] [--min-sdk n] [--target-sdk n] [--label s]");
  process.exit(2);
}
const apkPath = args[0];
const opt = {};
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--package") opt.package = args[++i];
  else if (args[i] === "--min-sdk") opt.minSdk = Number(args[++i]);
  else if (args[i] === "--target-sdk") opt.targetSdk = Number(args[++i]);
  else if (args[i] === "--label") opt.label = args[++i];
  else if (args[i] === "--json") opt.json = true;
}

const problems = [];
const facts = {};
const bad = (m) => problems.push(m);

const buf = fs.readFileSync(apkPath);
facts.size = buf.length;
let zip;
try {
  zip = readZip(buf);
} catch (e) {
  console.error("ZIP 读取失败: " + e.message);
  process.exit(1);
}
const names = zip.entries.map((e) => e.name);
facts.entries = names.length;
const byName = new Map(zip.entries.map((e) => [e.name, e]));

// 1) required entries ---------------------------------------------------------
if (!byName.has("AndroidManifest.xml")) bad("缺少 AndroidManifest.xml");
if (!byName.has("classes.dex")) bad("缺少 classes.dex");
if (!names.some((n) => n.startsWith("META-INF/") && n.endsWith(".SF"))) bad("缺少 v1 签名 .SF");
if (!names.some((n) => n.startsWith("META-INF/") && (n.endsWith(".RSA") || n.endsWith(".DSA")))) bad("缺少 v1 签名 .RSA/.DSA");

// 2) manifest ---------------------------------------------------------------
let root = null;
try {
  root = parseXml(byName.get("AndroidManifest.xml").data);
} catch (e) {
  bad("AndroidManifest.xml 解析失败: " + e.message);
}
if (root) {
  if (root.tag !== "manifest") bad("AXML 根节点不是 <manifest>");
  const pkg = attrOf(root, "package", null);
  facts.package = pkg;
  if (!pkg) bad("manifest 缺 package");
  if (opt.package && pkg !== opt.package) bad(`package 不符: ${pkg} != ${opt.package}`);
  facts.versionCode = attrOf(root, "versionCode");
  facts.versionName = attrOf(root, "versionName");

  const sdk = childrenOf(root, "uses-sdk")[0];
  if (!sdk) bad("缺 <uses-sdk>");
  else {
    facts.minSdk = attrOf(sdk, "minSdkVersion");
    facts.targetSdk = attrOf(sdk, "targetSdkVersion");
    if (opt.minSdk && facts.minSdk !== opt.minSdk) bad(`minSdkVersion 不符: ${facts.minSdk} != ${opt.minSdk}`);
    if (opt.targetSdk && facts.targetSdk !== opt.targetSdk) bad(`targetSdkVersion 不符: ${facts.targetSdk} != ${opt.targetSdk}`);
  }
  facts.permissions = childrenOf(root, "uses-permission").map((n) => attrOf(n, "name"));
  if (!facts.permissions.includes("android.permission.INTERNET")) bad("manifest 缺 INTERNET 权限");

  const app = childrenOf(root, "application")[0];
  if (!app) bad("manifest 缺 <application>");
  else {
    facts.label = attrOf(app, "label");
    facts.theme = attrOf(app, "theme");
    if (opt.label && facts.label !== opt.label) bad(`label 不符: ${facts.label} != ${opt.label}`);
    if (facts.label == null) bad("application 缺 label（桌面图标会显示包名）");

    const acts = childrenOf(app, "activity");
    facts.activities = acts.map((a) => attrOf(a, "name"));
    const launchers = acts.filter((a) =>
      childrenOf(a, "intent-filter").some(
        (f) =>
          childrenOf(f, "action").some((x) => attrOf(x, "name") === "android.intent.action.MAIN") &&
          childrenOf(f, "category").some((x) => attrOf(x, "name") === "android.intent.category.LAUNCHER"),
      ),
    );
    if (!launchers.length) bad("没有带 MAIN+LAUNCHER 的 activity（桌面无图标）");
    else {
      facts.launcher = attrOf(launchers[0], "name");
      const exported = attrOf(launchers[0], "exported");
      facts.launcherExported = exported;
      if (exported !== true) bad("launcher activity 的 exported 不是 true（Android 12+ 装不上/点不开）");
    }
    for (const a of acts) {
      const n = attrOf(a, "name");
      if (!n || !n.includes(".")) bad(`activity name 不是全限定名: ${n}`);
    }
  }
}

// 2b) resources.arsc + launcher icon ----------------------------------------
const arscEntry = byName.get("resources.arsc");
if (arscEntry) {
  try {
    const table = parseArsc(arscEntry.data);
    facts.arscId = table.packageId;
    const icon = table.entries.find((e) => e.type === "drawable" || e.type === "mipmap");
    if (!icon) bad("resources.arsc 里没有 drawable/mipmap 条目");
    else {
      facts.icon = { id: "0x" + icon.id.toString(16), path: icon.path };
      const file = byName.get(icon.path);
      if (!file) bad(`arsc 指向的文件不在 APK 里: ${icon.path}`);
      else {
        const magic = file.data.slice(0, 4).toString("hex");
        facts.iconBytes = file.data.length;
        facts.iconMagic = magic;
        if (magic !== "89504e47") bad(`图标不是 PNG: ${icon.path} magic=${magic}`);
      }
      const appNode = root ? childrenOf(root, "application")[0] : null;
      const iconAttr = appNode && appNode.attrs ? appNode.attrs.find((a) => a.name === "icon") : null;
      if (!iconAttr) bad("manifest application 缺 android:icon");
      else if (iconAttr.value !== icon.id) bad(`manifest android:icon=${iconAttr.value} 与 arsc 资源 id 0x${icon.id.toString(16)} 不一致`);
      facts.manifestIcon = iconAttr ? iconAttr.value : null;
    }
  } catch (e) {
    bad("resources.arsc 解析失败: " + e.message);
  }
} else {
  facts.icon = null;
}

// 3) dex --------------------------------------------------------------------
const dex = byName.get("classes.dex");
if (dex) {
  const d = dex.data;
  const magic = d.slice(0, 8).toString("latin1");
  facts.dexSize = d.length;
  if (!/^dex\n0\d\d\0$/.test(magic)) bad("classes.dex 魔数不对: " + JSON.stringify(magic));
  else facts.dexVersion = magic.slice(4, 7);
  if (d.length < 112) bad("classes.dex 太小");
  else {
    const fileSize = d.readUInt32LE(32);
    if (fileSize !== d.length) bad(`dex file_size 字段 ${fileSize} != 实际 ${d.length}`);
    const want = d.readUInt32LE(8);
    const got = adler32(d.slice(12));
    if (want !== got) bad(`dex adler32 不符: 文件 ${want.toString(16)} 实算 ${got.toString(16)}`);
    const sha = crypto.createHash("sha1").update(d.slice(32)).digest();
    if (Buffer.compare(sha, d.slice(12, 32)) !== 0) bad("dex sha1 不符");
  }
  const classDefs = d.length >= 112 ? d.readUInt32LE(96) : 0;
  facts.dexClasses = classDefs;
  if (classDefs < 1) bad("classes.dex 里没有 classDef");
}

// 4) v2/v3 signing block ----------------------------------------------------
const eocdOff = zip.eocdOffset;
const cdOff = buf.readUInt32LE(eocdOff + 16);
const hasV2 = cdOff >= 32 && buf.slice(cdOff - 16, cdOff).toString("latin1") === "APK Sig Block 42";
facts.v2 = hasV2;
if (!hasV2) bad("没有 APK Signing Block（v2/v3），Android 7+ 上可能被判定为未签名");

// 5) stored entry alignment (4 bytes) --------------------------------------
const stored = zip.entries.filter((e) => e.method === 0);
let misaligned = 0;
for (const e of stored) if (e.dataOffset % 4 !== 0) misaligned++;
if (misaligned) bad(`${misaligned} 个 stored 条目未 4 字节对齐`);
facts.stored = stored.length;

if (opt.json) {
  console.log(JSON.stringify({ ok: problems.length === 0, problems, facts, entries: names }, null, 2));
} else {
  console.log(`APK: ${apkPath}  (${(buf.length / 1024).toFixed(1)}KB, ${facts.entries} entries)`);
  console.log(`  package=${facts.package} versionName=${facts.versionName} code=${facts.versionCode}`);
  console.log(`  label=${facts.label} theme=${facts.theme} minSdk=${facts.minSdk} targetSdk=${facts.targetSdk}`);
  console.log(`  launcher=${facts.launcher} exported=${facts.launcherExported}`);
  console.log(`  dex: ${facts.dexVersion} ${facts.dexSize}B, ${facts.dexClasses} classDef, adler32/sha1 ok`);
  console.log(`  signing: v1=${names.some((n) => n.endsWith(".SF"))} v2/v3=${facts.v2} stored=${facts.stored} aligned=${misaligned === 0}`);
  console.log(`  permissions=${(facts.permissions || []).join(", ")}`);

  if (facts.icon) console.log(`  icon=${facts.icon.id} ${facts.icon.path} ${facts.iconBytes}B ${facts.iconMagic}`);
  console.log(problems.length ? `  PROBLEMS:\n` + problems.map((p) => "   - " + p).join("\n") : "  ok");
}
process.exit(problems.length ? 1 : 0);