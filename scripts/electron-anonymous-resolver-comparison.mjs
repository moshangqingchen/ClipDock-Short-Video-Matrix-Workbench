/** One bounded api.bilibili.com DNS comparison; no business HTTP or account Session. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isIP, BlockList } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), "..");
const host = "api.bilibili.com", controllerUrl = "http://127.0.0.1:9790";
const resources = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\MAOMAOYUNAPP\\resources";
const resultPath = path.join(root, "docs/network-anonymous-resolver-comparison.results.json");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const assert = (value, code) => { if (!value) throw Error(code); };
const safeError = error => /^[A-Z_]{1,80}$/.test(error?.code ?? "") ? error.code
  : /^ERR_[A-Z_]{1,70}$/.test(error?.message?.match(/ERR_[A-Z_]+/)?.[0] ?? "") ? error.message.match(/ERR_[A-Z_]+/)[0]
  : /^[A-Z_]{1,80}$/.test(error?.message ?? "") ? error.message : "READ_UNAVAILABLE";
const canonicalIp = value => isIP(value) === 4 ? value : isIP(value) === 6 && !value.includes("%")
  ? new URL(`http://[${value}]`).hostname.slice(1, -1) : null;
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild"), { spawn } = await import("node:child_process"), { default: electron } = await import("electron");
  const parentDirectory = path.join(root, "docs/.compare");
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "resolver-comparison-"));
  try {
    const built = await build({ stdin: { contents: [
      "export { SelectedClientConfig } from './src/main/network/selected-client-config.ts';",
      "export { ClashReader } from './src/main/network/clash-reader.ts';",
      "export { WindowsControllerOwnerReader } from './src/main/network/windows-controller-owner.ts';",
      "export { WindowsNetworkFingerprintReader } from './src/main/network/windows-network-fingerprint.ts';",
      "export { WindowsSystemHostsReader } from './src/main/network/windows-system-hosts.ts';",
      "export { ensureDirectSession, isDirectSessionReady } from './src/main/network/direct-session.ts';",
      "export { configureAnonymousCredentials } from './src/main/network/anonymous-session-privacy.ts';",
      "export { configureChromiumTransport } from './src/main/network/chromium-transport.ts';",
      "export { classifyCurrentKernelDnsAddress } from './src/main/network/kernel-dns-address-policy.ts';",
    ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", external: ["electron", "node:*"],
      tsconfig: path.join(root, "tsconfig.electron.json"), outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const hashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter(file => file.startsWith("src/"))
      .map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    const env = { ...process.env, CLIPDOCK_RESOLVER_COMPARISON_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => worker.kill(), 45_000);
    const code = await new Promise(resolve => { worker.once("exit", value => resolve(value ?? 1)); worker.once("error", () => resolve(1)); });
    clearTimeout(timer);
    assert(fs.existsSync(path.join(temporary, "result.json")), "CHILD_RESULT_UNAVAILABLE");
    const result = JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"));
    result.sourceHashes = hashes;
    result.sourceHashesStable = Object.entries(hashes).every(([file, value]) => sha(fs.readFileSync(path.join(root, file))) === value);
    result.scriptHash = sha(fs.readFileSync(script));
    if (!result.sourceHashesStable) { result.comparisons = null; result.conclusionsRetained = false; }
    if (fs.existsSync(resultPath)) {
      const previous = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      fs.copyFileSync(resultPath, resultPath.replace(".results.json", `.${previous.executedAt.replace(/[^0-9TZ]/g, "")}.results.json`));
    }
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ executedAt: result.executedAt, counts: result.counts, checks: result.checks,
      stable: result.stable, chromium: result.chromium, kernel: result.kernel, comparisons: result.comparisons,
      conclusionsRetained: result.conclusionsRetained, sourceHashesStable: result.sourceHashesStable, failure: result.failure ?? null }, null, 2));
    process.exitCode = code || (result.sourceHashesStable ? 0 : 1);
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
  finally {
    const resolved = path.resolve(temporary);
    assert(path.dirname(resolved) === path.resolve(parentDirectory) && path.basename(resolved).startsWith("resolver-comparison-"), "UNSAFE_TEMPORARY_PATH");
    assert(fs.realpathSync.native(resolved).toLowerCase() === resolved.toLowerCase(), "TEMPORARY_PATH_CHANGED");
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Exact isolated fixture, no retry. */ }
  }
}

