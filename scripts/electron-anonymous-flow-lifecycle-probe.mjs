/** Two real anonymous factory requests; delete only independently attributed experiment IDs. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const boundedLifecycleRun = process.argv.includes("--bounded-lifecycle");
const distinctDestinationsRun = boundedLifecycleRun || process.argv.includes("--distinct-destinations");
const reportStem = boundedLifecycleRun
  ? "network-anonymous-flow-lifecycle-v3"
  : distinctDestinationsRun
    ? "network-anonymous-flow-lifecycle-v2"
    : "network-anonymous-flow-lifecycle";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const digest = (value) => sha(JSON.stringify(value));
const canonical = (value) =>
  net.isIP(value) === 4
    ? value
    : net.isIP(value) === 6
      ? new URL(`http://[${value}]/`).hostname.slice(1, -1)
      : null;
const ipHash = (value) => (canonical(value) ? sha(canonical(value)) : null);
const tuple = (row) =>
  JSON.stringify([row.ownerPid, row.sourceAddress, row.sourcePort, row.remoteAddress, row.remotePort]);
async function bounded(work, ms) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("BOUNDED_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function control(endpoint) {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:9790/${endpoint}`, {
    signal: AbortSignal.timeout(2500),
    redirect: "error",
  });
  if (!response.ok) throw Error("CONTROLLER_UNAVAILABLE");
  return { value: await response.json(), startedAtMono: start, completedAtMono: performance.now() };
}
function projectSocket(row) {
  return {
    ownerPid: row.ownerPid,
    sourceAddressHash: ipHash(row.sourceAddress),
    sourcePort: row.sourcePort,
    remoteAddressHash: ipHash(row.remoteAddress),
    remotePort: row.remotePort,
    socketAddressFamily: net.isIP(row.remoteAddress) === 6 ? "ipv6" : "ipv4",
    state: row.state,
  };
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
  const types = Object.fromEntries(
    Object.entries(data.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]),
  );
  const roots = new Set(),
    edges = new Map(),
    sockets = new Map(),
    peers = new Map(),
    shapes = new Map();
  const link = (a, b) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a).add(b);
  };
  const dependencies = (value, output = []) => {
    if (!value || typeof value !== "object") return output;
    for (const [key, item] of Object.entries(value)) {
      if (key === "source_dependency" && item && typeof item.id === "number") output.push(item.id);
      else if (item && typeof item === "object") dependencies(item, output);
    }
    return output;
  };
  for (const event of data.events ?? []) {
    const id = event.source?.id,
      name = types[event.type] ?? String(event.type),
      params = event.params ?? {};
    if (!Number.isInteger(id)) continue;
    if (params.url === exactUrl && /URL_REQUEST/.test(name)) roots.add(id);
    if (/TCP_CONNECT|SOCKET|HTTP_STREAM|URL_REQUEST/.test(name)) shapes.set(name, Object.keys(params).sort());
    for (const value of [
      params.address,
      params.remote_address,
      params.remoteAddress,
      ...(Array.isArray(params.address_list) ? params.address_list : []),
    ]) {
      const remote = endpoint(value);
      if (remote) {
        if (!peers.has(id)) peers.set(id, new Map());
        peers.get(id).set(JSON.stringify(remote), remote);
      }
    }
    // Resolver/global-service dependencies can connect unrelated requests; exclude them.
    if (!/HOST_RESOLVER|DNS_|PROXY_|CERT_VERIFIER/.test(name))
      for (const other of dependencies(params)) {
        link(id, other);
        link(other, id);
      }
    const local = endpoint(params.source_address ?? params.local_address ?? params.localAddress);
    if (local && /TCP_CONNECT|SOCKET/.test(name)) {
      const remote = endpoint(params.address ?? params.remote_address ?? params.remoteAddress);
      const row = {
        sourceId: id,
        event: name,
        sourceAddress: local.address,
        sourcePort: local.port,
        remoteAddress: remote?.address ?? null,
        remotePort: remote?.port ?? null,
      };
      sockets.set(JSON.stringify([id, local.address, local.port]), row);
    }
  }
  const reached = new Set(roots),
    pending = [...roots];
  while (pending.length)
    for (const neighbor of edges.get(pending.shift()) ?? [])
      if (!reached.has(neighbor)) {
        reached.add(neighbor);
        pending.push(neighbor);
      }
  const related = [...sockets.values()]
    .filter((item) => reached.has(item.sourceId))
    .map((item) => {
      const destinations = [...(peers.get(item.sourceId)?.values() ?? [])];
      return !item.remoteAddress && destinations.length === 1
        ? { ...item, remoteAddress: destinations[0].address, remotePort: destinations[0].port }
        : item;
    });
  return {
    rootCount: roots.size,
    related,
    allSocketCount: sockets.size,
    requestDependencySocketAttribution: roots.size === 1 && related.length === 1,
    allEventsCount: data.events?.length ?? 0,
    eventFieldShapes: Object.fromEntries(shapes),
  };
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
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", BASELINE_SCRIPT],
      { windowsHide: true, timeout: 5000, maxBuffer: 384 * 1024 },
      (error, stdout) => {
        if (error) return reject(Error("BASELINE_UNAVAILABLE"));
        try {
          const parsed = JSON.parse(stdout);
          if (
            !Array.isArray(parsed) ||
            parsed.length > 2048 ||
            parsed.some((row) => !ownerPids.includes(row.ownerPid))
          )
            throw Error();
          resolve(
            parsed.map((row) => ({
              ...row,
              sourceAddress: canonical(row.sourceAddress),
              remoteAddress: canonical(row.remoteAddress),
            })),
          );
        } catch {
          reject(Error("BASELINE_UNAVAILABLE"));
        }
      },
    );
    child.stdin.on("error", () => reject(Error("BASELINE_UNAVAILABLE")));
    child.stdin.end(JSON.stringify({ ownerPids }));
  });
  return { rows, startedAtMono, completedAtMono: performance.now() };
}

const publicUrl = "https://api.bilibili.com/robots.txt";
const publicHost = "api.bilibili.com";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value, reason) {
  if (!value) throw Error(reason);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function connectionKey(row) {
  return JSON.stringify([
    row.id,
    row.host,
    row.sourceAddress,
    row.sourcePort,
    row.destinationPort,
    row.remoteDestinationIp,
    row.network,
    row.route,
    row.startedAtMs,
  ]);
}
function projectConnection(row) {
  return {
    id: row.id,
    host: row.host,
    sourceAddressHash: ipHash(row.sourceAddress),
    sourcePort: row.sourcePort,
    destinationPort: row.destinationPort,
    remoteDestinationHash: ipHash(row.remoteDestinationIp),
    network: row.network,
    route: row.route,
    inboundType: row.inboundType,
    processIdentity: row.processIdentity,
  };
}
function stableDirect(value) {
  const result = structuredClone(value);
  delete result.alive;
  delete result.history;
  return result;
}
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  assert(
    !fs.existsSync(path.join(repository, "docs", reportStem + ".results.json")),
    "EXISTING_RESULT_MUST_NOT_BE_OVERWRITTEN",
  );
  const { build } = await import("esbuild"),
    electron = require("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-flow-lifecycle-"));
  let result;
  try {
    const buildResult = await build({
      stdin: {
        contents: [
          "export {AnonymousProofProbe,ANONYMOUS_TLS_FACTORY_ID} from './src/main/network/anonymous-proof-probe.ts';",
          "export {WindowsTcpSocketReader} from './src/main/network/windows-tcp-sockets.ts';",
          "export {WindowsControllerOwnerReader} from './src/main/network/windows-controller-owner.ts';",
          "export {WindowsRouteSelectionReader} from './src/main/network/windows-route-selection.ts';",
          "export {WindowsNetworkFingerprintReader} from './src/main/network/windows-network-fingerprint.ts';",
          "export {parseScopedConnections,connectionHostScope} from './src/main/network/connection-evidence.ts';",
          "export {configureChromiumTransport,readChromiumTransportState} from './src/main/network/chromium-transport.ts';",
          "export {evaluateRules} from './src/main/network/rules.ts';",
        ].join("\n"),
        resolveDir: repository,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: path.join(temporary, "production.cjs"),
      tsconfig: path.join(repository, "tsconfig.electron.json"),
      metafile: true,
      logLevel: "silent",
    });
    const sourceFiles = Object.keys(buildResult.metafile.inputs).filter((file) => file.startsWith("src/"));
    const hashes = Object.fromEntries(
      sourceFiles.map((file) => [file, sha(fs.readFileSync(path.join(repository, file)))]),
    );
    const bundleHash = sha(fs.readFileSync(path.join(temporary, "production.cjs")));
    const env = { ...process.env, SV_FLOW_LIFECYCLE_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const processChild = spawn(
      electron,
      [
        script,
        ...(boundedLifecycleRun
          ? ["--bounded-lifecycle"]
          : distinctDestinationsRun
            ? ["--distinct-destinations"]
            : []),
      ],
      {
        cwd: repository,
        env,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    const watchdog = setTimeout(() => processChild.kill(), 45000);
    const code = await new Promise((resolve) => {
      processChild.once("error", () => resolve(1));
      processChild.once("exit", (value) => resolve(value ?? 1));
    });
    clearTimeout(watchdog);
    result = fs.existsSync(path.join(temporary, "result.json"))
      ? JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"))
      : { failure: "CHILD_RESULT_MISSING" };
    result.childExitCode = code;
    result.productionBundleSha256 = bundleHash;
    result.sourceHashes = hashes;
    result.measurementScriptSha256 = sha(fs.readFileSync(script));
    result.sourcesStillCurrentAtCompletion = sourceFiles.every(
      (file) => sha(fs.readFileSync(path.join(repository, file))) === hashes[file],
    );
  } finally {
    const target = path.resolve(temporary);
    assert(
      path.dirname(target) === path.resolve(os.tmpdir()) &&
        path.basename(target).startsWith("sv-flow-lifecycle-"),
      "UNSAFE_CLEANUP_TARGET",
    );
    await delay(250);
    fs.rmSync(target, { recursive: true, force: true });
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(target);
  }
  fs.writeFileSync(
    path.join(repository, "docs", reportStem + ".results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      flowAssociationObserved: result.flowAssociationObserved ?? false,
      qualificationGranted: false,
      requests: result.requests?.length,
      deletes: result.interventions?.length,
      failure: result.failure ?? null,
      rawTemporaryDataRemoved: result.rawTemporaryDataRemoved,
    }),
  );
  process.exitCode = result.failure || result.childExitCode ? 1 : 0;
}

async function child() {
  const { app, session } = require("electron"),
    temporary = process.env.SV_FLOW_LIFECYCLE_ROOT;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("sv-flow-lifecycle-"),
    "ISOLATION_REQUIRED",
  );
  const production = require(path.join(temporary, "production.cjs"));
  production.configureChromiumTransport(app);
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
  const result = {
    executedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      packaged: app.isPackaged,
    },
    transport: production.readChromiumTransportState(app),
    isolation: {
      realAccounts: false,
      realCredentials: false,
      productionBootstrap: false,
      temporaryProfiles: true,
      publicRequestMaximum: 2,
      exactPublicUrl: publicUrl,
      netLog: "isolated child only",
      rawPacketsCaptured: false,
      osConfigurationChanged: false,
      etwOrEStatsEnabled: false,
      productionFactoryModified: false,
      measurementShim: "hold original fetch Response after headers; no proxy/DNS/TLS/Agent replacement",
      headerHoldMaximumMs: 8000,
      productionTimeoutMs: 10000,
      sourceRouteQueriesAfterLifecycle: boundedLifecycleRun,
      minimumRemainingBeforeDeleteMs: boundedLifecycleRun ? { A: 4500, B: 2200 } : null,
      deletionPolicy: "only exact new experiment-owned mihomo IDs",
    },
    qualificationGranted: false,
    flowAssociationObserved: false,
    requests: [],
    snapshots: [],
    interventions: [],
    associations: [],
  };
  const ownerReader = new production.WindowsControllerOwnerReader({ controllerUrl: "http://127.0.0.1:9790" });
  const networkReader = new production.WindowsNetworkFingerprintReader();
  const phases = [],
    restores = [],
    probes = [],
    routeReaders = [];
  let creating = null,
    logging = false,
    issued = 0,
    referenceOwner,
    referenceState,
    before,
    beforeConnections,
    tcpReader,
    referenceTcpOwners,
    latestSnapshot;
  const capture = (created) => {
    if (!creating) return;
    const phase = creating,
      originalFetch = created.fetch;
    phase.session = created;
    created.fetch = async (input, options) => {
      try {
        assert(
          String(input) === publicUrl &&
            options?.method === "GET" &&
            options?.credentials === "omit" &&
            options?.redirect === "manual" &&
            options?.cache === "no-store",
          "NON_ANONYMOUS_OR_UNEXPECTED_URL",
        );
        assert(!phase.issued && issued < 2, "REQUEST_BUDGET_EXCEEDED");
        phase.issued = true;
        issued++;
        phase.report.requestIssued = true;
        const state = await readState();
        assert(state.fingerprint === referenceState.fingerprint, "CONTROLLER_CHANGED_BEFORE_SEND");
        phase.preflight = state.public;
        phase.report.preflight = state.public;
        phase.requestStartedAtMono = performance.now();
        phase.report.requestStartedAtMono = phase.requestStartedAtMono;
        const response = await originalFetch.call(created, input, options);
        phase.headersAtMono = performance.now();
        phase.statusCode = response.status;
        phase.report.headersObservedAtMono = phase.headersAtMono;
        phase.report.statusCode = response.status;
        phase.responseHeld = true;
        await session.defaultSession.netLog.stopLogging();
        logging = false;
        phase.wire = netlogRequest(phase.logFile, publicUrl);
        phase.report.netLog = {
          rootCount: phase.wire.rootCount,
          relatedSocketCount: phase.wire.related.length,
          requestDependencySocketAttribution: phase.wire.requestDependencySocketAttribution,
          sockets: phase.wire.related.map((s) => ({
            sourceId: s.sourceId,
            sourceAddressHash: ipHash(s.sourceAddress),
            sourcePort: s.sourcePort,
            remoteAddressHash: ipHash(s.remoteAddress),
            remotePort: s.remotePort,
          })),
        };
        phase.headers.resolve();
        phase.holdDeadlineMono = performance.now() + 8000;
        phase.report.holdDeadlineMono = phase.holdDeadlineMono;
        try {
          await bounded(phase.release.promise, 8000);
        } finally {
          phase.responseHeld = false;
          phase.report.holdEndedAtMono = performance.now();
        }
        return response;
      } catch (error) {
        phase.report.failure = /^[A-Z0-9_]+$/.test(String(error.message))
          ? error.message
          : "FACTORY_FETCH_UNAVAILABLE";
        phase.headers.reject(error);
        throw error;
      }
    };
    restores.push(() => {
      created.fetch = originalFetch;
    });
  };
  app.on("session-created", capture);
  async function readState() {
    const [config, rules, direct] = await Promise.all([
      control("configs"),
      control("rules"),
      control("proxies/DIRECT"),
    ]);
    const decision = production.evaluateRules(config.value.mode, rules.value.rules, {
      host: publicHost,
      port: 443,
      network: "tcp",
    });
    result.preflightReads ??= [];
    result.preflightReads.push({
      atMono: performance.now(),
      mode: config.value.mode,
      tun: config.value.tun?.enable ?? null,
      ruleRoute: decision.route,
      ruleIndex: decision.ruleIndex,
      ruleType: rules.value.rules[decision.ruleIndex]?.type ?? null,
      selectedBuiltinDirect: rules.value.rules[decision.ruleIndex]?.proxy === "DIRECT",
      exactBuiltinDirect: direct.value.type === "Direct",
      emptyDialerConfirmed: direct.value["dialer-proxy"] === "",
    });
    assert(
      config.value.mode === "rule" &&
        config.value.tun?.enable === true &&
        decision.route === "direct" &&
        decision.ruleIndex !== null &&
        rules.value.rules[decision.ruleIndex]?.proxy === "DIRECT" &&
        direct.value.type === "Direct" &&
        direct.value["dialer-proxy"] === "",
      "CURRENT_DIRECT_RULE_REQUIRED",
    );
    return {
      fingerprint: digest([config.value, rules.value, stableDirect(direct.value)]),
      public: {
        mode: config.value.mode,
        tun: config.value.tun.enable,
        ruleRoute: decision.route,
        ruleIndex: decision.ruleIndex,
        ruleType: rules.value.rules[decision.ruleIndex].type,
        exactBuiltinDirect: true,
        emptyDialerConfirmed: true,
      },
    };
  }
  const scoped = (value) =>
    production.parseScopedConnections(value, production.connectionHostScope([publicHost]));
  const checkOwner = (owner) =>
    assert(
      owner.available &&
        digest([owner.kernelEpoch, owner.owner, owner.scopeHash]) ===
          digest([referenceOwner.kernelEpoch, referenceOwner.owner, referenceOwner.scopeHash]),
      "KERNEL_OWNER_CHANGED",
    );
  const holdsActive = () =>
    phases.every(
      (p) =>
        p.responseHeld &&
        !p.signal.signal.aborted &&
        !p.active?.abort.signal.aborted &&
        !p.settled &&
        performance.now() < p.holdDeadlineMono,
    );
  const checkHeld = () => assert(holdsActive(), "FACTORY_HOLD_NO_LONGER_ACTIVE");
  const remainingWindow = () =>
    Math.min(...phases.map((p) => Math.min(p.holdDeadlineMono, p.factoryStartedAtMono + 10000))) -
    performance.now();
  async function snapshot(name) {
    checkHeld();
    const [table, connections, owner, state] = await Promise.all([
      tcpReader.read(),
      control("connections"),
      ownerReader.read(),
      readState(),
    ]);
    checkOwner(owner);
    assert(state.fingerprint === referenceState.fingerprint, "CONTROLLER_CHANGED");
    assert(table.available, "TCP_READ_UNAVAILABLE");
    if (referenceTcpOwners) assert(digest(table.owners) === referenceTcpOwners, "TCP_OWNER_IDENTITY_CHANGED");
    else {
      referenceTcpOwners = digest(table.owners);
      const actualOwner = table.owners.find((v) => v.pid === referenceOwner.owner.pid);
      assert(
        actualOwner &&
          actualOwner.createdAtTicks === referenceOwner.owner.createdAtTicks &&
          actualOwner.executablePathIdentity === referenceOwner.owner.executablePathIdentity,
        "TCP_KERNEL_OWNER_MISMATCH",
      );
    }
    const kernel = table.sockets.filter(
      (s) =>
        s.ownerPid === referenceOwner.owner.pid &&
        phases.some((p) => p.connection.remoteDestinationIp === s.remoteAddress) &&
        s.remotePort === 443,
    );
    const parsed = scoped(connections.value);
    const report = {
      name,
      startedAtMono: table.startedAtMono,
      completedAtMono: performance.now(),
      ownerStable: true,
      controllerStable: true,
      kernelRows: kernel.map(projectSocket),
      ownConnections: phases.map((p) => ({
        label: p.label,
        exists: parsed.some((v) => connectionKey(v) === connectionKey(p.connection)),
      })),
      holdsActiveAtCompletion: holdsActive(),
      remainingWindowMs: remainingWindow(),
    };
    result.snapshots.push(report);
    if (boundedLifecycleRun)
      assert(report.holdsActiveAtCompletion, "LIFECYCLE_SAMPLE_INVALIDATED_BY_SELF_CLEANUP");
    latestSnapshot = report;
    return { table, kernel, connections: parsed, report };
  }
  function ownedPresent(rows, phase) {
    return (
      rows.filter((r) => r.id === phase.connection.id && connectionKey(r) === connectionKey(phase.connection))
        .length === 1
    );
  }
  async function deleteOwned(phase) {
    checkHeld();
    assert(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(phase.connection.id),
      "INVALID_EXPERIMENT_ID",
    );
    const [connections, owner, state] = await Promise.all([
      control("connections"),
      boundedLifecycleRun ? Promise.resolve(null) : ownerReader.read(),
      readState(),
    ]);
    if (boundedLifecycleRun) {
      checkHeld();
      assert(
        latestSnapshot?.ownerStable && performance.now() - latestSnapshot.completedAtMono < 500,
        "FRESH_OWNER_SNAPSHOT_REQUIRED",
      );
    } else checkOwner(owner);
    assert(state.fingerprint === referenceState.fingerprint, "CONTROLLER_CHANGED_BEFORE_DELETE");
    const rows = scoped(connections.value),
      oldIds = new Set(scoped(beforeConnections.value).map((r) => r.id));
    result.deletionPreflights ??= [];
    result.deletionPreflights.push({
      label: phase.label,
      connectionId: phase.connection.id,
      atMono: performance.now(),
      absentFromBaseline: !oldIds.has(phase.connection.id),
      exactOwnedIdPresent: ownedPresent(rows, phase),
      independentAppTuple:
        !!phase.appSocket &&
        phase.connection.sourceAddress === phase.appSocket.sourceAddress &&
        phase.connection.sourcePort === phase.appSocket.sourcePort,
      requestDependencyAttribution: phase.wire.requestDependencySocketAttribution,
      ownerStable: true,
      ownerEvidence: boundedLifecycleRun
        ? { snapshot: latestSnapshot.name, completedAtMono: latestSnapshot.completedAtMono }
        : "immediate-controller-owner-read",
      controllerStable: true,
      remainingWindowMs: remainingWindow(),
    });
    assert(!oldIds.has(phase.connection.id) && ownedPresent(rows, phase), "OWNERSHIP_RECHECK_FAILED");
    assert(
      phase.appSocket &&
        phase.wire.requestDependencySocketAttribution &&
        phase.connection.sourceAddress === phase.appSocket.sourceAddress &&
        phase.connection.sourcePort === phase.appSocket.sourcePort &&
        phase.connection.route === "direct",
      "INDEPENDENT_OWNERSHIP_REQUIRED",
    );
    const startedAtMono = performance.now();
    if (boundedLifecycleRun) {
      checkHeld();
      assert(
        remainingWindow() >= (phase.label === "A" ? 4500 : 2200),
        "INSUFFICIENT_LIFECYCLE_WINDOW_BEFORE_DELETE",
      );
    }
    const response = await fetch(
      "http://127.0.0.1:9790/connections/" + encodeURIComponent(phase.connection.id),
      { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(2000) },
    );
    result.interventions.push({
      label: phase.label,
      connectionId: phase.connection.id,
      method: "DELETE",
      ownershipRechecked: true,
      startedAtMono,
      completedAtMono: performance.now(),
      status: response.status,
    });
    assert(response.status === 204, "DELETE_NOT_ACKNOWLEDGED");
    if (boundedLifecycleRun) checkHeld();
  }
  try {
    const [state, owner, network] = await Promise.all([
      readState(),
      ownerReader.read(),
      networkReader.readObservation(),
    ]);
    assert(owner.available, "KERNEL_OWNER_UNAVAILABLE");
    assert(network.available, "OS_NETWORK_UNAVAILABLE");
    referenceState = state;
    referenceOwner = owner;
    result.controller = state.public;
    result.visibleControllerFingerprint = state.fingerprint;
    result.kernelOwner = { kernelEpoch: owner.kernelEpoch, owner: owner.owner };
    result.osNetworkBefore = network;
    const ownerPids = [...new Set([...app.getAppMetrics().map((v) => v.pid), owner.owner.pid])];
    [before, beforeConnections] = await Promise.all([baseline(ownerPids), control("connections")]);
    result.baseline = {
      startedAtMono: before.startedAtMono,
      completedAtMono: before.completedAtMono,
      selectedOwnerCount: ownerPids.length,
      scopedIncomingCount: scoped(beforeConnections.value).length,
      rawSocketRowsRetained: false,
    };
    for (const label of ["A", "B"]) {
      const phase = {
        label,
        headers: deferred(),
        release: deferred(),
        signal: new AbortController(),
        logFile: path.join(temporary, label + ".netlog.json"),
        report: { label, requestIssued: false, appSocketIndependentlyVerified: false },
      };
      phases.push(phase);
      result.requests.push(phase.report);
      await session.defaultSession.netLog.startLogging(phase.logFile, {
        captureMode: "default",
        maxFileSize: 6 * 1024 * 1024,
      });
      logging = true;
      const probe = new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 10000 });
      probes.push(probe);
      creating = phase;
      phase.factoryStartedAtMono = performance.now();
      phase.report.factoryStartedAtMono = phase.factoryStartedAtMono;
      phase.pending = probe.probeTls({ host: publicHost, port: 443 }, phase.signal.signal).then((found) => {
        phase.settled = true;
        phase.report.factorySettledAtMono = performance.now();
        phase.found = found;
        return found;
      });
      creating = null;
      await bounded(phase.headers.promise, 4000);
      assert(
        phase.wire.requestDependencySocketAttribution &&
          phase.wire.related[0].remoteAddress &&
          phase.wire.related[0].remotePort === 443,
        "REQUEST_NETLOG_AMBIGUOUS",
      );
      // Read-only isolated instrumentation of the actual generated factory slot, never rewriting its context.
      const slot = probe.slots?.[0];
      assert(
        slot?.session === phase.session && typeof slot.contextId === "string",
        "ACTUAL_FACTORY_CONTEXT_MISSING",
      );
      phase.contextId = slot.contextId;
      phase.active = slot.active;
      Object.assign(phase.report, {
        factoryId: production.ANONYMOUS_TLS_FACTORY_ID,
        transportContextId: phase.contextId,
        factoryContextSource: "read-only-actual-isolated-factory-slot",
        fromCache: phase.active?.fromCache ?? null,
        hookStatus: phase.active?.statusCode ?? null,
        certificateValidation: "chromium-default",
        credentials: "omit",
      });
      assert(
        phase.active?.fromCache === false &&
          phase.active.statusCode === phase.statusCode &&
          phase.statusCode === 200,
        "FRESH_TLS_200_REQUIRED",
      );
    }
    result.preconditions = {
      distinctSessions: phases[0].session !== phases[1].session,
      distinctContexts: phases[0].contextId !== phases[1].contextId,
      distinctAppSocketTuples:
        JSON.stringify(phases[0].wire.related[0]) !== JSON.stringify(phases[1].wire.related[0]),
      allowDistinctDestinations: distinctDestinationsRun,
    };
    assert(
      result.preconditions.distinctSessions && result.preconditions.distinctContexts,
      "SESSIONS_MUST_DIFFER",
    );
    const connections = await control("connections"),
      rows = scoped(connections.value),
      oldIds = new Set(scoped(beforeConnections.value).map((r) => r.id));
    for (const phase of phases) {
      const wire = phase.wire.related[0];
      const matches = rows.filter(
        (r) =>
          !oldIds.has(r.id) &&
          r.host === publicHost &&
          r.network === "tcp" &&
          r.route === "direct" &&
          r.destinationPort === 443 &&
          r.sourceAddress === wire.sourceAddress &&
          r.sourcePort === wire.sourcePort &&
          r.remoteDestinationIp,
      );
      phase.report.incomingCandidates = matches.map(projectConnection);
      assert(matches.length === 1, "INCOMING_ID_AMBIGUOUS");
      phase.connection = matches[0];
    }
    result.preconditions.distinctIncomingIds = phases[0].connection.id !== phases[1].connection.id;
    result.preconditions.sameRemoteDestination =
      phases[0].connection.remoteDestinationIp === phases[1].connection.remoteDestinationIp;
    assert(result.preconditions.distinctIncomingIds, "INCOMING_IDS_NOT_DISTINCT");
    if (!distinctDestinationsRun)
      assert(result.preconditions.sameRemoteDestination, "SAME_DESTINATION_NOT_OBSERVED");
    const appPids = app
      .getAppMetrics()
      .filter((metric) => metric.serviceName === "network.mojom.NetworkService")
      .map((v) => v.pid);
    const remotes = [
      ...new Map(
        [
          ...phases.map((p) => ({ address: p.wire.related[0].remoteAddress, port: 443 })),
          ...phases.map((p) => ({ address: p.connection.remoteDestinationIp, port: 443 })),
        ].map((v) => [JSON.stringify(v), v]),
      ).values(),
    ];
    tcpReader = new production.WindowsTcpSocketReader({
      ownerPids: [...new Set([...appPids, referenceOwner.owner.pid])],
      remotes,
    });
    const first = await snapshot("both-held-before-intervention");
    for (const phase of phases) {
      const wire = phase.wire.related[0],
        matches = first.table.sockets.filter(
          (s) =>
            appPids.includes(s.ownerPid) &&
            s.sourceAddress === wire.sourceAddress &&
            s.sourcePort === wire.sourcePort &&
            s.remoteAddress === wire.remoteAddress &&
            s.remotePort === wire.remotePort &&
            s.state === "Established",
        );
      phase.report.appSocketMatches = matches.map(projectSocket);
      assert(matches.length === 1, "APP_TUPLE_NOT_INDEPENDENTLY_VERIFIED");
      phase.appSocket = matches[0];
      Object.assign(phase.report, {
        appSocketIndependentlyVerified: true,
        label: phase.label,
        factoryId: production.ANONYMOUS_TLS_FACTORY_ID,
        transportContextId: phase.contextId,
        factoryContextSource: "read-only-actual-isolated-factory-slot",
        requestStartedAtMono: phase.requestStartedAtMono,
        headersObservedAtMono: phase.headersAtMono,
        statusCode: phase.statusCode,
        fromCache: false,
        certificateValidation: "chromium-default",
        credentials: "omit",
        preflight: phase.preflight,
        netLog: {
          rootCount: phase.wire.rootCount,
          relatedSocketCount: phase.wire.related.length,
          requestDependencySocketAttribution: true,
          sourceId: wire.sourceId,
          sourceAddressHash: ipHash(wire.sourceAddress),
          sourcePort: wire.sourcePort,
          remoteAddressHash: ipHash(wire.remoteAddress),
          remotePort: wire.remotePort,
        },
        appSocket: projectSocket(phase.appSocket),
        incoming: projectConnection(phase.connection),
      });
    }
    const baselineKeys = new Set(before.rows.map(tuple));
    const candidates = first.kernel.filter((s) => s.state === "Established" && !baselineKeys.has(tuple(s)));
    result.initialKernelCandidates = candidates.map((s) => ({ ...projectSocket(s), newSinceBaseline: true }));
    result.preconditions.newKernelCandidateCount = candidates.length;
    result.preconditions.totalScopedEstablishedCount = first.kernel.filter(
      (s) => s.state === "Established",
    ).length;
    assert(
      candidates.length === 2 && first.kernel.filter((s) => s.state === "Established").length === 2,
      "EXACTLY_TWO_NEW_PHYSICAL_CANDIDATES_REQUIRED",
    );
    async function querySourceRoutes() {
      result.sourceConstrainedRoutes = [];
      for (const candidate of [
        ...new Map(candidates.map((s) => [JSON.stringify([s.sourceAddress, s.remoteAddress]), s])).values(),
      ]) {
        const routeReader = new production.WindowsRouteSelectionReader({
          addresses: [candidate.remoteAddress],
          localAddress: candidate.sourceAddress,
        });
        routeReaders.push(routeReader);
        const route = await routeReader.read();
        routeReader.dispose();
        await routeReader.whenIdle();
        assert(
          route.available &&
            route.basis === "windows-source-route-query" &&
            route.selections.length === 1 &&
            route.selections[0].sourceAddress === candidate.sourceAddress &&
            route.selections[0].hardwareInterface === true,
          "PHYSICAL_SOURCE_ROUTE_UNAVAILABLE",
        );
        const physical = route.selections[0];
        result.sourceConstrainedRoutes.push({
          basis: route.basis,
          startedAtMono: route.startedAtMono,
          completedAtMono: route.completedAtMono,
          actualSocketSourceMatch: true,
          sourceAddressHash: ipHash(physical.sourceAddress),
          targetAddressHash: ipHash(physical.targetAddress),
          addressFamily: physical.addressFamily,
          hardwareInterface: physical.hardwareInterface,
          interfaceIndex: physical.interfaceIndex,
          interfaceIdentity: physical.interfaceIdentity,
          sourceState: physical.sourceState,
          adapterStatus: physical.adapterStatus,
          interfaceConnection: physical.interfaceConnection,
          nextHopHash: ipHash(physical.nextHop.split("%")[0]),
          destinationPrefixHash: sha(physical.destinationPrefix),
        });
      }
    }
    if (!boundedLifecycleRun) await querySourceRoutes();
    const stable = boundedLifecycleRun ? first : await snapshot("held-control-before-delete-A");
    assert(
      candidates.every((candidate) =>
        stable.kernel.some((s) => tuple(s) === tuple(candidate) && s.state === "Established"),
      ) && phases.every((p) => ownedPresent(stable.connections, p)),
      "PREINTERVENTION_CONNECTION_NOT_STABLE",
    );
    await deleteOwned(phases[0]);
    const afterA = await snapshot("after-delete-A");
    assert(
      !afterA.connections.some((r) => r.id === phases[0].connection.id) &&
        ownedPresent(afterA.connections, phases[1]),
      "INCOMING_A_NOT_SELECTIVELY_CLOSED",
    );
    const disappearedA = candidates.filter(
      (candidate) => !afterA.kernel.some((s) => tuple(s) === tuple(candidate) && s.state === "Established"),
    );
    const remainingB = candidates.filter((candidate) =>
      afterA.kernel.some((s) => tuple(s) === tuple(candidate) && s.state === "Established"),
    );
    assert(
      disappearedA.length === 1 &&
        remainingB.length === 1 &&
        disappearedA[0].remoteAddress === phases[0].connection.remoteDestinationIp &&
        remainingB[0].remoteAddress === phases[1].connection.remoteDestinationIp &&
        afterA.kernel.filter((s) => s.state === "Established").length === 1,
      "PHYSICAL_A_NOT_SELECTIVELY_CLOSED",
    );
    result.associations.push({
      label: "A",
      connectionId: phases[0].connection.id,
      physicalSocket: projectSocket(disappearedA[0]),
      basis: "exact-owned-ID-close-with-other-flow-held-control",
      matchedByUniqueCandidateAlone: false,
    });
    await deleteOwned(phases[1]);
    const afterB = await snapshot("after-delete-B");
    assert(
      !afterB.connections.some((r) => phases.some((p) => p.connection.id === r.id)) &&
        !afterB.kernel.some((s) => s.state === "Established"),
      "PHYSICAL_B_NOT_CLOSED",
    );
    result.associations.push({
      label: "B",
      connectionId: phases[1].connection.id,
      physicalSocket: projectSocket(remainingB[0]),
      basis: "second-exact-owned-ID-close-after-first-pair-excluded",
      matchedByUniqueCandidateAlone: false,
    });
    if (boundedLifecycleRun) {
      checkHeld();
      result.lifecycleCompletedAtMono = performance.now();
      result.lifecycleCompletedBeforeSelfCleanup = true;
      phases.forEach((phase) => phase.release.resolve());
      await bounded(Promise.allSettled(phases.map((phase) => phase.pending)), 3000);
      await querySourceRoutes();
    }
    const [networkAfter, stateAfter, ownerAfter] = await Promise.all([
      networkReader.readObservation(),
      readState(),
      ownerReader.read(),
    ]);
    checkOwner(ownerAfter);
    result.osNetworkAfter = networkAfter;
    assert(
      networkAfter.available &&
        network.hash === networkAfter.hash &&
        state.fingerprint === stateAfter.fingerprint,
      "ENVIRONMENT_CHANGED",
    );
    result.flowAssociationObserved = true;
    result.associationScope =
      "two observed TLS factory flows under the declared before/after observation model; not physical absolute causality or complete transport qualification";
  } catch (error) {
    result.failure = /^[A-Z0-9_]+$/.test(String(error.message)) ? error.message : "INVESTIGATION_INCOMPLETE";
  } finally {
    phases.forEach((phase) => phase.release.resolve());
    await bounded(Promise.allSettled(phases.map((phase) => phase.pending)), 3000).catch(() => {});
    for (const phase of phases) {
      result.factoryResults ??= [];
      result.factoryResults.push({
        label: phase.label,
        available: phase.found?.available ?? false,
        reason: phase.found?.available ? undefined : (phase.found?.reason ?? "NO_RESULT"),
        ...(phase.found?.available ? { observation: phase.found.observation } : {}),
      });
      phase.signal.abort();
    }
    app.removeListener("session-created", capture);
    restores.forEach((restore) => restore());
    await bounded(Promise.allSettled(probes.map((probe) => probe.dispose())), 4000).catch(() => {});
    if (logging) await session.defaultSession.netLog.stopLogging().catch(() => {});
    ownerReader.dispose();
    routeReaders.forEach((reader) => reader.dispose());
    result.publicRequestsIssued = issued;
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result, null, 2) + "\n");
    app.exit(result.failure ? 1 : 0);
  }
}
