/** Real Electron response observation with synthetic protocol responses and isolated data. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electronPath from "electron";

const tempRoot = path.resolve(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempRoot, "sv-profile-observer-"));
const project = fileURLToPath(new URL("../", import.meta.url));
try {
  await build({
    stdin: { contents: 'export {IdentityObserver} from "./src/main/browser/identity-observer"; export {installBusinessNetwork} from "./src/main/network/business-access";', resolveDir: project, loader: "ts" },
    outfile: path.join(scratch, "observer.cjs"), tsconfig: path.join(project, "tsconfig.electron.json"),
    bundle: true, platform: "node", format: "cjs", external: ["electron"],
  });
  const env = { ...process.env, SV_PROFILE_OBSERVER_SCRATCH: scratch, ELECTRON_ENABLE_LOGGING: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [path.join(project, "scripts/electron-profile-observer.fixture.cjs")], {
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
  if (code !== 0) throw new Error(`profile observer smoke failed: ${stdout}\n${stderr}`);
  process.stdout.write(stdout);
} finally {
  if (path.dirname(path.resolve(scratch)) === tempRoot && path.basename(scratch).startsWith("sv-profile-observer-"))
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
