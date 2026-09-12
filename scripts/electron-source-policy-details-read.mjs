/** One current local-source projection only. No controller read or historical report input. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const resources = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\MAOMAOYUNAPP\\resources";
const resultPath = path.join(root, "docs/network-source-policy-details-live.results.json");
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
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "source-policy-details-"));
  try {
    const built = await build({ stdin: { contents: [
      "export { SelectedClientConfig } from './src/main/network/selected-client-config.ts';",
      "export { SELECTED_CLIENT_PROFILE, selectedClientDecoder } from './src/main/network/selected-client-protocol.ts';",
      "export { projectSourcePolicyDetails, querySourcePolicyTarget } from './src/main/network/source-policy-details.ts';",
      "export { load, CORE_SCHEMA } from 'js-yaml';",
    ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm",
      external: ["electron", "node:*"], tsconfig: path.join(root, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const hashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter(file => file.startsWith("src/"))
      .map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    const environment = { ...process.env, CLIPDOCK_POLICY_DETAILS_ROOT: temporary };
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
    if (fs.existsSync(resultPath)) {
      const previous = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      assert(typeof previous.executedAt === "string", "PREVIOUS_RESULT_INVALID");
      fs.copyFileSync(resultPath, resultPath.replace(".results.json", `.${previous.executedAt.replace(/[^0-9TZ]/g, "")}.results.json`));
    }
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ executedAt: result.executedAt, checks: result.checks, counts: result.counts,
      policy: result.policy, sourceHashesStable: result.sourceHashesStable, failure: result.failure ?? null }, null, 2));
    process.exitCode = code || (result.sourceHashesStable ? 0 : 1);
  } catch (error) {
    console.error(/^[A-Z_]{1,100}$/.test(error.message) ? error.message : "POLICY_DETAILS_LOCAL_READ_FAILED");
    process.exitCode = 1;
  } finally {
    const resolved = path.resolve(temporary);
    assert(path.dirname(resolved) === path.resolve(parentDirectory) && path.basename(resolved).startsWith("source-policy-details-"), "UNSAFE_TEMPORARY_PATH");
    assert(fs.realpathSync.native(resolved).toLowerCase() === resolved.toLowerCase(), "TEMPORARY_PATH_CHANGED");
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Exact isolated fixture only; no retry. */ }
  }
}

