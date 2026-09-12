/** Anonymous HEADs through the production website pool and real Windows/mihomo readers.
 * No account, Cookie, OAuth token, system proxy change, TLS exception or direct retry.
 */
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
if (!process.versions.electron) {
  const { default: executable } = await import("electron");
  const code = await new Promise((resolve) => {
    const child = spawn(executable, [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { windowsHide: true, stdio: "inherit" });
    child.once("error", () => resolve(1)); child.once("close", (value) => resolve(value ?? 1));
  });
  process.exit(code);
}
if (process.platform !== "win32" || process.argv.slice(2).join(" ") !== "--run-once") throw new Error("EXPLICIT_WINDOWS_RUN_REQUIRED");
const root = process.cwd(), stamp = new Date().toISOString().replace(/[-:.]/g, ""),
  folder = fs.mkdtempSync(path.join(root, "docs", ".compare", "global-web-live-")), bundle = path.join(folder, "production.mjs");
const { app } = await import("electron");
app.setPath("userData", path.join(folder, "userData"));
app.setPath("sessionData", path.join(folder, "sessionData"));
app.commandLine.appendSwitch("disable-background-networking");
app.disableHardwareAcceleration(); app.on("window-all-closed", () => undefined);
await app.whenReady();
await build({ stdin: { contents: [
  ['GlobalProxyRuntime', 'src/main/api/global-proxy-runtime.ts'],
  ['WindowsProxyStateReader', 'src/main/network/windows-proxy-state.ts'],
  ['WindowsNetworkFingerprintReader', 'src/main/network/windows-network-fingerprint.ts'],
  ['ClashReader', 'src/main/network/clash-reader.ts'],
].map(([name, file]) => `export { ${name} } from ${JSON.stringify(path.join(root, file))};`).join('\n'), resolveDir: root },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node24", external: ["node:*"], alias: { "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main") } });
const { GlobalProxyRuntime, WindowsProxyStateReader, WindowsNetworkFingerprintReader, ClashReader } = await import(pathToFileURL(bundle).href);
const proxyReader = new WindowsProxyStateReader(), networkReader = new WindowsNetworkFingerprintReader();
const controllerReader = new ClashReader({ controllerUrl: "http://127.0.0.1:9790", getSecret: () => null });
let proxyState = null, network = { available: false, hash: null }, observed = 0, generation = 1, stopped = false, timer, reading;
const result = { startedAt: new Date().toISOString(), runtime: process.versions.node, anonymousOnly: true,
  actualWindowsSource: true, actualMihomoSource: true, systemProxyChanged: false, realAccountUsed: false,
  browserPageCompatibilityTested: false, osReads: 0, targets: [], passed: false };
result.electron = process.versions.electron;
const checkpoint = () => fs.writeFileSync(path.join(folder, "checkpoint.json"), JSON.stringify(result, null, 2));
checkpoint();
const runtime = new GlobalProxyRuntime({
  configuration: () => ({ controllerUrl: "http://127.0.0.1:9790", proxyPort: 10090, credentialRevision: createHash("sha256").update("null").digest("hex") }),
  readSwitch: () => ({ proxy: performance.now() - observed < 10_000 && proxyState?.state === "active" ? "on" : "unknown", generation }),
  readNetwork: () => performance.now() - observed < 10_000 ? network : { available: false, hash: null },
  getSecret: () => null,
});
async function refresh() {
  reading = (async () => {
    const controller = await controllerReader.read().catch(() => null);
    const [nextProxy, nextNetwork] = await Promise.all([proxyReader.read(controller?.tun === true ? { mihomoTun: true } : {}), networkReader.read()]);
    if (stopped) return;
    if (proxyState && (proxyState.state !== nextProxy.state || network.hash !== nextNetwork.hash)) generation++;
    proxyState = nextProxy; network = nextNetwork; observed = performance.now(); result.osReads++;
    result.controllerReadable = controller !== null; result.controllerTun = controller?.tun ?? null;
    result.proxyReasons = nextProxy.reasons;
    runtime.observeController(controller?.fingerprint ?? null);
    runtime.sync();
  })();
  await reading;
  if (!stopped) timer = setTimeout(() => void refresh(), 2000);
}
const abort = new AbortController(); let eligibility;
try {
  await refresh(); result.proxyActivity = proxyState.state; result.networkAvailable = network.available;
  eligibility = await runtime.acquireEligibility("youtube", abort.signal);
  if (!eligibility?.isCurrent()) throw new Error("LIVE_PROXY_QUALIFICATION_UNAVAILABLE");
  checkpoint();
  const qualifiedAt = performance.now();
  result.qualificationDurationMs = Math.round(qualifiedAt - observed);
  eligibility.signal.addEventListener("abort", () => {
    result.eligibilityRevokedAfterMs = Math.round(performance.now() - qualifiedAt);
  }, { once: true });
  for (const [platformId, host] of [["x", "x.com"], ["youtube", "studio.youtube.com"], ["tiktok", "www.tiktok.com"]]) {
    const item = { platformId, host, permitGranted: false, tlsVerified: false, httpStatus: null, durationMs: 0,
      eligibilityCurrentBefore: eligibility.isCurrent() };
    result.targets.push(item);
    checkpoint();
    const start = performance.now(), requestAbort = new AbortController(); let tunnel, secure;
    try {
      const signal = AbortSignal.any([abort.signal, eligibility.signal, requestAbort.signal, AbortSignal.timeout(12_000)]);
      const assertCurrent = () => { if (signal.aborted || !eligibility.isCurrent()) throw new Error("LIVE_PROXY_REVOKED"); };
      tunnel = await runtime.openWebTunnel({ platformId, host, signal, assertCurrent }); item.permitGranted = true; checkpoint();
      secure = tls.connect({ socket: tunnel.stream, servername: host, rejectUnauthorized: true, minVersion: "TLSv1.2" });
      item.httpStatus = await new Promise((resolve, reject) => {
        let prefix = "";
        secure.once("secureConnect", () => {
          try { assertCurrent(); if (!secure.authorized) throw new Error("LIVE_TLS_UNVERIFIED");
            item.tlsVerified = true; secure.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: ClipDock-Anonymous-Diagnostic\r\n\r\n`);
          } catch (error) { reject(error); }
        });
        secure.on("data", (chunk) => {
          prefix += chunk.toString("latin1");
          const match = /^HTTP\/1\.[01] (\d{3}) /.exec(prefix);
          if (match) resolve(Number(match[1]));
          else if (prefix.length > 4096) reject(new Error("LIVE_RESPONSE_INVALID"));
        });
        secure.once("error", () => reject(new Error("LIVE_TLS_OR_ROUTE_FAILED")));
        secure.once("close", () => reject(new Error("LIVE_RESPONSE_CLOSED")));
      });
    } catch (error) { item.error = /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : "LIVE_TARGET_UNAVAILABLE"; }
    finally { secure?.destroy(); requestAbort.abort(); tunnel?.close(); await tunnel?.closed; item.durationMs = Math.round(performance.now() - start);
      item.eligibilityCurrentAfter = eligibility.isCurrent(); checkpoint(); }
  }
  result.passed = result.targets.length === 3 && result.targets.every((item) => item.permitGranted && item.tlsVerified && item.httpStatus !== null);
} catch (error) { result.error = /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : "LIVE_PROBE_UNAVAILABLE"; }
finally {
  stopped = true; clearTimeout(timer); abort.abort(); eligibility?.release(); runtime.invalidate();
  await reading;
  const cleanup = await Promise.allSettled([runtime.dispose(), proxyReader.dispose(), controllerReader.whenIdle()]);
  result.cleanupComplete = cleanup.every((item) => item.status === "fulfilled");
  result.completedAt = new Date().toISOString();
  const output = path.join(root, "docs", ".compare", `global-web-live-${stamp}.results.json`);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: result.passed, error: result.error, result: output }) + "\n");
  if (!result.passed || !result.cleanupComplete) process.exitCode = 1;
  app.exit(process.exitCode ?? 0);
}
