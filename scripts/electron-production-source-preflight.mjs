/** Read-only live-controller preflight. No real anonymous samplers, account Session or permission issuer. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const outputPath = path.join(repository, "docs/network-production-source-preflight.results.json");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const assert = (condition, code) => { if (!condition) throw new Error(code); };
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild");
  const { spawn } = await import("node:child_process");
  const { default: electron } = await import("electron");
  const parentDirectory = path.join(repository, "docs/.compare");
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "production-preflight-"));
  try {
    const built = await build({ stdin: { contents: [
      "export {ClashReader} from './src/main/network/clash-reader.ts';",
      "export {ProductionProofSource} from './src/main/network/production-proof-source.ts';",
      "export {resolveOperationCatalog} from './src/main/network/operation-catalog.ts';",
      "export {evaluateRules} from './src/main/network/rules.ts';",
    ].join("\n"), resolveDir: repository, loader: "ts" }, platform: "node", format: "esm", bundle: true,
      external: ["electron"], tsconfig: path.join(repository, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const hashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter((file) => file.startsWith("src/"))
      .map((file) => [file, sha(fs.readFileSync(path.join(repository, file)))]));
    const environment = { ...process.env, CLIPDOCK_PRODUCTION_PREFLIGHT_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], { cwd: repository, env: environment, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => worker.kill(), 25_000);
    const code = await new Promise((resolve) => {
      worker.once("exit", (value) => resolve(value ?? 1)); worker.once("error", () => resolve(1));
    });
    clearTimeout(timer);
    assert(fs.existsSync(path.join(temporary, "result.json")), "PREFLIGHT_CHILD_NO_RESULT");
    const result = JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"));
    result.sourceHashes = hashes;
    result.scriptHash = sha(fs.readFileSync(script));
    result.sourcesUnchanged = Object.entries(hashes).every(([file, hash]) => sha(fs.readFileSync(path.join(repository, file))) === hash);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ controllerStable: result.controllerStable, sourceResult: result.sourceResult,
      sourceController: result.sourceController, counts: result.counts, checks: result.checks,
      failure: result.failure ?? null, sourcesUnchanged: result.sourcesUnchanged }, null, 2));
    process.exitCode = code || (result.sourcesUnchanged ? 0 : 1);
  } catch (error) {
    console.error(/^[A-Z_]{1,100}$/.test(error.message) ? error.message : "PREFLIGHT_FAILED");
    process.exitCode = 1;
  } finally {
    const resolved = path.resolve(temporary);
    assert(path.dirname(resolved) === path.resolve(parentDirectory) && path.basename(resolved).startsWith("production-preflight-"), "UNSAFE_TEMPORARY_PATH");
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Never reuse isolated data. */ }
  }
}

