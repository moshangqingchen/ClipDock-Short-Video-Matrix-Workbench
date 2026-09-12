/** Isolated, read-only current selected-client loader test. No old report is an input. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const resultPath = path.join(root, "docs/network-selected-client-config-live.results.json");
const resources = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\MAOMAOYUNAPP\\resources";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const assert = (value, code) => { if (!value) throw Error(code); };
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild");
  const { spawn } = await import("node:child_process");
  const { default: electron } = await import("electron");
  const parentDirectory = path.join(root, "docs/.compare");
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "selected-client-smoke-"));
  try {
    const built = await build({ stdin: { contents: [
      "export { SelectedClientConfig } from './src/main/network/selected-client-config.ts';",
      "export { SELECTED_CLIENT_PROFILE, selectedClientDecoder } from './src/main/network/selected-client-protocol.ts';",
      "export { ClashReader } from './src/main/network/clash-reader.ts';",
    ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm",
      external: ["electron", "node:*"], tsconfig: path.join(root, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const inputs = Object.keys(built.metafile.inputs);
    assert(!inputs.some(value => /(?:babel|@electron\/asar|typescript|node:vm)/.test(value)), "UNEXPECTED_RUNTIME_DEPENDENCY");
    const hashes = Object.fromEntries(inputs.filter(file => file.startsWith("src/"))
      .map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    const environment = { ...process.env, CLIPDOCK_SELECTED_CLIENT_SMOKE_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => worker.kill(), 25000);
    const code = await new Promise(resolve => { worker.once("exit", value => resolve(value ?? 1)); worker.once("error", () => resolve(1)); });
    clearTimeout(timer);
    assert(fs.existsSync(path.join(temporary, "result.json")), "CHILD_RESULT_UNAVAILABLE");
    const result = JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"));
    result.sourceHashes = hashes;
    result.sourceHashesStable = Object.entries(hashes).every(([file, value]) => sha(fs.readFileSync(path.join(root, file))) === value);
    result.scriptHash = sha(fs.readFileSync(script));
    result.bundleHasExplorationRuntimeDependencies = false;
    if (fs.existsSync(resultPath)) {
      const previous = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const suffix = previous.executedAt.replace(/[^0-9TZ]/g, "");
      fs.copyFileSync(resultPath, resultPath.replace(".results.json", `.${suffix}.results.json`));
    }
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ selection: result.selection, source: result.source, checks: result.checks,
      counts: result.counts, sourceHashesStable: result.sourceHashesStable, failure: result.failure ?? null }, null, 2));
    process.exitCode = code || (result.sourceHashesStable ? 0 : 1);
  } catch (error) { console.error(/^[A-Z_]{1,100}$/.test(error.message) ? error.message : "SELECTED_CLIENT_SMOKE_FAILED"); process.exitCode = 1; }
  finally {
    const resolved = path.resolve(temporary);
    assert(path.dirname(resolved) === path.resolve(parentDirectory) && path.basename(resolved).startsWith("selected-client-smoke-"), "UNSAFE_TEMPORARY_PATH");
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Isolated data is never reused. */ }
  }
}
async function child() {
  const { app, net, session } = await import("electron");
  const temporary = process.env.CLIPDOCK_SELECTED_CLIENT_SMOKE_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
    path.basename(temporary).startsWith("selected-client-smoke-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData")); app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND"); app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const result = { executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome },
    isolation: { temporaryUserData: true, accountCreated: false, configurationChanged: false, publicHttpRequests: false,
      previousReportUsedAsInput: false, vendorCodeExecuted: false, decoderMaterialPersisted: false, productionBootstrapChanged: false },
    counts: { controllerRequests: 0, controllerReads: 0, sessionCreations: 0, electronRequests: 0 }, checks: [],
    selectedClientVersion: null, selection: null, source: null, permissionIssued: false, pathQualificationCreated: false };
  const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); assert(value, name); };
  let factory;
  try {
    await app.whenReady();
    const { default: http } = await import("node:http");
    const { syncBuiltinESMExports } = await import("node:module");
    const request = http.request;
    http.request = function(options, callback) {
      assert(options.hostname === "127.0.0.1" && Number(options.port) === 9790 && options.method === "GET", "NON_CONTROLLER_REQUEST");
      assert(!Object.keys(options.headers ?? {}).some(key => /cookie|authorization/i.test(key)), "UNEXPECTED_AUTH_HEADER");
      result.counts.controllerRequests++; return request.call(this, options, callback);
    };
    syncBuiltinESMExports();
    session.fromPartition = () => { result.counts.sessionCreations++; throw Error("SESSION_FORBIDDEN"); };
    net.request = () => { result.counts.electronRequests++; throw Error("ELECTRON_REQUEST_FORBIDDEN"); };
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    result.selectedClientVersion = production.SELECTED_CLIENT_PROFILE.version;
    result.artifactPreflight = [];
    for (const [kind, file] of [["resources", resources], ["archive", path.join(resources, "app.asar")],
      ["extra", path.join(resources, "extra")], ["config", path.join(resources, "extra/config.yaml")]]) {
      try {
        const resolved = await fs.promises.realpath(file), stat = await fs.promises.lstat(file);
        result.artifactPreflight.push({ kind, pathUnchanged: path.normalize(file).toLowerCase() === path.normalize(resolved).toLowerCase(),
          file: stat.isFile(), directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink() });
      } catch { result.artifactPreflight.push({ kind, available: false }); }
    }
    for (const [kind, file, expected] of [["package", path.join(resources, "app.asar/package.json"), production.SELECTED_CLIENT_PROFILE.packageSha256],
      ["main", path.join(resources, "app.asar/src/main/main.js"), production.SELECTED_CLIENT_PROFILE.mainSha256]]) {
      let handle;
      try {
        handle = await fs.promises.open(file, "r"); const info = await handle.stat();
        assert(info.size > 0 && info.size < 1024 * 1024, "ARTIFACT_LIMIT");
        const bytes = Buffer.alloc(info.size); const read = await handle.read(bytes, 0, bytes.length, 0);
        const record = { kind, available: true, bytes: read.bytesRead, digestMatches: sha(bytes) === expected };
        if (kind === "main") { try { production.selectedClientDecoder(bytes).dispose(); record.decoderConstructed = true; } catch { record.decoderConstructed = false; } }
        bytes.fill(0); result.artifactPreflight.push(record);
      } catch(error) { result.artifactPreflight.push({ kind, available: false, code: /^[A-Z_]{1,64}$/.test(error.code ?? "") ? error.code : "ARTIFACT_UNAVAILABLE" }); }
      finally { await handle?.close(); }
    }
    const configFile = path.join(resources, "extra/config.yaml");
    const configHash = () => { const info = fs.statSync(configFile); assert(info.isFile() && info.size < 8 * 1024 * 1024, "CONFIG_SIZE_INVALID"); return sha(fs.readFileSync(configFile)); };
    const beforeHash = configHash();
    const reader = new production.ClashReader({ controllerUrl: "http://127.0.0.1:9790", getSecret: () => null });
    let observed;
    factory = new production.SelectedClientConfig({ resourcesPath: resources, readController: async signal => {
      result.counts.controllerReads++; return observed = await reader.read(signal);
    } });
    check("STARTS_WITHOUT_SELECTION", factory.getSelectedLoader() === null && factory.getSnapshot().state === "checking");
    const loader = await factory.select();
    result.selection = loader ? { selected: true, profile: loader.loaderProfileId, selectedAtMono: loader.selectedAtMono,
      sourcePathIdentity: loader.sourcePathIdentity, decoderIdentity: loader.decoderIdentity, currentQualificationReferences: loader.qualificationEvidenceIds.length } :
      { selected: false, state: factory.getSnapshot().state, reason: factory.getSnapshot().reason ?? null };
    check("CURRENT_NATIVE_ASAR_PINNED_SELECTION", loader !== null);
    check("SELECTION_DOES_NOT_READ_CONTROLLER", result.counts.controllerRequests === 0);
    const candidate = await factory.read();
    result.source = candidate.state === "candidate" ? { state: "candidate", kind: candidate.candidate.kind,
      runtimeConfigurationProven: candidate.candidate.runtimeConfigurationProven, ruleCount: candidate.candidate.comparedRuleCount,
      startedAtMono: candidate.candidate.startedAtMono, completedAtMono: candidate.candidate.completedAtMono,
      expiresAtMono: candidate.candidate.expiresAtMono, controllerFingerprint: candidate.candidate.controllerFingerprint,
      mode: observed?.mode, tun: observed?.tun, kernelVersion: observed?.version,
      selectedPathMatches: candidate.candidate.sourcePathIdentity === loader.sourcePathIdentity } :
      { state: candidate.state, reason: candidate.reason ?? null };
    check("CURRENT_DECODE_AND_CONTROLLER_COMPARISON", candidate.state === "candidate");
    check("SELECTED_BEFORE_OBSERVATION", loader.selectedAtMono <= candidate.candidate.startedAtMono);
    check("SOURCE_PATH_MATCHES_SELECTION", candidate.candidate.sourcePathIdentity === loader.sourcePathIdentity);
    check("CANDIDATE_IS_NOT_RUNTIME_ATTESTATION", candidate.candidate.runtimeConfigurationProven === false);
    check("CURRENT_CONFIG_NOT_MODIFIED", beforeHash === configHash());
    check("NO_SESSION_OR_ELECTRON_NETWORK", result.counts.sessionCreations === 0 && result.counts.electronRequests === 0);
    factory.invalidate(); check("INVALIDATE_WITHDRAWS_SELECTION", factory.getSelectedLoader() === null);
    factory.dispose(); const afterCount = result.counts.controllerRequests;
    check("DISPOSE_CANNOT_RESELECT", await factory.select() === null && (await factory.read()).state === "unavailable");
    check("DISPOSE_DOES_NOT_READ_CONTROLLER", afterCount === result.counts.controllerRequests);
  } catch (error) { result.failure = /^[A-Z_]{1,100}$/.test(error.message) ? error.message : "READ_ONLY_SMOKE_UNAVAILABLE"; }
  finally {
    factory?.dispose(); result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); app.exit(result.failure ? 1 : 0);
  }
}
