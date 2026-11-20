// resources.arsc 模板替换：拿一台真机上能装的真包资源表当底板，
// 只改 package chunk 里的包名（固定 128 个 UTF-16 字符，不足补 0），其余字节原样保留。
// 之所以这么做：手写资源表在真机上会被安装器判成“解析软件包时出现问题”，
// 而真实 aapt 产物的字节布局是经过系统验证的。
import fs from "node:fs";

const PKG_OFF = 76;          // RES_TABLE 头 12 + 全局池 64
const PKG_NAME_OFF = PKG_OFF + 12;
const PKG_NAME_CHARS = 128;

export function loadTemplate(file) {
  return fs.readFileSync(file);
}

export function patchPackageName(buf, pkg) {
  const out = Buffer.from(buf);
  const name = String(pkg);
  if (/[^\x20-\x7e]/.test(name)) throw new Error("package name must be ascii");
  if (name.length > PKG_NAME_CHARS) throw new Error("package name too long");
  out.fill(0, PKG_NAME_OFF, PKG_NAME_OFF + PKG_NAME_CHARS * 2);
  out.write(name, PKG_NAME_OFF, "utf16le");
  return out;
}

export function templatePackageName(buf) {
  const s = buf.slice(PKG_NAME_OFF, PKG_NAME_OFF + PKG_NAME_CHARS * 2).toString("utf16le");
  const i = s.indexOf("\u0000");
  return i < 0 ? s : s.slice(0, i);
}