async function child() {
  const { app, net, session } = await import("electron");
  const temporary = process.env.CLIPDOCK_POLICY_DETAILS_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
    path.basename(temporary).startsWith("source-policy-details-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
  app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  const result = { executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron },
    readOnly: true, controllerRuntimeCompared: false, candidateCreated: false, permissionIssued: false,
    configurationChanged: false, decoderMaterialPersisted: false, previousReportUsedAsInput: false,
    counts: { controllerReads: 0, networkAttempts: 0, accountSessionCreations: 0 }, checks: [], policy: null };
  const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); assert(value, name); };
  let factory, decoder, mainBytes, beforeBytes, afterBytes;
  try {
    await app.whenReady();
    const { default: http } = await import("node:http"), { default: https } = await import("node:https");
    const { syncBuiltinESMExports } = await import("node:module");
    const forbiddenNetwork = () => { result.counts.networkAttempts++; throw Error("NETWORK_FORBIDDEN"); };
    http.request = forbiddenNetwork; http.get = forbiddenNetwork;
    https.request = forbiddenNetwork; https.get = forbiddenNetwork;
    globalThis.fetch = forbiddenNetwork; net.request = forbiddenNetwork; net.fetch = forbiddenNetwork;
    syncBuiltinESMExports();
    session.fromPartition = () => { result.counts.accountSessionCreations++; throw Error("SESSION_FORBIDDEN"); };
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    factory = new production.SelectedClientConfig({ resourcesPath: resources, readController: async () => {
      result.counts.controllerReads++; throw Error("CONTROLLER_READ_FORBIDDEN");
    } });
    const loader = await factory.select();
    check("CURRENT_SUPPORTED_LOADER_SELECTED_WITHOUT_CONTROLLER", loader !== null && result.counts.controllerReads === 0);
    const configFile = path.join(resources, "extra/config.yaml");
    const boundedRead = async (file, maxBytes) => {
      const before = await fs.promises.stat(file);
      assert(before.isFile() && before.size > 0 && before.size <= maxBytes, "LOCAL_FILE_LIMIT");
      const bytes = await fs.promises.readFile(file), after = await fs.promises.stat(file);
      assert(before.size === bytes.length && after.size === before.size && after.mtimeMs === before.mtimeMs, "LOCAL_FILE_CHANGED");
      return bytes;
    };
    mainBytes = await boundedRead(path.join(resources, "app.asar/src/main/main.js"), 1024 * 1024);
    check("CURRENT_DECODER_SOURCE_PROFILE_MATCH", sha(mainBytes) === production.SELECTED_CLIENT_PROFILE.mainSha256);
    beforeBytes = await boundedRead(configFile, 8 * 1024 * 1024);
    decoder = production.selectedClientDecoder(mainBytes);
    const decoded = production.load(decoder.decode(beforeBytes, new AbortController().signal), { schema: production.CORE_SCHEMA });
    const details = production.projectSourcePolicyDetails(decoded);
    const summary = list => ({ state: list.state, retainedCount: list.entries.length, complete: list.complete,
      unsupportedCount: list.unsupportedCount, truncated: list.truncated });
    const queried = host => Object.fromEntries(Object.entries(production.querySourcePolicyTarget(details, host))
      .map(([key, value]) => [key, { state: value.state, matchedCount: value.matches.length, complete: value.complete }]));
    result.policy = {
      dns: { fakeIpRange: details.dns.fakeIpRange, fakeIpRange6: details.dns.fakeIpRange6,
        fakeIpFilterMode: details.dns.fakeIpFilterMode, fakeIpFilter: summary(details.dns.fakeIpFilter) },
      hosts: summary(details.hosts),
      sniffer: { forceDomain: summary(details.sniffer.forceDomain), skipDomain: summary(details.sniffer.skipDomain),
        skipSrcAddress: summary(details.sniffer.skipSrcAddress), skipDstAddress: summary(details.sniffer.skipDstAddress),
        protocols: Object.fromEntries(Object.entries(details.sniffer.protocols).map(([key, value]) => [key, {
          state: value.state, ports: summary(value.ports), overrideDestination: value.overrideDestination,
          complete: value.complete, unsupportedCount: value.unsupportedCount,
        }])), protocolsComplete: details.sniffer.protocolsComplete,
        unsupportedProtocolCount: details.sniffer.unsupportedProtocolCount },
      targets: ["api.bilibili.com", "myip.ipip.net", "api6.ipify.org"].map(host => ({ host, ...queried(host) })),
    };
    afterBytes = await boundedRead(configFile, 8 * 1024 * 1024);
    check("CURRENT_CONFIG_BYTES_UNCHANGED", beforeBytes.equals(afterBytes));
    check("NO_NETWORK_OR_CONTROLLER_READ", result.counts.controllerReads === 0 && result.counts.networkAttempts === 0);
    check("NO_ACCOUNT_SESSION_CREATED", result.counts.accountSessionCreations === 0);
    check("SOURCE_POLICY_IS_NOT_CANDIDATE_OR_PERMIT", !Object.hasOwn(details, "runtimeConfigurationProven") && !Object.hasOwn(details, "route"));
  } catch (error) {
    result.failure = /^[A-Z_]{1,100}$/.test(error.message) ? error.message : "LOCAL_POLICY_READ_UNAVAILABLE";
  } finally {
    decoder?.dispose(); factory?.dispose(); mainBytes?.fill(0); beforeBytes?.fill(0); afterBytes?.fill(0);
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
    app.exit(result.failure ? 1 : 0);
  }
}
