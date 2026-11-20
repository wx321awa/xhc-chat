// apkforge: build an installable, signed APK from a src dir without Gradle/Android SDK.
// src layout: manifest.json, java/**/*.java, assets/**
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, basename, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip, readZip } from "./lib/zip.mjs";
import { buildManifest, parseXml, attrOf } from "./lib/axml.mjs";
import { buildArsc } from "./lib/arsc.mjs";
import { loadTemplate, patchPackageName } from "./lib/arsc-tpl.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const VENDOR = join(ROOT, "vendor");
const JAVA = join(VENDOR, "jdk/bin/java");
const JAVAC = join(VENDOR, "jdk/bin/javac");
const ANDROID_JAR = join(VENDOR, "android.jar");
const R8 = join(VENDOR, "r8.jar");
const SIGNER = join(VENDOR, "uber-apk-signer.jar");

function args(argv) {
  const o = { src: join(HERE, "samples/hello"), out: join(ROOT, "dist/XHC-1.0-unsigned.apk"), sign: true, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--src") o.src = resolve(argv[++i]);
    else if (a === "--out") o.out = resolve(argv[++i]);
    else if (a === "--no-sign") o.sign = false;
    else if (a === "--quiet") o.quiet = true;
    else throw new Error("unknown arg " + a);
  }
  return o;
}

