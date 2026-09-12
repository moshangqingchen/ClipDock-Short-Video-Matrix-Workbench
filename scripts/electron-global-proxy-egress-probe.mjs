/** Build only by default. --run-once invokes ONE production anonymous Cloudflare probe.
 * No account/bootstrap, application OAuth, Session, credentials or network-configuration writes.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), "..");
const controller = { host: "127.0.0.1", port: 9790 }, proxy = { host: "127.0.0.1", port: 10090 };
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const assert = (value, reason) => { if (!value) throw Error(reason); };
const safeError = (error) => /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message ?? "") ? error.message : "PROBE_UNAVAILABLE";
function projectSample(sample) {
  if (!sample) return null;
  const family = net.isIP(sample.ip);
  assert(family === 4 || family === 6, "SAMPLE_ADDRESS_INVALID");
  const canonical = family === 4 ? sample.ip : new URL(`https://[${sample.ip}]`).hostname.slice(1, -1);
  return {
    sampleId: sample.sampleId, generation: sample.generation, revision: sample.revision,
    countryCode: sample.countryCode, addressFamily: family === 4 ? "ipv4" : "ipv6",
    addressHash: sha(canonical), maskedIp: family === 4 ? canonical.split(".").slice(0, 2).join(".") + ".*.*" : canonical.split(":").slice(0, 2).join(":") + ":*",
    chainFingerprint: sample.chainFingerprint, controllerFingerprint: sample.controllerFingerprint,
    kernelOwner: sample.kernelOwner, observedAtMono: sample.observedAtMono, expiresAtMono: sample.expiresAtMono,
  };
}
function tempRoot(value) {
  const resolved = value ? path.resolve(value) : "";
  assert(path.dirname(resolved) === path.resolve(root, "docs/.compare") && path.basename(resolved).startsWith("global-proxy-egress-"), "ISOLATION_REQUIRED");
  return resolved;
}

if (!process.versions.electron) await parent();
else {
  // Only pre-ready setup is awaited at module scope; awaiting child().whenReady() here deadlocks Electron.
  const startup = await prepareChild();
  void child(startup).catch(() => startup.app.exit(1));
}

async function parent() {
  const run = process.argv.includes("--run-once");
  assert(process.argv.slice(2).every(arg => ["--run-once", "--build-only"].includes(arg)) && !(run && process.argv.includes("--build-only")), "INVALID_ARGUMENTS");
  const { build } = await import("esbuild"), { default: electron } = await import("electron");
  const base = path.join(root, "docs/.compare"); fs.mkdirSync(base, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(base, "global-proxy-egress-"));
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const reportFile = path.join(root, `docs/global-proxy-egress.${timestamp}.results.json`);
  let report = null, hashes = {}, childExit = null, watchdog = false;
  try {
    const outfile = path.join(temporary, "production.mjs");
    const built = await build({
      stdin: { contents: [
        "export {ProxyEgressProbe} from './src/main/api/proxy-egress-probe.ts';",
        "export {ProxyTunnelReader} from './src/main/api/proxy-tunnel-reader.ts';",
        "export {verifyProxyTunnelEvidence} from './src/main/api/proxy-tunnel-evidence.ts';",
        "export {GLOBAL_EGRESS_COUNTRIES} from './src/main/api/global-proxy-runtime.ts';",
      ].join("\n"), resolveDir: root, loader: "ts" },
      bundle: true, format: "esm", platform: "node", external: ["electron"], tsconfig: path.join(root, "tsconfig.electron.json"),
      outfile, metafile: true, logLevel: "silent",
    });
    hashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter(file => file.startsWith("src/")).map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    // A local redaction check only. Never import or execute bundled production code in build mode.
    const sample = projectSample({ ip: "203.0.113.10", countryCode: "JP" });
    assert(!JSON.stringify(sample).includes("203.0.113.10") && sample.maskedIp === "203.0.*.*", "REDACTION_CHECK_FAILED");
    if (!run) {
      console.log(JSON.stringify({ buildOnly: true, sourceFiles: Object.keys(hashes).length, productionImported: false, publicProbes: 0, controllerReads: 0 }));
      return;
    }
    const env = { ...process.env, CLIPDOCK_GLOBAL_EGRESS_PROBE_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, "--run-once"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => { watchdog = true; worker.kill(); }, 55_000);
    childExit = await new Promise(resolve => { worker.once("exit", code => resolve(code ?? 1)); worker.once("error", () => resolve(1)); });
    clearTimeout(timer);
    const checkpoint = path.join(temporary, "result.json");
    report = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, "utf8")) : { failure: "CHILD_NO_CHECKPOINT" };
  } catch (error) {
    if (run) report = { ...(report ?? {}), failure: safeError(error) };
    else { console.error(safeError(error)); process.exitCode = 1; }
  } finally {
    const resolved = tempRoot(temporary);
    let removed = false;
    try { fs.rmSync(resolved, { recursive: true, force: true }); removed = !fs.existsSync(resolved); } catch { /* exact private path; report failure */ }
    if (report) {
      report.scriptHash = sha(fs.readFileSync(script)); report.sourceHashes = hashes;
      report.sourceHashesStable = Object.entries(hashes).every(([file, digest]) => sha(fs.readFileSync(path.join(root, file))) === digest);
      report.parent = { childExit, watchdog, productionProbeBudget: 1 };
      report.temporaryDataRemoved = removed;
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
      console.log(JSON.stringify({ report: path.relative(root, reportFile), failure: report.failure, sample: report.sample, readerStages: report.readerStages, cleanup: report.cleanup, sourceHashesStable: report.sourceHashesStable, temporaryDataRemoved: removed }));
      process.exitCode = report.failure || childExit !== 0 || watchdog || !removed || !report.sourceHashesStable ? 1 : 0;
    } else if (!removed) { console.error("TEMPORARY_CLEANUP_FAILED"); process.exitCode = 1; }
  }
}

