/**
 * Launch the packaged main process against a throwaway data dir, wait for the
 * shell to load and the IPC bridge to answer, then exit non-zero on failure.
 * Run via: npm run smoke:electron
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-smoke-"));
const port = 9333;
const child = spawn(electronPath, [".", `--remote-debugging-port=${port}`], {
  cwd: process.cwd(),
  env: { ...process.env, SV_WORKBENCH_DATA_DIR: dataDir, ELECTRON_ENABLE_LOGGING: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
  if (!target) throw new Error("shell page not found");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== 1) return;
      data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

let ok = false;
try {
  let attempts = 0;
  while (attempts < 40) {
    attempts += 1;
    await sleep(500);
    try {
      const info = await evaluate("window.workbench.app.info()");
      if (!info?.userAgent) throw new Error("no app info");
      if (/Electron/.test(info.userAgent)) throw new Error(`UA still advertises Electron: ${info.userAgent}`);
      const accounts = await evaluate("window.workbench.accounts.list()");
      if (!Array.isArray(accounts)) throw new Error("accounts.list did not return an array");
      const rendered = await evaluate("Boolean(document.querySelector('nav[aria-label=主导航]'))");
      if (!rendered) throw new Error("shell navigation not rendered");
      console.log(`smoke ok: electron ${info.electron}, chrome ${info.chrome}, ua "${info.userAgent}"`);
      ok = true;
      break;
    } catch (error) {
      if (attempts >= 40) throw error;
    }
  }
} catch (error) {
  console.error("smoke failed:", error.message);
  if (stderr.trim()) console.error(stderr.slice(-2000));
} finally {
  child.kill();
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
