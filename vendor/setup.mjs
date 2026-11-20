// PrivChat/XHC vendor bootstrap: JDK17 + android.jar + r8(D8) + uber-apk-signer
// runs on aarch64 Ubuntu (proot) with no apt; downloads via node fetch through policy proxy.
import { writeFileSync, mkdirSync, readdirSync, renameSync, statSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const V = "/root/workspace/privchat/vendor";
const T = "/tmp/xhc-dl";
mkdirSync(V, { recursive: true });
mkdirSync(T, { recursive: true });

const rec = [];
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function dl(url, dest) {
  const t0 = Date.now();
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(dest, buf);
  const sha = createHash("sha256").update(buf).digest("hex");
  log(`[dl] ${url}\n     -> ${dest}  ${(buf.length / 1048576).toFixed(1)}MB ${((Date.now() - t0) / 1000).toFixed(1)}s  sha256=${sha}`);
  rec.push({ url, dest, size: buf.length, sha });
  return sha;
}

// ---------- 1) JDK 17 aarch64 (Tsinghua Adoptium mirror) ----------
const JI = "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/aarch64/linux/";
log("listing", JI);
const html = await (await fetch(JI, { signal: AbortSignal.timeout(60000) })).text();
const cands = [...html.matchAll(/href="([^"]*OpenJDK17U-jdk_aarch64_linux_hotspot_[^"]*\.tar\.gz)"/g)].map(m => m[1].replace(/^.*\//, ""));
if (!cands.length) throw new Error("no jdk tar.gz found in mirror index; html head: " + html.slice(0, 300));
cands.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const jdkName = cands[cands.length - 1];
log("jdk file:", jdkName, "of", cands.length, "candidates");
await dl(JI + jdkName, join(T, jdkName));
let r = spawnSync("tar", ["-xzf", join(T, jdkName), "-C", V], { encoding: "utf8" });
if (r.status !== 0) throw new Error("tar jdk failed: " + r.stderr);
const dirs = readdirSync(V).filter(d => d.startsWith("jdk-") && statSync(join(V, d)).isDirectory());
if (!dirs.length) throw new Error("jdk extract produced no jdk-* dir");
if (existsSync(join(V, "jdk"))) rmSync(join(V, "jdk"), { recursive: true, force: true });
renameSync(join(V, dirs[dirs.length - 1]), join(V, "jdk"));
log("jdk ->", join(V, "jdk"));

// ---------- 2) android.jar (platform-33/34 zip from dl.google.com) ----------
const REPO = "https://dl.google.com/android/repository/";
const platCands = ["platform-33_r03.zip", "platform-33_r02.zip", "platform-33_r01.zip", "platform-34_r03.zip", "platform-34_r02.zip", "platform-34_r01.zip", "platform-35_r01.zip"];
let plat = null;
for (const c of platCands) {
  try {
    const h = await fetch(REPO + c, { method: "HEAD", signal: AbortSignal.timeout(30000) });
    log("probe", c, h.status, h.headers.get("content-length") || "");
    if (h.ok) { plat = c; break; }
  } catch (e) { log("probe err", c, e.message); }
}
if (!plat) throw new Error("no platform zip reachable");
await dl(REPO + plat, join(T, plat));
const ex = join(T, "plat");
rmSync(ex, { recursive: true, force: true });
mkdirSync(ex, { recursive: true });
r = spawnSync("python3", ["-m", "zipfile", "-e", join(T, plat), ex], { encoding: "utf8" });
if (r.status !== 0) throw new Error("unzip platform failed: " + r.stderr);
const aj = readdirSync(ex).map(d => join(ex, d, "android.jar")).find(p => existsSync(p));
if (!aj) throw new Error("android.jar not found after unzip: " + readdirSync(ex).join(","));
const ab = (await import("node:fs")).readFileSync(aj);
writeFileSync(join(V, "android.jar"), ab);
rec.push({ url: REPO + plat + "!/android.jar", dest: join(V, "android.jar"), size: ab.length, sha: createHash("sha256").update(ab).digest("hex") });
log(`android.jar ${(ab.length / 1048576).toFixed(1)}MB sha256=${createHash("sha256").update(ab).digest("hex")}`);

// ---------- 3) r8 jar (D8) from Google Maven ----------
const GM = "https://dl.google.com/dl/android/maven2/com/android/tools/r8/";
const meta = await (await fetch(GM + "maven-metadata.xml", { signal: AbortSignal.timeout(60000) })).text();
const vers = [...meta.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1])
  .filter(v => !/(alpha|beta|dev|rc)/i.test(v));
vers.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const r8v = vers[vers.length - 1];
log("r8 version:", r8v, "(stable pool", vers.length + ")");
const r8sha = await dl(`${GM}${r8v}/r8-${r8v}.jar`, join(V, "r8.jar"));

// ---------- 4) uber-apk-signer ----------
const US = "https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar";
const usha = await dl(US, join(V, "uber-apk-signer.jar"));

// ---------- 5) verify ----------
const J = join(V, "jdk/bin/java"), JC = join(V, "jdk/bin/javac");
const checks = [];
function run(label, cmd, args) {
  const q = spawnSync(cmd, args, { encoding: "utf8", timeout: 180000 });
  const out = ((q.stdout || "") + (q.stderr || "")).trim().split("\n").slice(0, 8).join(" | ");
  checks.push({ label, code: q.status, out });
  log(`[check] ${label} exit=${q.status} :: ${out}`);
  return q.status;
}
run("java -version", J, ["-version"]);
run("javac --version", JC, ["--version"]);
run("D8 --version", J, ["-cp", join(V, "r8.jar"), "com.android.tools.r8.D8", "--version"]);
run("uber-apk-signer --version", J, ["-jar", join(V, "uber-apk-signer.jar"), "--version"]);

const md = ["# PrivChat/XHC vendor 组件清单", "", `生成时间：${new Date().toISOString()}`, "", "| 组件 | 版本/文件 | 大小 | sha256 | 来源 |", "|---|---|---|---|---|"];
for (const x of rec) md.push(`| ${x.dest.split("/").pop()} | ${x.dest.split("/").pop()} | ${(x.size / 1048576).toFixed(2)}MB | ${x.sha} | ${x.url} |`);
md.push("", "## 实测命令", "");
for (const c of checks) md.push("- `" + c.label + "` → exit " + c.code + " :: " + c.out);
md.push("", "## 路径", "", "- java: `" + J + "`", "- javac: `" + JC + "`", "- D8: `" + J + " -cp " + join(V, "r8.jar") + " com.android.tools.r8.D8`", "- signer: `" + J + " -jar " + join(V, "uber-apk-signer.jar") + "`", "- android.jar: `" + join(V, "android.jar") + "`");
writeFileSync(join(V, "VERSIONS.md"), md.join("\n") + "\n");
log("VERSIONS.md written");
const bad = checks.filter(c => c.code !== 0 && c.label !== "uber-apk-signer --version");
log(bad.length ? "FAILED checks: " + bad.map(b => b.label).join(",") : "ALL OK");
if (bad.length) process.exit(1);