function run(label, bin, argv, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(bin, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  console.log(`[${ok ? "ok" : "FAIL"}] ${label} (${ms}ms)` + (ok ? "" : "\n" + out));
  if (!ok) throw new Error(label + " failed (exit " + r.status + ")\n" + out);
  return out;
}

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

function main() {
  const o = args(process.argv);
  const src = o.src;
  const work = join(ROOT, ".build", basename(src));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(work, "classes"), { recursive: true });
  mkdirSync(join(work, "dex"), { recursive: true });
  mkdirSync(dirname(o.out), { recursive: true });

  const specPath = [join(src, "manifest.json"), join(src, "android/manifest.json")].find(existsSync);
  if (!specPath) throw new Error("missing manifest.json (also tried " + join(src, "android/manifest.json") + ")");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  console.log(`[i] building ${spec.package} v${spec.versionName} (code ${spec.versionCode}) -> ${o.out}`);

  // 1) javac -----------------------------------------------------------------
  const javaFiles = walk(join(src, "java"), (p) => p.endsWith(".java"));
  let classJar = null;
  if (javaFiles.length) {
    run(`javac ${javaFiles.length} file(s)`, JAVAC, [
      "-encoding", "UTF-8", "-nowarn", "-source", "8", "-target", "8",
      "-cp", ANDROID_JAR, "-d", join(work, "classes"), ...javaFiles,
    ]);
    const classFiles = walk(join(work, "classes"), (p) => p.endsWith(".class"));
    const entries = classFiles.map((p) => ({
      name: relative(join(work, "classes"), p).split("\\").join("/"),
      data: readFileSync(p),
    }));
    classJar = join(work, "classes.jar");
    writeFileSync(classJar, buildZip(entries).zip);
    console.log(`[i] classes.jar: ${entries.length} classes, ${(statSync(classJar).size / 1024).toFixed(1)}KB`);
    // 2) d8 ------------------------------------------------------------------
    run("d8 -> classes.dex", JAVA, [
      "-cp", R8, "com.android.tools.r8.D8",
      "--release", "--min-api", String(spec.minSdk || spec.minSdkVersion || 23),
      "--lib", ANDROID_JAR,
      "--output", join(work, "dex"),
      classJar,
    ]);
  } else {
    console.log("[i] no java sources, skipping dex");
  }
  const dexPath = join(work, "dex/classes.dex");
  if (javaFiles.length && !existsSync(dexPath)) throw new Error("d8 produced no classes.dex");

  // 3) resources.arsc + res/** ------------------------------------------------
  // Kept minimal on purpose: one resource type, one default-config entry (launcher icon).
  const entries = [
    ...(existsSync(dexPath) ? [{ name: "classes.dex", data: readFileSync(dexPath) }] : []),
  ];
  let iconRes = null;
  const resDir = join(src, "res");
  if (existsSync(resDir)) {
    const resFiles = [];
    for (const p of walk(resDir, () => true)) {
      const rel = "res/" + relative(resDir, p).split("\\").join("/");
      const m = rel.match(/^res\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(\.\w+)$/);
      if (!m) throw new Error("unexpected res path: " + rel);
      resFiles.push({ type: m[1], name: m[2], path: rel, file: p });
    }
    // 优先用真机可装包的资源表当底板（见 lib/arsc-tpl.mjs 的说明）；手写版仅兜底。
    const tplPath = join(import.meta.dirname, "templates", "drawable-ic_launcher.arsc");
    let arsc, ids;
    if (existsSync(tplPath)) {
      arsc = patchPackageName(loadTemplate(tplPath), spec.package);
      ids = new Map([["drawable/ic_launcher", 0x7f010000]]);
      const needSame = resFiles.every((f) => f.path === "res/drawable/ic_launcher.png");
      if (!needSame) throw new Error("arsc template only supports res/drawable/ic_launcher.png");
    } else {
      ({ arsc, ids } = buildArsc({ package: spec.package, files: resFiles }));
    }
    // Android 要求 resources.arsc 不压缩且 4 字节对齐（否则安装时报「解析软件包时出现问题」）
    entries.push({ name: "resources.arsc", data: arsc, store: true, align: 4 });
    for (const f of resFiles) entries.push({ name: f.path, data: readFileSync(f.file) });
    iconRes = ids.get("drawable/ic_launcher") ?? ids.get("mipmap/ic_launcher") ?? null;
    console.log(`[i] resources.arsc ${arsc.length}B, ${resFiles.length} res file(s), icon=0x${(iconRes || 0).toString(16)}`);
  }

  // 3) binary manifest -------------------------------------------------------
  const manifest = buildManifest({
    package: spec.package,
    versionCode: spec.versionCode,
    versionName: spec.versionName,
    minSdk: spec.minSdk ?? spec.minSdkVersion,
    targetSdk: spec.targetSdk ?? spec.targetSdkVersion,
    label: spec.label,
    themeStyle: spec.themeStyle,
    permissions: spec.permissions || [],
    application: spec.application || {},
    iconRes,
    activities: spec.activities || [],
    services: spec.services || [],
  });
  writeFileSync(join(work, "AndroidManifest.xml"), manifest);
  // self-check: parse it back before packing
  const back = parseXml(manifest);
  if (attrOf(back, "package", null) !== spec.package) throw new Error("manifest round-trip lost package");
  console.log(`[i] AndroidManifest.xml ${manifest.length}B, root=<${back.tag} package="${attrOf(back, "package", null)}" label="${attrOf(back.children.find(c => c.tag === "application"), "label")}">`);

  // 4) apk zip ---------------------------------------------------------------
  entries.unshift({ name: "AndroidManifest.xml", data: manifest });
  const assetsDir = join(src, "assets");
  // never ship dev/test material: assets/test/**, *.test.html, selfcheck.html
  const SKIP = /(^|\/)test\/|selfcheck\.html$|\.test\.(html|js)$/;
  for (const p of walk(assetsDir, (f) => !SKIP.test(relative(assetsDir, f).split("\\").join("/")))) {
    entries.push({ name: "assets/" + relative(assetsDir, p).split("\\").join("/"), data: readFileSync(p) });
  }
  const { zip } = buildZip(entries);
  writeFileSync(o.out, zip);
  const r = readZip(zip);
  console.log(`[i] apk written: ${o.out} ${(zip.length / 1024).toFixed(1)}KB, ${r.entries.length} entries`);

  // 5) sign ----------------------------------------------------------------
  if (o.sign) {
    const signedDir = join(work, "signed"); // per-build dir: never pick up a stale apk from an earlier run
    mkdirSync(signedDir, { recursive: true });
    // NOTE: uber-apk-signer's built-in zipalign is x86_64 only -> must pass --skipZipAlign on aarch64.
    // Alignment for uncompressed entries is handled by our own zip writer (align extra field).
    run("uber-apk-signer", JAVA, [
      "-jar", SIGNER, "-a", o.out, "-o", signedDir, "--skipZipAlign",
    ]);
    const files = readdirSync(signedDir).filter((f) => f.endsWith(".apk"));
    if (!files.length) throw new Error("signer produced no apk in " + signedDir);
    const signed = join(signedDir, files.find((f) => f === basename(o.out).replace(/\.apk$/, "-debugSigned.apk")) || files.find((f) => f.includes("Signed")) || files[0]);
    const finalPath = o.out.replace(/\.apk$/, "") + "-signed.apk";
    copyFileSync(signed, finalPath);
    console.log(`[i] signed apk: ${finalPath} ${(statSync(finalPath).size / 1024).toFixed(1)}KB`);
  }
}

main();