async function prepareChild() {
  const { app, BrowserWindow, webContents } = await import("electron");
  const temporary = tempRoot(process.env.CLIPDOCK_GLOBAL_EGRESS_PROBE_ROOT);
  assert(!app.isReady(), "STARTUP_TOO_LATE");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  return { app, BrowserWindow, webContents, temporary };
}
async function child({ app, BrowserWindow, webContents, temporary }) {
  const result = {
    executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, node: process.versions.node },
    target: { host: "www.cloudflare.com", port: 443 }, controller, proxy,
    experiment: { generation: 1, revision: "isolated-global-egress-v1", scope: "one-production-factory-sample-not-exclusive-switch-or-business-eligibility" },
    isolation: { ownTemporaryUserData: true, accountOrDatabaseRead: false, credentialProvided: false, sessionCreated: 0, webContentsCreated: 0, configurationChanged: false, tlsTrustModified: false, productionNetworkCallsModified: false },
    counts: { productionProbeCalls: 0, anonymousTunnelReads: 0 }, readerStages: [], sample: null,
    cleanup: { probeDrained: false, readerDrained: false, clientsDisposed: false, windows: null, webContents: null }, failure: null,
  };
  const save = () => fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
  save();
  const abort = new AbortController(); let reader, probe, generationValid = true;
  app.on("session-created", () => { result.isolation.sessionCreated++; abort.abort(); result.failure ??= "UNEXPECTED_SESSION"; save(); });
  app.on("web-contents-created", () => { result.isolation.webContentsCreated++; abort.abort(); result.failure ??= "UNEXPECTED_WEB_CONTENTS"; save(); });
  const version = { generation: result.experiment.generation, revision: result.experiment.revision };
  try {
    await app.whenReady();
    assert(process.versions.electron === "43.3.0", "RUNTIME_VERSION_MISMATCH");
    assert(BrowserWindow.getAllWindows().length === 0 && webContents.getAllWebContents().length === 0, "UNEXPECTED_WINDOW");
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    reader = new production.ProxyTunnelReader({ controllerUrl: "http://127.0.0.1:9790", proxy, getSecret: () => null, readVersion: () => generationValid ? version : null });
    const observedReader = {
      readAnonymousTunnel: async (context, signal) => {
        const stage = { phase: "after-verified-tls-before-anonymous-get", startedAtMono: performance.now(), completedAtMono: null, contextHash: sha(context.id), available: false, verified: false, evidenceExpiresAtMono: null, chainFingerprint: null, controllerFingerprint: null, ownerIdentityHash: null, metadata: null, failure: null };
        result.readerStages.push(stage); result.counts.anonymousTunnelReads++; save();
        try {
          const evidence = await reader.readAnonymousTunnel(context, signal);
          stage.available = evidence !== null;
          await reader.whenIdle();
          if (evidence) {
            const verified = production.verifyProxyTunnelEvidence({ context, evidence, controller, proxy, ...version, nowMono: performance.now(), readStartedAtMono: stage.startedAtMono });
            stage.verified = verified !== null;
            stage.evidenceExpiresAtMono = verified?.evidenceExpiresAtMono ?? null;
            stage.chainFingerprint = verified?.chainFingerprint ?? null;
            stage.controllerFingerprint = verified?.controllerFingerprint ?? null;
            stage.ownerIdentityHash = verified ? sha(JSON.stringify(verified.kernelOwner)) : null;
            stage.metadata = { generation: evidence.generation, revisionMatches: evidence.revision === version.revision, controllerFingerprintStable: evidence.controllerBefore.fingerprint === evidence.controllerAfter.fingerprint, modeBefore: evidence.controllerBefore.mode, modeAfter: evidence.controllerAfter.mode, scopedConnectionCount: evidence.connections.value.connections.length, controllerOwnerAvailable: evidence.controllerOwner.available, proxyOwnerAvailable: evidence.proxyOwner.available, proxyOwnerBasis: evidence.proxyOwner.available ? evidence.proxyOwner.basis : null };
          }
          return evidence;
        } catch (error) { stage.failure = safeError(error); throw error; }
        finally { stage.completedAtMono = performance.now(); save(); }
      },
      whenIdle: () => reader.whenIdle(),
    };
    probe = new production.ProxyEgressProbe({ proxy, controller, reader: observedReader, readVersion: () => generationValid ? version : null, allowedCountries: production.GLOBAL_EGRESS_COUNTRIES });
    result.counts.productionProbeCalls++; save();
    const sample = await probe.probe(abort.signal);
    result.sample = projectSample(sample); save();
    assert(sample !== null, "PROBE_UNAVAILABLE");
    assert(result.counts.productionProbeCalls === 1 && result.counts.anonymousTunnelReads === 1 && result.readerStages.every(stage => stage.verified), "PROBE_EVIDENCE_INCOMPLETE");
  } catch (error) { result.failure ??= safeError(error); save(); }
  finally {
    generationValid = false; abort.abort(); probe?.invalidate(); reader?.invalidate();
    try {
      await probe?.whenIdle(); result.cleanup.probeDrained = true; save();
      await reader?.whenIdle(); result.cleanup.readerDrained = true; save();
      const disposed = await Promise.allSettled([probe?.dispose(), reader?.dispose()]);
      result.cleanup.clientsDisposed = disposed.every(item => item.status === "fulfilled");
      if (!result.cleanup.clientsDisposed) result.failure ??= "CLEANUP_FAILED";
    } catch { result.failure ??= "CLEANUP_FAILED"; }
    result.cleanup.windows = BrowserWindow.getAllWindows().length;
    result.cleanup.webContents = webContents.getAllWebContents().length;
    if (result.cleanup.windows || result.cleanup.webContents || result.isolation.sessionCreated) result.failure ??= "ISOLATION_FAILED";
    save(); app.exit(result.failure ? 1 : 0);
  }
}
