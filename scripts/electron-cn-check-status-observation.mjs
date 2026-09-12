/** Current-behaviour observation, not flow approval. Only synthetic accounts and loopback TLS. */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const name = "network-cn-check-status-observation";
const scenarios = ["no-content", "html-challenge", "forbidden"];
const platforms = [
  { id: "douyin", host: "creator.douyin.com", path: "/web/api/media/user/info/", method: "GET", cookies: ["sessionid"], body: { status_code: 0, user: {} } },
  { id: "baijiahao", host: "baijiahao.baidu.com", path: "/builder/app/appinfo", method: "GET", cookies: ["BDUSS"], body: { errno: 0, data: {} } },
  { id: "weixin_channels", host: "channels.weixin.qq.com", path: "/cgi-bin/mmfinderassistant-bin/auth/auth_data", method: "POST", cookies: ["sessionid", "wxuin"], body: { errCode: 0, data: {} } },
];
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, code) => { if (!condition) throw Error(code); };
async function bounded(work, code, ms = 6000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild");
  const parentDirectory = path.join(root, "docs/.compare");
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "cn-status-observation-"));
  const sourceHashes = {};
  const stable = () => Object.entries(sourceHashes).every(([file, value]) => sha(fs.readFileSync(path.join(root, file))) === value);
  try {
    await build({ stdin: { contents: [
      "export {createStore} from './src/main/db/index.ts';",
      "export {AccountService} from './src/main/services/account-service.ts';",
      "export {NetworkRuntime} from './src/main/network/runtime.ts';",
      "export {EgressGate} from './src/main/network/egress-gate.ts';",
      "export {configureAccountSession} from './src/main/browser/account-session.ts';",
      "export {installBusinessNetwork} from './src/main/network/business-access.ts';",
      "export {installSessionNetworkPolicy} from './src/main/network/session-observer.ts';",
      "export {resolveOperationCatalog} from './src/main/network/operation-catalog.ts';",
      "export {getPlatform} from './src/shared/platforms.ts';",
    ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", external: ["electron", "node:*"],
    tsconfig: path.join(root, "tsconfig.electron.json"), outfile: path.join(temporary, "production.mjs"), logLevel: "silent",
    plugins: [{ name: "capture-compiled-source", setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\].*\.tsx?$/ }, (args) => {
        const relative = path.relative(root, args.path).split(path.sep).join("/");
        if (!relative.startsWith("src/")) return;
        const bytes = fs.readFileSync(args.path); sourceHashes[relative] = sha(bytes);
        return { contents: bytes.toString("utf8"), loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
      });
    } }] });
    assert(stable(), "SOURCE_CHANGED_DURING_BUILD");
    if (process.argv.includes("--build-only")) {
      console.log(JSON.stringify({ buildOnly: true, sourceCount: Object.keys(sourceHashes).length, sourcesUnchanged: true, childStarted: false })); return;
    }
    const { spawn, spawnSync } = await import("node:child_process");
    const { default: electron } = await import("electron");
    const candidates = ["openssl"];
    const located = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
    for (const git of (located.stdout ?? "").trim().split(/\r?\n/).filter(Boolean))
      candidates.push(path.join(path.dirname(path.dirname(git)), "usr/bin/openssl.exe"));
    const openssl = candidates.find((value) => spawnSync(value, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0);
    assert(openssl, "OPENSSL_UNAVAILABLE");
    assert(spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(temporary, "key.pem"),
      "-out", path.join(temporary, "cert.pem"), "-days", "1", "-subj", "/CN=creator.douyin.com", "-addext",
      "subjectAltName=" + platforms.map((value) => "DNS:" + value.host).join(",")],
    { windowsHide: true, stdio: "ignore" }).status === 0, "LOCAL_CERTIFICATE_FAILED");
    const environment = { ...process.env, CLIPDOCK_CN_STATUS_OBSERVATION_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const startedAt = new Date().toISOString();
    const worker = spawn(electron, [script], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => worker.kill(), 40000);
    const code = await new Promise((resolve) => { worker.once("exit", (value) => resolve(value ?? 1)); worker.once("error", () => resolve(1)); });
    clearTimeout(timer);
    const local = path.join(temporary, "result.json");
    const result = fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, "utf8")) : { executedAt: startedAt, failure: "CHILD_RESULT_UNAVAILABLE", observations: [] };
    result.sourceHashes = sourceHashes; result.sourcesUnchanged = stable(); result.scriptHash = sha(fs.readFileSync(script));
    result.childExitCode = code;
    const target = path.join(root, "docs", name + ".results.json");
    if (fs.existsSync(target)) fs.copyFileSync(target, target.replace(/\.results\.json$/, ".history-" + Date.now() + ".results.json"));
    fs.writeFileSync(target, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ observationOnly: true, runtime: result.runtime, isolationChecks: result.checks,
      receiver: result.receiver, counts: result.counts, unexpectedAuthenticationCases: result.unexpectedAuthenticationCases,
      observations: result.observations, failure: result.failure ?? null, sourcesUnchanged: result.sourcesUnchanged }, null, 2));
    // A completed observation can exit 0 while recording failed authentication expectations.
    process.exitCode = code || (result.sourcesUnchanged ? 0 : 1);
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : "CN_STATUS_OBSERVATION_FAILED"); process.exitCode = 1;
  } finally {
    const resolved = path.resolve(temporary);
    assert(path.dirname(resolved) === path.resolve(parentDirectory) && path.basename(resolved).startsWith("cn-status-observation-"), "UNSAFE_TEMPORARY_PATH");
    await delay(350);
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Never reused. */ }
  }
}

