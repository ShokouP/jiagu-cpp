/* 临时：验证 GUI 服务 API（node 脚本，避免 PowerShell 编码干扰） */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7845;
const BASE = "http://127.0.0.1:" + PORT;
const child = spawn(process.execPath, [path.join(HERE, "jcp.mjs"), "gui", "--no-open", "--port", String(PORT)], {
  cwd: HERE,
  stdio: ["ignore", "pipe", "pipe"],
  env: Object.assign({}, process.env, { JCP_SAVE_DIR: path.join(HERE, "build") }),
});
child.stdout.on("data", (d) => process.stdout.write("[gui] " + d));
child.stderr.on("data", (d) => process.stderr.write("[gui!] " + d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/examples"); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server not up");
}
async function post(p, body) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
try {
  await waitUp();
  const page = await (await fetch(BASE + "/")).text();
  console.log("html:", page.indexOf("id=\"ac\"") >= 0 && page.indexOf("文長") >= 0 ? "ac-ok" : "ac-missing", page.length);
  console.log("examples:", (await (await fetch(BASE + "/api/examples")).json()).length);
  const d = await (await fetch(BASE + "/api/load?name=san.jcp")).json();
  console.log("load:", d.ok, d.name, d.source.length);
  const run = await post("/api/run", { src: d.source });
  console.log("run:", JSON.stringify({ ok: run.ok, output: run.output, exit: run.exit, error: run.error, ins: run.ins }));
  const chk = await post("/api/check", { src: d.source });
  console.log("check:", JSON.stringify(chk));
  const png = await post("/api/png", { src: d.source, title: "龜卜龜食" });
  console.log("png:", png.ok, png.png ? png.png.length : png.error);
  if (png.ok) fs.writeFileSync(path.join(HERE, "build", "gui-test.png"), Buffer.from(png.png.split(",")[1], "base64"));
  const save = await post("/api/png-save", { src: d.source, title: "龜卜龜食" });
  console.log("save:", JSON.stringify({ ok: save.ok, path: save.path, size: save.png ? save.png.length : 0, error: save.error }));
  if (save.ok) {
    const buf = fs.readFileSync(save.path);
    console.log("saveFile:", buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "PNG-OK" : "NOT-PNG", buf.length);
  }
} catch (e) {
  console.error("ERR", e.message);
} finally {
  child.kill();
}
