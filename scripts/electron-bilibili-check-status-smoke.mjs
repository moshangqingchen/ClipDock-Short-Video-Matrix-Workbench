/** Isolated production AccountService + Runtime integration. Only loopback TLS and synthetic accounts. */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const reportName = "network-bilibili-check-status-smoke";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(test, message, timeout = 5000) {
  const start = Date.now(); while (!test()) { if (Date.now() - start >= timeout) throw new Error(message); await delay(10); }
}
async function bounded(work, message, ms = 6000) {
  let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
if (!process.versions.electron) await parent(); else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild");
  const { spawn, spawnSync } = await import("node:child_process");
  const { default: electron } = await import("electron");
  const parentDirectory = path.join(repository, "docs/.compare");
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "bili-check-status-"));
  try {
    const candidates = ["openssl"];
    const located = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
    for (const git of (located.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)) candidates.push(path.join(path.dirname(path.dirname(git)), "usr/bin/openssl.exe"));
    const openssl = candidates.find((name) => spawnSync(name, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0);
    assert(openssl, "OPENSSL_UNAVAILABLE");
    assert(spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(temporary, "key.pem"),
      "-out", path.join(temporary, "cert.pem"), "-days", "1", "-subj", "/CN=api.bilibili.com", "-addext", "subjectAltName=DNS:api.bilibili.com,DNS:passport.bilibili.com"],
      { windowsHide: true, stdio: "ignore" }).status === 0, "LOCAL_CERTIFICATE_FAILED");
    const built = await build({ stdin: { contents: [
      "export {createStore} from './src/main/db/index.ts';",
      "export {AccountService} from './src/main/services/account-service.ts';",
      "export {CollectScheduler} from './src/main/data/scheduler.ts';",
      "export {NetworkRuntime} from './src/main/network/runtime.ts';",
      "export {EgressGate} from './src/main/network/egress-gate.ts';",
      "export {configureAccountSession} from './src/main/browser/account-session.ts';",
      "export {installBusinessNetwork} from './src/main/network/business-access.ts';",
      "export {installSessionNetworkPolicy} from './src/main/network/session-observer.ts';",
      "export {resolveOperationCatalog} from './src/main/network/operation-catalog.ts';",
      "export {getPlatform} from './src/shared/platforms.ts';",
    ].join("\n"), resolveDir: repository, loader: "ts" }, bundle: true, platform: "node", format: "esm", external: ["electron"],
      tsconfig: path.join(repository, "tsconfig.electron.json"), outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const sources = Object.fromEntries(Object.keys(built.metafile.inputs).filter((file) => file.startsWith("src/")).map((file) => [file, hash(fs.readFileSync(path.join(repository, file)))]));
    const environment = { ...process.env, CLIPDOCK_BILI_CHECK_ROOT: temporary }; delete environment.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], { cwd: repository, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => worker.kill(), 35000);
    const code = await new Promise((resolve) => { worker.once("exit", (value) => resolve(value ?? 1)); worker.once("error", () => resolve(1)); });
    clearTimeout(timer);
    const local = path.join(temporary, "result.json");
    assert(fs.existsSync(local), "ISOLATED_CHILD_NO_RESULT");
    const result = JSON.parse(fs.readFileSync(local, "utf8"));
    result.sourceHashes = sources;
    result.sourcesUnchanged = Object.entries(sources).every(([file, expected]) => hash(fs.readFileSync(path.join(repository, file))) === expected);
    fs.writeFileSync(path.join(repository, "docs", reportName + ".results.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ runtime: result.runtime, checks: result.checks, receiver: result.receiver, failure: result.failure ?? null,
      sourcesUnchanged: result.sourcesUnchanged }, null, 2));
    process.exitCode = code || (result.sourcesUnchanged ? 0 : 1);
  } catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : "BILI_CHECK_FIXTURE_FAILED"); process.exitCode = 1; }
  finally {
    const resolved = path.resolve(temporary);
    assert(path.dirname(resolved) === path.resolve(parentDirectory) && path.basename(resolved).startsWith("bili-check-status-"), "UNSAFE_TEMPORARY_PATH");
    await delay(350);
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Isolated data is never reused. */ }
  }
}

