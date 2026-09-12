/** Build-only by default. --run-once [--http2]: controlled loopback uploads, no real proxy/config changes. */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http2 from "node:http2";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url),
  root = path.resolve(path.dirname(script), "..");
const run = process.argv.includes("--run-once"),
  h2 = process.argv.includes("--http2");
const host = "clipdock-exclusive-upload.test",
  expectedBytes = 32 * 1024 * 1024,
  pauseAtBytes = 256 * 1024;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, code) => {
  if (!value) throw Error(code);
};
const safeError = (error) =>
  /^[A-Z_]{1,100}$/.test(error?.message ?? "") ? error.message : "CONTROLLED_OPERATION_FAILED";
function interruptedBeforeWholeBody(row, expected, http2Mode) {
  return (
    row.declaredBytes === expected &&
    row.receivedBytes > 0 &&
    row.receivedBytes < row.declaredBytes &&
    row.aborted &&
    row.requestClosed &&
    row.transportClosed &&
    (http2Mode
      ? row.streamClosed && row.rstCode === http2.constants.NGHTTP2_CANCEL
      : !row.complete && !row.ended)
  );
}
function checkReceiverAssertions() {
  const interrupted = {
    declaredBytes: expectedBytes,
    receivedBytes: pauseAtBytes,
    aborted: true,
    requestClosed: true,
    transportClosed: true,
    streamClosed: true,
    rstCode: http2.constants.NGHTTP2_CANCEL,
    complete: true,
    ended: true,
  };
  assert(interruptedBeforeWholeBody(interrupted, expectedBytes, true), "LOCAL_H2_CANCEL_WITH_COMPAT_END");
  for (const change of [
    { receivedBytes: expectedBytes },
    { receivedBytes: 0 },
    { declaredBytes: expectedBytes - 1 },
    { aborted: false },
    { transportClosed: false },
    { streamClosed: false },
    { rstCode: 0 },
  ])
    assert(
      !interruptedBeforeWholeBody({ ...interrupted, ...change }, expectedBytes, true),
      "LOCAL_COMPLETE_OR_UNPROVEN_UPLOAD_REJECTED",
    );
  assert(!interruptedBeforeWholeBody(interrupted, expectedBytes, false), "LOCAL_H1_COMPLETE_REJECTED");
  assert(
    interruptedBeforeWholeBody({ ...interrupted, complete: false, ended: false }, expectedBytes, false),
    "LOCAL_H1_PARTIAL_CANCEL",
  );
  return 10;
}
async function bounded(promise, code, ms = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(test, code, ms = 8000) {
  const end = performance.now() + ms;
  while (!test()) {
    assert(performance.now() < end, code);
    await delay(15);
  }
}
if (!process.versions.electron) await parent();
else {
  try {
    const startup = await prepareChild();
    void child(startup).catch(async () => {
      const filename = path.join(startup.temporary, "result.json");
      let previous = {};
      try {
        previous = JSON.parse(fs.readFileSync(filename, "utf8"));
      } catch {}
      fs.writeFileSync(
        filename,
        JSON.stringify({
          ...previous,
          failure: previous.failure ?? "CHILD_UNHANDLED",
          terminalFailure: "CHILD_UNHANDLED",
          cleanup: { ...previous.cleanup, drained: false },
        }),
      );
      startup.electron.app.exit(1);
    });
  } catch {
    const temporary = process.env.CLIPDOCK_EXCLUSIVE_UPLOAD_ROOT;
    if (
      temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
      path.basename(temporary).startsWith("exclusive-upload-")
    )
      fs.writeFileSync(
        path.join(temporary, "result.json"),
        JSON.stringify({ failure: "CHILD_STARTUP_FAILED", cleanup: { drained: false } }),
      );
    process.exit(1);
  }
}

async function parent() {
  assert(
    process.argv.slice(2).every((arg) => ["--run-once", "--build-only", "--http2"].includes(arg)) &&
      !(run && process.argv.includes("--build-only")),
    "INVALID_ARGUMENTS",
  );
  const { build } = await import("esbuild"),
    { default: electron } = await import("electron");
  const base = path.resolve(root, "docs/.compare");
  fs.mkdirSync(base, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(base, "exclusive-upload-"));
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const destination = path.join(
    root,
    `docs/network-exclusive-upload-${h2 ? "h2" : "h1"}.${stamp}.results.json`,
  );
  let report,
    childClosed = true;
  try {
    const built = await build({
      stdin: {
        contents: [
          "export {ExclusiveNetworkSwitch} from './src/main/network/exclusive-switch.ts';",
          "export {NetworkRuntime} from './src/main/network/runtime.ts';",
          "export {installBusinessNetwork,bindAccountWebContents,beginBusinessOperation} from './src/main/network/business-access.ts';",
          "export {ensureSessionObservation,installSessionNetworkPolicy,initializeAccountSessionNetwork} from './src/main/network/session-observer.ts';",
          "export {gatedSessionFetch} from './src/main/network/gated-session-fetch.ts';",
          "export {closeAccountView} from './src/main/network/close-account-view.ts';",
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
    assert(expectedBytes >= 16 * 1024 * 1024 && pauseAtBytes < expectedBytes / 8, "LOCAL_UPLOAD_BOUNDS");
    assert(safeError(Error("cookie=secret")) === "CONTROLLED_OPERATION_FAILED", "LOCAL_ERROR_PRIVACY");
    const receiverAssertionChecks = checkReceiverAssertions();
    if (!run) {
      console.log(
        JSON.stringify({
          buildOnly: true,
          protocol: h2 ? "h2" : "h1",
          sourceCount: Object.keys(sourceHashes).length,
          expectedUploadBytes: expectedBytes,
          receiverAssertionChecks,
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
      "LOCAL_CERTIFICATE_FAILED",
    );
    const env = { ...process.env, CLIPDOCK_EXCLUSIVE_UPLOAD_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    childClosed = false;
    const worker = spawn(electron, [script, "--run-once", ...(h2 ? ["--http2"] : [])], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      worker.kill();
    }, 65_000);
    const code = await new Promise((resolve) => {
      worker.once("error", () => {});
      worker.once("close", (value) => {
        childClosed = true;
        resolve(value ?? 1);
      });
    });
    clearTimeout(timer);
    report = fs.existsSync(path.join(temporary, "result.json"))
      ? JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"))
      : { failure: "CHILD_RESULT_MISSING", countsUnavailable: true };
    Object.assign(report, {
      receiverAssertionChecks,
      sourceHashes,
      sourceHashesStable: Object.entries(sourceHashes).every(
        ([name, digest]) => hash(fs.readFileSync(path.join(root, name))) === digest,
      ),
      scriptHash: hash(fs.readFileSync(script)),
      bundleHash: hash(fs.readFileSync(path.join(temporary, "production.mjs"))),
      childExitCode: code,
      parentWatchdogFired: killed,
    });
  } catch (error) {
    report ??= {
      failure: safeError(error),
      phase: "parent",
      countsUnavailable: true,
      cleanup: { drained: false },
    };
  } finally {
    const exact = path.resolve(temporary);
    assert(
      path.dirname(exact) === base &&
        path.basename(exact).startsWith("exclusive-upload-") &&
        fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(),
      "UNSAFE_TEMPORARY_PATH",
    );
    if (childClosed) {
      try {
        fs.rmSync(exact, { recursive: true });
      } catch {
        /* No broader path or cleanup retry. */
      }
    }
    if (report) report.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (report) {
    report.passed =
      !report.failure &&
      report.cleanup?.drained === true &&
      report.checks?.length > 0 &&
      report.checks.every((item) => item.passed) &&
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
          failure: report.failure ?? null,
          uploads: report.uploads,
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
    temporary = process.env.CLIPDOCK_EXCLUSIVE_UPLOAD_ROOT;
  assert(
    run &&
      temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
      path.basename(temporary).startsWith("exclusive-upload-") &&
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
    kind: "controlled-exclusive-upload-smoke",
    executedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    },
    protocol: h2 ? "h2" : "h1",
    scope: {
      syntheticProxyAndCn: true,
      syntheticOsHash: true,
      loopbackTlsOnly: true,
      syntheticCookieOnly: true,
      actualProxyModified: false,
      realAccounts: false,
      platformUploadValidated: false,
    },
    expectedBytes,
    pauseAtBytes,
    checks: [],
    uploads: {},
    arrivals: {},
    counts: { closeAllConnections: 0, stopViews: 0, fixtureOutOfScope: 0, syntheticCnReads: 0 },
    realNetworkPermissionGranted: false,
  };
  const windows = [],
    sockets = new Set(),
    sessions = new Set(),
    requests = new Set(),
    responses = new Set(),
    pending = new Set();
  let server,
    ses,
    access,
    runtime,
    uninstallPolicy,
    uninstallBusiness,
    phase = "startup",
    proxy = "unknown";
  const accountId = crypto.randomUUID(),
    cookie = "CLIPDOCK_UPLOAD=synthetic-only";
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
  checkpoint();
  try {
    await app.whenReady();
    assert(process.versions.electron === "43.3.0", "WRONG_ELECTRON_VERSION");
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => {
      result.counts.fixtureOutOfScope++;
      callback({ cancel: true });
    });
    const cert = fs.readFileSync(path.join(temporary, "cert.pem")),
      fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    const receiver = (request, response) => {
      const label = new URL(request.url, "https://fixture.invalid").pathname.slice(1);
      const allowed = [
        "page",
        "favicon.ico",
        "upload-main",
        "upload-xhr",
        "closed-main",
        "closed-raw",
        "closed-xhr",
      ];
      if (!allowed.includes(label)) {
        result.counts.fixtureOutOfScope++;
        request.destroy();
        return;
      }
      result.arrivals[label] = (result.arrivals[label] ?? 0) + 1;
      const onlyLoopback = ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(request.socket.remoteAddress);
      const credentialsSafe =
        !request.headers.authorization &&
        !request.headers["proxy-authorization"] &&
        (!request.headers.cookie || request.headers.cookie === cookie);
      if (!onlyLoopback || !credentialsSafe) {
        result.counts.fixtureOutOfScope++;
        request.destroy();
        return;
      }
      responses.add(response);
      response.once("close", () => responses.delete(response));
      response.on("error", () => {});
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Access-Control-Allow-Origin", "null");
      response.setHeader("Access-Control-Allow-Credentials", "true");
      if (label === "page" || label === "favicon.ico") {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><title>Controlled upload</title>");
        return;
      }
      requests.add(request);
      request.on("error", () => {});
      const row = (result.uploads[label] = {
        requests: result.arrivals[label],
        expectedBytes,
        declaredBytes: Number(request.headers["content-length"] ?? -1),
        receivedBytes: 0,
        chunks: 0,
        paused: false,
        bytesAtPause: null,
        bytesAtRevocation: null,
        complete: false,
        ended: false,
        aborted: false,
        requestClosed: false,
        transportClosed: false,
        streamClosed: false,
        rstCode: null,
        receivedSyntheticCookie: request.headers.cookie === cookie,
        httpVersion: request.httpVersion,
        onlyLoopback,
        credentialsSafe,
      });
      const actualSocket = h2 ? request.stream.session.socket : request.socket;
      actualSocket.once("close", () => {
        row.transportClosed = true;
      });
      if (h2) {
        const stream = request.stream;
        stream.on("error", () => {});
        stream.once("close", () => {
          row.streamClosed = true;
          row.rstCode = stream.rstCode;
        });
      }
      request.on("data", (chunk) => {
        row.receivedBytes += chunk.length;
        row.chunks++;
        if (!row.paused && row.receivedBytes >= pauseAtBytes) {
          row.paused = true;
          row.bytesAtPause = row.receivedBytes;
          request.pause();
          checkpoint();
        }
      });
      request.once("end", () => {
        row.ended = true;
        row.complete = request.complete === true;
        if (row.receivedBytes === row.declaredBytes && !row.aborted && !response.destroyed)
          response.end("unexpected complete upload");
      });
      request.once("aborted", () => {
        row.aborted = true;
      });
      request.once("close", () => {
        row.requestClosed = true;
        row.complete = request.complete === true;
        requests.delete(request);
      });
    };
    const options = { key: fs.readFileSync(path.join(temporary, "key.pem")), cert };
    server = h2
      ? http2.createSecureServer({ ...options, allowHTTP1: false }, receiver)
      : https.createServer(options, receiver);
    server.on("error", () => {});
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    if (h2)
      server.on("session", (current) => {
        sessions.add(current);
        current.on("error", () => {});
        current.once("close", () => sessions.delete(current));
      });
    await bounded(
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      }),
      "SERVER_START_TIMEOUT",
    );
    const origin = `https://${host}:${server.address().port}`,
      url = (label) => `${origin}/${label}`;
    ses = session.fromPartition(`exclusive-upload-${crypto.randomUUID()}`, { cache: false });
    check(
      "isolated Session starts without persisted credentials",
      ses.storagePath === null && (await ses.cookies.get({})).length === 0,
    );
    const close = ses.closeAllConnections.bind(ses);
    ses.closeAllConnections = async () => {
      result.counts.closeAllConnections++;
      await close();
    };
    access = new p.ExclusiveNetworkSwitch({
      readNetwork: () => ({ available: true, hash: "SYNTHETIC_UPLOAD_OS" }),
      readProxy: async () => {
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
      onSuspend: () =>
        Promise.all(
          windows
            .filter((window) => !window.isDestroyed())
            .map((window) => {
              result.counts.stopViews++;
              return p.closeAccountView(window.webContents);
            }),
        ).then(() => undefined),
    });
    access.on("state", () => runtime.syncExclusiveAccess());
    uninstallBusiness = p.installBusinessNetwork(runtime);
    uninstallPolicy = p.installSessionNetworkPolicy({
      registerSession: runtime.registerSession.bind(runtime),
      checkSessionRequest: (current, value) => {
        const parsed = new URL(value);
        if (["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) && parsed.origin !== origin) {
          result.counts.fixtureOutOfScope++;
          return { cancel: true, reason: "UNKNOWN_TARGET" };
        }
        return runtime.checkSessionRequest(current, value);
      },
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
      name: "CLIPDOCK_UPLOAD",
      value: "synthetic-only",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    });
    const ready = () => track(runtime.registerSession(ses, accountId, "bilibili").ready);
    const makeWindow = async (allowedPage) => {
      const window = new BrowserWindow({
        show: false,
        width: 400,
        height: 280,
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      windows.push(window);
      p.bindAccountWebContents(window.webContents, accountId);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await bounded(
        track(
          window.loadURL(allowedPage ? url("page") : "data:text/html,<title>Closed upload fixture</title>"),
        ),
        "PAGE_LOAD_TIMEOUT",
      );
      return window;
    };
    const allow = async () => {
      proxy = "inactive";
      await access.refresh();
      await ready();
      assert(!runtime.check(accountId).allowed, "FIRST_ROUND_NOT_CLOSED");
      await delay(60);
      await access.refresh();
      await ready();
      assert(runtime.check(accountId).allowed, "SECOND_ROUND_NOT_ALLOWED");
    };
    access.start();
    await access.whenIdle();
    await ready();
    for (const kind of ["main", "xhr"]) {
      phase = `allow-${kind}`;
      checkpoint();
      await allow();
      const window = kind === "xhr" ? await makeWindow(true) : null;
      const label = `upload-${kind}`,
        lease = p.beginBusinessOperation(accountId, url(label));
      const closeBefore = result.counts.closeAllConnections;
      let upload;
      if (kind === "main")
        upload = outcome(
          p.gatedSessionFetch(accountId, ses, url(label), {
            method: "POST",
            body: Buffer.alloc(expectedBytes, 0x5a),
            headers: { "Content-Type": "application/octet-stream" },
          }),
        );
      else {
        // The native executeJavaScript promise ends after send(), not after the document is destroyed.
        // Actual upload termination is independently observed at the server and destroyed WebContents.
        const started = await bounded(
          track(
            window.webContents.executeJavaScript(
              `(()=>{const x=new XMLHttpRequest();globalThis.fixtureUpload=x;x.open('POST',${JSON.stringify(url(label))});x.withCredentials=true;x.send(new Uint8Array(${expectedBytes}));return true})()`,
            ),
          ),
          "XHR_START_TIMEOUT",
        );
        assert(started === true, "XHR_NOT_STARTED");
      }
      phase = `backpressure-${kind}`;
      await until(() => result.uploads[label]?.paused, "UPLOAD_NOT_PARTIALLY_RECEIVED");
      const row = result.uploads[label];
      check(
        `${kind} real upload reached a paused receiver with a fixed incomplete body`,
        row.requests === 1 &&
          row.declaredBytes === expectedBytes &&
          row.bytesAtPause > 0 &&
          row.receivedBytes < expectedBytes &&
          !row.ended &&
          row.receivedSyntheticCookie &&
          row.httpVersion === (h2 ? "2.0" : "1.1"),
      );
      const pausedCount = row.receivedBytes;
      await delay(50);
      check(
        `${kind} receiver backpressure held application reads before revocation`,
        row.receivedBytes === pausedCount && !row.ended,
      );
      phase = `revoke-${kind}`;
      row.bytesAtRevocation = row.receivedBytes;
      row.revokedAtMono = performance.now();
      proxy = "active";
      access.observeProxyEnabled(0);
      check(
        `${kind} proxy event synchronously aborts the current lease`,
        lease.signal.aborted && !runtime.check(accountId).allowed,
      );
      lease.release();
      if (upload)
        check(
          "main native gated upload promise rejects as network dormant",
          (await bounded(upload, "MAIN_UPLOAD_NOT_REJECTED")) === "network-dormant",
        );
      await bounded(ready(), "SUSPENSION_NOT_DRAINED");
      // Resume only to count transport bytes already buffered while paused. No fixture socket is
      // destroyed here: the production abort/close must cause the server's terminal events itself.
      for (const request of requests) if (!request.destroyed) request.resume();
      await until(() => row.requestClosed && row.transportClosed, "UPLOAD_TRANSPORT_NOT_CLOSED");
      check(
        `${kind} receiver observed incomplete aborted transport before fixture cleanup`,
        // Node's H2 compatibility onStreamCloseRequest calls push(null), so a cancelled
        // stream may emit Readable end. complete also includes aborted/destroyed. Neither
        // substitutes for receiving the declared body. Preserve both raw observations.
        // https://raw.githubusercontent.com/nodejs/node/v24.18.1/lib/internal/http2/compat.js
        interruptedBeforeWholeBody(row, expectedBytes, h2),
      );
      check(
        `${kind} production connection cleanup ran${kind === "xhr" ? " and destroyed the upload page" : ""}`,
        result.counts.closeAllConnections > closeBefore && (!window || window.isDestroyed()),
      );
      const settledBytes = row.receivedBytes;
      await delay(150);
      check(
        `${kind} received-byte count remains stable after production cleanup`,
        row.receivedBytes === settledBytes,
      );
    }
    phase = "closed-new-uploads";
    const small = new Uint8Array(1024);
    check(
      "closed gated upload sends no new request",
      (await outcome(
        p.gatedSessionFetch(accountId, ses, url("closed-main"), { method: "POST", body: small }),
      )) === "network-dormant",
    );
    check(
      "closed raw Session upload is rejected by SessionGuard",
      (await bounded(
        outcome(ses.fetch(url("closed-raw"), { method: "POST", credentials: "include", body: small })),
        "CLOSED_RAW_PENDING",
      )) === "rejected",
    );
    const closedWindow = await makeWindow(false);
    const closedXhr = await bounded(
      track(
        closedWindow.webContents.executeJavaScript(
          `new Promise(resolve=>{const x=new XMLHttpRequest();x.open('POST',${JSON.stringify(url("closed-xhr"))});x.withCredentials=true;x.onload=()=>resolve('load');x.onerror=()=>resolve('error');x.onabort=()=>resolve('abort');x.send(new Uint8Array(1024))})`,
        ),
      ),
      "CLOSED_XHR_PENDING",
    );
    await delay(80);
    check(
      "closed page XHR fails and all three new uploads have zero receiver arrivals",
      closedXhr !== "load" &&
        ["closed-main", "closed-raw", "closed-xhr"].every((name) => !result.arrivals[name]),
    );
    check(
      "fixture traffic stayed loopback with synthetic credentials only",
      result.counts.fixtureOutOfScope === 0 &&
        Object.values(result.uploads).every((row) => row.onlyLoopback && row.credentialsSafe),
    );
  } catch (error) {
    result.failure = safeError(error);
    checkpoint();
  } finally {
    phase = "cleanup";
    checkpoint();
    let drained = true;
    try {
      access?.stop();
      const ended = await bounded(
        Promise.allSettled([runtime?.dispose(), access?.dispose()]),
        "RUNTIME_CLEANUP_TIMEOUT",
      );
      if (ended.some((item) => item.status === "rejected")) drained = false;
    } catch {
      drained = false;
    }
    // Failure cleanup may now forcibly close only this fixture's own transport. It never counts
    // towards the earlier revocation checks or rewrites their saved byte counts.
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    try {
      if (ses) {
        ses.setCertificateVerifyProc(null);
        await bounded(
          Promise.allSettled([
            ses.closeAllConnections(),
            ses.clearStorageData(),
            ses.clearHostResolverCache(),
            ses.clearAuthCache(),
          ]).then((items) => {
            if (items.some((item) => item.status === "rejected")) throw Error("SESSION_CLEANUP_FAILED");
          }),
          "SESSION_CLEANUP_TIMEOUT",
        );
      }
    } catch {
      drained = false;
    }
    for (const request of requests) request.destroy();
    for (const response of responses) response.destroy();
    for (const current of sessions) current.destroy();
    for (const socket of sockets) socket.destroy();
    try {
      await bounded(Promise.allSettled([...pending]), "NATIVE_WORK_DRAIN_TIMEOUT");
      if (server) await bounded(new Promise((resolve) => server.close(resolve)), "SERVER_CLEANUP_TIMEOUT");
      await until(
        () => sockets.size === 0 && sessions.size === 0 && requests.size === 0 && responses.size === 0,
        "FIXTURE_OBJECTS_NOT_CLOSED",
        3000,
      );
    } catch {
      drained = false;
    }
    try {
      uninstallPolicy?.();
    } catch {
      drained = false;
    }
    try {
      uninstallBusiness?.();
    } catch {
      drained = false;
    }
    result.cleanup = {
      drained:
        drained &&
        pending.size === 0 &&
        BrowserWindow.getAllWindows().length === 0 &&
        webContents.getAllWebContents().length === 0,
      pendingCount: pending.size,
      windows: BrowserWindow.getAllWindows().length,
      webContents: webContents.getAllWebContents().length,
      sockets: sockets.size,
      http2Sessions: sessions.size,
      requests: requests.size,
      responses: responses.size,
    };
    phase = "finished";
    checkpoint();
    app.exit(result.failure || !result.cleanup.drained ? 1 : 0);
  }
}
