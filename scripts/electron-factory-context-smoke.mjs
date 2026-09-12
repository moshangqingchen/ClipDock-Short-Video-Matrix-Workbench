/** Three actual production entrances, isolated loopback TLS only; no path qualification is produced. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const stem = "network-factory-context-smoke";
const hosts = ["api.bilibili.com", "myip.ipip.net", "ipwho.is"];
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value, message) {
  if (!value) throw new Error(message);
}
function safeError(error) {
  return /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "LOCAL_FACTORY_CONTEXT_FAILED";
}
async function bounded(work, ms, message) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (process.versions.electron) void child().catch(() => process.exit(1));
else await parent();

async function parent() {
  const { build } = await import("esbuild");
  const { spawn, spawnSync } = await import("node:child_process");
  const electron = require("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-factory-context-"));
  const stamp = new Date().toISOString().replaceAll(/[^0-9TZ]/g, "");
  let report = { executedAt: new Date().toISOString(), checks: [], failure: null };
  let childCode = 1;
  try {
    const contents = [
      "export {createStore} from './src/main/db/index.ts';",
      "export {AccountService} from './src/main/services/account-service.ts';",
      "export {NetworkRuntime} from './src/main/network/runtime.ts';",
      "export {EgressGate} from './src/main/network/egress-gate.ts';",
      "export {configureAccountSession} from './src/main/browser/account-session.ts';",
      "export {installBusinessNetwork} from './src/main/network/business-access.ts';",
      "export {installSessionNetworkPolicy} from './src/main/network/session-observer.ts';",
      "export {resolveOperationCatalog} from './src/main/network/operation-catalog.ts';",
      "export {AnonymousProofProbe,ANONYMOUS_TLS_FACTORY_ID} from './src/main/network/anonymous-proof-probe.ts';",
      "export {AnonymousEgressProbe,ANONYMOUS_EGRESS_FACTORY_ID} from './src/main/network/anonymous-egress-probe.ts';",
      "export {WindowsTcpSocketReader} from './src/main/network/windows-tcp-sockets.ts';",
      "export {configureChromiumTransport,readChromiumTransportState} from './src/main/network/chromium-transport.ts';",
    ].join("\n");
    const built = await build({
      stdin: { contents, resolveDir: repository, loader: "ts" },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      tsconfig: path.join(repository, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.cjs"),
      metafile: true,
      logLevel: "silent",
    });
    const sources = Object.fromEntries(
      Object.keys(built.metafile.inputs)
        .filter((file) => file.startsWith("src/"))
        .map((file) => [file, hash(fs.readFileSync(path.join(repository, file)))]),
    );
    if (process.argv.includes("--build-only")) {
      console.log(
        JSON.stringify({ buildOnly: true, publicRequests: 0, sourceCount: Object.keys(sources).length }),
      );
      childCode = 0;
      return;
    }
    const candidates = ["openssl"];
    const located = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
    for (const git of (located.stdout ?? "").trim().split(/\r?\n/).filter(Boolean))
      candidates.push(path.join(path.dirname(path.dirname(git)), "usr/bin/openssl.exe"));
    const openssl = candidates.find(
      (name) => spawnSync(name, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0,
    );
    assert(openssl, "OPENSSL_UNAVAILABLE");
    assert(
      spawnSync(
        openssl,
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          path.join(temporary, "key.pem"),
          "-out",
          path.join(temporary, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=api.bilibili.com",
          "-addext",
          "subjectAltName=" + hosts.map((host) => "DNS:" + host).join(","),
        ],
        { windowsHide: true, stdio: "ignore" },
      ).status === 0,
      "LOCAL_CERTIFICATE_FAILED",
    );
    const environment = { ...process.env, CLIPDOCK_FACTORY_CONTEXT_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], {
      cwd: repository,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let watchdogTerminated = false;
    const timer = setTimeout(() => {
      watchdogTerminated = true;
      worker.kill();
    }, 45_000);
    childCode = await new Promise((resolve) => {
      worker.once("exit", (code) => resolve(code ?? 1));
      worker.once("error", () => resolve(1));
    });
    clearTimeout(timer);
    const resultFile = path.join(temporary, "result.json");
    assert(fs.existsSync(resultFile), "ISOLATED_CHILD_NO_RESULT");
    report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    report.watchdogTerminated = watchdogTerminated;
    report.sourceHashes = sources;
    report.scriptSha256 = hash(fs.readFileSync(script));
    report.productionBundleSha256 = hash(fs.readFileSync(path.join(temporary, "production.cjs")));
    report.sourcesUnchanged = Object.entries(sources).every(
      ([file, digest]) => hash(fs.readFileSync(path.join(repository, file))) === digest,
    );
    if (!report.sourcesUnchanged) childCode = 1;
  } catch (error) {
    report.failure = safeError(error);
    childCode = 1;
  } finally {
    if (!process.argv.includes("--build-only")) {
      const output = path.join(repository, "docs", stem + "." + stamp + ".results.json");
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
      console.log(
        JSON.stringify(
          {
            report: path.basename(output),
            checks: report.checks,
            failure: report.failure,
            sourcesUnchanged: report.sourcesUnchanged,
            childCode,
          },
          null,
          2,
        ),
      );
    }
    const resolved = path.resolve(temporary);
    assert(
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
        path.basename(resolved).startsWith("sv-factory-context-"),
      "UNSAFE_TEMPORARY_PATH",
    );
    await delay(200);
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch {
      console.log(JSON.stringify({ temporaryRemoved: false, isolatedSyntheticDataOnly: true }));
    }
    process.exitCode = childCode;
  }
}

async function child() {
  const { app, session, net, webContents } = require("electron");
  const temporary = process.env.CLIPDOCK_FACTORY_CONTEXT_ROOT;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("sv-factory-context-"),
    "ISOLATION_REQUIRED",
  );
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    hosts.map((host) => `MAP ${host} 127.0.0.1`).join(", ") + ", MAP * ~NOTFOUND",
  );
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const production = require(path.join(temporary, "production.cjs"));
  production.configureChromiumTransport(app);
  const syntheticIp = "203.0.113.7",
    syntheticCookie = crypto.randomUUID().replaceAll("-", "");
  const result = {
    executedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      packaged: app.isPackaged,
      mainPid: process.pid,
      executableSha256: hash(fs.readFileSync(process.execPath)),
    },
    isolation: {
      localTlsOnly: true,
      controllerRead: false,
      publicRequests: 0,
      realAccounts: false,
      realCookies: false,
      temporaryUserData: true,
      systemTrustModified: false,
      hostResolverOverride: "exact-host-to-loopback-others-fail",
      trustOverride: "fixture-only-exact-host-generated-certificate-pin",
      responseTimingShim: "receiver-holds-before-headers-during-one-bounded-TCP-read",
      syntheticGateEvidence: true,
      productionEnforcementChanged: false,
    },
    sessions: [],
    calls: [],
    requests: [],
    checks: [],
    failure: null,
    qualification: {
      transportScopeObservationOnly: true,
      direct: false,
      resolverEquivalent: false,
      actualPublicAddressFamily: false,
      physicalRoute: false,
      flowReviewed: false,
      retainedQualificationProduced: false,
    },
  };
  const checkpoint = () =>
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result, null, 2));
  const stage = (name) => {
    result.stage = name;
    checkpoint();
  };
  const check = (name, value) => {
    result.checks.push({ name, passed: !!value });
    checkpoint();
    assert(value, name);
  };
  const socketSet = new Set(),
    handlers = new Set(),
    restores = [],
    sessions = new Map();
  let phase = "startup",
    server,
    store,
    runtime,
    service,
    tls,
    egress,
    uninstallBusiness,
    uninstallPolicy;
  let accountSession = null,
    originalRequest,
    sample = 0;
  const cert = fs.readFileSync(path.join(temporary, "cert.pem")),
    key = fs.readFileSync(path.join(temporary, "key.pem"));
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  const pin = (ses) => {
    const original = sessions.get(ses).rawCertificate;
    original((request, callback) => {
      let trusted = false;
      try {
        trusted =
          hosts.includes(request.hostname) &&
          new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      } catch {}
      callback(trusted ? 0 : -2);
    });
  };
  const observeSession = (ses) => {
    stage("session-created:" + phase);
    const facts = {
      id: result.sessions.length + 1,
      creationPhase: phase,
      persistent: ses.isPersistent(),
      storagePresent: ses.storagePath !== null,
      setup: [],
      credentialConfiguration: [],
      productionCertificateModes: [],
      requestCount: 0,
    };
    const entry = { facts, rawCertificate: ses.setCertificateVerifyProc.bind(ses) };
    sessions.set(ses, entry);
    result.sessions.push(facts);
    for (const name of ["setProxy", "closeAllConnections", "clearHostResolverCache", "clearAuthCache"]) {
      const original = ses[name].bind(ses);
      ses[name] = async (...args) => {
        const row = {
          name,
          phase,
          startedAtMono: performance.now(),
          completedAtMono: null,
          ...(name === "setProxy"
            ? { mode: args[0]?.mode ?? null, onlyModeField: Object.keys(args[0] ?? {}).length === 1 }
            : {}),
        };
        facts.setup.push(row);
        const value = await original(...args);
        row.completedAtMono = performance.now();
        return value;
      };
      restores.push(() => {
        ses[name] = original;
      });
    }
    const ntlm = ses.allowNTLMCredentialsForDomains.bind(ses);
    ses.allowNTLMCredentialsForDomains = (domains) => {
      facts.credentialConfiguration.push({ method: "allowNTLMCredentialsForDomains", empty: domains === "" });
      return ntlm(domains);
    };
    restores.push(() => {
      ses.allowNTLMCredentialsForDomains = ntlm;
    });
    ses.setCertificateVerifyProc = (handler) => {
      facts.productionCertificateModes.push(handler === null ? "default" : "custom");
      return entry.rawCertificate(handler);
    };
    restores.push(() => {
      ses.setCertificateVerifyProc = entry.rawCertificate;
    });
    const original = ses.fetch.bind(ses);
    ses.fetch = (url, options) => {
      const parsed = new URL(typeof url === "string" ? url : url.url);
      assert(
        hosts.includes(parsed.hostname) && parsed.protocol === "https:" && parsed.port === "",
        "FIXED_LOOPBACK_FETCH_REQUIRED",
      );
      facts.requestCount++;
      result.calls.push({
        sessionId: facts.id,
        phase,
        api: "session.fetch",
        host: parsed.hostname,
        path: parsed.pathname === "/" + syntheticIp ? "/<synthetic-ip>" : parsed.pathname,
        method: options?.method,
        credentials: options?.credentials,
        redirect: options?.redirect,
        cache: options?.cache,
        referrerPolicy: options?.referrerPolicy ?? null,
        calledAtMono: performance.now(),
        fixturePinApplied: true,
      });
      // The factory restores normal trust on creation. Pin only immediately before this local request.
      pin(ses);
      return original(url, options);
    };
    restores.push(() => {
      ses.fetch = original;
    });
    stage("session-instrumented:" + phase);
  };
  app.on("session-created", observeSession);
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    check("NO_WEB_CONTENTS_CREATED", webContents.getAllWebContents().length === 0);
    result.chromiumTransport = production.readChromiumTransportState(app);
    check(
      "REAL_STARTUP_TCP_CONSTRAINT_ACTIVE",
      result.chromiumTransport.configuredBeforeReady && result.chromiumTransport.disableQuicSwitchPresent,
    );
    const handle = async (request, response) => {
      const host = request.headers.host,
        expected =
          (phase === "bilibili-check-status" &&
            host === "api.bilibili.com" &&
            request.url === "/x/web-interface/nav") ||
          (phase === "anonymous-tls" && host === "api.bilibili.com" && request.url === "/robots.txt") ||
          (phase === "anonymous-egress" &&
            ((host === "myip.ipip.net" && request.url === "/") ||
              (host === "ipwho.is" && request.url === "/" + syntheticIp)));
      const row = {
        phase,
        host,
        path: host === "ipwho.is" ? "/<synthetic-ip>" : request.url,
        method: request.method,
        expected: !!expected,
        receivedAtMono: performance.now(),
        cookiePresent: !!request.headers.cookie,
        authorizationPresent: !!request.headers.authorization,
        proxyAuthorizationPresent: !!request.headers["proxy-authorization"],
        syntheticCookieMatches:
          phase === "bilibili-check-status" &&
          ["SESSDATA", "bili_jct"].every((name) =>
            String(request.headers.cookie ?? "").includes(name + "=" + syntheticCookie),
          ),
        userAgent: request.headers["user-agent"] ?? null,
        tls: {
          version: request.socket.getProtocol(),
          alpn: request.socket.alpnProtocol || null,
          servername: request.socket.servername,
        },
        tuple: {
          sourceAddress: request.socket.remoteAddress,
          sourcePort: request.socket.remotePort,
          remoteAddress: request.socket.localAddress,
          remotePort: request.socket.localPort,
        },
        attribution: { available: false },
      };
      result.requests.push(row);
      checkpoint();
      assert(
        expected &&
          request.method === "GET" &&
          row.tuple.sourceAddress === "127.0.0.1" &&
          row.tuple.remoteAddress === "127.0.0.1" &&
          row.tuple.remotePort === 443,
        "UNEXPECTED_LOCAL_REQUEST",
      );
      const metrics = app
        .getAppMetrics()
        .filter((value) => value.serviceName === "network.mojom.NetworkService");
      assert(metrics.length > 0 && metrics.length <= 32, "NETWORK_SERVICE_METRICS_UNAVAILABLE");
      const reader = new production.WindowsTcpSocketReader({
        ownerPids: metrics.map((value) => value.pid),
        remotes: [{ address: row.tuple.remoteAddress, port: row.tuple.remotePort }],
      });
      const snapshot = await reader.read();
      const afterMetrics = app
        .getAppMetrics()
        .filter((value) => value.serviceName === "network.mojom.NetworkService");
      if (snapshot.available) {
        const matches = snapshot.sockets.filter(
          (socket) =>
            socket.sourceAddress === row.tuple.sourceAddress &&
            socket.sourcePort === row.tuple.sourcePort &&
            socket.remoteAddress === row.tuple.remoteAddress &&
            socket.remotePort === row.tuple.remotePort &&
            socket.state === "Established",
        );
        if (matches.length === 1) {
          const socket = matches[0],
            owner = snapshot.owners.find((value) => value.pid === socket.ownerPid);
          if (
            owner &&
            metrics.some((value) => value.pid === owner.pid) &&
            afterMetrics.some((value) => value.pid === owner.pid)
          )
            row.attribution = {
              available: true,
              source: "exact-receiver-tuple-to-windows-socket-to-app-metrics",
              owner,
              metricType: metrics.find((value) => value.pid === owner.pid).type,
              serviceName: "network.mojom.NetworkService",
              startedAtMono: snapshot.startedAtMono,
              completedAtMono: snapshot.completedAtMono,
              candidates: matches.length,
            };
        }
      }
      row.readFinishedAtMono = performance.now();
      checkpoint();
      assert(row.attribution.available, "EXACT_TCP_OWNER_UNAVAILABLE");
      response.writeHead(200, {
        "content-type": host === "myip.ipip.net" ? "text/plain; charset=utf-8" : "application/json",
        "cache-control": "no-store",
        "set-cookie": "fixture_response_only=1; Secure; HttpOnly",
      });
      row.headersReleasedAtMono = performance.now();
      if (host === "myip.ipip.net") response.end("当前 IP：" + syntheticIp + " 来自于：受控测试");
      else if (host === "ipwho.is")
        response.end(
          JSON.stringify({ success: true, ip: syntheticIp, country_code: "CN", connection: { asn: 64512 } }),
        );
      else if (request.url === "/robots.txt") response.end("User-agent: *\nDisallow:\n");
      else response.end(JSON.stringify({ code: 0, data: { isLogin: true } }));
    };
    server = https.createServer({ cert, key }, (request, response) => {
      const work = handle(request, response).catch((error) => {
        result.failure ??= safeError(error);
        response.destroy();
        checkpoint();
      });
      handlers.add(work);
      void work.then(() => handlers.delete(work));
    });
    server.on("connection", (socket) => {
      socketSet.add(socket);
      socket.once("close", () => socketSet.delete(socket));
    });
    server.on("tlsClientError", () => {});
    await new Promise((resolve, reject) => {
      server.once("error", () => reject(new Error("LOOPBACK_443_UNAVAILABLE")));
      server.listen(443, "127.0.0.1", resolve);
    });
    store = production.createStore(":memory:");
    const gate = new production.EgressGate({
      enforcement: "strict",
      timing: { warmupGapMs: 50, proofTtlMs: 30_000, controllerTtlMs: 60_000 },
    });
    runtime = new production.NetworkRuntime({
      enforcement: "strict",
      gate,
      networkReadiness: () => true,
      resolveCatalog: (selection) => {
        const source = production.resolveOperationCatalog(selection);
        if (
          selection.platformId !== "bilibili" ||
          selection.operation !== "check-status" ||
          selection.activePageOrigin !== null
        )
          return source;
        return production.resolveOperationCatalog({
          ...selection,
          review: {
            source: "main-process-flow-review",
            platformId: source.platformId,
            operation: source.operation,
            sourceVersion: source.sourceVersion,
            selectionKey: source.selectionKey,
            reviewId: "controlled-factory-context-only",
            evidenceRefs: ["local-synthetic-test-only"],
            flowReviewed: true,
            additionalRequiredOrigins: [],
            reviewedRequestRange: source.requiredOrigins,
          },
        });
      },
    });
    uninstallBusiness = production.installBusinessNetwork(runtime);
    uninstallPolicy = production.installSessionNetworkPolicy(runtime);
    const failView = () => {
      throw new Error("UNEXPECTED_VIEW_ACTION");
    };
    const pool = {
      getState: () => null,
      getSession: () => null,
      getWebContents: () => null,
      ensure: failView,
      navigate: failView,
      show: failView,
      remove: () => undefined,
    };
    service = new production.AccountService({ store, viewPool: pool, notify: () => undefined });
    runtime.setSuspendHandler((id) => service.suspendNetworkAccount(id));
    gate.setNetworkState({
      controllerReadable: true,
      mode: "rule",
      tun: true,
      rulesVersion: "controlled-local-rules",
    });
    phase = "account-initialization";
    const account = store.accounts.create({ platformId: "bilibili" });
    const configured = production.configureAccountSession(account.id, "bilibili");
    accountSession = configured.session;
    await configured.ready;
    for (const name of ["SESSDATA", "bili_jct"])
      await accountSession.cookies.set({
        url: "https://api.bilibili.com/",
        name,
        value: syntheticCookie,
        secure: true,
        httpOnly: true,
        path: "/",
      });
    await runtime.prepareOperation(account.id, { operation: "check-status", activePageOrigin: null }).ready;
    const scope = runtime.listProofScopes().find((value) => value.accountId === account.id);
    assert(scope && scope.catalogReviewed, "CONTROLLED_SCOPE_UNAVAILABLE");
    const evidence = () => {
      const at = performance.now(),
        id = ++sample;
      return {
        sampleId: "controlled-round-" + id,
        generation: gate.generation,
        rulesVersion: "controlled-local-rules",
        contextId: scope.contextId,
        catalogVersion: scope.catalogVersion,
        observedAtMono: at,
        targets: scope.targets.map((target) => ({
          target,
          route: {
            source: "correlated-connection",
            contextId: scope.contextId,
            rulesVersion: "controlled-local-rules",
            ruleDecision: "direct",
            connectionId: `fixture-${id}-${target.addressFamily}`,
            correlationVerified: true,
            chains: ["DIRECT"],
            observedAtMono: at,
          },
          egress: {
            target,
            contextId: scope.contextId,
            ip: target.addressFamily === "ipv4" ? syntheticIp : "2001:db8::1",
            countryCode: "CN",
            asn: 64512,
            source: "controlled-loopback-fixture",
            applicabilityVerified: true,
            observedAtMono: at,
          },
          tls: { verified: true, observedAtMono: at },
          dns: { status: "resolved", addressFamily: target.addressFamily, observedAtMono: at },
        })),
      };
    };
    assert(!gate.acceptEvidence(account.id, evidence()).allowed, "ONE_TEST_ROUND_MUST_STAY_CLOSED");
    await delay(65);
    assert(gate.acceptEvidence(account.id, evidence()).allowed, "CONTROLLED_GATE_NOT_READY");
    originalRequest = net.request;
    net.request = (options) => {
      assert(
        options?.session === accountSession && options.url === "https://api.bilibili.com/x/web-interface/nav",
        "EXACT_ACCOUNT_SESSION_REQUIRED",
      );
      const facts = sessions.get(accountSession).facts;
      facts.requestCount++;
      result.calls.push({
        sessionId: facts.id,
        phase,
        api: "net.request",
        host: "api.bilibili.com",
        path: "/x/web-interface/nav",
        method: options.method,
        credentials: options.credentials,
        redirect: options.redirect,
        cache: options.cache,
        bypassCustomProtocolHandlers: options.bypassCustomProtocolHandlers,
        calledAtMono: performance.now(),
        fixturePinApplied: true,
      });
      pin(accountSession);
      return originalRequest.call(net, options);
    };
    phase = "bilibili-check-status";
    const status = await bounded(
      service.checkStatus(account.id, { skipProbe: false, silent: true }),
      11_000,
      "CHECK_STATUS_TIMEOUT",
    );
    check(
      "REAL_NO_VIEW_CHECK_STATUS_CONFIRMED_SYNTHETIC_RESPONSE",
      status.status === "online" && webContents.getAllWebContents().length === 0,
    );
    // Session.fetch can internally delegate to net.request; this fixture wrapper describes
    // only the explicit account entrance and must not reject the anonymous implementation.
    net.request = originalRequest;
    phase = "anonymous-tls";
    stage("before-tls-construction");
    tls = new production.AnonymousProofProbe();
    stage("before-tls-call");
    const tlsResult = await tls.probeTls(
      { host: "api.bilibili.com", port: 443 },
      new AbortController().signal,
    );
    check("REAL_TLS_FACTORY_COMPLETED", tlsResult.available);
    result.tlsObservation = {
      factoryId: tlsResult.observation.factoryId,
      transportContextId: tlsResult.observation.transportContextId,
      origin: tlsResult.observation.origin,
      credentials: tlsResult.observation.credentials,
      status: tlsResult.observation.statusCode,
      reportedCertificateLabelOnly: tlsResult.observation.certificateValidation,
      effectiveFixturePin: true,
    };
    phase = "anonymous-egress";
    egress = new production.AnonymousEgressProbe();
    const egressResult = await egress.probe("ipip", new AbortController().signal);
    check("REAL_EGRESS_FACTORY_COMPLETED_SYNTHETIC_ECHO_AND_GEO", egressResult.available);
    result.egressObservation = {
      factoryId: egressResult.observation.factoryId,
      transportContextId: egressResult.observation.transportContextId,
      reportedAddressFamily: egressResult.observation.reportedAddressFamily,
      syntheticResponseMatched: egressResult.observation.ip === syntheticIp,
      countryNotMeasured: true,
      effectiveFixturePin: true,
    };
    check(
      "FOUR_EXACT_LOCAL_REQUESTS_ONLY",
      result.requests.length === 4 && result.requests.every((row) => row.expected),
    );
    check(
      "ALL_REQUESTS_HAVE_EXACT_NETWORK_SERVICE_SOCKET_OWNER",
      result.requests.every((row) => row.attribution.available),
    );
    check(
      "SAME_NETWORK_SERVICE_INSTANCE_FOR_ALL_THREE_ENTRANCES",
      new Set(result.requests.map((row) => JSON.stringify(row.attribution.owner))).size === 1,
    );
    check(
      "NETWORK_SERVICE_IS_DISTINCT_FROM_MAIN_PROCESS",
      result.requests.every((row) => row.attribution.owner.pid !== process.pid),
    );
    check(
      "ONLY_ACCOUNT_REQUEST_CARRIED_SYNTHETIC_COOKIES",
      result.requests.every((row) =>
        row.phase === "bilibili-check-status" ? row.syntheticCookieMatches : !row.cookiePresent,
      ),
    );
    check(
      "NO_AUTHORIZATION_HEADERS_REACHED_RECEIVER",
      result.requests.every((row) => !row.authorizationPresent && !row.proxyAuthorizationPresent),
    );
    const calledSessions = [...sessions].filter(([, value]) => value.facts.requestCount > 0);
    check(
      "THREE_DISTINCT_SESSIONS_USED",
      calledSessions.length === 3 &&
        result.tlsObservation.transportContextId !== result.egressObservation.transportContextId,
    );
    for (const [ses, { facts }] of calledSessions) {
      const call = result.calls.find((row) => row.sessionId === facts.id);
      const setup = facts.setup.filter(
        (row) => row.completedAtMono !== null && row.completedAtMono <= call.calledAtMono,
      );
      const direct = setup.findIndex(
        (row) => row.name === "setProxy" && row.mode === "direct" && row.onlyModeField,
      );
      const close = setup.findIndex((row, index) => index > direct && row.name === "closeAllConnections");
      const dnsClear = setup.findIndex(
        (row, index) => index > close && row.name === "clearHostResolverCache",
      );
      facts.proxyResolution = await ses.resolveProxy("https://" + call.host + "/");
      check(
        "DIRECT_CLOSE_DNS_CLEAR_BEFORE_SESSION_" + facts.id,
        direct >= 0 && close > direct && dnsClear > close && facts.proxyResolution === "DIRECT",
      );
    }
    check(
      "ACCOUNT_PERSISTENT_ANONYMOUS_SESSIONS_MEMORY_ONLY",
      calledSessions.every(
        ([ses, value]) =>
          value.facts.persistent === (ses === accountSession) &&
          value.facts.storagePresent === (ses === accountSession),
      ),
    );
    check(
      "ANONYMOUS_COOKIES_REMAIN_EMPTY",
      (
        await Promise.all(
          calledSessions
            .filter(([ses]) => ses !== accountSession)
            .map(async ([ses]) => (await ses.cookies.get({})).length),
        )
      ).every((count) => count === 0),
    );
    check("NO_BROWSER_VIEW_CREATED_BY_ANY_ENTRANCE", webContents.getAllWebContents().length === 0);
    result.completedAt = new Date().toISOString();
  } catch (error) {
    result.failure ??= safeError(error);
    result.failureType = error?.name ?? null;
    stage("caught-operation-failure");
  } finally {
    phase = "cleanup";
    stage("cleanup-start");
    if (originalRequest) net.request = originalRequest;
    service?.dispose();
    const cleanup = await Promise.allSettled([runtime?.dispose(), tls?.dispose(), egress?.dispose()]);
    stage("cleanup-closed");
    await Promise.allSettled([tls?.whenIdle(), egress?.whenIdle(), ...handlers]);
    stage("cleanup-idle");
    result.cleanupSucceeded = cleanup.every((value) => value.status === "fulfilled");
    uninstallPolicy?.();
    uninstallBusiness?.();
    app.off("session-created", observeSession);
    for (const restore of restores) restore();
    for (const socket of socketSet) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    store?.close();
    checkpoint();
    app.exit(
      result.failure || !result.cleanupSucceeded || result.checks.some((value) => !value.passed) ? 1 : 0,
    );
  }
}