async function child() {
  const { app, net } = await import("electron");
  const temporary = process.env.CLIPDOCK_BILI_CHECK_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(repository, "docs/.compare") &&
    path.basename(temporary).startsWith("bili-check-status-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData")); app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("host-resolver-rules", "MAP api.bilibili.com 127.0.0.1, MAP passport.bilibili.com 127.0.0.1, MAP * ~NOTFOUND");
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("disable-quic"); app.disableHardwareAcceleration(); app.on("window-all-closed", () => {});
  const result = { executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged },
    isolation: { temporaryUserData: true, realAccountOpened: false, localTlsOnly: true, syntheticCookieOnly: true,
      sessionCertificatePinOnly: true, globalCertificateBypass: false, controllerRead: false, configurationChanged: false,
      injectedReviewAndEvidenceOnly: true, productionEnforcementChanged: false }, checks: [],
    receiver: { navRequests: 0, unexpectedRequests: 0, syntheticCookieRequests: 0, onlyLoopback: true, streamClosed: 0,
      sameOriginFinalRequests: 0, crossOriginRequests: 0, crossOriginCredentialRequests: 0, redirectResponses: 0 },
    counts: { sessionFetchCalls: 0, netRequestCalls: 0, followedRedirects: 0, profileCalls: 0, collectCalls: 0, viewActions: 0, onlineEvents: 0, followupEvents: 0 },
    responseBranches: [], finalResponseFacts: [], redirectFacts: [] };
  const sockets = new Set(), held = new Set(), configured = [];
  let server, store, runtime, service, scheduler, uninstallBusiness, uninstallPolicy, originalNetRequest;
  let mode = "normal", sample = 0, exerciseFollowups = false;
  const check = (name, value) => { result.checks.push({ name, passed: !!value }); assert(value, name); };
  try {
    await app.whenReady();
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    originalNetRequest = net.request;
    net.request = (options) => {
      assert(typeof options === "object" && configured.some((entry) => entry.session === options.session), "EXACT_CONFIGURED_SESSION_REQUIRED");
      assert(options.method === "GET" && options.credentials === "include" && options.redirect === "manual", "BOUNDED_MAIN_PROBE_REQUIRED");
      result.counts.netRequestCalls++;
      const request = originalNetRequest.call(net, options);
      request.on("redirect", (status, method, location) => {
        let next = null; try { next = new URL(location); } catch {}
        result.redirectFacts.push({ scenario: mode, status, method, expectedOrigin: next?.origin === "https://api.bilibili.com" });
      });
      const rawFollow = request.followRedirect.bind(request);
      request.followRedirect = () => { result.counts.followedRedirects++; return rawFollow(); };
      return request;
    };
    const cert = fs.readFileSync(path.join(temporary, "cert.pem")), key = fs.readFileSync(path.join(temporary, "key.pem"));
    const certHash = new crypto.X509Certificate(cert).fingerprint256;
    const synthetic = crypto.randomUUID().replaceAll("-", "");
    server = https.createServer({ cert, key }, (request, response) => {
      result.receiver.onlyLoopback &&= ["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
      const cookie = String(request.headers.cookie ?? "");
      if (request.headers.host === "passport.bilibili.com") {
        result.receiver.crossOriginRequests++;
        if (cookie || request.headers.authorization) result.receiver.crossOriginCredentialRequests++;
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ code: 0, data: { isLogin: true } })); return;
      }
      if (request.headers.host !== "api.bilibili.com" || request.method !== "GET" || !["/x/web-interface/nav", "/fixture/nav-final"].includes(request.url)) {
        result.receiver.unexpectedRequests++; response.writeHead(404); response.end(); return;
      }
      if (cookie.includes("SESSDATA=" + synthetic) && cookie.includes("bili_jct=" + synthetic)) result.receiver.syntheticCookieRequests++;
      if (request.url === "/fixture/nav-final") {
        result.receiver.sameOriginFinalRequests++;
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ code: 0, data: { isLogin: true } })); return;
      }
      result.receiver.navRequests++;
      if (mode.startsWith("redirect-")) {
        result.receiver.redirectResponses++;
        const cross = mode.includes("cross");
        response.writeHead(mode.endsWith("307") ? 307 : 302, { "cache-control": "no-store",
          location: cross ? "https://passport.bilibili.com/fixture/redirect-target" : "/fixture/nav-final" });
        response.end(); return;
      }
      if (mode === "unauthorized") { response.writeHead(401, { "cache-control": "no-store" }); response.end(); return; }
      if (mode === "no-content") { response.writeHead(204, { "cache-control": "no-store" }); response.end(); return; }
      if (mode === "challenge-html") {
        response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        response.end('<!doctype html><html><p>Complete verification</p><img src="https://passport.bilibili.com/fixture/challenge-image"></html>'); return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (mode === "stream") {
        held.add(response); response.write('{"code":0,"data":');
        response.once("close", () => { result.receiver.streamClosed++; held.delete(response); });
      } else if (mode === "logged-out") response.end(JSON.stringify({ code: -101, data: { isLogin: false } }));
      else if (mode === "challenge-json") response.end(JSON.stringify({ code: -352, message: "synthetic verification required" }));
      else if (mode === "bad-json") response.end("{synthetic-broken-json");
      else response.end(JSON.stringify({ code: 0, data: { isLogin: true } }));
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once("error", () => reject(new Error("LOOPBACK_443_UNAVAILABLE"))); server.listen(443, "127.0.0.1", resolve); });
    store = production.createStore(":memory:");
    const gate = new production.EgressGate({ enforcement: "strict", timing: { warmupGapMs: 50, proofTtlMs: 30000, controllerTtlMs: 60000 } });
    runtime = new production.NetworkRuntime({ enforcement: "strict", gate, networkReadiness: () => true,
      resolveCatalog: (selection) => {
        const source = production.resolveOperationCatalog(selection);
        if (selection.platformId !== "bilibili" || selection.operation !== "check-status" || selection.activePageOrigin !== null) return source;
        return production.resolveOperationCatalog({ ...selection, review: { source: "main-process-flow-review", platformId: source.platformId,
          operation: source.operation, sourceVersion: source.sourceVersion, selectionKey: source.selectionKey,
          reviewId: "controlled-no-page-bili-fixture", evidenceRefs: ["loopback-synthetic-test-only"], flowReviewed: true,
          additionalRequiredOrigins: [], reviewedRequestRange: source.requiredOrigins } });
      } });
    uninstallBusiness = production.installBusinessNetwork(runtime); uninstallPolicy = production.installSessionNetworkPolicy(runtime);
    const failView = () => { result.counts.viewActions++; throw new Error("UNEXPECTED_VIEW_ACTION"); };
    const pool = { getState: () => null, getSession: () => null, getWebContents: () => null, ensure: failView, navigate: failView, show: failView, remove: () => undefined };
    service = new production.AccountService({ store, viewPool: pool, notify: () => undefined,
      fetchProfile: async () => { result.counts.profileCalls++; return { displayName: "fixture-profile-must-not-run" }; } });
    const collectors = new Map([["bilibili", { workingUrl: production.getPlatform("bilibili").routes.home,
      collect: async () => { result.counts.collectCalls++; return { metrics: [], works: [] }; } }]]);
    scheduler = new production.CollectScheduler({ store, pool, collectors, accounts: service, notify: () => undefined });
    runtime.setSuspendHandler((accountId) => { service.suspendNetworkAccount(accountId); scheduler.suspendNetworkAccount(accountId); });
    service.on("account-online", (account) => {
      result.counts.onlineEvents++;
      if (exerciseFollowups) {
        result.counts.followupEvents++;
        scheduler.resumeNetworkAccount(account.id);
        scheduler.enqueue(account.id, "login");
        void service.refreshProfile(account.id).catch(() => undefined);
      }
    });
    gate.setNetworkState({ controllerReadable: true, mode: "rule", tun: true, rulesVersion: "controlled-local-rules" });
    const create = async (status = "unknown", domainCookies = false) => {
      const account = store.accounts.create({ platformId: "bilibili" });
      store.accounts.updateStatus(account.id, status, "synthetic pre-test authentication");
      const configuredSession = production.configureAccountSession(account.id, "bilibili"); configured.push(configuredSession);
      const ses = configuredSession.session;
      ses.setCertificateVerifyProc((request, callback) => {
        let trusted = false;
        try { trusted = ["api.bilibili.com", "passport.bilibili.com"].includes(request.hostname) && new crypto.X509Certificate(request.certificate.data).fingerprint256 === certHash; } catch {}
        callback(trusted ? 0 : -2);
      });
      const rawFetch = ses.fetch.bind(ses);
      ses.fetch = (...args) => { result.counts.sessionFetchCalls++; return rawFetch(...args).then((response) => {
        let parsed = null; try { parsed = new URL(response.url); } catch {}
        result.finalResponseFacts.push({ scenario: mode, status: response.status, urlPresent: Boolean(response.url),
          expectedOrigin: parsed?.origin === "https://api.bilibili.com", https: parsed?.protocol === "https:",
          hasUserInfo: Boolean(parsed?.username || parsed?.password) });
        return response;
      }); };
      await configuredSession.ready;
      for (const name of ["SESSDATA", "bili_jct"]) await ses.cookies.set({ url: "https://api.bilibili.com/", name, value: synthetic, secure: true, httpOnly: true, path: "/",
        ...(domainCookies ? { domain: ".bilibili.com" } : {}) });
      if (domainCookies) {
        const matching = await ses.cookies.get({ url: "https://passport.bilibili.com/" });
        assert(["SESSDATA", "bili_jct"].every((name) => matching.some((cookie) => cookie.name === name && cookie.value === synthetic)), "DOMAIN_COOKIES_MUST_MATCH_CROSS_ORIGIN");
      }
      return store.accounts.get(account.id);
    };
    const evidence = (scope) => {
      const at = performance.now(); const id = ++sample;
      return { sampleId: "controlled-round-" + id, generation: gate.generation, rulesVersion: "controlled-local-rules", contextId: scope.contextId,
        catalogVersion: scope.catalogVersion, observedAtMono: at, targets: scope.targets.map((target) => ({ target,
          route: { source: "correlated-connection", contextId: scope.contextId, rulesVersion: "controlled-local-rules", ruleDecision: "direct", connectionId: `fixture-${id}-${target.addressFamily}`, correlationVerified: true, chains: ["DIRECT"], observedAtMono: at },
          egress: { target, contextId: scope.contextId, ip: target.addressFamily === "ipv4" ? "192.0.2.1" : "2001:db8::1", countryCode: "CN", asn: 64512, source: "controlled-loopback-fixture", applicabilityVerified: true, observedAtMono: at },
          tls: { verified: true, observedAtMono: at }, dns: { status: "resolved", addressFamily: target.addressFamily, observedAtMono: at } })) };
    };
    const activate = async (account, checkFirst = false) => {
      await runtime.prepareOperation(account.id, { operation: "check-status", activePageOrigin: null }).ready;
      const scope = runtime.listProofScopes().find((value) => value.accountId === account.id);
      assert(scope && scope.catalogReviewed && scope.targets.length === 2 && scope.targets.every((target) => target.host === "api.bilibili.com"), "EXACT_TEST_SCOPE_REQUIRED");
      const first = gate.acceptEvidence(account.id, evidence(scope)); assert(!first.allowed, "ONE_ROUND_MUST_STAY_CLOSED");
      if (checkFirst) {
        const count = result.counts.netRequestCalls; await service.checkStatus(account.id, { skipProbe: false, silent: true });
        check("one_round_still_does_not_create_client_request", result.counts.netRequestCalls === count && result.receiver.navRequests === 0);
      }
      await delay(65);
      const second = gate.acceptEvidence(account.id, evidence(scope));
      assert(second.allowed && runtime.check(account.id).allowed, "TWO_TEST_ROUNDS_REQUIRED");
    };
    const happy = await create();
    const unchanged = await service.checkStatus(happy.id, { skipProbe: false, silent: true });
    check("closed_check_preserves_auth_and_never_calls_fetch_or_receiver", unchanged.status === happy.status &&
      unchanged.lastCheckedAt === happy.lastCheckedAt && result.counts.netRequestCalls === 0 && result.receiver.navRequests === 0);
    await activate(happy, true);
    const online = await bounded(service.checkStatus(happy.id, { skipProbe: false, silent: true }), "HAPPY_PROBE_TIMEOUT");
    check("real_account_service_reads_synthetic_login_response_after_two_rounds", online.status === "online" && result.counts.netRequestCalls === 1 && result.receiver.navRequests === 1);
    check("real_partition_fetch_sent_only_synthetic_session_cookies_to_loopback", result.receiver.syntheticCookieRequests === 1 && result.receiver.onlyLoopback);
    check("no_view_was_created_for_status_check", result.counts.viewActions === 0);
    const revoked = await create("offline"); await activate(revoked);
    mode = "stream";
    const pending = service.checkStatus(revoked.id, { skipProbe: false, silent: true });
    await until(() => held.size === 1, "STREAM_NOT_REACHED");
    gate.revoke(revoked.id, "NETWORK_CHANGED");
    const old = await bounded(pending, "REVOKED_PROBE_DID_NOT_SETTLE");
    await until(() => result.receiver.streamClosed === 1, "STREAM_NOT_CLOSED");
    check("revocation_aborts_real_fetch_and_prevents_late_online_commit", old.status === "offline" && store.accounts.get(revoked.id).status === "offline" &&
      store.accounts.get(revoked.id).lastCheckedAt === revoked.lastCheckedAt && result.counts.onlineEvents === 1);
    const beforeClosed = result.counts.netRequestCalls;
    await service.checkStatus(revoked.id, { skipProbe: false, silent: true });
    check("revoked_followup_check_cannot_send_again", result.counts.netRequestCalls === beforeClosed && result.receiver.navRequests === 2);
    mode = "normal";
    const profile = await create("online"); await activate(profile);
    await service.refreshProfile(profile.id);
    check("profile_cannot_borrow_check_status_scope", result.counts.profileCalls === 0 && !runtime.check(profile.id).allowed && result.receiver.navRequests === 2);
    const collect = await create("online"); await activate(collect);
    scheduler.start();
    // This is the exact main-process allowed-state callback, including the empty queue case.
    scheduler.resumeNetworkAccount(collect.id);
    check("idle_scheduler_preserves_an_unrelated_check_status_permit", runtime.check(collect.id).allowed);
    const job = scheduler.enqueue(collect.id, "manual"); await delay(25);
    check("collect_waits_for_its_own_scope_without_view_or_collector_execution", job.state === "waiting-network" &&
      store.collectJobs.get(job.id).state === "waiting-network" && result.counts.collectCalls === 0 && result.counts.viewActions === 0 && result.receiver.navRequests === 2);
    check("all_receiver_requests_are_exact_local_nav_and_no_public_route_is_used", result.receiver.unexpectedRequests === 0 && result.receiver.onlyLoopback && result.receiver.syntheticCookieRequests === 2);

    exerciseFollowups = true;
    {
      mode = "normal";
      const account = await create("online", true); await activate(account);
      const confirmed = await bounded(service.checkStatus(account.id, { skipProbe: false, silent: true }), "THROTTLE_BASELINE_TIMEOUT");
      const afterConfirmedFetches = result.counts.netRequestCalls;
      const beforeOnline = result.counts.onlineEvents;
      await delay(25);
      const skipped = await bounded(service.checkStatus(account.id), "DEFAULT_SKIPPED_PROBE_TIMEOUT");
      check("successful_probe_then_default_check_preserves_every_field_without_fetch", JSON.stringify(skipped) === JSON.stringify(confirmed) &&
        result.counts.netRequestCalls === afterConfirmedFetches);
      mode = "challenge-json";
      const challenged = await bounded(service.checkStatus(account.id, { skipProbe: false, silent: true }), "THROTTLED_CHALLENGE_TIMEOUT");
      check("forced_challenge_after_success_preserves_true_verification_times", JSON.stringify(challenged) === JSON.stringify(confirmed) &&
        result.counts.netRequestCalls === afterConfirmedFetches + 1);
      await delay(25);
      const afterChallenge = await bounded(service.checkStatus(account.id), "POST_CHALLENGE_DEFAULT_TIMEOUT");
      check("default_check_after_challenge_stays_throttled_without_refreshing_true_times", JSON.stringify(afterChallenge) === JSON.stringify(confirmed) &&
        JSON.stringify(store.accounts.get(account.id)) === JSON.stringify(confirmed) && result.counts.netRequestCalls === afterConfirmedFetches + 1);
      check("throttled_unconfirmed_checks_do_not_emit_online_or_enqueue_followups", result.counts.onlineEvents === beforeOnline &&
        store.collectJobs.list(account.id).length === 0 && result.counts.profileCalls === 0 && result.counts.collectCalls === 0);
      result.responseBranches.push({ scenario: "success-default-challenge-default", before: account.status, after: afterChallenge.status,
        originalFieldsPreserved: true, defaultProbeFetches: 0, createdJobs: 0 });
    }
    for (const statusCode of [302, 307]) {
      mode = `redirect-same-${statusCode}`;
      const account = await create("offline", true); await activate(account);
      const beforeFinal = result.receiver.sameOriginFinalRequests;
      const response = await bounded(service.checkStatus(account.id, { skipProbe: false, silent: true }), "SAME_ORIGIN_REDIRECT_TIMEOUT");
      await delay(25);
      check(`same_origin_${statusCode}_uses_its_existing_origin`, response.status === "online" && result.receiver.sameOriginFinalRequests === beforeFinal + 1);
      check(`same_origin_${statusCode}_followups_require_independent_scope`, result.counts.profileCalls === 0 && result.counts.collectCalls === 0 && result.counts.viewActions === 0 &&
        store.collectJobs.list(account.id, true).length === 1 && store.collectJobs.list(account.id, true)[0].state === "waiting-network");
      result.responseBranches.push({ scenario: mode, before: account.status, after: response.status, followupsWaiting: true });
    }
    for (const statusCode of [302, 307]) {
      mode = `redirect-cross-${statusCode}`;
      const account = await create("offline", true); await activate(account);
      const beforeOnline = result.counts.onlineEvents, beforeFetch = result.counts.netRequestCalls;
      const response = await bounded(service.checkStatus(account.id, { skipProbe: false, silent: true }), "CROSS_ORIGIN_REDIRECT_TIMEOUT");
      await delay(25);
      check(`cross_origin_${statusCode}_second_hop_cannot_send_domain_cookies`, result.receiver.crossOriginRequests === 0 && result.receiver.crossOriginCredentialRequests === 0 && result.counts.netRequestCalls === beforeFetch + 1);
      check(`cross_origin_${statusCode}_rejection_preserves_auth_without_followups`, JSON.stringify(response) === JSON.stringify(account) &&
        JSON.stringify(store.accounts.get(account.id)) === JSON.stringify(account) && result.counts.onlineEvents === beforeOnline && store.collectJobs.list(account.id).length === 0);
      result.responseBranches.push({ scenario: mode, before: account.status, after: response.status, secondHopReached: false, followupsWaiting: false });
    }
    for (const branch of ["unauthorized", "logged-out", "challenge-html", "challenge-json", "no-content", "bad-json"]) {
      mode = branch;
      const unconfirmed = !["unauthorized", "logged-out"].includes(branch);
      for (const previousStatus of unconfirmed ? ["offline", "online"] : ["online"]) {
      const account = await create(previousStatus, true); await activate(account);
      const beforeOnline = result.counts.onlineEvents;
      const response = await bounded(service.checkStatus(account.id, { skipProbe: false, silent: true }), "RESPONSE_BRANCH_TIMEOUT");
      await delay(25);
      const safeVerdict = (unconfirmed ? JSON.stringify(response) === JSON.stringify(account) && JSON.stringify(store.accounts.get(account.id)) === JSON.stringify(account) : response.status === "offline") &&
        result.counts.onlineEvents === beforeOnline && store.collectJobs.list(account.id).length === 0;
      const name = `${branch.replaceAll("-", "_")}_${previousStatus}_${unconfirmed ? "preserves_auth_and_all_verification_times" : "confirms_logged_out"}`;
      result.checks.push({ name, passed: safeVerdict });
      if (!safeVerdict) result.failure ??= name;
      check(`${branch.replaceAll("-", "_")}_${previousStatus}_cannot_start_profile_collect_or_html_resources`, result.counts.profileCalls === 0 && result.counts.collectCalls === 0 && result.counts.viewActions === 0 && result.receiver.crossOriginRequests === 0);
      result.responseBranches.push({ scenario: mode, before: account.status, after: response.status,
        emittedOnline: result.counts.onlineEvents !== beforeOnline, createdJobs: store.collectJobs.list(account.id).length });
      }
    }
    check("all_extended_requests_remain_on_controlled_loopback", result.receiver.onlyLoopback && result.receiver.unexpectedRequests === 0 && result.receiver.crossOriginCredentialRequests === 0);
    check("bilibili_main_uses_original_session_with_tracked_redirects_and_no_fetch_fallback", result.counts.sessionFetchCalls === 0 &&
      result.counts.netRequestCalls === result.receiver.navRequests && result.counts.followedRedirects === 2 && result.redirectFacts.length === 4);
  } catch (error) { result.failure = /^[A-Za-z0-9_]+$/.test(String(error?.message)) ? error.message : "CONTROLLED_SERVICE_FIXTURE_FAILED"; }
  finally {
    scheduler?.stop(); service?.dispose(); await runtime?.dispose(); uninstallPolicy?.(); uninstallBusiness?.();
    if (originalNetRequest) net.request = originalNetRequest;
    for (const value of configured) { value.dispose(); await value.session.closeAllConnections().catch(() => undefined); }
    for (const response of held) response.destroy(); for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    store?.close(); result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); app.exit(result.failure ? 1 : 0);
  }
}