async function child() {
  const { app, net, session } = await import("electron");
  const temporary = process.env.CLIPDOCK_RESOLVER_COMPARISON_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
    path.basename(temporary).startsWith("resolver-comparison-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData")); app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  const transport = production.configureChromiumTransport(app);
  const result = { executedAt: new Date().toISOString(), target: host,
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, transport },
    isolation: { temporaryUserData: true, accountSessionReused: false, configurationChanged: false, osConfigurationChanged: false,
      scriptedBusinessOrPublicHttp: false, internalResolverTransportObserved: false, historicalReportInput: false },
    counts: { controllerRequests: 0, controllerReads: 0, kernelQueries: 0, chromiumQueries: 0, blockedHttpAttempts: 0 },
    checks: [], initialization: [], chromium: [], kernel: [], comparisons: null, stable: null,
    conclusionsRetained: false, resolverEquivalenceQualified: false, fetchResolutionProven: false, permitIssued: false };
  const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); assert(value, name); };
  let factory, owner, systemHosts, ses, currentController, loader;
  const deadline = new AbortController();
  const timer = setTimeout(() => { deadline.abort(); result.failure = "EXPERIMENT_TIMEOUT";
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); app.exit(1); }, 40_000);
  try {
    await app.whenReady();
    const { default: http } = await import("node:http"), { default: https } = await import("node:https");
    const { syncBuiltinESMExports } = await import("node:module");
    const originalRequest = http.request;
    http.request = function(options, callback) {
      const target = new URL(options.path, controllerUrl);
      const fixed = ["/configs", "/rules", "/version", "/proxies/DIRECT"].includes(target.pathname) && !target.search;
      const dns = target.pathname === "/dns/query" && target.searchParams.get("name") === host &&
        ["A", "AAAA"].includes(target.searchParams.get("type")) && [...target.searchParams.keys()].length === 2;
      assert(options.hostname === "127.0.0.1" && Number(options.port) === 9790 && options.method === "GET" && (fixed || dns), "HTTP_SCOPE_INVALID");
      assert(!Object.keys(options.headers ?? {}).some(key => /cookie|authorization/i.test(key)), "HTTP_AUTH_FORBIDDEN");
      result.counts.controllerRequests++; return originalRequest.call(this, options, callback);
    };
    const forbid = () => { result.counts.blockedHttpAttempts++; throw Error("PUBLIC_HTTP_FORBIDDEN"); };
    http.get = forbid; https.request = forbid; https.get = forbid; globalThis.fetch = forbid; net.request = forbid; net.fetch = forbid;
    syncBuiltinESMExports();
    const reader = new production.ClashReader({ controllerUrl, getSecret: () => null });
    factory = new production.SelectedClientConfig({ resourcesPath: resources, readController: async () => {
      result.counts.controllerReads++; return currentController = await reader.read();
    } });
    owner = new production.WindowsControllerOwnerReader({ controllerUrl });
    systemHosts = new production.WindowsSystemHostsReader();
    const network = new production.WindowsNetworkFingerprintReader();
    loader = await factory.select(); check("CURRENT_SUPPORTED_LOADER_SELECTED", loader !== null);
    const snapshot = async () => {
      const [source, kernelOwner, os, hosts] = await Promise.all([
        factory.read(), owner.read(deadline.signal), network.readObservation(), systemHosts.read([host], deadline.signal),
      ]);
      check("CURRENT_SOURCE_AND_ENVIRONMENT_AVAILABLE", source.state === "candidate" && kernelOwner.available && os.available && hosts.available);
      return { source: source.candidate, kernelOwner, os, hosts, controller: currentController };
    };
    const before = await snapshot();
    result.before = { sourceStartedAtMono: before.source.startedAtMono, sourceExpiresAtMono: before.source.expiresAtMono,
      controllerVersion: before.controller.fingerprint, sourceFileFingerprint: before.source.fileFingerprint,
      effectivePolicyFingerprint: before.source.policy.fingerprint, kernelEpoch: before.kernelOwner.kernelEpoch,
      osHash: before.os.hash, systemHostsHash: before.hosts.fileHash,
      systemHostsTargetMatchCount: before.hosts.hosts[0].ipv4.length + before.hosts.hosts[0].ipv6.length };
    const address = (raw, candidate, controllerVersion, now) => {
      const normalized = canonicalIp(raw); assert(normalized !== null, "ADDRESS_INVALID");
      const family = isIP(normalized) === 4 ? "ipv4" : "ipv6";
      const field = family === "ipv4" ? candidate.policy.details?.dns.fakeIpRange : candidate.policy.details?.dns.fakeIpRange6;
      let overlapsExplicitFakeRange = null;
      if (field?.state === "known") {
        const [base, prefix] = field.value.split("/"), blocks = new BlockList();
        blocks.addSubnet(base, Number(prefix), family); overlapsExplicitFakeRange = blocks.check(normalized, family);
      }
      return { ipHash: sha(normalized), family, classification: production.classifyCurrentKernelDnsAddress(normalized,
        controllerVersion, { candidate, loader }, now), overlapsExplicitFakeRange };
    };
    const kernelRound = async (round, candidate, controllerVersion) => Promise.all(["A", "AAAA"].map(async queryType => {
      result.counts.kernelQueries++;
      try {
        const observed = await reader.readDnsQuery(host, queryType, deadline.signal), now = performance.now();
        const record = { round, queryType, available: true, status: observed.status, truncated: observed.truncated,
          startedAtMono: observed.startedAtMono, completedAtMono: observed.completedAtMono,
          answers: observed.answers.map(answer => ({ type: answer.type, nameHash: sha(answer.name), ttl: answer.ttl,
            expiresAtMono: observed.startedAtMono + answer.ttl * 1000,
            ...(answer.type === 5 ? { cnameHash: sha(answer.data) } : address(answer.data, candidate, controllerVersion, now)) })) };
        result.kernel.push(record); return record;
      } catch(error) { const record = { round, queryType, available: false, error: safeError(error) }; result.kernel.push(record); return record; }
    }));
    await kernelRound("before", before.source, before.controller.fingerprint);
    ses = session.fromPartition(`sv-resolver-comparison-${crypto.randomUUID()}`, { cache: false });
    production.configureAnonymousCredentials(ses);
    ses.webRequest.onBeforeRequest((_details, callback) => { result.counts.blockedHttpAttempts++; callback({ cancel: true }); });
    for (const [method, label] of [["setProxy", "direct"], ["closeAllConnections", "close"], ["clearHostResolverCache", "clear-dns"]]) {
      const original = ses[method].bind(ses);
      ses[method] = async (...args) => { result.initialization.push({ step: label, startedAtMono: performance.now() }); return original(...args); };
    }
    await production.ensureDirectSession(ses);
    check("PRODUCTION_DIRECT_CLOSE_DNS_ORDER", production.isDirectSessionReady(ses) && result.initialization.map(value => value.step).join(",") === "direct,close,clear-dns");
    for (const [kind, options] of [["default", undefined], ["explicit-A", { queryType: "A", cacheUsage: "disallowed" }], ["explicit-AAAA", { queryType: "AAAA", cacheUsage: "disallowed" }]]) {
      if (kind !== "default") await ses.clearHostResolverCache();
      result.counts.chromiumQueries++; const startedAtMono = performance.now();
      let queryTimer;
      try {
        const observed = await Promise.race([options === undefined ? ses.resolveHost(host) : ses.resolveHost(host, options),
          new Promise((_, reject) => { queryTimer = setTimeout(() => reject(Error("CHROMIUM_QUERY_TIMEOUT")), 7000); })]);
        const completedAtMono = performance.now();
        assert(Array.isArray(observed.endpoints) && observed.endpoints.length <= 128, "ENDPOINT_LIMIT");
        result.chromium.push({ kind, actualOptions: options ?? null, available: true, startedAtMono, completedAtMono,
          ttlAvailable: false, endpoints: observed.endpoints.map(endpoint => address(endpoint.address, before.source, before.controller.fingerprint, completedAtMono)) });
      } catch(error) {
        result.chromium.push({ kind, actualOptions: options ?? null, available: false, startedAtMono, completedAtMono: performance.now(), error: safeError(error) });
        if (safeError(error) === "CHROMIUM_QUERY_TIMEOUT") throw error;
      } finally { clearTimeout(queryTimer); }
    }
    await kernelRound("after", before.source, before.controller.fingerprint);
    const after = await snapshot(), completed = performance.now();
    const selected = factory.getSelectedLoader();
    result.after = { sourceStartedAtMono: after.source.startedAtMono, sourceExpiresAtMono: after.source.expiresAtMono,
      controllerVersion: after.controller.fingerprint, kernelEpoch: after.kernelOwner.kernelEpoch, osHash: after.os.hash,
      systemHostsHash: after.hosts.fileHash, sourceFileFingerprint: after.source.fileFingerprint,
      systemHostsTargetMatchCount: after.hosts.hosts[0].ipv4.length + after.hosts.hosts[0].ipv6.length };
    result.stable = {
      selectedSource: selected !== null && selected.sourcePathIdentity === loader.sourcePathIdentity && selected.decoderIdentity === loader.decoderIdentity,
      source: before.source.fileFingerprint === after.source.fileFingerprint && before.source.policy.fingerprint === after.source.policy.fingerprint &&
        before.source.sourceGeneration === after.source.sourceGeneration && before.source.sourcePathIdentity === after.source.sourcePathIdentity,
      controller: before.controller.fingerprint === after.controller.fingerprint,
      owner: before.kernelOwner.kernelEpoch === after.kernelOwner.kernelEpoch,
      os: before.os.hash === after.os.hash,
      systemHosts: before.hosts.fileHash === after.hosts.fileHash && before.hosts.fileIdentity === after.hosts.fileIdentity,
    };
    result.validity = { completedAtMono: completed, sourceBeforeStillFresh: completed < before.source.expiresAtMono,
      sourceAfterStillFresh: completed < after.source.expiresAtMono,
      kernelAnswersStillFresh: result.kernel.flatMap(item => item.answers ?? []).every(answer => completed < answer.expiresAtMono),
      chromiumTtlUnknown: true, deadlinesExtended: false };
    if (Object.values(result.stable).every(Boolean)) {
      const kernelSets = round => new Set(result.kernel.filter(item => item.round === round && item.available).flatMap(item => item.answers.filter(answer => answer.ipHash).map(answer => answer.ipHash)));
      const beforeSet = kernelSets("before"), afterSet = kernelSets("after");
      result.comparisons = result.chromium.map(item => ({ kind: item.kind, available: item.available,
        defaultBusinessFamilySelectionProven: false,
        endpoints: (item.endpoints ?? []).map(value => ({ ...value, inKernelBefore: beforeSet.has(value.ipHash), inKernelAfter: afterSet.has(value.ipHash) })) }));
      result.conclusionsRetained = true;
    }
    check("QUERY_BUDGET_RESPECTED", result.counts.kernelQueries === 4 && result.counts.chromiumQueries === 3);
    check("NO_BUSINESS_OR_PUBLIC_HTTP", result.counts.blockedHttpAttempts === 0);
    check("CURRENT_SOURCE_ENVIRONMENT_STABLE", result.conclusionsRetained);
  } catch (error) { result.failure = safeError(error); result.comparisons = null; result.conclusionsRetained = false; }
  finally {
    deadline.abort(); factory?.dispose(); owner?.dispose(); systemHosts?.dispose();
    await ses?.closeAllConnections().catch(() => {}); await ses?.clearHostResolverCache().catch(() => {});
    clearTimeout(timer); result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); app.exit(result.failure ? 1 : 0);
  }
}
