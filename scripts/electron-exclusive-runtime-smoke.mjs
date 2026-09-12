/** Default: build/local checks only. --run-once: isolated Electron + loopback TLS, synthetic policy inputs. */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url),
  root = path.resolve(path.dirname(script), "..");
const run = process.argv.includes("--run-once"),
  host = "clipdock-exclusive.test";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, code) => {
  if (!condition) throw Error(code);
};
const safeError = (error) =>
  /^[A-Z_]{1,100}$/.test(error?.message ?? "") ? error.message : "CONTROLLED_OPERATION_FAILED";
async function bounded(promise, name, ms = 7000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(name)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(test, name) {
  const end = performance.now() + 6000;
  while (!test()) {
    assert(performance.now() < end, name);
    await delay(15);
  }
}
if (!process.versions.electron) await parent();
else {
  const startup = await prepareChild();
  void child(startup).catch(() => process.exit(1));
}

async function parent() {
  assert(
    process.argv.slice(2).every((arg) => ["--run-once", "--build-only"].includes(arg)) &&
      !(run && process.argv.includes("--build-only")),
    "INVALID_ARGUMENTS",
  );
  const { build } = await import("esbuild"),
    { default: electron } = await import("electron");
  const base = path.resolve(root, "docs/.compare");
  fs.mkdirSync(base, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(base, "exclusive-runtime-"));
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const destination = path.join(root, `docs/network-exclusive-runtime-smoke.${stamp}.results.json`);
  let report;
  try {
    const built = await build({
      stdin: {
        contents: [
          "export {ExclusiveNetworkSwitch} from './src/main/network/exclusive-switch.ts';",
          "export {NetworkRuntime} from './src/main/network/runtime.ts';",
          "export {installBusinessNetwork,bindAccountWebContents,beginBusinessOperation} from './src/main/network/business-access.ts';",
          "export {ensureSessionObservation,installSessionNetworkPolicy,initializeAccountSessionNetwork,setBlockedRequestSink} from './src/main/network/session-observer.ts';",
          "export {gatedSessionFetch} from './src/main/network/gated-session-fetch.ts';",
          "export {pageFetch} from './src/main/data/collectors/shared.ts';",
          "export {closeAccountView} from './src/main/network/close-account-view.ts';",
          "export {AccountService} from './src/main/services/account-service.ts';",
          "export {checkingNetworkSnapshot} from './src/shared/network.ts';",
          "export {configureChromiumTransport} from './src/main/network/chromium-transport.ts';",
        ].join("\n"),
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron", "node:*"],
      metafile: true,
      tsconfig: path.join(root, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.mjs"),
      logLevel: "silent",
    });
    const sourceHashes = Object.fromEntries(
      Object.keys(built.metafile.inputs)
        .filter((name) => name.startsWith("src/"))
        .map((name) => [name, hash(fs.readFileSync(path.join(root, name)))]),
    );
    assert(
      safeError(Error("cookie=synthetic/query?secret=value")) === "CONTROLLED_OPERATION_FAILED",
      "LOCAL_ERROR_PRIVACY",
    );
    let settle,
      done = false;
    const original = new Promise((resolve) => {
      settle = resolve;
    }).then(() => {
      done = true;
    });
    const timeout = await bounded(original, "LOCAL_TIMEOUT", 1).then(
      () => false,
      () => true,
    );
    assert(timeout && !done, "LOCAL_TIMEOUT_NOT_DRAIN");
    settle();
    await original;
    assert(done, "LOCAL_ACTUAL_DRAIN");
    if (!run) {
      console.log(
        JSON.stringify({
          buildOnly: true,
          localChecks: 3,
          sourceCount: Object.keys(sourceHashes).length,
          electronStarted: false,
          networkRequests: 0,
        }),
      );
      return;
    }
    const candidates = ["openssl"];
    if (process.platform === "win32") {
      const located = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
      for (const git of (located.stdout ?? "").trim().split(/\r?\n/).filter(Boolean))
        candidates.push(path.join(path.dirname(path.dirname(git)), "usr/bin/openssl.exe"));
    }
    const openssl = candidates.find(
      (exe) => spawnSync(exe, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0,
    );
    assert(openssl, "OPENSSL_REQUIRED");
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
          `/CN=${host}`,
          "-addext",
          `subjectAltName=DNS:${host}`,
        ],
        { windowsHide: true, stdio: "ignore" },
      ).status === 0,
      "LOCAL_CERTIFICATE_GENERATION_FAILED",
    );
    const env = { ...process.env, CLIPDOCK_EXCLUSIVE_SMOKE_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, "--run-once"], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      worker.kill();
    }, 50_000);
    const code = await new Promise((resolve) => {
      worker.once("error", () => resolve(1));
      worker.once("exit", (n) => resolve(n ?? 1));
    });
    clearTimeout(timer);
    const filename = path.join(temporary, "result.json");
    report = fs.existsSync(filename)
      ? JSON.parse(fs.readFileSync(filename, "utf8"))
      : { failure: "CHILD_RESULT_MISSING", countsUnavailable: true };
    Object.assign(report, {
      sourceHashes,
      sourceHashesStable: Object.entries(sourceHashes).every(
        ([name, digest]) => hash(fs.readFileSync(path.join(root, name))) === digest,
      ),
      scriptHash: hash(fs.readFileSync(script)),
      bundleHash: hash(fs.readFileSync(path.join(temporary, "production.mjs"))),
      childExitCode: code,
      parentWatchdogFired: killed,
    });
  } finally {
    const exact = path.resolve(temporary);
    assert(
      path.dirname(exact) === base &&
        path.basename(exact).startsWith("exclusive-runtime-") &&
        fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(),
      "UNSAFE_TEMPORARY_PATH",
    );
    await delay(100);
    try {
      fs.rmSync(exact, { recursive: true });
    } catch {
      /* Only this exact owned directory; no broader retry. */
    }
    if (report) report.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (report) {
    report.passed =
      !report.failure &&
      report.cleanup?.drained === true &&
      report.checks?.every((check) => check.passed) &&
      report.sourceHashesStable &&
      report.rawTemporaryDataRemoved &&
      report.childExitCode === 0 &&
      !report.parentWatchdogFired;
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(
      JSON.stringify(
        {
          report: path.relative(root, destination),
          passed: report.passed,
          checks: report.checks?.length ?? 0,
          counts: report.counts,
          failure: report.failure ?? null,
          cleanup: report.cleanup,
        },
        null,
        2,
      ),
    );
    process.exitCode = report.passed ? 0 : 1;
  }
}

