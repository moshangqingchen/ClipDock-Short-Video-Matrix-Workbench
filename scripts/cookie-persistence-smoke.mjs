/** Two real Chromium processes, synthetic cookies only, isolated temporary userData. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electron from "electron";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipdock-cookie-smoke-"));
const entry = path.join(root, "smoke.cjs");
const source = `
import { app, session } from "electron";
import assert from "node:assert/strict";
import { CookieGuard } from ${JSON.stringify(path.resolve("src/main/browser/cookie-guard.ts"))};
app.setPath("userData", process.env.COOKIE_SMOKE_ROOT);
app.setPath("sessionData", process.env.COOKIE_SMOKE_ROOT + "/profiles");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const ses = session.fromPartition("persist:synthetic-only");
  const diagnostics = [];
  const guard = new CookieGuard(ses, "weixin_channels", { onDiagnostic: row => diagnostics.push(row) });
  if (process.env.COOKIE_SMOKE_STAGE === "write") {
    await ses.cookies.set({ url:"https://channels.weixin.qq.com/", name:"sessionid", value:"synthetic-old", secure:true, httpOnly:true, sameSite:"lax" });
    await ses.cookies.set({ url:"https://channels.weixin.qq.com/", name:"sessionid", value:"synthetic-rotated", secure:true, httpOnly:true, sameSite:"lax" });
    await ses.cookies.set({ url:"https://channels.weixin.qq.com/", name:"__Host-synthetic", value:"synthetic-host", secure:true, path:"/", sameSite:"strict" });
    await ses.cookies.set({ url:"https://channels.weixin.qq.com/", domain:".weixin.qq.com", name:"synthetic-domain", value:"synthetic-domain", secure:true, sameSite:"lax" });
    await guard.persistExisting();
  } else {
    const cookies = await ses.cookies.get({});
    const login = cookies.find(c => c.name === "sessionid");
    assert.equal(login?.value, "synthetic-rotated");
    assert.equal(login.hostOnly, true);
    assert.equal(login.session, false);
    assert.equal(login.secure, true);
    assert.equal(login.httpOnly, true);
    assert.equal(login.sameSite, "lax");
    const host = cookies.find(c => c.name === "__Host-synthetic");
    assert.equal(host?.hostOnly, true);
    assert.equal(host?.session, false);
    const domain = cookies.find(c => c.name === "synthetic-domain");
    assert.equal(domain?.hostOnly, false);
    assert.equal(domain?.session, false);
  }
  assert.equal(await guard.flush(5000, true), true);
  assert.equal(diagnostics.some(row => row.outcome !== "success"), false);
  assert.equal(JSON.stringify(diagnostics).includes("synthetic-rotated"), false);
  guard.dispose();
  console.log("COOKIE_SMOKE_OK:" + process.env.COOKIE_SMOKE_STAGE);
  app.quit();
}).catch(() => { console.error("COOKIE_SMOKE_FAILED"); app.exit(1); });`;
try {
  await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" }, outfile: entry,
    bundle: true, platform: "node", format: "cjs", external: ["electron"], tsconfig: "tsconfig.electron.json" });
  for (const stage of ["write", "read"]) {
    await new Promise((resolve, reject) => {
      const env = { ...process.env, COOKIE_SMOKE_ROOT: root, COOKIE_SMOKE_STAGE: stage };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [entry], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.resume();
      const timer = setTimeout(() => child.kill(), 30_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && output.includes("COOKIE_SMOKE_OK:" + stage)) resolve();
        else reject(new Error("Synthetic cookie process failed: " + stage));
      });
    });
  }
  console.log(JSON.stringify({ passed: true, processes: 2, cases: ["rotation", "hostOnly", "__Host-prefix", "domain", "restart", "no-secret-diagnostics"] }));
} finally {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error("Unexpected fixture path");
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
