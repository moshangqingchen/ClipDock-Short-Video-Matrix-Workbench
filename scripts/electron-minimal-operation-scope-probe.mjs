/** One anonymous public robots request for the smallest existing no-page account operation. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const reportPath = path.join(repository, "docs/network-minimal-operation-scope.results.json");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild");
  const { spawn } = await import("node:child_process");
  const { default: electron } = await import("electron");
  const parentDir = path.join(repository, "docs/.compare");
  fs.mkdirSync(parentDir, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDir, "minimal-operation-"));
  try {
    const built = await build({ stdin: { contents: [
      "export {ClashReader} from './src/main/network/clash-reader.ts';",
      "export {KernelDnsReader} from './src/main/network/kernel-dns.ts';",
      "export {AnonymousProofProbe} from './src/main/network/anonymous-proof-probe.ts';",
      "export {resolveOperationCatalog} from './src/main/network/operation-catalog.ts';",
      "export {evaluateRules} from './src/main/network/rules.ts';",
    ].join("\n"), resolveDir: repository, loader: "ts" }, platform: "node", format: "esm", bundle: true,
      external: ["electron"], tsconfig: path.join(repository, "tsconfig.electron.json"), outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const sources = Object.fromEntries(Object.keys(built.metafile.inputs).filter((file) => file.startsWith("src/")).map((file) => [file, sha(fs.readFileSync(path.join(repository, file)))]));
    fs.writeFileSync(path.join(temporary, "source-hashes.json"), JSON.stringify(sources));
    const env = { ...process.env, CLIPDOCK_MINIMAL_SCOPE_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], { cwd: repository, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume(); // Browser diagnostics may contain URLs; never retain them.
    const timer = setTimeout(() => worker.kill(), 30_000);
    const code = await new Promise((resolve) => { worker.once("exit", (value) => resolve(value ?? 1)); worker.once("error", () => resolve(1)); });
    clearTimeout(timer);
    const output = path.join(temporary, "result.json");
    if (!fs.existsSync(output)) throw new Error("ISOLATED_SCOPE_PROBE_FAILED");
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    result.sourceHashes = sources;
    result.sourcesUnchanged = Object.entries(sources).every(([file, hash]) => sha(fs.readFileSync(path.join(repository, file))) === hash);
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ reportPath, sourcesUnchanged: result.sourcesUnchanged, controllerStable: result.controllerStable,
      selectedScope: result.scope, tls: result.tls, dnsStatus: result.dns?.status, failure: result.failure ?? null }, null, 2));
    process.exitCode = code;
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(parentDir) || !path.basename(resolved).startsWith("minimal-operation-")) throw new Error("UNSAFE_TEMPORARY_PATH");
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Isolated locked data is never reused. */ }
  }
}

async function child() {
  const { app } = await import("electron");
  const temporary = process.env.CLIPDOCK_MINIMAL_SCOPE_ROOT;
  if (!temporary || path.dirname(path.resolve(temporary)) !== path.resolve(repository, "docs/.compare") ||
    !path.basename(temporary).startsWith("minimal-operation-")) throw new Error("ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  const result = { executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged },
    isolation: { temporaryUserData: true, realAccountOpened: false, productionAppOpened: false, accountCookieAccessed: false,
      accountProbeEndpointRequested: false, publicEndpointRequestsMaximum: 1, publicEndpointKind: "robots", redirectFollowed: false,
      requestBodyRecorded: false, responseBodyRecorded: false, configurationChanged: false },
    scope: null, controllerBefore: null, controllerAfter: null, controllerStable: false, dns: null, tls: null,
    limitations: ["Public anonymous TLS observation only; not an authenticated check-status result or reviewed flow",
      "No claim of Chromium final DNS, AF, DIRECT path, CN egress, packaged process equivalence or business permission"] };
  let probe;
  let dns;
  try {
    await app.whenReady();
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    const reader = new production.ClashReader({ controllerUrl: "http://127.0.0.1:9790", getSecret: () => null });
    const before = await reader.read();
    result.controllerBefore = { mode: before.mode, tun: before.tun, version: before.version, fingerprint: before.fingerprint };
    if (before.mode !== "rule") throw new Error("RULE_MODE_REQUIRED_NO_PUBLIC_PROBE_SENT");
    const catalog = production.resolveOperationCatalog({ platformId: "bilibili", operation: "check-status", activePageOrigin: null });
    result.scope = { platformId: catalog.platformId, operation: catalog.operation, activePageOrigin: catalog.pageOrigin,
      sourceVersion: catalog.sourceVersion, selectionKey: catalog.selectionKey, requiredOrigins: catalog.requiredOrigins,
      sourceInventoryFrozen: catalog.sourceInventoryFrozen, executionSupported: catalog.executionSupported,
      flowReviewed: catalog.flowReviewed, reviewState: catalog.reviewState,
      rulesObservation: production.evaluateRules(before.mode, before.rules, { host: "api.bilibili.com", port: 443, network: "tcp" }) };
    if (catalog.requiredOrigins.length !== 1 || catalog.requiredOrigins[0].host !== "api.bilibili.com") throw new Error("SOURCE_SCOPE_CHANGED");
    dns = new production.KernelDnsReader({ reader, concurrency: 2, readControllerVersion: async () => {
      const r = await reader.read(); return { controllerVersion: r.fingerprint, startedAtMono: r.startedAtMono, completedAtMono: r.completedAtMono };
    } });
    result.dns = await dns.read(["api.bilibili.com"]);
    if (!result.dns.available || result.dns.controllerVersionBefore.controllerVersion !== before.fingerprint || result.dns.controllerVersionAfter.controllerVersion !== before.fingerprint)
      throw new Error("CONTROLLER_CHANGED_NO_PUBLIC_PROBE_SENT");
    probe = new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 8000 });
    result.tls = await probe.probeTls({ host: "api.bilibili.com", port: 443 }, new AbortController().signal);
    const after = await reader.read();
    result.controllerAfter = { mode: after.mode, tun: after.tun, version: after.version, fingerprint: after.fingerprint };
    result.controllerStable = before.fingerprint === after.fingerprint;
  } catch (error) {
    const message = String(error?.message ?? "");
    result.failure = /^[A-Z_]{1,100}$/.test(message) ? message : "SCOPE_PROBE_UNAVAILABLE";
  } finally {
    dns?.dispose(); await probe?.dispose();
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
    app.exit(result.failure ? 1 : 0);
  }
}
