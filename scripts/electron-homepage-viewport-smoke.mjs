/** Native viewport regression; no application startup, account data, or network requests. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electronPath from "electron";

const tempRoot = path.resolve(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempRoot, "sv-homepage-viewport-"));
const project = fileURLToPath(new URL("../", import.meta.url));
try {
  await build({
    entryPoints: [path.join(project, "src/main/browser/homepage-check-host.ts")],
    outfile: path.join(scratch, "homepage-check-host.cjs"),
    bundle: true, platform: "node", format: "cjs", external: ["electron"],
  });
  const env = { ...process.env, SV_HOMEPAGE_VIEWPORT_SCRATCH: scratch, ELECTRON_ENABLE_LOGGING: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [path.join(project, "scripts/electron-homepage-viewport.fixture.cjs")], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); }, 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  if (code !== 0) throw new Error(`homepage viewport smoke failed: ${stdout}\n${stderr}`);
  process.stdout.write(stdout);
} finally {
  // Delete only this invocation's freshly generated directory under the known temp root.
  if (path.dirname(path.resolve(scratch)) === tempRoot && path.basename(scratch).startsWith("sv-homepage-viewport-"))
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
