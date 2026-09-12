/** Bounded, account-free qualification investigation. Never loads the production bootstrap. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const nativeOwnerRun = process.argv.includes("--native-owner");
const reportStem = nativeOwnerRun ? "network-anonymous-factory-path-native-owner" : "network-anonymous-factory-path";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const digest = (value) => sha(JSON.stringify(value));
const canonical = (value) => net.isIP(value) === 4 ? value : net.isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : null;
const ipHash = (value) => canonical(value) ? sha(canonical(value)) : null;
const tuple = (row) => JSON.stringify([row.ownerPid, row.sourceAddress, row.sourcePort, row.remoteAddress, row.remotePort]);
const sources = [
  "src/main/network/anonymous-proof-probe.ts", "src/main/network/anonymous-egress-probe.ts",
  "src/main/network/anonymous-session-privacy.ts", "src/main/network/direct-session.ts",
  "src/main/network/connection-evidence.ts", "src/main/network/windows-tcp-sockets.ts",
  "src/main/network/windows-controller-owner.ts", "src/main/network/windows-route-selection.ts",
];
async function bounded(work, ms) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("BOUNDED_TIMEOUT")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function control(endpoint) {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:9790/${endpoint}`, { signal: AbortSignal.timeout(2500), redirect: "error" });
  if (!response.ok) throw Error("CONTROLLER_UNAVAILABLE");
  return { value: await response.json(), startedAtMono: start, completedAtMono: performance.now() };
}
function projectSocket(row) {
  return { ownerPid: row.ownerPid, sourceAddressHash: ipHash(row.sourceAddress), sourcePort: row.sourcePort,
    remoteAddressHash: ipHash(row.remoteAddress), remotePort: row.remotePort,
    socketAddressFamily: net.isIP(row.remoteAddress) === 6 ? "ipv6" : "ipv4", state: row.state };
}
function endpoint(value) {
  if (typeof value !== "string") return null;
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  if (!match || !canonical(match[1]) || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  return { address: canonical(match[1]), port: Number(match[2]) };
}

// Unlike the earlier experiment's all-source-port list, retain request-source dependencies.
// A graph with multiple sockets stays ambiguous; it is never resolved by host/PID guessing.
function netlogRequest(logFile, exactUrl) {
  const data = JSON.parse(fs.readFileSync(logFile, "utf8"));
  const types = Object.fromEntries(Object.entries(data.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]));
  const roots = new Set(), edges = new Map(), sockets = new Map(), peers = new Map(), shapes = new Map();
  const link = (a, b) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); };
  const dependencies = (value, output = []) => {
    if (!value || typeof value !== "object") return output;
    for (const [key, item] of Object.entries(value)) {
      if (key === "source_dependency" && item && typeof item.id === "number") output.push(item.id);
      else if (item && typeof item === "object") dependencies(item, output);
    }
    return output;
  };
  for (const event of data.events ?? []) {
    const id = event.source?.id, name = types[event.type] ?? String(event.type), params = event.params ?? {};
    if (!Number.isInteger(id)) continue;
    if (params.url === exactUrl && /URL_REQUEST/.test(name)) roots.add(id);
    if (/TCP_CONNECT|SOCKET|HTTP_STREAM|URL_REQUEST/.test(name)) shapes.set(name, Object.keys(params).sort());
    for (const value of [params.address, params.remote_address, params.remoteAddress, ...(Array.isArray(params.address_list) ? params.address_list : [])]) {
      const remote = endpoint(value);
      if (remote) { if (!peers.has(id)) peers.set(id, new Map()); peers.get(id).set(JSON.stringify(remote), remote); }
    }
    // Resolver/global-service dependencies can connect unrelated requests; exclude them.
    if (!/HOST_RESOLVER|DNS_|PROXY_|CERT_VERIFIER/.test(name))
      for (const other of dependencies(params)) { link(id, other); link(other, id); }
    const local = endpoint(params.source_address ?? params.local_address ?? params.localAddress);
    if (local && /TCP_CONNECT|SOCKET/.test(name)) {
      const remote = endpoint(params.address ?? params.remote_address ?? params.remoteAddress);
      const row = { sourceId: id, event: name, sourceAddress: local.address, sourcePort: local.port,
        remoteAddress: remote?.address ?? null, remotePort: remote?.port ?? null };
      sockets.set(JSON.stringify([id, local.address, local.port]), row);
    }
  }
  const reached = new Set(roots), pending = [...roots];
  while (pending.length) for (const neighbor of edges.get(pending.shift()) ?? []) if (!reached.has(neighbor)) {
    reached.add(neighbor); pending.push(neighbor);
  }
  const related = [...sockets.values()].filter((item) => reached.has(item.sourceId)).map((item) => {
    const destinations = [...(peers.get(item.sourceId)?.values() ?? [])];
    return !item.remoteAddress && destinations.length === 1 ? { ...item, remoteAddress: destinations[0].address, remotePort: destinations[0].port } : item;
  });
  return { rootCount: roots.size, related, allSocketCount: sockets.size,
    requestDependencySocketAttribution: roots.size === 1 && related.length === 1,
    allEventsCount: data.events?.length ?? 0, eventFieldShapes: Object.fromEntries(shapes) };
}

const BASELINE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$factoryScope = [Console]::In.ReadToEnd() | ConvertFrom-Json
$factoryRows = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $factoryScope.ownerPids -contains [long]$_.OwningProcess } | ForEach-Object {
  [ordered]@{ ownerPid=[long]$_.OwningProcess; sourceAddress=[string]$_.LocalAddress; sourcePort=[int]$_.LocalPort; remoteAddress=[string]$_.RemoteAddress; remotePort=[int]$_.RemotePort; state=[string]$_.State }
})
ConvertTo-Json -InputObject @($factoryRows) -Depth 4 -Compress
`;
async function baseline(ownerPids) {
  const startedAtMono = performance.now();
  const rows = await new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", BASELINE_SCRIPT],
      { windowsHide: true, timeout: 5000, maxBuffer: 384 * 1024 }, (error, stdout) => {
        if (error) return reject(Error("BASELINE_UNAVAILABLE"));
        try {
          const parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed) || parsed.length > 2048 || parsed.some((row) => !ownerPids.includes(row.ownerPid))) throw Error();
          resolve(parsed.map((row) => ({ ...row, sourceAddress: canonical(row.sourceAddress), remoteAddress: canonical(row.remoteAddress) })));
        } catch { reject(Error("BASELINE_UNAVAILABLE")); }
      });
    child.stdin.on("error", () => reject(Error("BASELINE_UNAVAILABLE")));
    child.stdin.end(JSON.stringify({ ownerPids }));
  });
  return { rows, startedAtMono, completedAtMono: performance.now() };
}

if (!process.versions.electron) await parent();
else void child().catch(() => { process.exitCode = 1; process.exit(1); });

async function parent() {
  if (fs.existsSync(path.join(repository, "docs", `${reportStem}.results.json`))) throw Error("EXISTING_INVESTIGATION_MUST_NOT_BE_OVERWRITTEN");
  const { build } = await import("esbuild"), { default: electron } = await import("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-factory-path-"));
  const hashes = Object.fromEntries(sources.map((file) => [file, sha(fs.readFileSync(path.join(repository, file)))]));
  let result, bundleSha256;
  try {
    await build({ stdin: { contents: [
      "export {AnonymousProofProbe} from './src/main/network/anonymous-proof-probe.ts';",
      "export {AnonymousEgressProbe} from './src/main/network/anonymous-egress-probe.ts';",
      "export {WindowsTcpSocketReader} from './src/main/network/windows-tcp-sockets.ts';",
      "export {WindowsControllerOwnerReader} from './src/main/network/windows-controller-owner.ts';",
      "export {WindowsRouteSelectionReader} from './src/main/network/windows-route-selection.ts';",
      "export {parseScopedConnections,connectionHostScope} from './src/main/network/connection-evidence.ts';",
      "export {evaluateRules} from './src/main/network/rules.ts';",
    ].join("\n"), resolveDir: repository, loader: "ts" }, bundle: true, platform: "node", format: "esm",
      external: ["electron"], outfile: path.join(temporary, "production.mjs"), tsconfig: path.join(repository, "tsconfig.electron.json"), logLevel: "silent" });
    bundleSha256 = sha(fs.readFileSync(path.join(temporary, "production.mjs")));
    const env = { ...process.env, SV_FACTORY_PATH_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    const processChild = spawn(electron, [script, ...(nativeOwnerRun ? ["--native-owner"] : [])], { cwd: repository, env, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => processChild.kill(), 65000);
    const code = await new Promise((resolve) => { processChild.once("error", () => resolve(1)); processChild.once("exit", (value) => resolve(value ?? 1)); });
    clearTimeout(timer);
    result = fs.existsSync(path.join(temporary, "result.json")) ? JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8")) : { failure: "NO_CHILD_RESULT", childExitCode: code };
    result.sourceHashes = hashes;
    result.productionBundleSha256 = bundleSha256;
    result.measurementScriptSha256 = sha(fs.readFileSync(script));
    result.sourcesStillCurrentAtCompletion = sources.every((file) => sha(fs.readFileSync(path.join(repository, file))) === hashes[file]);
    result.childExitCode = code;
    result.rawNetLogPersistedInReport = false;
    result.rawTemporaryDataRemoved = false;
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("sv-factory-path-")) throw Error("UNSAFE_CLEANUP_TARGET");
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.rmSync(resolved, { recursive: true, force: true });
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(resolved);
  }
  fs.writeFileSync(path.join(repository, "docs", `${reportStem}.results.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output: `docs/${reportStem}.results.json`, phases: result.phases?.map((phase) => ({ factory: phase.factory, available: phase.available,
    requests: phase.requests?.map((request) => ({ host: request.host, attribution: request.appSocketAttribution, kernelCandidates: request.kernelOutgoingCandidates?.length ?? 0 })) })),
    failure: result.failure ?? null, rawTemporaryDataRemoved: result.rawTemporaryDataRemoved }, null, 2));
  process.exitCode = result.failure || result.childExitCode ? 1 : 0;
}

async function child() {
  const { app, session } = await import("electron");
  const temporary = process.env.SV_FACTORY_PATH_ROOT;
  if (!temporary || path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("sv-factory-path-")) throw Error("ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData")); app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  const result = { executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, packaged: app.isPackaged },
    isolation: { temporaryProfiles: true, accountOpened: false, productionBootstrapLoaded: false, factoryCodeLoadedUnmodified: true, proxyDnsTlsAgentModifiedByShim: false,
      responseHeaderHoldMaximumMs: 4500, tlsTimeoutMs: 10000, egressTimeoutMs: 15000, netLogScope: "isolated child Network Service only", optionalIpv6Sample: false },
    qualificationGranted: false, reasons: ["Diagnostic investigation only; unknown echo rule is not a DIRECT permit", "Kernel outgoing rows remain candidates until their flow ownership is independently qualified"], phases: [] };
  const ownerReader = new production.WindowsControllerOwnerReader({ controllerUrl: "http://127.0.0.1:9790" });
  const liveReaders = [], probes = [], restores = [], pendingMeasurements = new Set();
  let physicalRouteQueries = 0;
  const requestedHosts = new Set();
  let activePhase = null, logging = false, logSequence = 0;
  const reserved = new Set(["api.bilibili.com", "myip.ipip.net", "ipwho.is"]);
  async function inspect({ url, phase, before, beforeConnections, logFile, owner }) {
    const responseAtMono = performance.now();
    await session.defaultSession.netLog.stopLogging(); logging = false;
    const wire = netlogRequest(logFile, url.href);
    const afterConnections = await control("connections");
    const rows = production.parseScopedConnections(afterConnections.value, production.connectionHostScope([url.hostname]));
    const oldIds = new Set(production.parseScopedConnections(beforeConnections.value, production.connectionHostScope([url.hostname])).map((row) => row.id));
    const candidates = rows.filter((row) => !oldIds.has(row.id) && row.destinationPort === 443 && row.network === "tcp" && wire.related.some((socket) => socket.sourceAddress === row.sourceAddress && socket.sourcePort === row.sourcePort));
    const appMetrics = app.getAppMetrics().filter((metric) => metric.serviceName === "network.mojom.NetworkService");
    const appPids = appMetrics.map((metric) => metric.pid), ownerPids = [...new Set([...appPids, process.pid, ...(owner.available ? [owner.owner.pid] : [])])];
    const remotes = [...new Map([
      ...wire.related.filter((row) => row.remoteAddress && row.remotePort).map((row) => ({ address: row.remoteAddress, port: row.remotePort })),
      ...candidates.filter((row) => row.remoteDestinationIp).map((row) => ({ address: row.remoteDestinationIp, port: row.destinationPort })),
    ].map((remote) => [JSON.stringify(remote), remote])).values()];
    const snapshot = remotes.length && remotes.length <= 32 ? await new production.WindowsTcpSocketReader({ ownerPids, remotes }).read() : null;
    const appRows = snapshot?.available ? snapshot.sockets.filter((row) => appPids.includes(row.ownerPid) && wire.related.some((socket) => socket.sourceAddress === row.sourceAddress && socket.sourcePort === row.sourcePort && (!socket.remoteAddress || socket.remoteAddress === row.remoteAddress) && (!socket.remotePort || socket.remotePort === row.remotePort))) : [];
    const kernelRows = snapshot?.available && owner.available ? snapshot.sockets.filter((row) => row.ownerPid === owner.owner.pid && row.state === "Established" && candidates.some((connection) => connection.remoteDestinationIp === row.remoteAddress && connection.destinationPort === row.remotePort)) : [];
    const baselineKeys = new Set(before?.rows?.map(tuple) ?? []);
    const actualOwner = snapshot?.available && owner.available ? snapshot.owners.find((entry) => entry.pid === owner.owner.pid) : null;
    const ownerMatches = !!actualOwner && actualOwner.createdAtTicks === owner.owner.createdAtTicks && actualOwner.executablePathIdentity === owner.owner.executablePathIdentity;
    const request = { host: url.hostname, requestPathKind: url.hostname === "ipwho.is" ? "anonymous-ip-geography" : url.pathname,
      requestStartedAtMono: beforeConnections.completedAtMono, headersObservedAtMono: responseAtMono,
      netLog: { requestRootCount: wire.rootCount, relatedSocketCount: wire.related.length, allSocketCount: wire.allSocketCount, eventCount: wire.allEventsCount, eventFieldShapes: wire.eventFieldShapes,
        requestDependencySocketAttribution: wire.requestDependencySocketAttribution,
        sockets: wire.related.map((row) => ({ sourceId: row.sourceId, event: row.event, sourceAddressHash: ipHash(row.sourceAddress), sourcePort: row.sourcePort,
          remoteAddressHash: ipHash(row.remoteAddress), remotePort: row.remotePort, socketAddressFamily: row.remoteAddress ? net.isIP(row.remoteAddress) === 6 ? "ipv6" : "ipv4" : null })) },
      appNetworkServicePids: appPids, tcpTableAvailable: snapshot?.available ?? false,
      appSocketAttribution: wire.requestDependencySocketAttribution && appRows.length === 1 ? "request-dependency-and-exact-windows-tuple" : "UNATTRIBUTED",
      appSocketRows: appRows.map(projectSocket),
      kernelConnections: candidates.map((row) => ({ id: row.id, host: row.host, sourceAddressHash: ipHash(row.sourceAddress), sourcePort: row.sourcePort,
        destinationPort: row.destinationPort, remoteDestinationHash: ipHash(row.remoteDestinationIp), remoteDestinationFamily: row.remoteDestinationIp ? net.isIP(row.remoteDestinationIp) === 6 ? "ipv6" : "ipv4" : null,
        inboundType: row.inboundType, route: row.route, processIdentity: row.processIdentity, network: row.network })),
      kernelOwnerStable: ownerMatches, kernelOwner: actualOwner ?? null,
      kernelOutgoingCandidates: kernelRows.map((row) => ({ ...projectSocket(row), newSinceBaseline: before ? !baselineKeys.has(tuple(row)) : null })),
      kernelOutgoingFlowAttributionVerified: false,
      measurementCompletedAtMono: performance.now() };
    request.sourceConstrainedRoutes = [];
    for (const socket of kernelRows) {
      if (!ownerMatches || physicalRouteQueries >= 2) break;
      physicalRouteQueries++;
      const reader = new production.WindowsRouteSelectionReader({ addresses: [socket.remoteAddress], localAddress: socket.sourceAddress });
      liveReaders.push(reader);
      const route = await reader.read(); reader.dispose();
      request.sourceConstrainedRoutes.push({ socket: projectSocket(socket), available: route.available,
        ...(route.available ? { basis: route.basis, requestedSourceHash: ipHash(socket.sourceAddress),
          selections: route.selections.map((item) => ({ sourceAddressHash: ipHash(item.sourceAddress), remoteAddressHash: ipHash(item.targetAddress),
            actualSocketSourceMatch: canonical(item.sourceAddress) === canonical(socket.sourceAddress), hardwareInterface: item.hardwareInterface,
            interfaceIndex: item.interfaceIndex, interfaceIdentity: item.interfaceIdentity, addressFamily: item.addressFamily, sourceState: item.sourceState,
            adapterStatus: item.adapterStatus, interfaceConnection: item.interfaceConnection, nextHopHash: ipHash(item.nextHop.split("%")[0]), destinationPrefixHash: sha(item.destinationPrefix) })) } : { reason: route.reason }) });
    }
    request.measurementCompletedAtMono = performance.now();
    phase.requests.push(request);
  }
  const capture = (created) => {
    if (!activePhase) return;
    const phase = activePhase, originalFetch = created.fetch;
    created.fetch = async (input, options) => {
      const url = new URL(input);
      if (!reserved.has(url.hostname) || url.protocol !== "https:" || (url.port && url.port !== "443") || requestedHosts.has(url.hostname)) throw Error("PROBE_BUDGET_REACHED");
      if (url.hostname === "api.bilibili.com" && url.pathname !== "/robots.txt" || url.hostname === "myip.ipip.net" && url.pathname !== "/" || url.search || options?.credentials !== "omit" || options?.redirect !== "manual") throw Error("FIXED_FACTORY_REQUEST_REQUIRED");
      requestedHosts.add(url.hostname);
      const [currentConfig, currentRules] = await Promise.all([control("configs"), control("rules")]);
      const decision = production.evaluateRules(currentConfig.value.mode, currentRules.value.rules, { host: url.hostname, port: 443, network: "tcp" });
      phase.preflight ??= [];
      phase.preflight.push({ host: url.hostname, mode: currentConfig.value.mode, tun: currentConfig.value.tun?.enable ?? null, decision,
        completedAtMono: Math.max(currentConfig.completedAtMono, currentRules.completedAtMono) });
      if (currentConfig.value.mode !== "rule" || currentConfig.value.tun?.enable !== true) throw Error("RULE_TUN_INVESTIGATION_REQUIRED");
      const metrics = app.getAppMetrics().map((metric) => metric.pid);
      const owner = phase.owner;
      const before = await baseline([...new Set([...metrics, ...(owner.available ? [owner.owner.pid] : [])])]).catch(() => null);
      const beforeConnections = await control("connections");
      const logFile = path.join(temporary, `anonymous-${++logSequence}.netlog.json`);
      await session.defaultSession.netLog.startLogging(logFile, { captureMode: "default", maxFileSize: 8 * 1024 * 1024 }); logging = true;
      const response = await originalFetch.call(created, input, options);
      const investigation = inspect({ url, phase, before, beforeConnections, logFile, owner });
      pendingMeasurements.add(investigation);
      void investigation.then(() => pendingMeasurements.delete(investigation), () => pendingMeasurements.delete(investigation));
      try { await bounded(investigation, 4500); }
      catch {
        phase.requests.push({ host: url.hostname, appSocketAttribution: "UNATTRIBUTED", measurementError: "MISSING_OR_LATE_MEASUREMENT" });
        await bounded(response.body?.cancel() ?? Promise.resolve(), 500).catch(() => {});
        throw Error("MEASUREMENT_WINDOW_EXCEEDED");
      }
      return response;
    };
    restores.push(() => { created.fetch = originalFetch; });
  };
  app.on("session-created", capture);
  try {
    const [beforeConfig, beforeRules, beforeDirect] = await Promise.all([control("configs"), control("rules"), control("proxies/DIRECT")]);
    result.controllerBefore = { mode: beforeConfig.value.mode, tun: beforeConfig.value.tun?.enable ?? null,
      configHash: digest(beforeConfig.value), rulesHash: digest(beforeRules.value), directPolicyHash: digest(beforeDirect.value) };
    result.rules = [...reserved].map((host) => ({ host, ...production.evaluateRules(beforeConfig.value.mode, beforeRules.value.rules, { host, port: 443, network: "tcp" }) }));
    for (const factory of ["tls", "egress-ipip"]) {
      const owner = await ownerReader.read();
      const phase = { factory, owner, kernelOwnerAtStart: owner.available ? { kernelEpoch: owner.kernelEpoch, owner: owner.owner } : { available: false }, requests: [] }; activePhase = phase;
      const probe = factory === "tls" ? new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 10000 }) : new production.AnonymousEgressProbe({ concurrency: 1, timeoutMs: 15000 });
      probes.push(probe);
      const abort = new AbortController();
      const found = factory === "tls" ? await probe.probeTls({ host: "api.bilibili.com", port: 443 }, abort.signal) : await probe.probe("ipip", abort.signal);
      phase.available = found.available;
      if (found.available) {
        const observation = found.observation;
        phase.observation = { factoryId: observation.factoryId, transportContextId: observation.transportContextId,
          startedAtMono: observation.startedAtMono, observedAtMono: observation.observedAtMono ?? observation.completedAtMono, completedAtMono: observation.completedAtMono,
          statusCode: observation.statusCode ?? observation.echo.statusCode,
          ...(factory === "tls" ? {} : { reportedAddressFamily: observation.reportedAddressFamily, reportedAddressHash: ipHash(observation.ip), countryCode: observation.countryCode, asn: observation.asn }) };
      } else phase.reason = found.reason;
      await bounded(Promise.allSettled([...pendingMeasurements]), 15000);
      delete phase.owner; result.phases.push(phase);
      await probe.dispose(); activePhase = null;
      if (logging) { await session.defaultSession.netLog.stopLogging(); logging = false; }
    }
    const [afterConfig, afterRules] = await Promise.all([control("configs"), control("rules")]);
    result.controllerAfter = { mode: afterConfig.value.mode, tun: afterConfig.value.tun?.enable ?? null,
      configHash: digest(afterConfig.value), rulesHash: digest(afterRules.value) };
    result.visibleControllerUnchanged = result.controllerAfter.configHash === result.controllerBefore.configHash && result.controllerAfter.rulesHash === result.controllerBefore.rulesHash;
  } catch { result.failure = "BOUNDED_INVESTIGATION_INCOMPLETE"; }
  finally {
    app.removeListener("session-created", capture); restores.forEach((restore) => restore());
    await Promise.allSettled(probes.map((probe) => probe.dispose()));
    if (logging) await session.defaultSession.netLog.stopLogging().catch(() => {});
    ownerReader.dispose(); liveReaders.forEach((reader) => reader.dispose());
    result.requestedHosts = [...requestedHosts]; result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    app.exit(result.failure ? 1 : 0);
  }
}
