/** One actual anonymous TLS factory request. No retry, DELETE, account or configuration mutation. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isIP, BlockList } from "node:net";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";

const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), "..");
const host = "api.bilibili.com", publicUrl = "https://api.bilibili.com/robots.txt";
const controllerUrl = "http://127.0.0.1:9790";
const resources = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\MAOMAOYUNAPP\\resources";
const resultPath = path.join(root, "docs/network-fake-ip-flow-observation.results.json");
const transportEntryOnly = process.argv.includes("--transport-entry-only");
const explicitPublicRun = process.argv.includes("--single-public-run");
const explicitPublicRecheck = process.argv.includes("--single-public-recheck");
let lastResort = () => {};
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const digest = value => sha(JSON.stringify(value));
const assert = (value, code) => { if (!value) throw Error(code); };
const canonical = value => isIP(value) === 4 ? value : isIP(value) === 6 && !value.includes("%")
  ? new URL(`http://[${value}]`).hostname.slice(1, -1) : null;
const ipHash = value => canonical(value) ? sha(canonical(value)) : null;
const safeError = error => /^[A-Z_]{1,80}$/.test(error?.code ?? "") ? error.code
  : /^ERR_[A-Z_]{1,70}$/.test(error?.message?.match(/ERR_[A-Z_]+/)?.[0] ?? "") ? error.message.match(/ERR_[A-Z_]+/)[0]
  : /^[A-Z_]{1,80}$/.test(error?.message ?? "") ? error.message : "OBSERVATION_UNAVAILABLE";
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject }; }
async function bounded(work, ms) { let timer; try { return await Promise.race([work,
  new Promise((_, reject) => { timer = setTimeout(() => reject(Error("BOUNDED_TIMEOUT")), ms); })]);
} finally { clearTimeout(timer); } }
function endpoint(value) { if (typeof value !== "string") return null;
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  return match && canonical(match[1]) && Number(match[2]) > 0 && Number(match[2]) <= 65535
    ? { address: canonical(match[1]), port: Number(match[2]) } : null; }

// Same request dependency walk as the lifecycle experiment; shared resolver/proxy/cert edges excluded.
function netlogRequest(logFile) {
  assert(fs.statSync(logFile).size <= 8 * 1024 * 1024, "NETLOG_LIMIT");
  const data = JSON.parse(fs.readFileSync(logFile, "utf8"));
  assert(Array.isArray(data.events) && data.events.length <= 50000, "NETLOG_LIMIT");
  const types = Object.fromEntries(Object.entries(data.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]));
  const roots = new Set(), edges = new Map(), sockets = new Map(), peers = new Map(), retainedEdges = [];
  const link = (a, b) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); };
  const dependencies = (value, output = []) => { if (!value || typeof value !== "object") return output;
    for (const [key, item] of Object.entries(value)) { if (key === "source_dependency" && item && Number.isInteger(item.id)) output.push(item.id);
      else if (item && typeof item === "object") dependencies(item, output); } return output; };
  for (const event of data.events) {
    const id = event.source?.id, name = types[event.type] ?? String(event.type), params = event.params ?? {};
    if (!Number.isInteger(id)) continue;
    if (params.url === publicUrl && /URL_REQUEST/.test(name)) roots.add(id);
    for (const value of [params.address, params.remote_address, params.remoteAddress,
      ...(Array.isArray(params.address_list) ? params.address_list : [])]) {
      const remote = endpoint(value); if (remote) { if (!peers.has(id)) peers.set(id, new Map()); peers.get(id).set(JSON.stringify(remote), remote); }
    }
    if (!/HOST_RESOLVER|DNS_|PROXY_|CERT_VERIFIER/.test(name)) for (const other of dependencies(params)) {
      link(id, other); link(other, id); retainedEdges.push({ from: id, to: other, event: name, time: event.time });
    }
    const local = endpoint(params.source_address ?? params.local_address ?? params.localAddress);
    if (local && /TCP_CONNECT|SOCKET/.test(name)) {
      const remote = endpoint(params.address ?? params.remote_address ?? params.remoteAddress);
      sockets.set(JSON.stringify([id, local.address, local.port]), { sourceId: id, event: name, time: event.time,
        sourceAddress: local.address, sourcePort: local.port, remoteAddress: remote?.address ?? null, remotePort: remote?.port ?? null });
    }
  }
  const reached = new Set(roots), pending = [...roots];
  while (pending.length) for (const next of edges.get(pending.shift()) ?? []) if (!reached.has(next)) { reached.add(next); pending.push(next); }
  const related = [...sockets.values()].filter(row => reached.has(row.sourceId)).map(row => {
    const remote = [...(peers.get(row.sourceId)?.values() ?? [])];
    return !row.remoteAddress && remote.length === 1 ? { ...row, remoteAddress: remote[0].address, remotePort: remote[0].port } : row;
  });
  return { rootIds: [...roots], related, edges: retainedEdges.filter(edge => reached.has(edge.from) && reached.has(edge.to)),
    eventCount: data.events.length, uniquelyAttributed: roots.size === 1 && related.length === 1 };
}
const projectSocket = row => ({ ownerPid: row.ownerPid ?? null, sourceAddressHash: ipHash(row.sourceAddress),
  sourcePort: row.sourcePort, remoteAddressHash: ipHash(row.remoteAddress), remotePort: row.remotePort, state: row.state ?? null });
const flowKey = row => JSON.stringify([row.id, row.host, row.sniffHost, row.sourceAddress, row.sourcePort,
  row.destinationPort, row.destinationIp, row.remoteDestinationIp, row.network, row.inboundType, row.route, row.startedAtMs]);
const projectFlow = row => ({ id: row.id, host: row.host, sniffHost: row.sniffHost, sourceAddressHash: ipHash(row.sourceAddress),
  sourcePort: row.sourcePort, destinationPort: row.destinationPort, destinationIpHash: ipHash(row.destinationIp),
  remoteDestinationHash: ipHash(row.remoteDestinationIp), network: row.network, inboundType: row.inboundType,
  route: row.route, processIdentity: row.processIdentity, startedAtMs: row.startedAtMs });

// Fixed read-only baseline; stdin is data and never interpolated into PowerShell source.
const BASELINE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$clipdockScope = [Console]::In.ReadToEnd() | ConvertFrom-Json
$clipdockRows = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $clipdockScope.ownerPids -contains [long]$_.OwningProcess } | ForEach-Object {
  [ordered]@{ ownerPid=[long]$_.OwningProcess; sourceAddress=[string]$_.LocalAddress; sourcePort=[int]$_.LocalPort; remoteAddress=[string]$_.RemoteAddress; remotePort=[int]$_.RemotePort; state=[string]$_.State }
})
ConvertTo-Json -InputObject @($clipdockRows) -Depth 4 -Compress
`;
async function baseline(ownerPids) { const startedAtMono = performance.now();
  const rows = await new Promise((resolve, reject) => { const worker = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", BASELINE],
    { windowsHide: true, timeout: 5000, maxBuffer: 384 * 1024 }, (error, stdout) => {
      if (error) return reject(Error("BASELINE_UNAVAILABLE"));
      try { const parsed = JSON.parse(stdout); assert(Array.isArray(parsed) && parsed.length <= 2048 &&
        parsed.every(row => ownerPids.includes(row.ownerPid)), "BASELINE_INVALID");
        resolve(parsed.map(row => ({ ...row, sourceAddress: canonical(row.sourceAddress), remoteAddress: canonical(row.remoteAddress) })));
      } catch { reject(Error("BASELINE_INVALID")); }
    }); worker.stdin.on("error", () => reject(Error("BASELINE_UNAVAILABLE"))); worker.stdin.end(JSON.stringify({ ownerPids })); });
  return { rows, startedAtMono, completedAtMono: performance.now() }; }
function answerSet(query) {
  assert(query.status === 0 && !query.truncated && query.answers.length > 0, "DNS_QUERY_UNUSABLE");
  const normalized = value => value.toLowerCase().replace(/\.$/, "");
  let leaf = host; const chain = [], seen = new Set();
  while (true) { assert(!seen.has(leaf) && seen.size < 16, "DNS_CNAME_INVALID"); seen.add(leaf);
    const aliases = query.answers.filter(rr => rr.type === 5 && normalized(rr.name) === leaf);
    assert(aliases.length <= 1, "DNS_CNAME_INVALID"); if (!aliases.length) break;
    chain.push(aliases[0]); leaf = normalized(aliases[0].data);
  }
  const records = query.answers.filter(rr => rr.type === (query.queryType === "A" ? 1 : 28) && normalized(rr.name) === leaf);
  assert(records.length > 0 && query.answers.every(rr => chain.includes(rr) || records.includes(rr)), "DNS_ANSWER_UNRELATED");
  return { addresses: records.map(rr => canonical(rr.data)), expiresAtMono: Math.min(...[...chain, ...records].map(rr => query.startedAtMono + rr.ttl * 1000)) };
}

if (!process.versions.electron) await parent(); else void child().catch(error => { lastResort(error); process.exit(1); });
async function parent() {
  const buildOnly = process.argv.includes("--build-only");
  let authorizedPrevious = null;
  assert([transportEntryOnly, explicitPublicRun, explicitPublicRecheck].filter(Boolean).length <= 1, "CONFLICTING_RUN_MODES");
  if (!transportEntryOnly && !buildOnly) {
    assert((explicitPublicRun || explicitPublicRecheck) && fs.existsSync(resultPath), "EXPLICIT_SINGLE_PUBLIC_RUN_REQUIRED");
    const bytes = fs.readFileSync(resultPath), previous = JSON.parse(bytes.toString("utf8"));
    if (explicitPublicRecheck) assert(previous.mode === "single-public-observation" && previous.failure === "PRODUCTION_SOCKET_PARSER_UNAVAILABLE" &&
      previous.productionSocket?.reason === "SOCKET_AMBIGUOUS" && previous.counts.nativeRequestsForwarded === 1, "ORIGINAL_SOCKET_FAILURE_REQUIRED");
    else assert(previous.mode === "transport-entry-only" && previous.childExitCode === 0 && !previous.failure &&
      previous.counts.nativeRequestsForwarded === 0 && previous.checks.length === 4 && previous.checks.every(check => check.passed), "SUCCESSFUL_CLOSED_PREFLIGHT_REQUIRED");
    const history = resultPath.replace(".results.json", explicitPublicRecheck ? ".socket-ambiguous.results.json" : ".transport-entry-stub.results.json");
    assert(!fs.existsSync(history), "PUBLIC_REPLAY_NOT_ALLOWED");
    fs.copyFileSync(resultPath, history);
    assert(sha(fs.readFileSync(history)) === sha(bytes), "CLOSED_HISTORY_MISMATCH");
    authorizedPrevious = { history, bytesHash: sha(bytes) };
  }
  const { build } = await import("esbuild"), { default: electron } = await import("electron");
  const temporaryParent = path.join(root, "docs/.compare"), temporary = fs.mkdtempSync(path.join(temporaryParent, "fake-ip-flow-"));
  let result;
  try {
    const built = await build({ stdin: { contents: [
      "export {AnonymousProofProbe,ANONYMOUS_TLS_FACTORY_ID} from './src/main/network/anonymous-proof-probe.ts';",
      "export {SelectedClientConfig} from './src/main/network/selected-client-config.ts';",
      "export {ClashReader} from './src/main/network/clash-reader.ts';",
      "export {WindowsTcpSocketReader} from './src/main/network/windows-tcp-sockets.ts';",
      "export {WindowsControllerOwnerReader} from './src/main/network/windows-controller-owner.ts';",
      "export {WindowsNetworkFingerprintReader} from './src/main/network/windows-network-fingerprint.ts';",
      "export {WindowsSystemHostsReader} from './src/main/network/windows-system-hosts.ts';",
      "export {parseScopedConnections,connectionHostScope} from './src/main/network/connection-evidence.ts';",
      "export {configureChromiumTransport,readChromiumTransportState} from './src/main/network/chromium-transport.ts';",
      "export {classifyCurrentKernelDnsAddress} from './src/main/network/kernel-dns-address-policy.ts';",
      "export {evaluateRules} from './src/main/network/rules.ts';",
      "export {parseAnonymousRequestSocket} from './src/main/network/anonymous-request-socket.ts';",
    ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", external: ["electron", "node:*"],
      tsconfig: path.join(root, "tsconfig.electron.json"), outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const hashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter(file => file.startsWith("src/"))
      .map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    if (buildOnly) { console.log(JSON.stringify({ buildOnly: true, sourceFiles: Object.keys(hashes), publicRequestsIssued: 0 })); return; }
    const env = { ...process.env, CLIPDOCK_FAKE_IP_FLOW_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, ...(transportEntryOnly ? ["--transport-entry-only"] : []), ...(explicitPublicRecheck ? ["--single-public-recheck"] : [])], { cwd: root, env, windowsHide: true, stdio: "ignore" });
    let parentWatchdogFired = false;
    const timer = setTimeout(() => { parentWatchdogFired = true; worker.kill(); }, 45000);
    const code = await new Promise(resolve => { worker.once("error", () => resolve(1)); worker.once("exit", value => resolve(value ?? 1)); }); clearTimeout(timer);
    result = fs.existsSync(path.join(temporary, "result.json")) ? JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"))
      : { failure: "CHILD_RESULT_MISSING", qualificationGranted: false };
    result.childExitCode = code; result.parentWatchdogFired = parentWatchdogFired; result.sourceHashes = hashes; result.scriptHash = sha(fs.readFileSync(script));
    result.bundleHash = sha(fs.readFileSync(path.join(temporary, "production.mjs")));
    result.sourceHashesStable = Object.entries(hashes).every(([file, value]) => sha(fs.readFileSync(path.join(root, file))) === value);
    if (!result.sourceHashesStable) result.observationRetained = false;
  } finally {
    const exact = path.resolve(temporary);
    assert(path.dirname(exact) === path.resolve(temporaryParent) && path.basename(exact).startsWith("fake-ip-flow-"), "UNSAFE_TEMPORARY_PATH");
    assert(fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(), "TEMPORARY_PATH_CHANGED");
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(exact, { recursive: true, force: true }); } catch { /* One exact cleanup attempt; never retry another path. */ }
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (result) {
    if (fs.existsSync(resultPath)) {
      const previous = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const history = authorizedPrevious?.history ?? resultPath.replace(".results.json", previous.mode === "transport-entry-only"
        ? ".transport-entry-sync-throw.results.json" : ".initial-missing-result.results.json");
      if (authorizedPrevious) assert(sha(fs.readFileSync(resultPath)) === authorizedPrevious.bytesHash &&
        sha(fs.readFileSync(history)) === authorizedPrevious.bytesHash, "EXISTING_REPORT_CHANGED_DURING_RUN");
      else { assert(transportEntryOnly && !fs.existsSync(history), "EXISTING_RESULT_HISTORY_REQUIRED"); fs.copyFileSync(resultPath, history); }
      result.previousAttempt = { report: path.basename(history), retainedUnmodified: true, publicRequestCountUnavailable: !previous.counts };
    }
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ executedAt: result.executedAt, counts: result.counts, checks: result.checks, mapping: result.mapping,
      stable: result.stable, validity: result.validity, observationRetained: result.observationRetained,
      sourceHashesStable: result.sourceHashesStable, rawTemporaryDataRemoved: result.rawTemporaryDataRemoved, failure: result.failure ?? null }, null, 2));
    process.exitCode = result.failure || result.childExitCode || !result.sourceHashesStable ? 1 : 0; }
}

