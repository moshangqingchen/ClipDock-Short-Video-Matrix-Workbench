/** One normal-DNS IPv6 echo factory investigation; anonymous echo + matching geo at most once. */
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
const repairedRun = process.argv.includes("--repaired");
const reportStem = repairedRun
  ? "network-anonymous-egress-ipv6-path-v2"
  : "network-anonymous-egress-ipv6-path";
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

function assert(value, reason) {
  if (!value) throw Error(reason);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function stableDirect(value) {
  const result = structuredClone(value);
  delete result.alive;
  delete result.history;
  return result;
}
function dnsSummary(logFile, host) {
  const log = JSON.parse(fs.readFileSync(logFile, "utf8"));
  const types = Object.fromEntries(
    Object.entries(log.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]),
  );
  // These are explicit hostname observations, separate from the socket dependency graph.
  // Shared resolver sources are never used to connect an unrelated socket to this request.
  const boundSources = new Set();
  const related = [];
  const hostValue = (value) =>
    typeof value === "string" &&
    (value === host ||
      value === `${host}:443` ||
      value === `https://${host}` ||
      value === `https://${host}:443`);
  for (const event of log.events ?? []) {
    const name = types[event.type] ?? String(event.type);
    if (!/HOST_RESOLVER|DNS_/.test(name)) continue;
    const params = event.params ?? {};
    if ([params.host, params.hostname, params.domain_name, params.name].some(hostValue))
      boundSources.add(event.source?.id);
  }
  for (const event of log.events ?? []) {
    const name = types[event.type] ?? String(event.type);
    if (!boundSources.has(event.source?.id) || !/HOST_RESOLVER|DNS_/.test(name)) continue;
    const params = event.params ?? {};
    const addresses = [
      ...(Array.isArray(params.addresses) ? params.addresses : []),
      ...(Array.isArray(params.address_list) ? params.address_list : []),
    ]
      .map((v) => canonical(v) ?? endpoint(v)?.address)
      .filter(Boolean);
    related.push({
      event: name,
      sourceId: event.source.id,
      phase: event.phase,
      fieldNames: Object.keys(params).sort(),
      addresses: addresses.map((ip) => ({ hash: ipHash(ip), family: net.isIP(ip) === 6 ? "ipv6" : "ipv4" })),
      netError: typeof params.net_error === "number" ? params.net_error : null,
    });
  }
  return {
    forcedResolution: false,
    additionalDnsQueries: false,
    explicitHostResolverSourceCount: boundSources.size,
    observations: related.slice(0, 64),
    resolverPathEquivalenceVerified: false,
  };
}

