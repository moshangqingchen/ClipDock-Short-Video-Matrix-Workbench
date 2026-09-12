/** Anonymous production in-app website smoke. No user accounts or proxy-setting writes.
 * node scripts/electron-simple-web-smoke.mjs --run-once
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const base = path.join(root, "docs", ".compare");
const safeError = (error) => /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message ?? "") ? error.message : "WEB_SMOKE_FAILED";
const assert = (value, code) => { if (!value) throw new Error(code); };
function isolatedDirectory(value) {
  const directory = path.resolve(value ?? "");
  assert(path.dirname(directory) === base && path.basename(directory).startsWith("simple-web-smoke-"), "ISOLATION_REQUIRED");
  assert(fs.realpathSync(directory) === directory, "ISOLATION_REQUIRED");
  return directory;
}

if (!process.versions.electron) await parent();
else {
  const { app } = await import("electron");
  const directory = isolatedDirectory(process.env.SV_SIMPLE_WEB_SMOKE_DIRECTORY);
  fs.mkdirSync(path.join(directory, "userData"));
  fs.mkdirSync(path.join(directory, "sessionData"));
  app.setPath("userData", path.join(directory, "userData"));
  app.setPath("sessionData", path.join(directory, "sessionData"));
  app.commandLine.appendSwitch("disable-quic");
  app.commandLine.appendSwitch("disable-background-networking");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => undefined);
  // Do not await whenReady at module scope: Electron must finish evaluating the entry module first.
  void child(app, directory).catch(() => app.exit(1));
}

async function parent() {
  assert(process.platform === "win32" && process.argv.slice(2).join(" ") === "--run-once", "EXPLICIT_WINDOWS_RUN_REQUIRED");
  const { build } = await import("esbuild");
  const { default: electron } = await import("electron");
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, "simple-web-smoke-"));
  const output = path.join(base, `simple-web-smoke-${new Date().toISOString().replace(/[-:.]/g, "")}.results.json`);
  let report = { passed: false }, childExit = null, watchdog = false;
  try {
    await build({
      stdin: {
        contents: "export { GlobalEmbeddedBrowser, globalPartition } from './src/main/browser/global-embedded-browser.ts';",
        resolveDir: root, loader: "ts",
      },
      outfile: path.join(directory, "production.mjs"), bundle: true, format: "esm", platform: "node",
      external: ["electron"], tsconfig: path.join(root, "tsconfig.electron.json"), logLevel: "silent",
    });
    const env = { ...process.env, SV_SIMPLE_WEB_SMOKE_DIRECTORY: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, "--run-once"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // Browser output can contain request URLs. Only emit the bounded report below.
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => { watchdog = true; worker.kill(); }, 50_000);
    childExit = await new Promise((resolve) => {
      worker.once("error", () => resolve(1));
      worker.once("close", (code) => resolve(code ?? 1));
    });
    clearTimeout(timer);
    const result = path.join(directory, "result.json");
    report = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, "utf8")) : { passed: false, error: "CHILD_NO_RESULT" };
  } catch (error) { report = { passed: false, error: safeError(error) }; }
  finally {
    let removed = false;
    try {
      // Validate the exact private directory before recursive removal; never touch installed/user data.
      fs.rmSync(isolatedDirectory(directory), { recursive: true, force: true });
      removed = !fs.existsSync(directory);
    } catch { /* Report a cleanup failure without broadening the deletion target. */ }
    report.childExit = childExit; report.watchdog = watchdog; report.temporaryDataRemoved = removed;
    report.passed = report.passed && childExit === 0 && !watchdog && removed;
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ ...report, report: output }));
    process.exitCode = report.passed ? 0 : 1;
  }
}

async function child(app, directory) {
  const { BrowserWindow, session } = await import("electron");
  const report = {
    passed: false, anonymousOnly: true, realAccountUsed: false, systemProxyChanged: false,
    simulatedProxyOff: true, mainHostname: null, pageNonempty: false, loginFormPresent: false,
    viewClosedAfterAbort: false, syntheticCookiePreserved: false, cleanupComplete: false,
  };
  const save = () => fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(report));
  const abort = new AbortController();
  let window, browser, websiteView, websiteContents, accountSession;
  try {
    await app.whenReady();
    const { GlobalEmbeddedBrowser, globalPartition } = await import(pathToFileURL(path.join(directory, "production.mjs")).href);
    const accountId = randomUUID();
    accountSession = session.fromPartition(globalPartition(accountId), { cache: true });
    await accountSession.cookies.set({ url: "https://smoke.invalid/", name: "synthetic-smoke", value: "isolated-only", secure: true, httpOnly: true });
    window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const initialViews = new Set(window.contentView.children);
    const manager = new GlobalEmbeddedBrowser(window);
    browser = await manager.launch({
      transport: "system", accountId, platformId: "youtube", signal: abort.signal,
      assertCurrent: () => { if (abort.signal.aborted) throw new Error("SIMULATED_PROXY_OFF"); },
    });
    let browserFailed = false;
    void browser.closed.catch(() => { browserFailed = true; });
    const view = window.contentView.children.find((childView) => !initialViews.has(childView) && childView.webContents);
    assert(view, "EMBEDDED_VIEW_MISSING");
    websiteView = view;
    websiteContents = view.webContents;
    browser.show({ x: 0, y: 0, width: 1200, height: 850 });
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline && !browserFailed && !websiteContents.isDestroyed()) {
      try {
        const remaining = Math.max(1, Math.min(1000, deadline - Date.now()));
        let timer;
        const state = await Promise.race([
          websiteContents.executeJavaScript(`({
            hostname: location.hostname,
            pageNonempty: ["interactive", "complete"].includes(document.readyState) && (document.body?.innerText?.trim().length ?? 0) > 80,
            loginFormPresent: !!document.querySelector('input[type="email"], input[name="identifier"], input[autocomplete="username"]')
          })`).finally(() => clearTimeout(timer)),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
        ]);
        if (state) {
          report.mainHostname = state.hostname;
          report.pageNonempty = state.pageNonempty;
          report.loginFormPresent = state.loginFormPresent;
        }
        if (report.mainHostname === "accounts.google.com" && report.pageNonempty && report.loginFormPresent) break;
      } catch { /* A document can be replaced during the official sign-in redirect. */ }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    assert(!browserFailed && !websiteContents.isDestroyed(), "OFFICIAL_PAGE_LOAD_FAILED");
    assert(report.mainHostname === "accounts.google.com" && report.pageNonempty && report.loginFormPresent, "OFFICIAL_LOGIN_PAGE_NOT_READY");
  } catch (error) { report.error = safeError(error); }
  finally {
    abort.abort();
    try {
      await browser?.stop();
      report.viewClosedAfterAbort = !!websiteContents?.isDestroyed() && !window.contentView.children.includes(websiteView);
      const cookies = await accountSession?.cookies.get({ url: "https://smoke.invalid/", name: "synthetic-smoke" });
      report.syntheticCookiePreserved = cookies?.length === 1 && cookies[0].value === "isolated-only";
      if (window && !window.isDestroyed()) window.destroy();
      report.cleanupComplete = true;
    } catch { report.error ??= "CLEANUP_FAILED"; }
    report.passed = !report.error && report.viewClosedAfterAbort && report.syntheticCookiePreserved && report.cleanupComplete;
    save(); app.exit(report.passed ? 0 : 1);
  }
}