async function child() {
  const { app, session, net } = await import("electron"), temporary = process.env.CLIPDOCK_FAKE_IP_FLOW_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
    path.basename(temporary).startsWith("fake-ip-flow-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData")); app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  production.configureChromiumTransport(app);
  const result = { executedAt: new Date().toISOString(), target: publicUrl, mode: transportEntryOnly ? "transport-entry-only" : explicitPublicRecheck ? "single-public-recheck" : "single-public-observation",
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged, transport: production.readChromiumTransportState(app) },
    isolation: { temporaryUserData: true, accountSessionReused: false, configurationChanged: false, osConfigurationChanged: false,
      historicalReportInput: false, netLog: transportEntryOnly ? "not-started" : "isolated-child-only", factoryModified: false, nodePublicFetch: false,
      measurementShim: transportEntryOnly ? "closed local Writable stub; no socket or native request" : "original session.fetch with pre/post DNS reads and bounded original Response hold", headerHoldMaximumMs: 8000, factoryTimeoutMs: 10000 },
    counts: { factoryCalls: 0, publicRequestsIssued: 0, kernelQueries: 0, controllerReads: 0, controllerRequests: 0, connectionsReads: 0,
      deletes: 0, blockedHttpAttempts: 0, sessionCount: 0, electronTransportEntries: 0, nativeRequestsForwarded: 0 }, checks: [], initialization: [], dns: [], mapping: null, stable: null,
    observationRetained: false, resolverEquivalenceQualified: false, qualificationGranted: false, permitIssued: false };
  const checkpoint = phaseName => { result.phase = phaseName; result.checkpointAtMono = performance.now();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); };
  lastResort = error => { result.failure = safeError(error); result.topLevelFailure = true;
    try { checkpoint("top-level-failure"); } catch { /* Parent retains its own failure if disk unavailable. */ } };
  for (const event of ["uncaughtException", "unhandledRejection"]) process.on(event, error => {
    result.failure = safeError(error); result.fatalEvent = event;
    try { checkpoint("fatal-event"); } finally { app.exit(1); }
  });
  checkpoint("startup");
  const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); assert(value, name); };
  const deadline = new AbortController(), phase = { ready: deferred(), release: deferred(), responseHeld: false };
  let factory, owner, hostsReader, probe, tcp, logging = false, creating = false, currentController, loader, before, originalFetch, capturedSession;
  const logFile = path.join(temporary, "request.netlog.json");
  const timer = setTimeout(() => { deadline.abort(); result.failure = "EXPERIMENT_TIMEOUT";
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); app.exit(1); }, 40000);
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => { result.counts.blockedHttpAttempts++; callback({ cancel: true }); });
    const { default: http } = await import("node:http"), { default: https } = await import("node:https"), { syncBuiltinESMExports } = await import("node:module");
    const originalRequest = http.request;
    http.request = function(options, callback) {
      const target = new URL(options.path, controllerUrl), fixed = ["/configs", "/rules", "/version", "/proxies/DIRECT", "/connections"].includes(target.pathname) && !target.search;
      const dns = target.pathname === "/dns/query" && target.searchParams.get("name") === host && ["A", "AAAA"].includes(target.searchParams.get("type")) && [...target.searchParams.keys()].length === 2;
      assert(options.hostname === "127.0.0.1" && Number(options.port) === 9790 && options.method === "GET" && (fixed || dns), "HTTP_SCOPE_INVALID");
      assert(!Object.keys(options.headers ?? {}).some(key => /cookie|authorization/i.test(key)), "HTTP_AUTH_FORBIDDEN");
      result.counts.controllerRequests++; return originalRequest.call(this, options, callback);
    };
    const forbid = () => { result.counts.blockedHttpAttempts++; throw Error("PUBLIC_HTTP_FORBIDDEN"); };
    http.get = forbid; https.request = forbid; https.get = forbid; globalThis.fetch = forbid; net.fetch = forbid; syncBuiltinESMExports();
    const nativeRequest = net.request;
    net.request = options => {
      result.counts.electronTransportEntries++;
      const actualUrl = options?.url instanceof URL ? options.url.href : options?.url;
      result.transportEntry = { optionKeys: options && typeof options === "object" ? Object.keys(options).sort() : [],
        exactUrl: actualUrl === publicUrl, actualFactorySession: options?.session === capturedSession,
        method: options?.method === "GET" ? "GET" : "unknown", credentials: options?.credentials === "omit" ? "omit" : "unknown",
        redirect: ["manual", "error", "follow"].includes(options?.redirect) ? options.redirect : "unknown",
        autoSessionCookies: typeof options?.autoSessionCookies === "boolean" ? options.autoSessionCookies : null,
        useSessionCookies: typeof options?.useSessionCookies === "boolean" ? options.useSessionCookies : null };
      checkpoint("electron-transport-entry");
      if (transportEntryOnly) {
        // Electron v43.3.0 net-fetch creates its deferred Promise and abort listener before
        // request(options). Throwing there strands that Promise. This closed stub instead
        // lets the real net-fetch attach its error listener and return p before rejecting.
        result.transportEntry.blockedBeforeNativeCall = true;
        result.closedStub = { kind: "local-Writable-no-socket", asyncErrors: 0, abortCalls: 0, setHeaderCalls: 0 };
        const stub = new Writable({ autoDestroy: false,
          write(_chunk, _encoding, callback) { callback(); },
          final(callback) { callback(); queueMicrotask(() => {
            result.closedStub.asyncErrors++; stub.destroy(Error("TRANSPORT_ENTRY_ONLY_STOP"));
          }); },
        });
        stub._urlLoaderOptions = {};
        stub.setHeader = () => { result.closedStub.setHeaderCalls++; };
        stub.abort = () => { result.closedStub.abortCalls++; stub.destroy(); };
        checkpoint("closed-stub-returned-before-native");
        return stub;
      }
      assert(capturedSession && options?.session === capturedSession && actualUrl === publicUrl && options?.method === "GET" &&
        options?.credentials === "omit" && (!Object.hasOwn(options, "autoSessionCookies") || options.autoSessionCookies === false) &&
        (!Object.hasOwn(options, "useSessionCookies") || options.useSessionCookies === false) && options?.redirect === "manual" &&
        result.counts.nativeRequestsForwarded === 0, "EXACT_FACTORY_TRANSPORT_REQUIRED");
      result.counts.nativeRequestsForwarded++; checkpoint("native-request-forwarded"); return nativeRequest.call(net, options);
    };
    if (transportEntryOnly) {
      app.on("session-created", created => { if (creating) { capturedSession = created; result.counts.sessionCount++; } });
      probe = new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 10000 });
      creating = true; result.counts.factoryCalls++; checkpoint("transport-only-factory-call");
      phase.pending = probe.probeTls({ host, port: 443 }, deadline.signal); creating = false;
      result.factoryResult = await bounded(phase.pending, 13000);
      check("REAL_FACTORY_REACHED_ELECTRON_TRANSPORT", result.counts.electronTransportEntries === 1 && result.transportEntry?.actualFactorySession && result.transportEntry?.exactUrl);
      check("ZERO_NATIVE_REQUESTS_OR_DNS_QUERIES", result.counts.nativeRequestsForwarded === 0 && result.counts.kernelQueries === 0 && result.counts.controllerRequests === 0);
      check("FACTORY_CORRECTLY_UNAVAILABLE", result.factoryResult.available === false);
      check("CLOSED_STUB_ASYNC_ERROR_HANDLED", result.closedStub?.asyncErrors === 1 && result.closedStub.abortCalls >= 1 && !result.fatalEvent);
      checkpoint("transport-entry-only-verified"); return;
    }
    const reader = new production.ClashReader({ controllerUrl, getSecret: () => null });
    const readController = async () => { result.counts.controllerReads++; return currentController = await reader.read(); };
    const connections = async () => { const startedAtMono = performance.now(); result.counts.connectionsReads++;
      const value = await new Promise((resolve, reject) => { const req = http.request({ hostname: "127.0.0.1", port: 9790, path: "/connections", method: "GET" }, res => {
        const chunks = []; let bytes = 0; res.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(Error("CONNECTIONS_LIMIT")); else chunks.push(chunk); });
        res.on("end", () => { try { assert(res.statusCode === 200, "CONNECTIONS_UNAVAILABLE"); resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Error("CONNECTIONS_INVALID")); } });
        res.on("error", () => reject(Error("CONNECTIONS_UNAVAILABLE"))); }); req.setTimeout(2500, () => req.destroy(Error("CONNECTIONS_TIMEOUT"))); req.on("error", () => reject(Error("CONNECTIONS_UNAVAILABLE"))); req.end(); });
      return { startedAtMono, completedAtMono: performance.now(), rows: production.parseScopedConnections(value, production.connectionHostScope([host])) }; };
    factory = new production.SelectedClientConfig({ resourcesPath: resources, readController });
    owner = new production.WindowsControllerOwnerReader({ controllerUrl }); hostsReader = new production.WindowsSystemHostsReader();
    const network = new production.WindowsNetworkFingerprintReader(); loader = await factory.select(); check("CURRENT_SUPPORTED_LOADER_SELECTED", loader !== null);
    const snapshot = async () => { const [source, kernelOwner, os, hosts] = await Promise.all([
      factory.read(), owner.read(deadline.signal), network.readObservation(), hostsReader.read([host], deadline.signal)]);
      check("CURRENT_SOURCE_ENVIRONMENT_AVAILABLE", source.state === "candidate" && kernelOwner.available && os.available && hosts.available);
      return { source: source.candidate, kernelOwner, os, hosts, controller: currentController }; };
    const projectState = state => ({ sourceFileFingerprint: state.source.fileFingerprint, policyFingerprint: state.source.policy.fingerprint,
      sourceGeneration: state.source.sourceGeneration, sourceStartedAtMono: state.source.startedAtMono, sourceExpiresAtMono: state.source.expiresAtMono,
      controllerVersion: state.controller.fingerprint, kernelEpoch: state.kernelOwner.kernelEpoch, owner: state.kernelOwner.owner,
      osHash: state.os.hash, systemHostsHash: state.hosts.fileHash,
      systemHostsTargetMatchCount: state.hosts.hosts[0].ipv4.length + state.hosts.hosts[0].ipv6.length });
    before = await snapshot(); result.before = projectState(before);
    const address = (raw, at) => { const ip = canonical(raw); assert(ip, "ADDRESS_INVALID"); const family = isIP(ip) === 4 ? "ipv4" : "ipv6";
      const field = family === "ipv4" ? before.source.policy.details?.dns.fakeIpRange : before.source.policy.details?.dns.fakeIpRange6;
      let overlapsExplicitFakeRange = null; if (field?.state === "known") { const [base, prefix] = field.value.split("/"), block = new BlockList(); block.addSubnet(base, Number(prefix), family); overlapsExplicitFakeRange = block.check(ip, family); }
      return { ipHash: sha(ip), family, classification: production.classifyCurrentKernelDnsAddress(ip, before.controller.fingerprint,
        { candidate: before.source, loader }, at), overlapsExplicitFakeRange }; };
    const dnsRound = async round => Promise.all(["A", "AAAA"].map(async queryType => { assert(result.counts.kernelQueries < 4, "DNS_BUDGET_EXCEEDED"); result.counts.kernelQueries++;
      const value = await reader.readDnsQuery(host, queryType, deadline.signal);
      result.dns.push({ round, queryType, startedAtMono: value.startedAtMono, completedAtMono: value.completedAtMono, status: value.status, truncated: value.truncated,
        answers: value.answers.map(rr => ({ type: rr.type, nameHash: sha(rr.name), ttl: rr.ttl, expiresAtMono: value.startedAtMono + rr.ttl * 1000,
          ...(rr.type === 5 ? { cnameHash: sha(rr.data) } : address(rr.data, value.completedAtMono)) })) }); return value; }));
    const preflight = value => { const decision = production.evaluateRules(value.mode, value.rules, { host, port: 443, network: "tcp" });
      return { mode: value.mode, tun: value.tun, ruleCount: value.rules.length, ruleRoute: decision.route, ruleIndex: decision.ruleIndex,
        ruleType: decision.ruleIndex === null ? null : value.rules[decision.ruleIndex]?.type,
        builtinDirect: value.directPolicy?.kind === "direct", emptyDialer: value.directPolicy?.dialer === "none", fingerprint: value.fingerprint }; };
    result.preflight = preflight(before.controller);
    check("CURRENT_DIRECT_RULE", result.preflight.mode === "rule" && result.preflight.ruleRoute === "direct" && result.preflight.builtinDirect && result.preflight.emptyDialer);
    const [beforeTcp, beforeFlows] = await Promise.all([baseline([...new Set(app.getAppMetrics().map(row => row.pid))]), connections()]);
    result.baseline = { startedAtMono: beforeTcp.startedAtMono, completedAtMono: beforeTcp.completedAtMono, rows: beforeTcp.rows.length,
      connectionsStartedAtMono: beforeFlows.startedAtMono, connectionsCompletedAtMono: beforeFlows.completedAtMono, scopedConnections: beforeFlows.rows.length };
    app.on("session-created", created => { if (!creating) return; result.counts.sessionCount++; capturedSession = created;
      for (const [method, label] of [["setProxy", "direct"], ["closeAllConnections", "close"], ["clearHostResolverCache", "clear-dns"]]) {
        const original = created[method].bind(created); created[method] = async (...args) => { result.initialization.push({ step: label, atMono: performance.now() }); return original(...args); };
      }
      originalFetch = created.fetch;
      created.fetch = async (input, options) => { try {
        assert(String(input) === publicUrl && options?.method === "GET" && options.credentials === "omit" && options.redirect === "manual" &&
          options.cache === "no-store" && options.referrerPolicy === "no-referrer", "NON_ANONYMOUS_REQUEST");
        assert(result.counts.publicRequestsIssued === 0, "PUBLIC_REQUEST_BUDGET_EXCEEDED");
        const current = await readController(); assert(current.fingerprint === before.controller.fingerprint, "CONTROLLER_CHANGED_BEFORE_SEND");
        phase.dnsBefore = await dnsRound("before");
        phase.requestStartMono = performance.now(); phase.requestStartWall = Date.now(); result.counts.publicRequestsIssued++; checkpoint("factory-fetch-call");
        const response = await originalFetch.call(created, input, options);
        phase.headersMono = performance.now(); phase.headersWall = Date.now(); phase.responseHeld = true; phase.holdDeadlineMono = phase.headersMono + 8000;
        result.request = { startedAtMono: phase.requestStartMono, startedAtWallMs: phase.requestStartWall, headersAtMono: phase.headersMono,
          headersAtWallMs: phase.headersWall, status: response.status, holdDeadlineMono: phase.holdDeadlineMono };
        checkpoint("headers-received");
        [phase.hotFlows, phase.dnsAfter, phase.hotController] = await Promise.all([connections(), dnsRound("after"), readController()]);
        phase.hotCompletedMono = performance.now(); result.request.hotCompletedAtMono = phase.hotCompletedMono;
        result.hotConnectionSnapshot = { startedAtMono: phase.hotFlows.startedAtMono, completedAtMono: phase.hotFlows.completedAtMono,
          count: phase.hotFlows.rows.length, rows: phase.hotFlows.rows.slice(0, 128).map(projectFlow), projectionComplete: phase.hotFlows.rows.length <= 128 };
        result.hotController = { fingerprint: phase.hotController.fingerprint, startedAtMono: phase.hotController.startedAtMono,
          completedAtMono: phase.hotController.completedAtMono, sameAsInitial: phase.hotController.fingerprint === before.controller.fingerprint };
        const heldSlot = probe?.slots?.[0];
        result.heldFactory = { factoryId: production.ANONYMOUS_TLS_FACTORY_ID,
          transportContextId: heldSlot?.session === capturedSession ? heldSlot.contextId : null,
          fromCache: heldSlot?.active?.fromCache ?? null, statusCode: heldSlot?.active?.statusCode ?? null,
          contextSource: "actual-isolated-factory-slot", heldAtMono: phase.hotCompletedMono };
        checkpoint("hot-facts-collected");
        await session.defaultSession.netLog.stopLogging(); logging = false;
        phase.wire = netlogRequest(logFile);
        result.netLog = { rootIds: phase.wire.rootIds, eventCount: phase.wire.eventCount, edges: phase.wire.edges,
          uniquelyAttributed: phase.wire.uniquelyAttributed, sockets: phase.wire.related.map(row => ({ ...projectSocket(row), sourceId: row.sourceId, event: row.event, time: row.time })),
          timeBasis: "raw NetLog ticks retained separately; fetch wrapper clocks bracket send and headers" };
        const parsed = production.parseAnonymousRequestSocket(fs.readFileSync(logFile, "utf8"), { host, port: 443 });
        result.productionSocket = parsed.available ? { available: true, evidenceId: parsed.observation.evidenceId,
          rootId: parsed.observation.rootId, socketSourceId: parsed.observation.socketSourceId, relatedSourceIds: parsed.observation.relatedSourceIds,
          tuple: projectSocket(parsed.observation.tuple), eventEvidence: parsed.observation.eventEvidence.map(row => ({
            sourceId: row.sourceId, eventType: row.eventType, timeTicks: row.timeTicks, phase: row.phase, dependentSourceIds: row.dependentSourceIds,
            local: row.local ? { addressHash: ipHash(row.local.address), port: row.local.port } : null,
            remote: row.remote ? { addressHash: ipHash(row.remote.address), port: row.remote.port } : null })) } : parsed;
        assert(parsed.available, "PRODUCTION_SOCKET_PARSER_UNAVAILABLE");
        assert(phase.wire.uniquelyAttributed && Object.entries(parsed.observation.tuple).every(([key, value]) => phase.wire.related[0][key] === value), "SOCKET_PARSER_DISAGREEMENT");
        // Production parser supplies the tuple; the old transparent walk is an independent comparison.
        phase.wire.related[0] = { ...phase.wire.related[0], ...parsed.observation.tuple };
        phase.ready.resolve(); await bounded(phase.release.promise, Math.max(1, phase.holdDeadlineMono - performance.now()));
        phase.responseHeld = false; result.request.holdReleasedAtMono = performance.now(); return response;
      } catch (error) { phase.ready.reject(error); throw error; } };
    });
    await session.defaultSession.netLog.startLogging(logFile, { captureMode: "default", maxFileSize: 6 * 1024 * 1024 }); logging = true;
    probe = new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 10000 }); creating = true;
    result.counts.factoryCalls++; phase.factoryStartMono = performance.now(); checkpoint("factory-call");
    phase.pending = probe.probeTls({ host, port: 443 }, deadline.signal); creating = false;
    await bounded(phase.ready.promise, 9000);
    check("REQUEST_DEPENDENCY_UNIQUE", phase.wire.uniquelyAttributed && phase.wire.related[0].remoteAddress && phase.wire.related[0].remotePort === 443);
    check("HOT_CONTROLLER_STABLE", phase.hotController.fingerprint === before.controller.fingerprint);
    const wire = phase.wire.related[0], oldIds = new Set(beforeFlows.rows.map(row => row.id));
    const matches = phase.hotFlows.rows.filter(row => !oldIds.has(row.id) && row.host === host && (row.sniffHost === null || row.sniffHost === host) &&
      row.sourceAddress === wire.sourceAddress && row.sourcePort === wire.sourcePort && row.destinationPort === 443 && row.network === "tcp" && row.route === "direct" &&
      row.startedAtMs >= phase.requestStartWall && row.startedAtMs <= phase.headersWall && row.remoteDestinationIp);
    result.flow = { snapshotStartedAtMono: phase.hotFlows.startedAtMono, snapshotCompletedAtMono: phase.hotFlows.completedAtMono,
      candidateCount: matches.length, candidates: matches.map(projectFlow) };
    check("ONE_NEW_EXACT_OWN_FLOW", matches.length === 1);
    const own = matches[0], appPids = app.getAppMetrics().filter(row => row.serviceName === "network.mojom.NetworkService").map(row => row.pid);
    tcp = new production.WindowsTcpSocketReader({ ownerPids: appPids, remotes: [{ address: wire.remoteAddress, port: 443 }] });
    const table = await tcp.read(); check("APP_TCP_AVAILABLE", table.available);
    const appMatches = table.sockets.filter(row => appPids.includes(row.ownerPid) && row.sourceAddress === wire.sourceAddress && row.sourcePort === wire.sourcePort &&
      row.remoteAddress === wire.remoteAddress && row.remotePort === wire.remotePort && row.state === "Established");
    const afterFlows = await connections();
    const slot = probe.slots?.[0];
    check("FACTORY_CONTEXT_OWNERSHIP", slot?.session === capturedSession && typeof slot.contextId === "string" && slot.active?.fromCache === false && slot.active?.statusCode === 200);
    check("APP_TUPLE_INDEPENDENTLY_VERIFIED", appMatches.length === 1);
    check("FLOW_STILL_HELD", phase.responseHeld && !slot.active.abort.signal.aborted && performance.now() < phase.holdDeadlineMono &&
      afterFlows.rows.filter(row => flowKey(row) === flowKey(own)).length === 1);
    const appSocket = appMatches[0];
    check("APP_TUPLE_ABSENT_FROM_BASELINE", !beforeTcp.rows.some(row => row.ownerPid === appSocket.ownerPid && row.sourceAddress === appSocket.sourceAddress &&
      row.sourcePort === appSocket.sourcePort && row.remoteAddress === appSocket.remoteAddress && row.remotePort === appSocket.remotePort));
    result.appSocket = { ...projectSocket(appSocket), owners: table.owners, snapshotStartedAtMono: table.startedAtMono, snapshotCompletedAtMono: table.completedAtMono,
      stillHeldAtVerification: true, newComparedWithBaseline: true };
    result.factory = { factoryId: production.ANONYMOUS_TLS_FACTORY_ID, transportContextId: slot.contextId, contextSource: "actual-isolated-factory-slot",
      startedAtMono: phase.factoryStartMono, fromCache: slot.active.fromCache, statusCode: slot.active.statusCode, credentials: "omit", certificateValidation: "chromium-default" };
    const chosenType = isIP(own.remoteDestinationIp) === 4 ? "A" : "AAAA";
    const beforeAnswer = answerSet(phase.dnsBefore.find(value => value.queryType === chosenType)), afterAnswer = answerSet(phase.dnsAfter.find(value => value.queryType === chosenType));
    const appAddress = address(wire.remoteAddress, phase.hotCompletedMono), remoteAddress = address(own.remoteDestinationIp, phase.hotCompletedMono);
    result.mapping = { appAddress, remoteAddress, chosenQueryType: chosenType,
      remoteInBeforeAnswers: beforeAnswer.addresses.includes(own.remoteDestinationIp), remoteInAfterAnswers: afterAnswer.addresses.includes(own.remoteDestinationIp),
      beforeAnswersExpireAtMono: beforeAnswer.expiresAtMono, afterAnswersExpireAtMono: afterAnswer.expiresAtMono,
      beforeAnswersCoverActualRequest: phase.headersMono < beforeAnswer.expiresAtMono,
      beforeAnswersCoverHotWindow: phase.hotCompletedMono < beforeAnswer.expiresAtMono,
      afterAnswersFreshAtHotCompletion: phase.hotCompletedMono < afterAnswer.expiresAtMono,
      connectionId: own.id, connectionRemoteIsNotPublicEgress: true, possibleFamiliesConstraintProven: false };
    phase.release.resolve(); const found = await phase.pending; result.factoryResult = found;
    check("ACTUAL_FACTORY_SUCCEEDED", found.available && found.observation.transportContextId === slot.contextId);
    const after = await snapshot(), completed = performance.now(); result.after = projectState(after); checkpoint("post-verification");
    result.stable = { loader: factory.getSelectedLoader()?.sourcePathIdentity === loader.sourcePathIdentity && factory.getSelectedLoader()?.decoderIdentity === loader.decoderIdentity,
      source: before.source.fileFingerprint === after.source.fileFingerprint && before.source.policy.fingerprint === after.source.policy.fingerprint &&
        before.source.sourceGeneration === after.source.sourceGeneration && before.source.sourcePathIdentity === after.source.sourcePathIdentity,
      controller: before.controller.fingerprint === after.controller.fingerprint, owner: before.kernelOwner.kernelEpoch === after.kernelOwner.kernelEpoch,
      os: before.os.hash === after.os.hash, systemHosts: before.hosts.fileHash === after.hosts.fileHash && before.hosts.fileIdentity === after.hosts.fileIdentity };
    result.validity = { completedAtMono: completed, sourceBeforeStillFresh: completed < before.source.expiresAtMono,
      sourceAfterStillFresh: completed < after.source.expiresAtMono, dnsBeforeStillFreshAtFinalVerification: completed < beforeAnswer.expiresAtMono,
      dnsAfterStillFreshAtFinalVerification: completed < afterAnswer.expiresAtMono, deadlinesExtended: false };
    check("SOURCE_ENVIRONMENT_STABLE", Object.values(result.stable).every(Boolean));
    check("ONE_REQUEST_NO_RETRY_NO_DELETE", result.counts.factoryCalls === 1 && result.counts.publicRequestsIssued === 1 && result.counts.kernelQueries === 4 && result.counts.deletes === 0 && result.counts.blockedHttpAttempts === 0);
    result.observationRetained = appAddress.classification === "fake-ip" && remoteAddress.classification === "real" &&
      result.mapping.remoteInBeforeAnswers && result.mapping.remoteInAfterAnswers && result.mapping.beforeAnswersCoverHotWindow && result.mapping.afterAnswersFreshAtHotCompletion &&
      result.validity.sourceBeforeStillFresh && result.validity.sourceAfterStillFresh;
    if (!result.observationRetained) result.observationUnavailableReason = "MAPPING_OR_ORIGINAL_WINDOW_UNCONFIRMED";
  } catch (error) { result.failure = safeError(error); result.observationRetained = false; checkpoint("observation-failed"); }
  finally {
    checkpoint("cleanup-started");
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => { phase.release.resolve(); deadline.abort(); creating = false; }),
      Promise.resolve().then(() => bounded(phase.pending ?? Promise.resolve(), 3000)),
      Promise.resolve().then(() => bounded(probe?.dispose() ?? Promise.resolve(), 4000)),
      Promise.resolve().then(() => logging ? bounded(session.defaultSession.netLog.stopLogging(), 3000) : undefined),
      Promise.resolve().then(() => { if (capturedSession && originalFetch) capturedSession.fetch = originalFetch; }),
      Promise.resolve().then(() => { factory?.dispose(); owner?.dispose(); hostsReader?.dispose(); }),
    ]);
    const drains = await Promise.allSettled([
      Promise.resolve().then(() => factory?.whenIdle()), Promise.resolve().then(() => owner?.whenIdle()), Promise.resolve().then(() => hostsReader?.whenIdle()),
    ]);
    result.cleanup = { actions: cleanup.map(value => value.status), drains: drains.map(value => value.status) };
    clearTimeout(timer); result.completedAt = new Date().toISOString(); checkpoint("cleanup-completed"); app.exit(result.failure ? 1 : 0);
  }
}