async function prepareChild() {
  const electron = await import("electron"),
    { app } = electron,
    temporary = process.env.CLIPDOCK_EXCLUSIVE_SMOKE_ROOT;
  assert(
    run &&
      temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
      path.basename(temporary).startsWith("exclusive-runtime-") &&
      !app.isReady(),
    "ISOLATION_REQUIRED",
  );
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", `MAP ${host} 127.0.0.1`);
  app.on("window-all-closed", () => {});
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  production.configureChromiumTransport(app);
  assert(!app.isReady(), "STARTUP_CONFIGURATION_TOO_LATE");
  return { electron, temporary, production };
}

async function child({ electron: { app, BrowserWindow, session, webContents }, temporary, production: p }) {
  const result = {
    kind: "controlled-exclusive-runtime-smoke",
    executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome },
    scope: {
      syntheticProxyAndCn: true,
      syntheticNetworkHash: true,
      syntheticAccountRepository: true,
      isolatedSession: true,
      loopbackTlsOnly: true,
      publicHttp: false,
      actualProxyModified: false,
      realAccounts: false,
      oldProofCoordinatorUsed: false,
      uploadValidated: false,
    },
    counts: {
      proxyReads: 0,
      syntheticCnReads: 0,
      closeAllConnections: 0,
      stopWebContents: 0,
      accountWrites: 0,
      accountOnlineEvents: 0,
      notifications: 0,
      fixtureOutOfScope: 0,
    },
    checks: [],
    receiver: {},
    blocked: {},
    states: [],
    qualificationGranted: false,
    realNetworkPermissionGranted: false,
  };
  let phase = "startup",
    server,
    ses,
    access,
    runtime,
    accounts,
    uninstallPolicy,
    uninstallBusiness;
  const windows = [],
    sockets = new Set(),
    responses = new Set(),
    pending = new Set();
  const checkpoint = () => {
    result.phase = phase;
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
  };
  const check = (name, value) => {
    result.checks.push({ name, passed: !!value });
    checkpoint();
    assert(value, "ASSERTION_FAILED");
  };
  const track = (promise) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const outcome = (promise) =>
    track(
      Promise.resolve(promise).then(
        () => "resolved",
        (error) => (error?.code === "NETWORK_DORMANT" ? "network-dormant" : "rejected"),
      ),
    );
  const count = (name) => result.receiver[name]?.requests ?? 0;
  const accountId = crypto.randomUUID(),
    syntheticCookie = "CLIPDOCK_SWITCH=synthetic-only";
  const account = {
    id: accountId,
    platformId: "bilibili",
    status: "online",
    lastCheckedAt: "2026-01-01T00:00:00.000Z",
    lastOnlineAt: "2026-01-01T00:00:00.000Z",
    displayName: "Synthetic account",
  };
  const originalAuth = JSON.stringify(account);
  checkpoint();
  try {
    await app.whenReady();
    assert(process.versions.electron === "43.3.0", "WRONG_ELECTRON_VERSION");
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => {
      result.counts.fixtureOutOfScope++;
      callback({ cancel: true });
    });
    const cert = fs.readFileSync(path.join(temporary, "cert.pem"));
    const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    server = https.createServer(
      { key: fs.readFileSync(path.join(temporary, "key.pem")), cert },
      (request, response) => {
        const candidate = new URL(request.url, "https://fixture.invalid").pathname.slice(1);
        const label = [
          "page",
          "unknown-main",
          "unknown-raw",
          "first-off",
          "allowed-main",
          "allowed-page",
          "allowed-xhr",
          "stream-main",
          "stream-page",
          "on-main",
          "on-raw",
          "restored-main",
          "favicon.ico",
        ].includes(candidate)
          ? candidate
          : "unexpected";
        if (label === "unexpected") {
          result.counts.fixtureOutOfScope++;
          response.destroy();
          return;
        }
        const row = (result.receiver[label] ??= {
          requests: 0,
          syntheticCookieRequests: 0,
          otherCredentialRequests: 0,
          onlyLoopback: true,
          chunks: 0,
          closed: 0,
        });
        row.requests++;
        row.syntheticCookieRequests += Number(request.headers.cookie === syntheticCookie);
        row.otherCredentialRequests += Number(
          !!request.headers.authorization ||
            !!request.headers["proxy-authorization"] ||
            (!!request.headers.cookie && request.headers.cookie !== syntheticCookie),
        );
        row.onlyLoopback &&= ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(request.socket.remoteAddress);
        responses.add(response);
        response.on("close", () => {
          responses.delete(response);
          row.closed++;
        });
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", label === "page" ? "text/html" : "application/json");
        if (label.startsWith("stream-")) {
          response.flushHeaders();
          const timer = setInterval(() => {
            if (!response.destroyed) {
              row.chunks++;
              response.write(" ");
            }
          }, 20);
          response.on("close", () => clearInterval(timer));
        } else
          response.end(label === "page" ? "<!doctype html><title>Isolated fixture</title>" : '{"ok":true}');
      },
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `https://${host}:${server.address().port}`,
      url = (label) => `${origin}/${label}`;
    ses = session.fromPartition(`sv-exclusive-test-${crypto.randomUUID()}`, { cache: false });
    check(
      "fixture Session has no persistent account storage",
      ses.storagePath === null && (await ses.cookies.get({})).length === 0,
    );
    const originalClose = ses.closeAllConnections.bind(ses);
    ses.closeAllConnections = async () => {
      result.counts.closeAllConnections++;
      await originalClose();
    };
    let proxy = "unknown";
    access = new p.ExclusiveNetworkSwitch({
      readNetwork: () => ({ available: true, hash: "SYNTHETIC_NETWORK" }),
      readProxy: async () => {
        result.counts.proxyReads++;
        const at = performance.now();
        return { state: proxy, startedAtMono: at, completedAtMono: at };
      },
      probeDomestic: async () => {
        result.counts.syntheticCnReads++;
        return {
          state: "reachable",
          country: "CN",
          asn: 4837,
          maskedIp: null,
          checkedAt: new Date().toISOString(),
          routeVerified: false,
        };
      },
      timing: { pollMs: 60000, warmupGapMs: 50 },
    });
    runtime = new p.NetworkRuntime({
      enforcement: "strict",
      networkReadiness: () => true,
      exclusiveAccess: { read: () => access.read(), acquire: () => access.acquire() },
      onSuspend: () => {
        accounts?.suspendNetworkAccount(accountId);
        return Promise.all(
          windows
            .filter((window) => !window.isDestroyed())
            .map((window) => p.closeAccountView(window.webContents)),
        ).then(() => undefined);
      },
    });
    access.on("state", (value) => {
      result.states.push({ state: value.state, proxy: value.proxy, generation: value.generation });
      runtime.syncExclusiveAccess();
    });
    uninstallBusiness = p.installBusinessNetwork(runtime);
    uninstallPolicy = p.installSessionNetworkPolicy({
      registerSession: runtime.registerSession.bind(runtime),
      checkSessionRequest: (current, rawUrl) => {
        const parsed = new URL(rawUrl);
        if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) && parsed.origin !== origin) {
          result.counts.fixtureOutOfScope++;
          return { cancel: true, reason: "UNKNOWN_TARGET" };
        }
        return runtime.checkSessionRequest(current, rawUrl);
      },
    });
    p.setBlockedRequestSink((event) => {
      const key = event.reason;
      result.blocked[key] = (result.blocked[key] ?? 0) + 1;
    });
    p.ensureSessionObservation(ses, "bilibili", accountId);
    await p.initializeAccountSessionNetwork(ses, accountId, "bilibili");
    ses.setCertificateVerifyProc((request, callback) => {
      let accepted = false;
      try {
        accepted =
          request.hostname === host &&
          new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      } catch {}
      callback(accepted ? 0 : -2);
    });
    await ses.cookies.set({
      url: origin,
      name: "CLIPDOCK_SWITCH",
      value: "synthetic-only",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    });
    accounts = new p.AccountService({
      store: {
        accounts: {
          get: () => structuredClone(account),
          updateStatus: () => {
            result.counts.accountWrites++;
            throw Error("UNEXPECTED_AUTH_WRITE");
          },
        },
        audit: { append() {} },
      },
      viewPool: { getState: () => null },
      notify: () => {
        result.counts.notifications++;
      },
    });
    accounts.on("account-online", () => {
      result.counts.accountOnlineEvents++;
    });
    const ready = () => track(runtime.registerSession(ses, accountId, "bilibili").ready);
    const createWindow = async () => {
      const window = new BrowserWindow({
        show: false,
        width: 400,
        height: 280,
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      windows.push(window);
      p.bindAccountWebContents(window.webContents, accountId);
      const stop = window.webContents.stop.bind(window.webContents);
      window.webContents.stop = () => {
        result.counts.stopWebContents++;
        stop();
      };
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await window.loadURL("data:text/html,<title>Isolated fixture</title>");
      return window;
    };
    const xhr = (wc, label) =>
      wc.executeJavaScript(
        `new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(url(label))});x.withCredentials=true;x.onload=()=>resolve(x.status===200);x.onerror=()=>resolve(false);x.onabort=()=>resolve(false);x.send()})`,
      );
    phase = "unknown";
    access.start();
    await access.whenIdle();
    await ready();
    check("unknown proxy state keeps account request authority closed", !runtime.check(accountId).allowed);
    check(
      "unknown gated main request is dormant",
      (await outcome(p.gatedSessionFetch(accountId, ses, url("unknown-main")))) === "network-dormant",
    );
    check(
      "unknown raw Session request is canceled",
      (await outcome(ses.fetch(url("unknown-raw"), { credentials: "include" }))) === "rejected",
    );
    check(
      "unknown checkStatus preserves actual service auth fields",
      JSON.stringify(await accounts.checkStatus(accountId)) === originalAuth,
    );
    check(
      "unknown requests have zero receiver arrivals",
      count("unknown-main") === 0 && count("unknown-raw") === 0,
    );
    phase = "first-off";
    proxy = "inactive";
    await access.refresh();
    await ready();
    check(
      "first proxy-off and CN round stays checking",
      access.read().state === "checking" && !runtime.check(accountId).allowed,
    );
    check(
      "first off round does not send a gated request",
      (await outcome(p.gatedSessionFetch(accountId, ses, url("first-off")))) === "network-dormant" &&
        count("first-off") === 0,
    );
    await delay(60);
    await access.refresh();
    await ready();
    check(
      "two stable proxy-off and CN rounds grant test domestic access",
      access.read().state === "domestic" &&
        runtime.check(accountId).allowed &&
        result.counts.syntheticCnReads === 2,
    );
    phase = "domestic";
    const main = await bounded(
      track(p.gatedSessionFetch(accountId, ses, url("allowed-main"))),
      "ALLOWED_MAIN_TIMEOUT",
    );
    check(
      "allowed real Session fetch reaches receiver with synthetic Cookie",
      main.status === 200 && result.receiver["allowed-main"]?.syntheticCookieRequests === 1,
    );
    const window = await createWindow();
    await window.loadURL(url("page"));
    const activeContents = window.webContents;
    const page = await bounded(
      track(p.pageFetch(activeContents, url("allowed-page"))),
      "ALLOWED_PAGE_TIMEOUT",
    );
    check(
      "allowed production pageFetch reaches receiver with synthetic Cookie",
      page.ok && result.receiver["allowed-page"]?.syntheticCookieRequests === 1,
    );
    check(
      "allowed page XHR reaches receiver with synthetic Cookie",
      (await bounded(track(xhr(activeContents, "allowed-xhr")), "ALLOWED_XHR_TIMEOUT")) &&
        result.receiver["allowed-xhr"]?.syntheticCookieRequests === 1,
    );
    phase = "active-streams";
    const mainPending = outcome(p.gatedSessionFetch(accountId, ses, url("stream-main")));
    const pagePending = outcome(p.pageFetch(activeContents, url("stream-page")));
    await until(
      () => result.receiver["stream-main"]?.chunks >= 2 && result.receiver["stream-page"]?.chunks >= 2,
      "STREAMS_NOT_STARTED",
    );
    const lease = p.beginBusinessOperation(accountId, url("lease")),
      closeBefore = result.counts.closeAllConnections,
      stopBefore = result.counts.stopWebContents;
    phase = "proxy-enabled";
    proxy = "active";
    access.observeProxyEnabled(0);
    check(
      "positive proxy event synchronously revokes the business lease",
      lease.signal.aborted && !runtime.check(accountId).allowed,
    );
    lease.release();
    const outcomes = await bounded(Promise.all([mainPending, pagePending]), "REVOKED_STREAMS_PENDING");
    await ready();
    await until(
      () => result.receiver["stream-main"]?.closed === 1 && result.receiver["stream-page"]?.closed === 1,
      "RECEIVER_NOT_CLOSED",
    );
    check(
      "both active production body readers settle as network dormant",
      outcomes.every((value) => value === "network-dormant"),
    );
    check(
      "production suspension calls stop and closes the actual view",
      result.counts.stopWebContents > stopBefore && activeContents.isDestroyed(),
    );
    check(
      "Session connection cleanup completes on proxy enable",
      result.counts.closeAllConnections > closeBefore,
    );
    const chunks = [result.receiver["stream-main"].chunks, result.receiver["stream-page"].chunks];
    await delay(80);
    check(
      "receiver streams remain stopped after cleanup",
      JSON.stringify(chunks) ===
        JSON.stringify([result.receiver["stream-main"].chunks, result.receiver["stream-page"].chunks]),
    );
    check(
      "proxy-on main call cannot arrive",
      (await outcome(p.gatedSessionFetch(accountId, ses, url("on-main")))) === "network-dormant" &&
        count("on-main") === 0,
    );
    check(
      "proxy-on raw Session hook cannot arrive",
      (await outcome(ses.fetch(url("on-raw"), { credentials: "include" }))) === "rejected" &&
        count("on-raw") === 0,
    );
    const oldDirect = {
      ...p.checkingNetworkSnapshot(),
      instanceId: "synthetic-old-direct",
      sequence: 1,
      state: "dual",
      reason: "READY",
      checkedAt: new Date().toISOString(),
      controller: { readable: true, mode: "rule", tun: false, ruleCount: 1, version: "synthetic" },
      rulesVersion: "synthetic-direct",
      targets: [
        {
          platformId: "bilibili",
          host,
          purpose: "business",
          route: "direct",
          reason: "READY",
          ruleType: "DOMAIN",
        },
      ],
    };
    runtime.onObservation(oldDirect);
    await ready();
    check(
      "historical DIRECT observation cannot reopen proxy-on authority",
      !runtime.check(accountId).allowed && access.read().state === "overseas",
    );
    check(
      "proxy-on checkStatus retains auth and real verification timestamps",
      JSON.stringify(await accounts.checkStatus(accountId)) === originalAuth &&
        result.counts.accountWrites === 0 &&
        result.counts.accountOnlineEvents === 0 &&
        result.counts.notifications === 0,
    );
    phase = "restore";
    proxy = "inactive";
    await access.refresh();
    await ready();
    check(
      "proxy-off first recovery round remains closed",
      access.read().state === "checking" && !runtime.check(accountId).allowed,
    );
    await delay(60);
    await access.refresh();
    await ready();
    const restored = await bounded(
      track(p.gatedSessionFetch(accountId, ses, url("restored-main"))),
      "RESTORE_TIMEOUT",
    );
    check(
      "second recovery round restores the original Session Cookie",
      access.read().state === "domestic" &&
        restored.status === 200 &&
        result.receiver["restored-main"].syntheticCookieRequests === 1,
    );
    check(
      "all receiver traffic is loopback and only synthetic credentials",
      Object.values(result.receiver).every((row) => row.onlyLoopback && row.otherCredentialRequests === 0) &&
        result.counts.fixtureOutOfScope === 0,
    );
    check(
      "no real authentication or notification changes occurred",
      JSON.stringify(account) === originalAuth &&
        result.counts.accountWrites === 0 &&
        result.counts.accountOnlineEvents === 0 &&
        result.counts.notifications === 0,
    );
  } catch (error) {
    result.failure = safeError(error);
    checkpoint();
  } finally {
    phase = "cleanup";
    let drained = true;
    try {
      access?.stop();
      accounts?.dispose();
      const cleanup = await bounded(
        Promise.allSettled([runtime?.dispose(), access?.dispose(), ...pending]),
        "RUNTIME_CLEANUP_TIMEOUT",
      );
      if (cleanup.some((value) => value.status === "rejected")) drained = false;
    } catch {
      drained = false;
    }
    uninstallPolicy?.();
    uninstallBusiness?.();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    try {
      if (ses) {
        ses.setCertificateVerifyProc(null);
        await bounded(
          Promise.all([
            ses.closeAllConnections(),
            ses.clearStorageData(),
            ses.clearHostResolverCache(),
            ses.clearAuthCache(),
          ]),
          "SESSION_CLEANUP_TIMEOUT",
        );
      }
    } catch {
      drained = false;
    }
    for (const response of responses) response.destroy();
    for (const socket of sockets) socket.destroy();
    try {
      if (server) await bounded(new Promise((resolve) => server.close(resolve)), "SERVER_CLEANUP_TIMEOUT");
    } catch {
      drained = false;
    }
    result.cleanup = {
      drained: drained && pending.size === 0,
      pendingCount: pending.size,
      windows: BrowserWindow.getAllWindows().length,
      webContents: webContents.getAllWebContents().length,
    };
    phase = "finished";
    checkpoint();
    app.exit(result.failure || !result.cleanup.drained ? 1 : 0);
  }
}
