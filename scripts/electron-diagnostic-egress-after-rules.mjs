/** Default: local build/self-check only. --run-once: two real anonymous factory calls, no retries.
 * Add --ipip-only to execute just the fixed IPIP factory call (and its matching-IP geo query).
 * --forced-api6 maps one current kernel AAAA before ready in a separate experimental profile.
 * This isolated observation grants no qualification or permit. No account/bootstrap is imported.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const controllerUrl = "http://127.0.0.1:9790";
const allProviders = [
  { provider: "ipip", host: "myip.ipip.net" },
  { provider: "ipify-ipv6", host: "api6.ipify.org" },
];
const ipipOnly = process.argv.includes("--ipip-only");
const forcedApi6 = process.argv.includes("--forced-api6");
const startupSelfCheck = process.argv.includes("--forced-startup-self-check");
const providers = ipipOnly
  ? allProviders.filter((entry) => entry.provider === "ipip")
  : forcedApi6
    ? allProviders.filter((entry) => entry.provider === "ipify-ipv6")
    : allProviders;
// The reviewed 424c2ef API uses this exact, case-sensitive inbound type. Never learn it from a match.
const expectedInboundType = "Tun";
const explicitRun = process.argv.includes("--run-once");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const assert = (value, code) => {
  if (!value) throw Error(code);
};
const safeError = (error) =>
  /^[A-Z_]{1,100}$/.test(error?.message ?? "") ? error.message : "OBSERVATION_UNAVAILABLE";
const canonical = (value) =>
  net.isIP(value) === 4
    ? value
    : net.isIP(value) === 6 && !value.includes("%")
      ? new URL(`http://[${value}]`).hostname.slice(1, -1)
      : null;
const ipHash = (value) => (canonical(value) ? sha(canonical(value)) : null);
const family = (value) => (net.isIP(value) === 4 ? "ipv4" : net.isIP(value) === 6 ? "ipv6" : null);
const projectTuple = (value) => ({
  sourceAddressHash: ipHash(value.sourceAddress),
  sourcePort: value.sourcePort,
  remoteAddressHash: ipHash(value.remoteAddress),
  remotePort: value.remotePort,
  socketAddressFamily: family(value.remoteAddress),
});
const exactTuple = (a, b) =>
  ["sourceAddress", "sourcePort", "remoteAddress", "remotePort"].every((key) => a[key] === b[key]);
function contextComparison(socket, timing, before, after, host, owner) {
  const oldIds = new Set(before.connections.map((entry) => entry.id));
  const candidates = after.connections.filter(
    (entry) => entry.sourcePort === socket.sourcePort && (entry.host === host || entry.sniffHost === host),
  );
  return {
    expectedInboundType,
    candidateBasis: "scoped-host-and-source-port-only; candidate is not an ownership assertion",
    candidateCount: candidates.length,
    truncated: candidates.length > 16,
    baselineCompletedBeforeSend: before.completedAtMono <= timing.sentAtMono,
    snapshotStartedAtMono: after.startedAtMono,
    snapshotCompletedAtMono: after.completedAtMono,
    candidates: candidates.slice(0, 16).map((entry) => ({
      idHash: sha(entry.id),
      newSinceBaseline: !oldIds.has(entry.id),
      sourceAddressMatches: entry.sourceAddress === socket.sourceAddress,
      sourcePortMatches: entry.sourcePort === socket.sourcePort,
      destinationPortMatches: entry.destinationPort === socket.remotePort,
      hostMatches: entry.host === host,
      sniffHostMatches: entry.sniffHost === null || entry.sniffHost === host,
      processIdentityPresent: entry.processIdentity !== null,
      processIdentityMatches: owner ? entry.processIdentity === owner.executablePathIdentity : null,
      inboundType: entry.inboundType,
      inboundTypeMatches: entry.inboundType === expectedInboundType,
      network: entry.network,
      networkMatches: entry.network === "tcp",
      route: entry.route,
      startedWithinRequestWindow:
        entry.startedAtMs >= timing.sentAtWall && entry.startedAtMs <= timing.headersAtWall,
    })),
  };
}
const bounded = async (work, ms) => {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("DRAIN_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

let lastResort = () => {};
let forcedStartup = null;
const forcedPreflightFacts = { controllerReads: 0, connectionsReads: 0, dnsReads: 0, osReads: 0 };
if (!process.versions.electron) await parent();
// Electron readiness waits for ESM initialization: do not await child() at module scope.
else {
  // Only this pre-ready phase is top-level awaited. It never waits for app.whenReady().
  if (forcedApi6)
    forcedStartup = await prepareForcedStartup().catch((error) => ({ failure: safeError(error) }));
  void child().catch((error) => {
    lastResort(error);
    process.exit(1);
  });
}

function selectCurrentAaaa(response, nowMono) {
  assert(
    response.host === "api6.ipify.org" &&
      response.queryType === "AAAA" &&
      response.question?.name === response.host &&
      response.question.type === 28 &&
      response.status === 0 &&
      response.truncated === false &&
      response.answers.length > 0,
    "CURRENT_AAAA_UNAVAILABLE",
  );
  let name = response.host;
  const visited = new Set();
  for (let index = 0; index < 8; index++) {
    assert(!visited.has(name), "CURRENT_AAAA_UNAVAILABLE");
    visited.add(name);
    const aliases = response.answers.filter((answer) => answer.name === name && answer.type === 5);
    if (!aliases.length) break;
    assert(aliases.length === 1, "CURRENT_AAAA_UNAVAILABLE");
    name = aliases[0].data;
  }
  const selected = response.answers.find(
    (answer) =>
      answer.name === name &&
      answer.type === 28 &&
      family(answer.data) === "ipv6" &&
      /^[23][0-9a-f]{3}:/i.test(canonical(answer.data)) &&
      !canonical(answer.data).startsWith("2001:db8:"),
  );
  assert(selected, "CURRENT_AAAA_UNAVAILABLE");
  // Preserve the original response start and every retained answer TTL, including aliases.
  const expiresAtMono = Math.min(
    ...response.answers.map((answer) => response.startedAtMono + answer.ttl * 1000),
  );
  assert(Number.isFinite(expiresAtMono) && nowMono < expiresAtMono, "CURRENT_AAAA_EXPIRED");
  return { address: canonical(selected.data), expiresAtMono };
}

async function prepareForcedStartup() {
  const { app } = await import("electron");
  const temporary = process.env.CLIPDOCK_DIAGNOSTIC_EGRESS_ROOT;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
      path.basename(temporary).startsWith("diagnostic-egress-after-rules-"),
    "ISOLATION_REQUIRED",
  );
  assert(!app.isReady(), "MAP_BEFORE_READY_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  production.configureChromiumTransport(app);
  if (startupSelfCheck) {
    // Exercise asynchronous TLA/ready ordering locally, with no factory or controller call.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert(!app.isReady(), "MAP_BEFORE_READY_REQUIRED");
    app.commandLine.appendSwitch("host-resolver-rules", "MAP api6.ipify.org [2001:db8::2]");
    return { selfCheck: true, mappedBeforeReady: true };
  }
  const reader = new production.ClashReader({ controllerUrl, getSecret: () => null });
  const networkReader = new production.WindowsNetworkFingerprintReader();
  forcedPreflightFacts.controllerReads++;
  forcedPreflightFacts.osReads++;
  // Do not abandon an uncancellable native OS read when the controller fails first.
  const initial = await Promise.allSettled([reader.read(), networkReader.readObservation()]);
  assert(
    initial.every((entry) => entry.status === "fulfilled"),
    "FORCED_PREFLIGHT_UNAVAILABLE",
  );
  const [controller, network] = initial.map((entry) => entry.value);
  forcedPreflightFacts.os = network;
  assert(network.available, "OS_CONFIGURATION_UNAVAILABLE");
  const decision = production.evaluateRules(controller.mode, controller.rules, {
    host: "api6.ipify.org",
    port: 443,
    network: "tcp",
    destination: { stage: "unknown" },
  });
  assert(
    controller.mode === "rule" &&
      controller.tun === true &&
      controller.directPolicy?.kind === "direct" &&
      decision.route === "direct",
    "DIAGNOSTIC_ROUTES_NOT_DIRECT",
  );
  forcedPreflightFacts.controller = {
    mode: controller.mode,
    tun: controller.tun,
    fingerprint: controller.fingerprint,
    kernelVersion: controller.version,
    startedAtMono: controller.startedAtMono,
    completedAtMono: controller.completedAtMono,
    decision,
  };
  forcedPreflightFacts.connectionsReads++;
  const connections = await reader.readConnections(["api6.ipify.org"]);
  // Last preflight I/O: no process startup, OS read or independent resolver prewarming after this.
  forcedPreflightFacts.dnsReads++;
  const dns = await reader.readDnsQuery("api6.ipify.org", "AAAA");
  forcedPreflightFacts.dns = {
    host: dns.host,
    queryType: dns.queryType,
    status: dns.status,
    truncated: dns.truncated,
    startedAtMono: dns.startedAtMono,
    completedAtMono: dns.completedAtMono,
    answers: dns.answers.map((answer) => ({
      type: answer.type,
      ttl: answer.ttl,
      addressHash: ipHash(answer.data),
      addressFamily: family(answer.data),
      nameHash: sha(answer.name),
      cnameHash: answer.type === 5 ? sha(answer.data) : null,
    })),
  };
  const selected = selectCurrentAaaa(dns, performance.now());
  assert(!app.isReady(), "MAP_BEFORE_READY_REQUIRED");
  app.commandLine.appendSwitch("host-resolver-rules", `MAP api6.ipify.org [${selected.address}]`);
  return {
    reader,
    networkReader,
    controller,
    network,
    connections,
    dns,
    ...selected,
    mappedAtMono: performance.now(),
    mappedBeforeReady: true,
  };
}

function echoParserSource() {
  const filename = "src/main/network/anonymous-request-socket.ts";
  const original = fs.readFileSync(path.join(root, filename), "utf8");
  const declaration = "export function parseAnonymousRequestSocket(";
  const exactLine =
    '    const exactUrl = `https://${target.host}${target.port === 443 ? "" : `:${target.port}`}/robots.txt`;';
  for (const token of [declaration, exactLine])
    assert(original.split(token).length === 2, "PARSER_SOURCE_CHANGED");
  const adapted = original
    .replace(declaration, "export function parseDiagnosticEchoSocket(")
    .replace(
      exactLine,
      '    if (target.port !== 443 || !["myip.ipip.net", "api6.ipify.org"].includes(target.host)) fail("INPUT_INVALID");\n    const exactUrl = `https://${target.host}/`;',
    );
  return { filename, original, adapted };
}

async function parserSelfCheck(filename) {
  const { parseDiagnosticEchoSocket: parse, correlateProbeConnection } = await import(
    pathToFileURL(filename).href
  );
  const fixture = (host, ipv6 = false) => ({
    constants: {
      logEventTypes: {
        URL_REQUEST_START_JOB: 1,
        HTTP_STREAM_JOB_BOUND_TO_REQUEST: 2,
        SOCKET_POOL_BOUND_TO_SOCKET: 3,
        TCP_CONNECT: 4,
        SOCKET_ALIVE: 5,
      },
      logSourceType: { URL_REQUEST: 1, HTTP_STREAM_JOB: 2, SOCKET: 3 },
    },
    events: [
      { source: { id: 1, type: 1 }, type: 1, params: { url: `https://${host}/` } },
      { source: { id: 2, type: 2 }, type: 2, params: { source_dependency: { id: 1 } } },
      { source: { id: 2, type: 2 }, type: 3, params: { source_dependency: { id: 3 } } },
      {
        source: { id: 3, type: 3 },
        type: 4,
        params: { address_list: [ipv6 ? "[2001:db8::2]:443" : "198.18.0.2:443"] },
      },
      {
        source: { id: 3, type: 3 },
        type: 5,
        params: { source_address: ipv6 ? "[2001:db8::1]:51234" : "192.0.2.1:51234" },
      },
    ],
  });
  let passed = 0;
  for (const { host } of allProviders)
    for (const ipv6 of [false, true]) {
      const result = parse(JSON.stringify(fixture(host, ipv6)), { host, port: 443 });
      assert(
        result.available && family(result.observation.tuple.remoteAddress) === (ipv6 ? "ipv6" : "ipv4"),
        "LOCAL_EXACT_SOCKET_FIXTURE_FAILED",
      );
      passed++;
    }
  const host = providers[0].host;
  const badPath = fixture(host);
  badPath.events[0].params.url += "robots.txt";
  assert(!parse(JSON.stringify(badPath), { host, port: 443 }).available, "LOCAL_WRONG_PATH_ACCEPTED");
  passed++;
  assert(
    !parse(JSON.stringify(fixture("other.example")), { host: "other.example", port: 443 }).available,
    "LOCAL_FOREIGN_HOST_ACCEPTED",
  );
  passed++;
  const ambiguous = fixture(host);
  ambiguous.events.push({ source: { id: 9, type: 1 }, type: 1, params: { url: `https://${host}/` } });
  assert(
    !parse(JSON.stringify(ambiguous), { host, port: 443 }).available,
    "LOCAL_AMBIGUOUS_REQUEST_ACCEPTED",
  );
  passed++;
  const owner = { executablePathIdentity: "a".repeat(64) };
  const before = { startedAtMono: 100, completedAtMono: 101, connections: [] };
  const after = {
    startedAtMono: 104,
    completedAtMono: 105,
    connections: [
      {
        id: "own-local-fixture",
        host,
        sniffHost: null,
        sourceAddress: "192.0.2.1",
        sourcePort: 51234,
        destinationPort: 443,
        destinationIp: null,
        remoteDestinationIp: null,
        network: "tcp",
        inboundType: "Tun",
        processIdentity: owner.executablePathIdentity,
        route: "direct",
        startedAtMs: 1002,
      },
    ],
  };
  const socket = {
    contextId: "local-fixture",
    target: { protocol: "https:", host, port: 443, addressFamily: "ipv4" },
    sourceAddress: "192.0.2.1",
    sourcePort: 51234,
    processIdentity: owner.executablePathIdentity,
    inboundType: expectedInboundType,
    network: "tcp",
    startedAtWallMs: 1002,
    completedAtWallMs: 1003,
    startedAtMono: 102,
    completedAtMono: 103,
  };
  assert(correlateProbeConnection(socket, before, after, 105, 15000).matched, "LOCAL_TUN_CASE_REJECTED");
  passed++;
  assert(
    correlateProbeConnection({ ...socket, inboundType: "TUN" }, before, after, 105, 15000).reason ===
      "CONTEXT_MISMATCH",
    "LOCAL_CORRELATOR_CASE_BOUNDARY_CHANGED",
  );
  passed++;
  const comparison = contextComparison(
    { ...socket, remotePort: 443 },
    { sentAtMono: 102, sentAtWall: 1002, headersAtWall: 1003 },
    before,
    after,
    host,
    owner,
  );
  assert(
    comparison.candidates.length === 1 &&
      comparison.candidates[0].inboundTypeMatches &&
      comparison.candidates[0].processIdentityMatches &&
      !JSON.stringify(comparison).includes("192.0.2.1"),
    "LOCAL_CONTEXT_PROJECTION_FAILED",
  );
  passed++;
  const dns = {
    host: "api6.ipify.org",
    queryType: "AAAA",
    status: 0,
    truncated: false,
    question: { name: "api6.ipify.org", type: 28 },
    startedAtMono: 100,
    completedAtMono: 500,
    answers: [{ name: "api6.ipify.org", type: 28, ttl: 2, data: "2606:4700::1111" }],
  };
  assert(selectCurrentAaaa(dns, 600).expiresAtMono === 2100, "LOCAL_DNS_TIME_REFRESHED");
  passed++;
  for (const [input, at, code] of [
    [dns, 2100, "CURRENT_AAAA_EXPIRED"],
    [{ ...dns, answers: [{ ...dns.answers[0], data: "192.0.2.1" }] }, 600, "CURRENT_AAAA_UNAVAILABLE"],
    [{ ...dns, host: "other.example" }, 600, "CURRENT_AAAA_UNAVAILABLE"],
    [{ ...dns, truncated: true }, 600, "CURRENT_AAAA_UNAVAILABLE"],
    [
      {
        ...dns,
        answers: [
          { name: "api6.ipify.org", type: 5, ttl: 1, data: "alias.example" },
          { ...dns.answers[0], name: "alias.example" },
        ],
      },
      1100,
      "CURRENT_AAAA_EXPIRED",
    ],
  ]) {
    let failure = null;
    try {
      selectCurrentAaaa(input, at);
    } catch (error) {
      failure = error.message;
    }
    assert(failure === code, "LOCAL_DNS_BOUNDARY_ACCEPTED");
    passed++;
  }
  return passed;
}

async function parent() {
  assert(!(explicitRun && process.argv.includes("--build-only")), "CONFLICTING_MODES");
  assert(!(ipipOnly && forcedApi6), "CONFLICTING_PROVIDERS");
  assert(
    process.argv
      .slice(2)
      .every((arg) => ["--run-once", "--build-only", "--ipip-only", "--forced-api6"].includes(arg)),
    "UNKNOWN_ARGUMENT",
  );
  const { build } = await import("esbuild");
  const { default: electron } = await import("electron");
  const temporaryParent = path.resolve(root, "docs/.compare");
  fs.mkdirSync(temporaryParent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryParent, "diagnostic-egress-after-rules-"));
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const resultPath = path.join(root, `docs/network-diagnostic-egress-after-rules.${stamp}.results.json`);
  let result;
  try {
    const parser = echoParserSource();
    const common = {
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron", "node:*"],
      tsconfig: path.join(root, "tsconfig.electron.json"),
      logLevel: "silent",
    };
    await build({
      ...common,
      stdin: {
        contents: parser.adapted + "\nexport {correlateProbeConnection} from './connection-evidence.ts';",
        resolveDir: path.join(root, "src/main/network"),
        loader: "ts",
      },
      outfile: path.join(temporary, "parser.mjs"),
    });
    const selfChecks = await parserSelfCheck(path.join(temporary, "parser.mjs"));
    const exports = [
      "export {AnonymousEgressProbe} from './anonymous-egress-probe.ts';",
      "export {AnonymousNetLogCapture} from './anonymous-netlog-capture.ts';",
      "export {ClashReader} from './clash-reader.ts';",
      "export {WindowsTcpSocketReader} from './windows-tcp-sockets.ts';",
      "export {WindowsRouteSelectionReader} from './windows-route-selection.ts';",
      "export {WindowsNetworkFingerprintReader} from './windows-network-fingerprint.ts';",
      "export {correlateProbeConnection,executablePathIdentity} from './connection-evidence.ts';",
      "export {evaluateRules} from './rules.ts';",
      "export {configureChromiumTransport,readChromiumTransportState} from './chromium-transport.ts';",
    ];
    const built = await build({
      ...common,
      stdin: {
        contents: parser.adapted + "\n" + exports.join("\n"),
        resolveDir: path.join(root, "src/main/network"),
        loader: "ts",
      },
      outfile: path.join(temporary, "production.mjs"),
      metafile: true,
    });
    const hashes = Object.fromEntries(
      Object.keys(built.metafile.inputs)
        .filter((name) => name.startsWith("src/"))
        .map((name) => [name, sha(fs.readFileSync(path.join(root, name)))]),
    );
    hashes[parser.filename] = sha(parser.original);
    const buildFacts = {
      scriptHash: sha(fs.readFileSync(script)),
      sourceHashes: hashes,
      bundleHash: sha(fs.readFileSync(path.join(temporary, "production.mjs"))),
      parserSourceHash: sha(parser.original),
      privateEchoParserAdapterHash: sha(parser.adapted),
      parserAdaptation:
        "one exact function-name replacement plus one fixed-root-URL replacement; original log unchanged",
      localParserChecks: selfChecks,
    };
    if (!explicitRun) {
      let startupCheck = null;
      if (forcedApi6) {
        const env = { ...process.env, CLIPDOCK_DIAGNOSTIC_EGRESS_ROOT: temporary };
        delete env.ELECTRON_RUN_AS_NODE;
        const worker = spawn(electron, [script, "--forced-api6", "--forced-startup-self-check"], {
          cwd: root,
          env,
          windowsHide: true,
          stdio: "ignore",
        });
        const timer = setTimeout(() => worker.kill(), 15_000);
        const code = await new Promise((resolve) => {
          worker.once("error", () => resolve(1));
          worker.once("exit", (value) => resolve(value ?? 1));
        });
        clearTimeout(timer);
        const filename = path.join(temporary, "startup-check.json");
        startupCheck = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : null;
        assert(
          code === 0 &&
            startupCheck?.mappedBeforeReady &&
            startupCheck?.readyReached &&
            startupCheck?.exactMap &&
            startupCheck.publicRequestsIssued === 0,
          "LOCAL_PRE_READY_CHECK_FAILED",
        );
      }
      console.log(
        JSON.stringify({
          buildOnly: true,
          selectedProviders: providers.map((entry) => entry.provider),
          localParserChecks: selfChecks,
          productionSourceCount: Object.keys(hashes).length,
          accountSessions: 0,
          controllerRequests: 0,
          publicRequestsIssued: 0,
          privateEchoParserAdapterHash: buildFacts.privateEchoParserAdapterHash,
          forcedStartupLocalCheck: startupCheck,
        }),
      );
      return;
    }
    const env = { ...process.env, CLIPDOCK_DIAGNOSTIC_EGRESS_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(
      electron,
      [script, "--run-once", ...(ipipOnly ? ["--ipip-only"] : []), ...(forcedApi6 ? ["--forced-api6"] : [])],
      {
        cwd: root,
        env,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    let watchdog = false;
    const timer = setTimeout(() => {
      watchdog = true;
      worker.kill();
    }, 65_000);
    const code = await new Promise((resolve) => {
      worker.once("error", () => resolve(1));
      worker.once("exit", (value) => resolve(value ?? 1));
    });
    clearTimeout(timer);
    // Native read-only PowerShell work has a 6s production timeout; a killed Electron may not drain it.
    if (watchdog) await new Promise((resolve) => setTimeout(resolve, 6500));
    const checkpointPath = path.join(temporary, "result.json");
    result = fs.existsSync(checkpointPath)
      ? JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
      : { failure: "CHILD_RESULT_MISSING", requestCountUnavailable: true, qualificationGranted: false };
    Object.assign(result, buildFacts, {
      childExitCode: code,
      parentWatchdogFired: watchdog,
      sourceHashesStable: Object.entries(hashes).every(
        ([name, hash]) => sha(fs.readFileSync(path.join(root, name))) === hash,
      ),
    });
  } finally {
    const exact = path.resolve(temporary);
    assert(
      path.dirname(exact) === temporaryParent &&
        path.basename(exact).startsWith("diagnostic-egress-after-rules-"),
      "UNSAFE_TEMPORARY_PATH",
    );
    assert(fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(), "TEMPORARY_PATH_CHANGED");
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      fs.rmSync(exact, { recursive: true });
    } catch {
      /* No retry or broader deletion. */
    }
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (result) {
    result.observationRetained = Boolean(
      result.sourceHashesStable &&
      result.rawTemporaryDataRemoved &&
      !result.parentWatchdogFired &&
      !result.failure &&
      result.cleanup?.drained &&
      result.childExitCode === 0,
    );
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(
      JSON.stringify(
        {
          report: path.relative(root, resultPath),
          observationRetained: result.observationRetained,
          providers: result.providers?.map((row) => ({
            provider: row.provider,
            result: row.factoryResult,
            echoRouteObservation: row.echoRouteObservation,
            actualSocketAF: row.echoSocket?.socketAddressFamily ?? null,
            incoming: row.incoming?.reason ?? row.incoming?.matched ?? null,
          })),
          failure: result.failure ?? null,
          cleanup: result.cleanup,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.observationRetained ? 0 : 1;
  }
}

async function child() {
  const { app, session, BrowserWindow, webContents } = await import("electron");
  const temporary = process.env.CLIPDOCK_DIAGNOSTIC_EGRESS_ROOT;
  assert(
    (explicitRun || startupSelfCheck) &&
      temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
      path.basename(temporary).startsWith("diagnostic-egress-after-rules-"),
    "ISOLATION_REQUIRED",
  );
  if (!forcedApi6) {
    app.setPath("userData", path.join(temporary, "userData"));
    app.setPath("sessionData", path.join(temporary, "sessionData"));
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-background-networking");
    app.commandLine.appendSwitch("disable-component-update");
  }
  app.on("window-all-closed", () => {});
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  if (!forcedApi6) production.configureChromiumTransport(app);
  if (startupSelfCheck) {
    assert(forcedStartup?.selfCheck && !forcedStartup.failure, "LOCAL_PRE_READY_CHECK_FAILED");
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    fs.writeFileSync(
      path.join(temporary, "startup-check.json"),
      JSON.stringify({
        mappedBeforeReady: forcedStartup.mappedBeforeReady,
        readyReached: app.isReady(),
        exactMap:
          app.commandLine.getSwitchValue("host-resolver-rules") === "MAP api6.ipify.org [2001:db8::2]",
        publicRequestsIssued: 0,
        factoryCalls: 0,
        controllerRequests: 0,
      }),
    );
    app.exit(0);
    return;
  }
  const result = {
    kind: "diagnostic-egress-after-approved-rules",
    selectedProviders: providers.map((entry) => entry.provider),
    expectedInboundType,
    executedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      transport: production.readChromiumTransportState(app),
    },
    isolation: {
      accounts: false,
      bootstrap: false,
      temporaryProfile: true,
      normalDns: !forcedApi6,
      resolverProfile: forcedApi6 ? "isolated-forced-api6-current-aaaa-v1" : "normal",
      geoNormalDns: true,
      mappedBeforeReady: forcedApi6 ? forcedStartup?.mappedBeforeReady === true : null,
      fetchOrSlotsPatched: false,
      productionDeadlineMs: 12000,
      deadlineExtended: false,
      configurationChanged: false,
      controllerDeletes: 0,
      netLogStages: ["echo"],
      rawIpPersisted: false,
    },
    counts: {
      factoryCalls: 0,
      echoHeaderSends: 0,
      geoHeaderSends: 0,
      captures: 0,
      tcpReads: 0,
      controllerReads: 0,
      connectionsReads: 0,
      dnsReads: 0,
      osReads: 0,
      routeReads: 0,
      anonymousSessions: 0,
      unexpectedRequests: 0,
    },
    providers: [],
    controller: [],
    forcedPreflight: forcedApi6 ? forcedPreflightFacts : null,
    qualificationGranted: false,
    permitIssued: false,
    limits: [
      "Reported address family is not socket family.",
      "No incoming match is not native-route proof.",
      "Exact own incoming does not independently establish kernel physical socket or mainland path applicability.",
      "ASN is auxiliary; country is the factory's matching-IP geography result.",
      ...(forcedApi6
        ? [
            "Forced AAAA is a separate experimental resolver profile, never normal Chromium DNS equivalence.",
            "Source-constrained Find-NetRoute is an OS observation of the exact owned socket, not a routing mutation or permit.",
          ]
        : []),
    ],
  };
  const checkpoint = (phase) => {
    result.phase = phase;
    result.checkpointAtMono = performance.now();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
  };
  lastResort = (error) => {
    result.failure = safeError(error);
    try {
      checkpoint("top-level-failure");
    } catch {
      /* Parent records the missing checkpoint. */
    }
  };
  const abort = new AbortController(),
    work = new Set(),
    captures = [],
    routeReaders = [];
  const privateSessions = new Set();
  let quietRevoked = false,
    collecting = false,
    active = null,
    probe;
  const track = (promise) => {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => work.delete(promise),
    );
    return promise;
  };
  const quiet = () =>
    !quietRevoked &&
    !abort.signal.aborted &&
    BrowserWindow.getAllWindows().length === 0 &&
    webContents.getAllWebContents().length === 0 &&
    path.resolve(app.getPath("userData")) === path.resolve(temporary, "userData");
  const guard = (signal) => assert(quiet() && !signal?.aborted, "EXPERIMENT_CANCELLED");
  const revoke = () => {
    quietRevoked = true;
    abort.abort();
  };
  app.on("browser-window-created", revoke);
  app.on("web-contents-created", revoke);
  const timer = setTimeout(() => {
    result.failure = "EXPERIMENT_TIMEOUT";
    revoke();
    checkpoint("deadline");
  }, 55_000);
  checkpoint("startup");
  try {
    await app.whenReady();
    assert(
      process.platform === "win32" && process.versions.electron === "43.3.0",
      "RUNTIME_NOT_LOCKED_TARGET",
    );
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    assert(quiet(), "QUIET_WINDOW_UNAVAILABLE");
    if (forcedApi6) {
      Object.assign(result.counts, {
        controllerReads: forcedPreflightFacts.controllerReads,
        connectionsReads: forcedPreflightFacts.connectionsReads,
        dnsReads: forcedPreflightFacts.dnsReads,
        osReads: forcedPreflightFacts.osReads,
      });
      assert(
        !forcedStartup?.failure && forcedStartup?.mappedBeforeReady,
        forcedStartup?.failure ?? "FORCED_STARTUP_UNAVAILABLE",
      );
      result.forcedInput = {
        profileId: "isolated-forced-api6-current-aaaa-v1",
        addressHash: ipHash(forcedStartup.address),
        addressFamily: "ipv6",
        expiresAtMono: forcedStartup.expiresAtMono,
        mappedAtMono: forcedStartup.mappedAtMono,
        originalResponseStartedAtMono: forcedStartup.dns.startedAtMono,
        originalResponseCompletedAtMono: forcedStartup.dns.completedAtMono,
      };
    }
    app.on("session-created", (created) => {
      if (!collecting || created.storagePath !== null || privateSessions.size >= providers.length) {
        revoke();
        return;
      }
      privateSessions.add(created);
      result.counts.anonymousSessions++;
      created.webRequest.onErrorOccurred((details) => {
        if (!active) return;
        active.row.networkErrors ??= [];
        active.row.networkErrors.push({
          stage: active.stage,
          atMono: performance.now(),
          error: /^net::ERR_[A-Z_]+$/.test(details.error) ? details.error : "NETWORK_ERROR_UNPROJECTED",
        });
        checkpoint("request-network-error");
      });
      // Observe a hook unused by the factory. This never replaces its request/header guard.
      created.webRequest.onSendHeaders((details) => {
        let allowed = false;
        try {
          const url = new URL(details.url);
          const stage = active?.stage;
          allowed =
            quiet() &&
            active &&
            details.method === "GET" &&
            !url.search &&
            !url.username &&
            !url.password &&
            !Object.keys(details.requestHeaders).some((key) => /cookie|authorization/i.test(key)) &&
            ((stage === "echo" && details.url === `https://${active.row.host}/`) ||
              (stage === "geo" &&
                url.protocol === "https:" &&
                url.hostname === "ipwho.is" &&
                !url.port &&
                canonical(decodeURIComponent(url.pathname.slice(1))) !== null));
          if (allowed) {
            const key = stage === "echo" ? "echoHeaderSends" : "geoHeaderSends";
            active.row[key]++;
            result.counts[key]++;
            allowed = active.row[key] === 1 && result.counts[key] <= providers.length;
          }
        } catch {
          allowed = false;
        }
        if (!allowed) {
          result.counts.unexpectedRequests++;
          revoke();
        }
        checkpoint(allowed ? "anonymous-headers-sent" : "unexpected-request");
      });
    });
    const reader = forcedApi6
      ? forcedStartup.reader
      : new production.ClashReader({ controllerUrl, getSecret: () => null });
    let fingerprint = null;
    const readController = async (phase, retained = null) => {
      guard();
      if (!retained) result.counts.controllerReads++;
      const value = retained ?? (await track(reader.read()));
      guard();
      const decisions = providers.map(({ host }) => ({
        host,
        ...production.evaluateRules(value.mode, value.rules, {
          host,
          port: 443,
          network: "tcp",
          destination: { stage: "unknown" },
        }),
      }));
      result.controller.push({
        phase,
        startedAtMono: value.startedAtMono,
        completedAtMono: value.completedAtMono,
        mode: value.mode,
        tun: value.tun,
        kernelVersion: value.version,
        fingerprint: value.fingerprint,
        ruleCount: value.rules.length,
        rulesDigest: sha(JSON.stringify(value.rules)),
        decisions,
        directPolicy: value.directPolicy && {
          kind: value.directPolicy.kind,
          dialer: value.directPolicy.dialer,
          ipVersion: value.directPolicy.ipVersion,
          policyFingerprint: value.directPolicy.policyFingerprint,
        },
      });
      checkpoint("controller-read");
      assert(
        value.mode === "rule" &&
          value.tun === true &&
          value.directPolicy?.kind === "direct" &&
          decisions.every((decision) => decision.route === "direct"),
        "DIAGNOSTIC_ROUTES_NOT_DIRECT",
      );
      assert(fingerprint === null || fingerprint === value.fingerprint, "CONTROLLER_CHANGED");
      fingerprint = value.fingerprint;
      return value;
    };
    const readConnections = async (host) => {
      result.counts.connectionsReads++;
      return await track(reader.readConnections([host]));
    };
    await readController("preflight", forcedApi6 ? forcedStartup.controller : null);
    probe = new production.AnonymousEgressProbe(); // Preserve actual default 12s deadline and finite pool.
    for (const { provider, host } of providers) {
      if (!forcedApi6) await readController(`before-${provider}`);
      guard();
      const row = {
        provider,
        host,
        echoHeaderSends: 0,
        geoHeaderSends: 0,
        observer: [],
        echoSocket: null,
        incoming: null,
        factoryResult: null,
      };
      result.providers.push(row);
      const baseline = forcedApi6 ? forcedStartup.connections : await readConnections(host);
      guard();
      let capture = null,
        socket = null;
      const hooks = {
        beforeSend: async (context) => {
          guard(context.signal);
          assert(
            context.source === provider &&
              context.origin.port === 443 &&
              context.origin.host === (context.stage === "echo" ? host : "ipwho.is"),
            "OBSERVER_CONTEXT_MISMATCH",
          );
          active = { row, stage: context.stage };
          row.observer.push({
            stage: context.stage,
            boundary: "beforeSend",
            atMono: performance.now(),
            factoryId: context.factoryId,
            transportContextId: context.transportContextId,
          });
          if (context.stage === "echo") {
            if (forcedApi6) {
              row.forcedDnsValidAtBeforeSend = performance.now() < forcedStartup.expiresAtMono;
              assert(row.forcedDnsValidAtBeforeSend, "CURRENT_AAAA_EXPIRED");
            }
            capture = new production.AnonymousNetLogCapture({ isQuiescent: quiet, temporaryRoot: temporary });
            captures.push(capture);
            result.counts.captures++;
            await capture.start(context.trace.netLog, context.signal);
            guard(context.signal);
            if (forcedApi6) {
              row.forcedDnsValidAfterCaptureStart = performance.now() < forcedStartup.expiresAtMono;
              assert(row.forcedDnsValidAfterCaptureStart, "CURRENT_AAAA_EXPIRED");
            }
          }
          checkpoint("before-send");
        },
        headers: async (context, timing) => {
          guard(context.signal);
          row.observer.push({ stage: context.stage, boundary: "headers", ...timing });
          if (context.stage !== "echo") {
            checkpoint("geo-headers");
            return;
          }
          if (forcedApi6) {
            row.forcedDnsWindow = {
              sentAtMono: timing.sentAtMono,
              headersAtMono: timing.headersAtMono,
              expiresAtMono: forcedStartup.expiresAtMono,
              valid:
                timing.sentAtMono >= forcedStartup.dns.completedAtMono &&
                timing.headersAtMono < forcedStartup.expiresAtMono,
            };
            assert(row.forcedDnsWindow.valid, "CURRENT_AAAA_EXPIRED");
          }
          // Raw NetLog is deleted before finish returns. Its original URL and clock are unchanged.
          const log = await capture.finish(context.signal);
          guard(context.signal);
          const parsed = production.parseDiagnosticEchoSocket(log, { host, port: 443 });
          row.parser = parsed.available
            ? {
                available: true,
                evidenceId: parsed.observation.evidenceId,
                rootId: parsed.observation.rootId,
                socketSourceId: parsed.observation.socketSourceId,
                relatedSourceIds: parsed.observation.relatedSourceIds,
              }
            : parsed;
          checkpoint("echo-socket-parsed");
          if (!parsed.available) return;
          socket = parsed.observation.tuple;
          row.echoSocket = {
            ...projectTuple(socket),
            basis: "exact-factory-request-netlog-tcp-graph",
            windowsOwned: false,
            factoryId: context.factoryId,
            transportContextId: context.transportContextId,
          };
          const pids = app
            .getAppMetrics()
            .filter((entry) => entry.serviceName === "network.mojom.NetworkService")
            .map((entry) => entry.pid);
          if (!pids.length || pids.length > 31 || new Set(pids).size !== pids.length) {
            row.incoming = { matched: false, reason: "NETWORK_SERVICE_SCOPE_UNAVAILABLE" };
            return;
          }
          const tcpReader = new production.WindowsTcpSocketReader({
            ownerPids: pids,
            remotes: [{ address: socket.remoteAddress, port: socket.remotePort }],
          });
          result.counts.tcpReads++;
          const [tcp, connections] = await Promise.all([track(tcpReader.read()), readConnections(host)]);
          guard(context.signal);
          const rows = tcp.available
            ? tcp.sockets.filter((entry) => entry.state === "Established" && exactTuple(entry, socket))
            : [];
          const owner =
            rows.length === 1 && tcp.available
              ? tcp.owners.find((entry) => entry.pid === rows[0].ownerPid)
              : null;
          row.windows = {
            available: tcp.available,
            exactTupleMatches: rows.length,
            startedAtMono: tcp.startedAtMono,
            completedAtMono: tcp.completedAtMono,
            owner: owner && { ...owner },
            sourceIdentityMatchesElectron:
              owner?.executablePathIdentity === production.executablePathIdentity(process.execPath),
          };
          row.incomingContextComparison = contextComparison(
            socket,
            timing,
            baseline,
            connections,
            host,
            owner,
          );
          if (!owner || row.windows.sourceIdentityMatchesElectron !== true) {
            row.incoming = { matched: false, reason: "EXACT_APP_SOCKET_OWNER_UNAVAILABLE" };
            checkpoint("socket-owner-unavailable");
            return;
          }
          row.echoSocket.windowsOwned = true;
          if (forcedApi6) {
            row.echoSocket.matchesSelectedAaaa = canonical(socket.remoteAddress) === forcedStartup.address;
            row.physicalRoute = { available: false, reason: "FORCED_IPV6_SOCKET_NOT_OBSERVED" };
            if (
              family(socket.sourceAddress) === "ipv6" &&
              family(socket.remoteAddress) === "ipv6" &&
              row.echoSocket.matchesSelectedAaaa
            ) {
              const routeReader = new production.WindowsRouteSelectionReader({
                addresses: [socket.remoteAddress],
                localAddress: socket.sourceAddress,
              });
              routeReaders.push(routeReader);
              result.counts.routeReads++;
              const route = await track(routeReader.read(context.signal));
              await track(routeReader.whenIdle());
              guard(context.signal);
              const selection = route.available && route.selections.length === 1 ? route.selections[0] : null;
              const matched =
                !!selection &&
                route.basis === "windows-source-route-query" &&
                canonical(route.localAddress) === canonical(socket.sourceAddress) &&
                canonical(selection.targetAddress) === canonical(socket.remoteAddress) &&
                canonical(selection.sourceAddress) === canonical(socket.sourceAddress);
              const physical =
                matched &&
                selection.hardwareInterface &&
                selection.adapterUp &&
                selection.interfaceConnection === "Connected" &&
                selection.sourceState === "Preferred" &&
                !selection.skipAsSource &&
                selection.routeState === "Alive";
              row.physicalRoute = {
                available: !!physical,
                reason: physical ? null : route.available ? "PHYSICAL_SOURCE_ROUTE_UNVERIFIED" : route.reason,
                basis: route.available ? route.basis : null,
                exactSourceAndDestination: matched,
                startedAtMono: route.startedAtMono,
                completedAtMono: route.completedAtMono,
                scopeHash: route.available ? route.scopeHash : null,
                selectionHash: route.available ? route.selectionHash : null,
                selection: selection && {
                  addressFamily: selection.addressFamily,
                  sourceAddressHash: ipHash(selection.sourceAddress),
                  targetAddressHash: ipHash(selection.targetAddress),
                  interfaceIndex: selection.interfaceIndex,
                  interfaceIdentity: selection.interfaceIdentity,
                  hardwareInterface: selection.hardwareInterface,
                  adapterUp: selection.adapterUp,
                  interfaceConnection: selection.interfaceConnection,
                  sourceState: selection.sourceState,
                  skipAsSource: selection.skipAsSource,
                  routeState: selection.routeState,
                  routeMetric: selection.routeMetric,
                  interfaceMetric: selection.interfaceMetric,
                  destinationPrefixHash: sha(selection.destinationPrefix),
                  nextHopHash: ipHash(selection.nextHop),
                },
              };
              checkpoint("source-conditioned-physical-route");
            }
            // Old helper's optional-kernel-process boundary is unrelated to an independently owned
            // native socket. Retain actual incoming context facts without treating absence as native.
            row.incoming = { matched: false, reason: "NOT_ASSERTED_FOR_FORCED_PHYSICAL_OBSERVATION" };
            return;
          }
          const correlation = production.correlateProbeConnection(
            {
              contextId: context.transportContextId,
              target: { protocol: "https:", host, port: 443, addressFamily: family(socket.remoteAddress) },
              sourceAddress: socket.sourceAddress,
              sourcePort: socket.sourcePort,
              processIdentity: owner.executablePathIdentity,
              inboundType: expectedInboundType,
              network: "tcp",
              startedAtWallMs: timing.sentAtWall,
              completedAtWallMs: timing.headersAtWall,
              startedAtMono: timing.sentAtMono,
              completedAtMono: timing.headersAtMono,
            },
            baseline,
            connections,
            performance.now(),
            15_000,
          );
          row.incoming = correlation.matched
            ? {
                matched: true,
                connectionIdHash: sha(correlation.connectionId),
                route: "direct",
                observedAtMono: correlation.observedAtMono,
                destinationIpHash: ipHash(correlation.destinationIp),
                remoteDestinationIpHash: ipHash(correlation.remoteDestinationIp),
                remoteDestinationAddressFamily: family(correlation.remoteDestinationIp),
              }
            : correlation;
          checkpoint("echo-route-correlated");
        },
        cleanup: async (context) => {
          if (context.stage === "echo" && capture) {
            await capture.dispose();
            await capture.whenIdle();
          }
          row.observer.push({ stage: context.stage, boundary: "cleanup", atMono: performance.now() });
          active = null;
          checkpoint("stage-cleaned");
        },
      };
      collecting = true;
      result.counts.factoryCalls++;
      checkpoint("factory-start");
      const sample = await probe.probe(provider, abort.signal, hooks);
      await probe.whenIdle();
      collecting = false;
      active = null;
      if (sample.available) {
        const value = sample.observation;
        row.factoryResult = {
          available: true,
          source: value.source,
          factoryId: value.factoryId,
          reportedAddressHash: ipHash(value.ip),
          reportedAddressFamily: value.reportedAddressFamily,
          countryCode: value.countryCode,
          asn: value.asn,
          transportContextId: value.transportContextId,
          startedAtMono: value.startedAtMono,
          observedAtMono: value.observedAtMono,
          completedAtMono: value.completedAtMono,
          reportedAddressEqualsAppSource: socket
            ? canonical(value.ip) === canonical(socket.sourceAddress)
            : null,
          echo: value.echo,
          geo: value.geo,
        };
      } else row.factoryResult = sample;
      // Retain partial facts, but only label the combined echo observation available when the
      // original-deadline factory result, exact Windows owner and own DIRECT incoming all agree.
      // This still says nothing about the kernel's independent physical socket or account policy.
      row.echoRouteObservation = forcedApi6
        ? sample.available &&
          row.echoSocket?.windowsOwned &&
          row.physicalRoute?.available &&
          row.forcedDnsWindow?.valid
          ? { available: true, basis: "forced-aaaa-owned-ipv6-socket-with-source-conditioned-hardware-route" }
          : { available: false, reason: "INCOMPLETE_FORCED_IPV6_PHYSICAL_OBSERVATION" }
        : sample.available && row.echoSocket?.windowsOwned === true && row.incoming?.matched === true
          ? { available: true, basis: "anonymous-echo-with-exact-app-socket-and-direct-incoming" }
          : { available: false, reason: "INCOMPLETE_OR_UNAVAILABLE_ECHO_ROUTE_OBSERVATION" };
      checkpoint("factory-completed");
      await readController(`after-${provider}`);
      if (forcedApi6) {
        result.counts.osReads++;
        const after = await track(forcedStartup.networkReader.readObservation());
        result.osPostflight = after;
        result.osIdentityStable = after.available && after.hash === forcedStartup.network.hash;
        assert(result.osIdentityStable, "OS_CONFIGURATION_CHANGED_OR_UNAVAILABLE");
      }
      assert(row.echoHeaderSends <= 1 && row.geoHeaderSends <= 1, "PUBLIC_REQUEST_BUDGET_EXCEEDED");
    }
    assert(
      result.counts.factoryCalls === providers.length && result.counts.unexpectedRequests === 0,
      "FINAL_REQUEST_SCOPE_INVALID",
    );
  } catch (error) {
    result.failure = safeError(error);
    checkpoint("failed");
  } finally {
    clearTimeout(timer);
    abort.abort();
    collecting = false;
    const drain = await bounded(
      Promise.allSettled([
        probe?.dispose(),
        probe?.whenIdle(),
        ...captures.map((capture) => capture.dispose()),
        ...captures.map((capture) => capture.whenIdle()),
        ...routeReaders.map((reader) => {
          reader.dispose();
          return reader.whenIdle();
        }),
        ...work,
      ]),
      8000,
    ).catch(() => null);
    result.cleanup = {
      drained: !!drain && drain.every((item) => item.status === "fulfilled"),
      remainingReadWork: work.size,
      captureCount: captures.length,
      windows: BrowserWindow.getAllWindows().length,
      webContents: webContents.getAllWebContents().length,
    };
    checkpoint("finished");
    app.exit(result.failure || !result.cleanup.drained ? 1 : 0);
  }
}