async function child() {
  const { app, net, session } = await import("electron");
  const temporary = process.env.CLIPDOCK_CN_STATUS_OBSERVATION_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
    path.basename(temporary).startsWith("cn-status-observation-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("host-resolver-rules", [...platforms.map((value) => "MAP " + value.host + " 127.0.0.1"), "MAP * ~NOTFOUND"].join(", "));
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("disable-quic"); app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  const result = { observationOnly: true, executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged },
    isolation: { temporaryUserData: true, realAccountOpened: false, loopbackTlsOnly: true, syntheticCookiesOnly: true,
      perSessionCertificatePin: true, globalCertificateBypass: false, controllerRead: false, userConfigurationChanged: false,
      testOnlyReviewAndEvidence: true, productionReviewChanged: false, productionModeChanged: false, noViewOrPlatformScripts: true },
    checks: [], receiver: { requests: 0, unexpectedRequests: 0, syntheticCookieRequests: 0, authorizationRequests: 0, onlyLoopback: true },
    counts: { sessionFetchCalls: 0, netRequestCalls: 0, unexpectedNetRequestTargets: 0, unexpectedFetchTargets: 0, nodeNetworkAttempts: 0, defaultSessionRequests: 0, viewActions: 0, onlineEvents: 0 },
    observations: [], responseFacts: [], requestFacts: [], unexpectedAuthenticationCases: 0 };
  let server, store, runtime, service, uninstallBusiness, uninstallPolicy;
  const sockets = new Set(), configured = [], restorers = [];
  let branch = "valid-fixture", active = null, sample = 0;
  const synthetic = crypto.randomUUID().replaceAll("-", "");
  const checkpoint = (stage) => { result.stage = stage; fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); };
  const check = (label, condition) => { result.checks.push({ name: label, passed: Boolean(condition) }); assert(condition, label); };
  try {
    checkpoint("child-initialized");
    // No production code runs before these Node outbound guards. Chromium uses the exact mapped hosts below.
    const deny = () => { result.counts.nodeNetworkAttempts++; throw Error("NODE_NETWORK_FORBIDDEN"); };
    for (const module of [await import("node:http"), await import("node:https")]) {
      for (const key of ["request", "get"]) { const raw = module.default[key]; module.default[key] = deny; restorers.push(() => { module.default[key] = raw; }); }
    }
    const rawFetch = globalThis.fetch; globalThis.fetch = deny; restorers.push(() => { globalThis.fetch = rawFetch; });
    const rawRequest = net.request;
    net.request = (options) => {
      const url = options?.url instanceof URL ? options.url.href : options?.url;
      if (!active || !configured.some((value) => value.session === options?.session) ||
        url !== "https://" + active.host + active.path || options?.method !== active.method || options?.credentials !== "include") {
        result.counts.unexpectedNetRequestTargets++; checkpoint("unexpected-electron-request"); throw Error("EXACT_ELECTRON_REQUEST_REQUIRED");
      }
      result.counts.netRequestCalls++;
      return rawRequest.call(net, options);
    };
    restorers.push(() => { net.request = rawRequest; });
    checkpoint("awaiting-app-ready");
    await bounded(app.whenReady(), "APP_READY_TIMEOUT");
    checkpoint("app-ready");
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => { result.counts.defaultSessionRequests++; callback({ cancel: true }); });
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    checkpoint("production-imported");
    const cert = fs.readFileSync(path.join(temporary, "cert.pem")), key = fs.readFileSync(path.join(temporary, "key.pem"));
    const certHash = new crypto.X509Certificate(cert).fingerprint256;
    server = https.createServer({ cert, key }, (request, response) => {
      result.receiver.onlyLoopback &&= ["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
      const expected = platforms.find((value) => value.host === request.headers.host);
      if (!expected || expected !== active || request.url !== expected.path || request.method !== expected.method) {
        result.receiver.unexpectedRequests++; response.writeHead(404); response.end(); return;
      }
      result.receiver.requests++;
      const cookies = String(request.headers.cookie ?? "").split(/;\s*/).filter(Boolean);
      if (cookies.length === expected.cookies.length && expected.cookies.every((value) => cookies.includes(value + "=" + synthetic))) result.receiver.syntheticCookieRequests++;
      if (request.headers.authorization || request.headers["proxy-authorization"]) result.receiver.authorizationRequests++;
      let body = "";
      request.on("data", (chunk) => { body += chunk.toString("utf8"); if (body.length > 100) request.destroy(); });
      request.on("end", () => {
        result.requestFacts.push({ platform: expected.id, scenario: branch, method: request.method,
          contentType: request.headers["content-type"] ?? null, bodyBytes: Buffer.byteLength(body), bodyIsEmptyObject: body === "{}" });
        checkpoint(expected.id + "-" + branch + "-receiver-observed");
        const headers = { "cache-control": "no-store", "content-type": branch === "html-challenge" ? "text/html" : "application/json" };
        if (branch === "no-content") { response.writeHead(204, headers); response.end(); }
        else if (branch === "forbidden") { response.writeHead(403, headers); response.end(); }
        else { response.writeHead(200, headers); response.end(branch === "html-challenge" ? "<!doctype html><html><p>Complete verification</p></html>" :
          JSON.stringify(branch === "unknown-json" ? { syntheticUnknownChallenge: true } : expected.body)); }
      });
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once("error", () => reject(Error("LOOPBACK_443_UNAVAILABLE"))); server.listen(443, "127.0.0.1", resolve); });
    checkpoint("receiver-ready");
    store = production.createStore(":memory:");
    const gate = new production.EgressGate({ enforcement: "strict", timing: { warmupGapMs: 50, proofTtlMs: 30000, controllerTtlMs: 60000 } });
    runtime = new production.NetworkRuntime({ enforcement: "strict", gate, networkReadiness: () => true, resolveCatalog: (selection) => {
      const source = production.resolveOperationCatalog(selection);
      if (!platforms.some((value) => value.id === selection.platformId) || selection.operation !== "check-status" || selection.activePageOrigin !== null) return source;
      return production.resolveOperationCatalog({ ...selection, review: { source: "main-process-flow-review", platformId: source.platformId,
        operation: source.operation, sourceVersion: source.sourceVersion, selectionKey: source.selectionKey,
        reviewId: "synthetic-observation-only", evidenceRefs: ["not-production-review"], flowReviewed: true,
        additionalRequiredOrigins: [], reviewedRequestRange: source.requiredOrigins } });
    } });
    uninstallBusiness = production.installBusinessNetwork(runtime); uninstallPolicy = production.installSessionNetworkPolicy(runtime);
    const failView = () => { result.counts.viewActions++; throw Error("UNEXPECTED_VIEW_ACTION"); };
    service = new production.AccountService({ store, notify: () => undefined,
      viewPool: { getState: () => null, getSession: () => null, getWebContents: () => null, ensure: failView, navigate: failView, show: failView, remove: () => undefined } });
    runtime.setSuspendHandler((accountId) => service.suspendNetworkAccount(accountId));
    // Observe emitted authentication transitions; do not start another operation or hide their origin.
    service.on("account-online", () => result.counts.onlineEvents++);
    gate.setNetworkState({ controllerReadable: true, mode: "rule", tun: true, rulesVersion: "synthetic-local-rules" });
    const evidence = (scope) => {
      const at = performance.now(), id = ++sample;
      return { sampleId: "synthetic-round-" + id, generation: gate.generation, rulesVersion: "synthetic-local-rules", contextId: scope.contextId,
        catalogVersion: scope.catalogVersion, observedAtMono: at, targets: scope.targets.map((target) => ({ target,
          route: { source: "correlated-connection", contextId: scope.contextId, rulesVersion: "synthetic-local-rules", ruleDecision: "direct", connectionId: `fixture-${id}-${target.addressFamily}`, correlationVerified: true, chains: ["DIRECT"], observedAtMono: at },
          egress: { target, contextId: scope.contextId, ip: target.addressFamily === "ipv4" ? "192.0.2.1" : "2001:db8::1", countryCode: "CN", asn: 64512, source: "controlled-loopback-fixture", applicabilityVerified: true, observedAtMono: at },
          tls: { verified: true, observedAtMono: at }, dns: { status: "resolved", addressFamily: target.addressFamily, observedAtMono: at } })) };
    };
    for (const platform of platforms) {
      active = platform;
      checkpoint(platform.id + "-initializing");
      assert(production.getPlatform(platform.id).login.probe.url === "https://" + platform.host + platform.path &&
        production.getPlatform(platform.id).login.probeFromMain, "SOURCE_PROBE_CHANGED");
      const account = store.accounts.create({ platformId: platform.id });
      const value = production.configureAccountSession(account.id, platform.id); configured.push(value);
      const ses = value.session;
      ses.setCertificateVerifyProc((request, callback) => {
        let trusted = false; try { trusted = request.hostname === platform.host && new crypto.X509Certificate(request.certificate.data).fingerprint256 === certHash; } catch {}
        callback(trusted ? 0 : -2);
      });
      const fetch = ses.fetch.bind(ses);
      ses.fetch = (url, init) => {
        if (url !== "https://" + platform.host + platform.path || init?.method !== platform.method || init?.credentials !== "include") {
          result.counts.unexpectedFetchTargets++; return Promise.reject(Error("EXACT_SYNTHETIC_TARGET_REQUIRED"));
        }
        result.counts.sessionFetchCalls++;
        return fetch(url, init).then((response) => {
          result.responseFacts.push({ platform: platform.id, scenario: branch, status: response.status, finalUrlPresent: Boolean(response.url) });
          return response;
        });
      };
      await bounded(value.ready, "SESSION_READY_TIMEOUT");
      checkpoint(platform.id + "-session-ready");
      for (const cookie of platform.cookies) await ses.cookies.set({ url: "https://" + platform.host + "/", name: cookie, value: synthetic, secure: true, httpOnly: true, path: "/" });
      const closedBefore = store.accounts.get(account.id), requestsBefore = result.receiver.requests, fetchBefore = result.counts.sessionFetchCalls;
      const closed = await bounded(service.checkStatus(account.id, { skipProbe: false, silent: true }), "CLOSED_CHECK_TIMEOUT");
      check(platform.id + "_closed_preserves_all_fields_and_sends_nothing", JSON.stringify(closed) === JSON.stringify(closedBefore) &&
        result.receiver.requests === requestsBefore && result.counts.sessionFetchCalls === fetchBefore);
      await bounded(runtime.prepareOperation(account.id, { operation: "check-status", activePageOrigin: null }).ready, "OPERATION_READY_TIMEOUT");
      const scope = runtime.listProofScopes().find((item) => item.accountId === account.id);
      assert(scope && scope.catalogReviewed && scope.targets.length === 2 && scope.targets.every((target) => target.host === platform.host), "EXACT_TEST_SCOPE_REQUIRED");
      assert(!gate.acceptEvidence(account.id, evidence(scope)).allowed, "ONE_ROUND_MUST_STAY_CLOSED");
      await delay(65); assert(gate.acceptEvidence(account.id, evidence(scope)).allowed, "TWO_TEST_ROUNDS_REQUIRED");
      for (const scenario of scenarios) {
        branch = scenario;
        for (const priorStatus of ["offline", "online"]) {
          checkpoint(platform.id + "-" + scenario + "-" + priorStatus);
          store.accounts.updateStatus(account.id, "online", "synthetic prior verification");
          const before = store.accounts.updateStatus(account.id, priorStatus, "synthetic prior state");
          await delay(12);
          const onlineBefore = result.counts.onlineEvents, countBefore = result.receiver.requests;
          const after = await bounded(service.checkStatus(account.id, { skipProbe: false, silent: true }), "STATUS_CHECK_TIMEOUT");
          check(platform.id + "_" + scenario + "_" + priorStatus + "_one_local_response", result.receiver.requests === countBefore + 1);
          const observation = { platform: platform.id, scenario, before: { status: before.status, lastCheckedAt: before.lastCheckedAt, lastOnlineAt: before.lastOnlineAt },
            after: { status: after.status, lastCheckedAt: after.lastCheckedAt, lastOnlineAt: after.lastOnlineAt },
            statusChanged: before.status !== after.status, lastCheckedAtChanged: before.lastCheckedAt !== after.lastCheckedAt,
            lastOnlineAtChanged: before.lastOnlineAt !== after.lastOnlineAt, onlineEventEmitted: result.counts.onlineEvents > onlineBefore,
            unconfirmedShouldPreserve: scenario !== "valid-fixture" };
          if (observation.unconfirmedShouldPreserve) {
            observation.preservationExpectationPassed = JSON.stringify(observation.before) === JSON.stringify(observation.after);
            if (!observation.preservationExpectationPassed) result.unexpectedAuthenticationCases++;
          }
          result.observations.push(observation);
          checkpoint(platform.id + "-" + scenario + "-" + priorStatus + "-observed");
        }
      }
    }
    const plannedRequests = platforms.length * scenarios.length * 2;
    check("all_requests_exact_loopback_with_only_synthetic_cookies", result.receiver.requests === plannedRequests && result.receiver.syntheticCookieRequests === plannedRequests &&
      result.receiver.onlyLoopback && result.receiver.unexpectedRequests === 0 && result.receiver.authorizationRequests === 0);
    check("no_view_default_session_or_node_outbound_path", result.counts.viewActions === 0 && result.counts.defaultSessionRequests === 0 && result.counts.nodeNetworkAttempts === 0 && result.counts.unexpectedFetchTargets === 0 && result.counts.unexpectedNetRequestTargets === 0);
  } catch (error) { result.failure = /^[A-Z_]+$/.test(String(error?.message)) ? error.message : "CONTROLLED_OBSERVATION_FAILED"; }
  finally {
    checkpoint("cleanup");
    service?.dispose();
    await bounded(Promise.resolve(runtime?.dispose()), "RUNTIME_CLEANUP_TIMEOUT").catch(() => { result.failure ??= "RUNTIME_CLEANUP_TIMEOUT"; });
    uninstallPolicy?.(); uninstallBusiness?.();
    const sessionsClosed = await Promise.allSettled(configured.map((value) => {
      value.dispose(); return bounded(value.session.closeAllConnections(), "SESSION_CLEANUP_TIMEOUT", 2500);
    }));
    result.sessionCleanupCompleted = sessionsClosed.every((value) => value.status === "fulfilled");
    if (!result.sessionCleanupCompleted) result.failure ??= "SESSION_CLEANUP_TIMEOUT";
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await bounded(new Promise((resolve) => server.close(resolve)), "RECEIVER_CLEANUP_TIMEOUT", 2500).catch(() => { result.failure ??= "RECEIVER_CLEANUP_TIMEOUT"; });
    store?.close(); for (const restore of restorers.reverse()) restore();
    result.completedAt = new Date().toISOString();
    result.stage = "completed";
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); app.exit(result.failure ? 1 : 0);
  }
}