async function child() {
  const { app } = await import("electron");
  const temporary = process.env.CLIPDOCK_PRODUCTION_PREFLIGHT_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(repository, "docs/.compare") &&
    path.basename(temporary).startsWith("production-preflight-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
  app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  const result = { executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged },
    isolation: { temporaryUserData: true, accountCreated: false, accountSessionCreated: false,
      accountCookieAccessed: false, cookieOrTokenProvided: false, productionAppOpened: false,
      configurationChanged: false, productionReviewChanged: false, productionEnforcementChanged: false,
      reviewedScopeFixtureOnly: true, anonymousSamplersInstantiated: false, permitIssuerInstantiated: false,
      allowedController: "http://127.0.0.1:9790", controllerSecretRead: false },
    scope: null, controllerBefore: null, controllerAfter: null, sourceController: null, controllerStable: false,
    counts: { readController: 0, inputs: 0, conformanceRead: 0, bindSamples: 0, tls: 0, egress: 0 },
    sourceResult: null, checks: [] };
  let source;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  const check = (name, condition) => { result.checks.push({ name, passed: !!condition }); assert(condition, name); };
  try {
    await app.whenReady();
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    const reader = new production.ClashReader({ controllerUrl: "http://127.0.0.1:9790", getSecret: () => null });
    const required = [
      { host: "api.bilibili.com", role: "business", families: ["ipv4", "ipv6"] },
      { host: "myip.ipip.net", role: "egress-echo", families: ["ipv4"] },
      { host: "api6.ipify.org", role: "egress-echo", families: ["ipv6"] },
    ];
    const summarize = (value) => ({ mode: value.mode, tun: value.tun, version: value.version,
      fingerprint: value.fingerprint, startedAtMono: value.startedAtMono, completedAtMono: value.completedAtMono,
      directPolicy: value.directPolicy ? { kind: value.directPolicy.kind, dialer: value.directPolicy.dialer } : null,
      targets: required.map((target) => {
        const decision = production.evaluateRules(value.mode, value.rules, { host: target.host, port: 443, network: "tcp" });
        return { ...target, port: 443, protocol: "https:", decision: { ...decision,
          ruleType: decision.ruleType === null || /^[A-Za-z0-9_-]{1,32}$/.test(decision.ruleType) ? decision.ruleType : "unsupported" } };
      }) });
    const before = await reader.read(); result.controllerBefore = summarize(before);
    const catalog = production.resolveOperationCatalog({ platformId: "bilibili", operation: "check-status", activePageOrigin: null });
    assert(catalog.requiredOrigins.length === 1 && catalog.requiredOrigins[0].host === "api.bilibili.com", "SOURCE_SCOPE_CHANGED");
    const scope = { accountId: "preflight-no-account", platformId: "bilibili", contextId: "preflight-no-session-fixture",
      catalogVersion: `preflight-only:${catalog.selectionKey}`, catalogReviewed: true,
      targets: ["ipv4", "ipv6"].map((addressFamily) => ({ protocol: "https:", host: "api.bilibili.com", port: 443, addressFamily })) };
    result.scope = { platformId: scope.platformId, operation: catalog.operation, activePageOrigin: null,
      sourceVersion: catalog.sourceVersion, selectionKey: catalog.selectionKey, productionFlowReviewed: catalog.flowReviewed,
      testCatalogReviewed: true, targetCount: scope.targets.length, targets: scope.targets };
    const version = { generation: 1, rulesVersion: before.fingerprint };
    source = new production.ProductionProofSource({
      readController: async () => { result.counts.readController++; const current = await reader.read(); result.sourceController = summarize(current); return current; },
      readVersion: () => version,
      inputs: { read: async () => { result.counts.inputs++; const at = performance.now(); return { state: "unavailable", reason: "SOURCE_UNAVAILABLE", startedAtMono: at, completedAtMono: at }; } },
      conformance: {
        read: async () => { result.counts.conformanceRead++; return null; },
        bindSamples: async () => { result.counts.bindSamples++; return null; },
      },
      tls: { probeTls: async () => { result.counts.tls++; return { available: false, reason: "CONTEXT_UNVERIFIED" }; } },
      egress: { probe: async () => { result.counts.egress++; return { available: false, reason: "CONTEXT_UNVERIFIED" }; } },
    });
    const outcome = await source.collect({ ...version, scope, requestId: "preflight-" + crypto.randomUUID(), startedAtMono: performance.now(), signal: abort.signal });
    result.sourceResult = outcome.kind === "unavailable" ? { kind: outcome.kind, reason: outcome.reason } : { kind: "unexpected-evidence" };
    check("source_never_returns_evidence", outcome.kind === "unavailable");
    check("anonymous_and_conformance_providers_never_reached", result.counts.conformanceRead === 0 && result.counts.bindSamples === 0 && result.counts.tls === 0 && result.counts.egress === 0);
    const current = result.sourceController;
    if (current?.fingerprint === before.fingerprint && current.mode === "rule" && current.directPolicy?.kind === "direct" && current.directPolicy.dialer === "none" &&
      current.targets[0].decision.route === "direct" && current.targets.slice(1).some((target) => target.decision.route === "unknown")) {
      check("uninterpretable_echo_rules_reject_before_path_inputs", outcome.kind === "unavailable" && outcome.reason === "RULE_UNVERIFIABLE" && result.counts.inputs === 0);
    }
    const after = await reader.read(); result.controllerAfter = summarize(after);
    result.controllerStable = before.fingerprint === after.fingerprint && current?.fingerprint === before.fingerprint;
  } catch (error) {
    const message = String(error?.message ?? "");
    result.failure = /^[A-Za-z0-9_]{1,100}$/.test(message) ? message : "PREFLIGHT_UNAVAILABLE";
  } finally {
    clearTimeout(timer); abort.abort(); source?.dispose();
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
    app.exit(result.failure ? 1 : 0);
  }
}
