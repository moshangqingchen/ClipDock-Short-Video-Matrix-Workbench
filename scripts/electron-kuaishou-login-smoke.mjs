/** Native in-page login regression with isolated data and no platform requests. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electronPath from "electron";

const tempRoot = path.resolve(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempRoot, "sv-kuaishou-login-"));
const project = fileURLToPath(new URL("../", import.meta.url));
try {
  await build({
    entryPoints: [path.join(project, "src/main/browser/homepage-login.ts")],
    outfile: path.join(scratch, "homepage-login.cjs"), tsconfig: path.join(project, "tsconfig.electron.json"),
    bundle: true, platform: "node", format: "cjs",
  });
  const env = { ...process.env, SV_KUAISHOU_LOGIN_SCRATCH: scratch, ELECTRON_ENABLE_LOGGING: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [path.join(project, "scripts/electron-kuaishou-login.fixture.cjs")], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  if (code !== 0) throw new Error(`Kuaishou login smoke failed: ${stdout}\n${stderr}`);
  process.stdout.write(stdout);
} finally {
  if (path.dirname(path.resolve(scratch)) === tempRoot && path.basename(scratch).startsWith("sv-kuaishou-login-"))
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