function writeCheckpoint(target, result, stage) {
  const serialized =
    JSON.stringify({ ...result, checkpointStage: stage, checkpointAt: new Date().toISOString() }, null, 2) +
    "\n";
  const sequence = fs
    .readdirSync(path.dirname(target))
    .filter((name) => /^checkpoint-\d{4}\.json$/.test(name)).length;
  fs.writeFileSync(
    path.join(path.dirname(target), `checkpoint-${String(sequence).padStart(4, "0")}.json`),
    serialized,
    { flag: "wx" },
  );
  fs.writeFileSync(target, serialized);
}
async function finishReport(target, result, cleanup) {
  writeCheckpoint(target, result, "facts-before-final-cleanup");
  try {
    await cleanup();
    result.cleanupSucceeded = true;
  } catch {
    result.cleanupSucceeded = false;
    result.cleanupFailure = "FINAL_CLEANUP_FAILED";
  }
  result.completedAt = new Date().toISOString();
  writeCheckpoint(target, result, "final");
}
async function selfcheck() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-egress-ipv6-path-selfcheck-"));
  const target = path.join(temporary, "result.json");
  try {
    const facts = { requests: [{ host: "fixture.invalid", statusCode: 200 }], publicRequestsIssued: 0 };
    writeCheckpoint(target, facts, "measured-fixture");
    assert(
      JSON.parse(fs.readFileSync(target, "utf8")).requests[0].statusCode === 200,
      "CHECKPOINT_LOST_FACTS",
    );
    await finishReport(target, facts, async () => {
      throw Error("synthetic cleanup fault");
    });
    const failed = JSON.parse(fs.readFileSync(target, "utf8"));
    assert(
      failed.requests[0].statusCode === 200 &&
        failed.cleanupSucceeded === false &&
        failed.cleanupFailure === "FINAL_CLEANUP_FAILED",
      "CLEANUP_FAILURE_LOST_FACTS",
    );
    const readerWithReadOnly = { read: async () => ({ available: true }) };
    await finishReport(target, { ...facts }, async () => {
      await readerWithReadOnly.read();
    });
    const complete = JSON.parse(fs.readFileSync(target, "utf8"));
    assert(
      complete.cleanupSucceeded === true && complete.publicRequestsIssued === 0,
      "READ_ONLY_READER_CLEANUP_FAILED",
    );
    assert(
      fs.readdirSync(temporary).filter((name) => /^checkpoint-\d{4}\.json$/.test(name)).length === 5,
      "INDEPENDENT_CHECKPOINTS_REQUIRED",
    );
    console.log(
      JSON.stringify({
        checks: 4,
        publicRequestsIssued: 0,
        cleanupFailurePreservesFacts: true,
        missingDisposeNotInvented: true,
      }),
    );
  } finally {
    assert(
      path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
        path.basename(temporary).startsWith("sv-egress-ipv6-path-selfcheck-"),
      "UNSAFE_CLEANUP_TARGET",
    );
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (!process.versions.electron) {
  if (process.argv.includes("--cleanup-selfcheck")) await selfcheck();
  else await parent();
} else
  void child().catch(() => {
    const temporary = process.env.SV_EGRESS_IPV6_PATH_ROOT;
    if (
      temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("sv-egress-ipv6-path-")
    ) {
      const target = path.join(temporary, "result.json");
      try {
        const previous = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
        writeCheckpoint(
          target,
          { ...previous, outerFailure: "CHILD_OUTER_FAILURE" },
          "outer-error-preserving-facts",
        );
      } catch {
        /* The last successfully written checkpoint remains the fallback. */
      }
    }
    process.exit(1);
  });

async function parent() {
  assert(
    !fs.existsSync(path.join(repository, "docs", reportStem + ".results.json")),
    "EXISTING_RESULT_MUST_NOT_BE_OVERWRITTEN",
  );
  const { build } = await import("esbuild"),
    electron = require("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-egress-ipv6-path-"));
  let result,
    checkpoints = [];
  try {
    const built = await build({
      stdin: {
        contents: [
          "export {AnonymousEgressProbe,ANONYMOUS_EGRESS_FACTORY_ID} from './src/main/network/anonymous-egress-probe.ts';",
          "export {WindowsTcpSocketReader} from './src/main/network/windows-tcp-sockets.ts';",
          "export {WindowsControllerOwnerReader} from './src/main/network/windows-controller-owner.ts';",
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
    const files = Object.keys(built.metafile.inputs).filter((file) => file.startsWith("src/"));
    const hashes = Object.fromEntries(
      files.map((file) => [file, sha(fs.readFileSync(path.join(repository, file)))]),
    );
    const bundleHash = sha(fs.readFileSync(path.join(temporary, "production.cjs")));
    const env = { ...process.env, SV_EGRESS_IPV6_PATH_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const processChild = spawn(electron, [script, ...(repairedRun ? ["--repaired"] : [])], {
      cwd: repository,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    const watchdog = setTimeout(() => processChild.kill(), 40000);
    const code = await new Promise((resolve) => {
      processChild.once("error", () => resolve(1));
      processChild.once("exit", (value) => resolve(value ?? 1));
    });
    clearTimeout(watchdog);
    result = fs.existsSync(path.join(temporary, "result.json"))
      ? JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"))
      : { failure: "CHILD_RESULT_MISSING" };
    checkpoints = fs
      .readdirSync(temporary)
      .filter((name) => /^checkpoint-\d{4}\.json$/.test(name))
      .sort()
      .map((name) => ({
        file: name,
        result: JSON.parse(fs.readFileSync(path.join(temporary, name), "utf8")),
      }));
    result.checkpointCount = checkpoints.length;
    result.childExitCode = code;
    result.productionBundleSha256 = bundleHash;
    result.sourceHashes = hashes;
    result.measurementScriptSha256 = sha(fs.readFileSync(script));
    result.sourcesStillCurrentAtCompletion = files.every(
      (file) => sha(fs.readFileSync(path.join(repository, file))) === hashes[file],
    );
  } finally {
    const target = path.resolve(temporary);
    assert(
      path.dirname(target) === path.resolve(os.tmpdir()) &&
        path.basename(target).startsWith("sv-egress-ipv6-path-"),
      "UNSAFE_CLEANUP_TARGET",
    );
    await delay(250);
    fs.rmSync(target, { recursive: true, force: true });
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(target);
  }
  fs.writeFileSync(
    path.join(repository, "docs", reportStem + ".checkpoints.json"),
    JSON.stringify(checkpoints, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(repository, "docs", reportStem + ".results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      requests: result.publicRequestsIssued,
      factoryAvailable: result.factoryResult?.available ?? false,
      reportedAddressFamily: result.factoryResult?.observation?.reportedAddressFamily ?? null,
      echoSocketFamily:
        result.requests?.find((r) => r.host === "api6.ipify.org")?.actualAppSocketFamily ?? null,
      echoRoute:
        result.requests?.find((r) => r.host === "api6.ipify.org")?.attributedKernelRoute ?? "UNATTRIBUTED",
      qualificationGranted: false,
      failure: result.failure ?? null,
      rawTemporaryDataRemoved: result.rawTemporaryDataRemoved,
    }),
  );
  process.exitCode = result.failure || result.childExitCode ? 1 : 0;
}

async function child() {
  const { app, session } = require("electron"),
    temporary = process.env.SV_EGRESS_IPV6_PATH_ROOT;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("sv-egress-ipv6-path-"),
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
      platform: process.platform,
      packaged: app.isPackaged,
    },
    transport: production.readChromiumTransportState(app),
    qualificationGranted: false,
    isolation: {
      realAccounts: false,
      credentials: "omit",
      temporaryProfiles: true,
      defaultSessionAllDenied: true,
      publicRequestMaximum: 2,
      requestHosts: ["api6.ipify.org", "ipwho.is"],
      productionFactoryModified: false,
      forcedDns: false,
      extraDnsQueries: false,
      osOrControllerConfigurationChanged: false,
      connectionDelete: false,
      productionTimeoutMs: 12000,
      perResponseMeasurementMaximumMs: 2500,
      rawNetLog: "isolated child only; temporary deletion after exit",
      measurementShim: "hold actual factory Response after headers without changing DNS/proxy/TLS/Agent",
    },
    requests: [],
  };
  const ownerReader = new production.WindowsControllerOwnerReader({ controllerUrl: "http://127.0.0.1:9790" });
  const networkReader = new production.WindowsNetworkFingerprintReader();
  const signal = new AbortController(),
    pending = new Set(),
    restores = [];
  const hosts = new Set();
  let probe,
    creating = false,
    logging = false,
    issued = 0,
    referenceOwner,
    referenceState,
    before,
    beforeConnections;
  let echoSource = null,
    echoReport = null,
    originalEchoIp = null;
  const checkpoint = (stage) => {
    result.publicRequestsIssued = issued;
    writeCheckpoint(path.join(temporary, "result.json"), result, stage);
  };
  checkpoint("isolated-startup");
  const scoped = (value, host) =>
    production.parseScopedConnections(value, production.connectionHostScope([host]));
  async function readState() {
    const [config, rules, direct] = await Promise.all([
      control("configs"),
      control("rules"),
      control("proxies/DIRECT"),
    ]);
    return {
      config: config.value,
      rules: rules.value.rules,
      direct: direct.value,
      fingerprint: digest([config.value, rules.value, stableDirect(direct.value)]),
      public: {
        mode: config.value.mode,
        tun: config.value.tun?.enable ?? null,
        globalIpv6: config.value.ipv6 ?? null,
        exactBuiltinDirect: direct.value.type === "Direct",
        emptyDialerConfirmed: direct.value["dialer-proxy"] === "",
      },
    };
  }
  const ownerKey = (owner) =>
    owner.available ? digest([owner.kernelEpoch, owner.owner, owner.scopeHash]) : null;
  async function measure({ logFile, url, item, slot, headersAtMono }) {
    await session.defaultSession.netLog.stopLogging();
    logging = false;
    const wire = netlogRequest(logFile, url.href);
    item.dns = dnsSummary(logFile, url.hostname);
    item.netLog = {
      requestRootCount: wire.rootCount,
      relatedSocketCount: wire.related.length,
      requestDependencySocketAttribution: wire.requestDependencySocketAttribution,
      sockets: wire.related.map((s) => ({
        sourceId: s.sourceId,
        sourceAddressHash: ipHash(s.sourceAddress),
        sourcePort: s.sourcePort,
        remoteAddressHash: ipHash(s.remoteAddress),
        remotePort: s.remotePort,
        addressFamily: s.remoteAddress ? (net.isIP(s.remoteAddress) === 6 ? "ipv6" : "ipv4") : null,
      })),
    };
    const afterConnections = await control("connections"),
      oldIds = new Set(scoped(beforeConnections.value, url.hostname).map((r) => r.id));
    const parsed = scoped(afterConnections.value, url.hostname);
    const candidates = parsed.filter(
      (r) =>
        !oldIds.has(r.id) &&
        (r.host === url.hostname || r.sniffHost === url.hostname) &&
        r.destinationPort === 443 &&
        r.network === "tcp" &&
        wire.related.some((s) => s.sourceAddress === r.sourceAddress && s.sourcePort === r.sourcePort),
    );
    item.kernelConnectionCandidates = candidates.map((r) => {
      const raw = afterConnections.value.connections?.find((v) => v.id === r.id);
      const rawRemote = raw?.metadata?.remoteDestination;
      const reportedRemote = canonical(rawRemote) ?? endpoint(rawRemote)?.address;
      return {
        id: r.id,
        host: r.host,
        sourceAddressHash: ipHash(r.sourceAddress),
        sourcePort: r.sourcePort,
        destinationPort: r.destinationPort,
        destinationIpHash: ipHash(r.destinationIp),
        route: r.route,
        nonDirectChainHash: r.route === "non-direct" ? digest(raw?.chains ?? null) : null,
        inboundType: r.inboundType,
        processIdentity: r.processIdentity,
        directRemoteDestinationHash: ipHash(r.remoteDestinationIp),
        kernelReportedRemoteDestination: {
          shape: canonical(rawRemote)
            ? "ip"
            : endpoint(rawRemote)
              ? "ip-port"
              : rawRemote === undefined
                ? "absent"
                : "other",
          hash: ipHash(reportedRemote),
          family: reportedRemote ? (net.isIP(reportedRemote) === 6 ? "ipv6" : "ipv4") : null,
          isPhysicalSocketEvidence: false,
        },
      };
    });
    const appPids = app
      .getAppMetrics()
      .filter((v) => v.serviceName === "network.mojom.NetworkService")
      .map((v) => v.pid);
    const remotes = [
      ...new Map(
        [
          ...wire.related
            .filter((r) => r.remoteAddress && r.remotePort)
            .map((r) => ({ address: r.remoteAddress, port: r.remotePort })),
          ...candidates
            .filter((r) => r.remoteDestinationIp)
            .map((r) => ({ address: r.remoteDestinationIp, port: r.destinationPort })),
        ].map((r) => [JSON.stringify(r), r]),
      ).values(),
    ];
    let table = null;
    if (remotes.length > 0 && remotes.length <= 32 && appPids.length > 0) {
      const reader = new production.WindowsTcpSocketReader({
        ownerPids: [...new Set([...appPids, referenceOwner.owner.pid])],
        remotes,
      });
      table = await reader.read();
    }
    const owner = table?.available ? table.owners.find((v) => v.pid === referenceOwner.owner.pid) : null;
    const ownerStable =
      !!owner &&
      owner.createdAtTicks === referenceOwner.owner.createdAtTicks &&
      owner.executablePathIdentity === referenceOwner.owner.executablePathIdentity;
    const appRows = table?.available
      ? table.sockets.filter(
          (s) =>
            s.state === "Established" &&
            appPids.includes(s.ownerPid) &&
            wire.related.some(
              (w) =>
                w.sourceAddress === s.sourceAddress &&
                w.sourcePort === s.sourcePort &&
                w.remoteAddress === s.remoteAddress &&
                w.remotePort === s.remotePort,
            ),
        )
      : [];
    const timely =
      performance.now() - headersAtMono < 2500 &&
      !!slot.flight &&
      !slot.flight.abort.signal.aborted &&
      !signal.signal.aborted;
    const exact = wire.requestDependencySocketAttribution && appRows.length === 1 && ownerStable && timely;
    item.tcpTable = {
      available: table?.available ?? false,
      startedAtMono: table?.startedAtMono ?? null,
      completedAtMono: table?.completedAtMono ?? null,
      ownerStable,
      owners: table?.available ? table.owners : [],
      appSocketRows: appRows.map(projectSocket),
    };
    item.measurementTimely = timely;
    item.appSocketAttribution = exact ? "request-dependency-and-exact-windows-tuple" : "UNATTRIBUTED";
    item.actualAppSocketFamily = exact ? (net.isIP(appRows[0].remoteAddress) === 6 ? "ipv6" : "ipv4") : null;
    item.attributedKernelRoute =
      exact &&
      candidates.length === 1 &&
      candidates[0].sourceAddress === appRows[0].sourceAddress &&
      candidates[0].sourcePort === appRows[0].sourcePort
        ? candidates[0].route
        : "UNATTRIBUTED";
    const baselineKeys = new Set(before.rows.map(tuple));
    item.kernelOutgoingCandidates =
      ownerStable && table?.available
        ? table.sockets
            .filter(
              (s) =>
                s.ownerPid === referenceOwner.owner.pid &&
                s.state === "Established" &&
                candidates.some(
                  (r) => r.remoteDestinationIp === s.remoteAddress && r.destinationPort === s.remotePort,
                ),
            )
            .map((s) => ({ ...projectSocket(s), newSinceBaseline: !baselineKeys.has(tuple(s)) }))
        : [];
    item.kernelOutgoingFlowAttributionVerified = false;
    item.measurementCompletedAtMono = performance.now();
    if (url.hostname === "api6.ipify.org") {
      echoReport = item;
      if (exact) echoSource = appRows[0].sourceAddress;
    }
    checkpoint("response-path-measured");
  }
  const capture = (created) => {
    if (!creating) return;
    const originalFetch = created.fetch;
    created.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert(
        url.protocol === "https:" &&
          (!url.port || url.port === "443") &&
          !url.search &&
          !url.hash &&
          ["api6.ipify.org", "ipwho.is"].includes(url.hostname) &&
          !hosts.has(url.hostname) &&
          issued < 2 &&
          options?.method === "GET" &&
          options?.credentials === "omit" &&
          options?.redirect === "manual" &&
          options?.cache === "no-store",
        "FIXED_ANONYMOUS_BUDGET_REQUIRED",
      );
      if (url.hostname === "api6.ipify.org")
        assert(url.pathname === "/" && issued === 0, "ECHO_FIRST_REQUIRED");
      else {
        const parsed = canonical(decodeURIComponent(url.pathname.slice(1)));
        assert(issued === 1 && parsed && net.isIP(parsed) === 6, "MATCHING_IPV6_GEO_REQUIRED");
        originalEchoIp = parsed;
        result.partialEchoFromFactoryGeoTarget = {
          reportedAddressHash: ipHash(parsed),
          reportedAddressFamily: "ipv6",
          source: "actual-factory-constructed-geo-target",
          isSocketAfEvidence: false,
        };
      }
      const item = {
        host: url.hostname,
        pathKind: url.hostname === "api6.ipify.org" ? "public-root" : "same-anonymous-ip-geography",
        requestIssued: false,
        appSocketAttribution: "UNATTRIBUTED",
        attributedKernelRoute: "UNATTRIBUTED",
        actualAppSocketFamily: null,
      };
      result.requests.push(item);
      const state = await readState();
      item.preflight = {
        ...state.public,
        ruleDecision: production.evaluateRules(state.config.mode, state.rules, {
          host: url.hostname,
          port: 443,
          network: "tcp",
        }),
        atMono: performance.now(),
      };
      assert(
        state.fingerprint === referenceState.fingerprint &&
          state.config.mode === "rule" &&
          state.config.tun?.enable === true,
        "CONTROLLER_CHANGED_OR_UNEXPECTED_MODE",
      );
      const slot = probe.slots.find((v) => v.session === created);
      assert(
        slot && typeof slot.contextId === "string" && !slot.flight.abort.signal.aborted,
        "ACTUAL_FACTORY_CONTEXT_REQUIRED",
      );
      item.factoryId = production.ANONYMOUS_EGRESS_FACTORY_ID;
      item.transportContextId = slot.contextId;
      const logFile = path.join(temporary, `request-${issued}.netlog.json`);
      await session.defaultSession.netLog.startLogging(logFile, {
        captureMode: "default",
        maxFileSize: 8 * 1024 * 1024,
      });
      logging = true;
      hosts.add(url.hostname);
      issued++;
      item.requestIssued = true;
      item.startedAtMono = performance.now();
      checkpoint("before-original-factory-fetch");
      let response;
      try {
        response = await originalFetch.call(created, input, options);
        item.headersObservedAtMono = performance.now();
        item.statusCode = response.status;
        item.hookStatus = slot.flight?.active?.status ?? null;
        item.fromCache = slot.flight?.active?.fromCache ?? null;
        checkpoint("original-response-headers");
        const work = measure({ logFile, url, item, slot, headersAtMono: item.headersObservedAtMono });
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        try {
          await bounded(work, 2500);
        } catch {
          item.measurementFailure = "MISSING_OR_LATE_MEASUREMENT";
          signal.abort();
          throw Error("MEASUREMENT_WINDOW_EXCEEDED");
        }
        assert(
          !signal.signal.aborted && !!slot.flight && !slot.flight.abort.signal.aborted,
          "FACTORY_DEADLINE_EXCEEDED",
        );
        return response;
      } catch (error) {
        item.failure = /^[A-Z0-9_]+$/.test(String(error.message))
          ? error.message
          : "FACTORY_FETCH_UNAVAILABLE";
        if (logging) {
          await session.defaultSession.netLog.stopLogging().catch(() => {});
          logging = false;
        }
        if (fs.existsSync(logFile) && !item.netLog) {
          try {
            const wire = netlogRequest(logFile, url.href);
            item.dns = dnsSummary(logFile, url.hostname);
            item.netLog = {
              requestRootCount: wire.rootCount,
              relatedSocketCount: wire.related.length,
              requestDependencySocketAttribution: false,
            };
          } catch {
            /* No raw parse errors. */
          }
        }
        await bounded(response?.body?.cancel() ?? Promise.resolve(), 300).catch(() => {});
        checkpoint("request-failure-with-partial-facts");
        throw error;
      }
    };
    restores.push(() => {
      created.fetch = originalFetch;
    });
  };
  app.on("session-created", capture);
  try {
    const [state, owner, osBefore] = await Promise.all([
      readState(),
      ownerReader.read(),
      networkReader.readObservation(),
    ]);
    assert(
      state.config.mode === "rule" &&
        state.config.tun?.enable === true &&
        owner.available &&
        osBefore.available,
      "CURRENT_ENVIRONMENT_UNAVAILABLE",
    );
    referenceState = state;
    referenceOwner = owner;
    result.controllerBefore = { ...state.public, visibleFingerprint: state.fingerprint };
    result.kernelOwner = { kernelEpoch: owner.kernelEpoch, owner: owner.owner };
    result.osBefore = osBefore;
    const pids = [...new Set([...app.getAppMetrics().map((m) => m.pid), owner.owner.pid])];
    [before, beforeConnections] = await Promise.all([baseline(pids), control("connections")]);
    result.baseline = {
      startedAtMono: before.startedAtMono,
      completedAtMono: before.completedAtMono,
      selectedOwnerCount: pids.length,
      scopedExistingConnections: ["api6.ipify.org", "ipwho.is"].map((host) => ({
        host,
        count: scoped(beforeConnections.value, host).length,
      })),
    };
    checkpoint("environment-and-baseline");
    probe = new production.AnonymousEgressProbe({ concurrency: 1 });
    creating = true;
    const work = probe.probe("ipify-ipv6", signal.signal);
    creating = false;
    const found = await work;
    await bounded(Promise.allSettled([...pending]), 6000);
    result.factoryResult = {
      available: found.available,
      ...(found.available
        ? {
            observation: {
              factoryId: found.observation.factoryId,
              transportContextId: found.observation.transportContextId,
              startedAtMono: found.observation.startedAtMono,
              observedAtMono: found.observation.observedAtMono,
              completedAtMono: found.observation.completedAtMono,
              source: found.observation.source,
              reportedAddressFamily: found.observation.reportedAddressFamily,
              reportedAddressHash: ipHash(found.observation.ip),
              countryCode: found.observation.countryCode,
              asn: found.observation.asn,
              echo: found.observation.echo,
              geo: found.observation.geo,
              echoedIpEqualsGeoValidatedIp: true,
              actualEchoSocketSourceEqualsReportedIp: echoSource
                ? canonical(echoSource) === canonical(found.observation.ip)
                : null,
              actualEchoSocketFamily: echoReport?.actualAppSocketFamily ?? null,
            },
          }
        : { reason: found.reason }),
    };
    if (!found.available && originalEchoIp)
      result.partialEchoFromFactoryGeoTarget.actualSocketSourceEqualsReportedIp = echoSource
        ? canonical(echoSource) === originalEchoIp
        : null;
    checkpoint("factory-completed");
    const [afterState, afterOwner, osAfter] = await Promise.all([
      readState(),
      ownerReader.read(),
      networkReader.readObservation(),
    ]);
    result.controllerAfter = { ...afterState.public, visibleFingerprint: afterState.fingerprint };
    result.osAfter = osAfter;
    result.environmentStable =
      afterState.fingerprint === referenceState.fingerprint &&
      ownerKey(afterOwner) === ownerKey(referenceOwner) &&
      osAfter.available &&
      osAfter.hash === osBefore.hash;
    result.nativeIpv6Qualified = false;
  } catch (error) {
    result.failure = /^[A-Z0-9_]+$/.test(String(error.message))
      ? error.message
      : "BOUNDED_INVESTIGATION_INCOMPLETE";
  } finally {
    result.publicRequestsIssued = issued;
    await finishReport(path.join(temporary, "result.json"), result, async () => {
      creating = false;
      signal.abort();
      app.removeListener("session-created", capture);
      restores.forEach((r) => r());
      await bounded(Promise.allSettled([...pending]), 6500);
      if (probe) await bounded(probe.dispose(), 4000);
      if (logging) await session.defaultSession.netLog.stopLogging();
      ownerReader.dispose();
      // WindowsTcpSocketReader owns one bounded read, not a persistent lifecycle or dispose API.
    });
    app.exit(result.failure || !result.cleanupSucceeded ? 1 : 0);
  }
}
