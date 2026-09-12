/** Locked Electron, loopback TLS/UDP only. Run: node scripts/electron-quic-constraint-smoke.mjs */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const host = "clipdock-quic.test";
const apis = ["page-fetch", "session-fetch", "net-request"];
const stem = "network-quic-constraint-smoke";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value, message) {
  if (!value) throw Error(message);
}
async function bounded(work, ms, message) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (process.versions.electron) void child().catch(() => process.exit(1));
else await parent();

async function parent() {
  const { spawn, spawnSync } = await import("node:child_process");
  const { build } = await import("esbuild");
  const electron = require("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-quic-constraint-"));
  const receivers = [];
  const result = {
    executedAt: new Date().toISOString(),
    scope: {
      localOnly: true,
      realAccounts: false,
      realCookies: false,
      osConfigurationChanged: false,
      temporaryProfiles: true,
      systemTrustModified: false,
      receiverImplementsQuicHandshake: false,
    },
    sourceHashes: {
      "src/main/network/chromium-transport.ts": hash(
        fs.readFileSync(path.join(repository, "src/main/network/chromium-transport.ts")),
      ),
      "scripts/electron-quic-constraint-smoke.mjs": hash(fs.readFileSync(script)),
    },
    runs: [],
    checks: [],
    qualification: { quicConstraintValidated: false, routeOrAddressFamilyQualified: false },
  };
  let exitCode = 1;
  try {
    const candidates = ["openssl"];
    if (process.platform === "win32") {
      const located = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
      for (const git of (located.stdout ?? "").trim().split(/\r?\n/).filter(Boolean))
        candidates.push(path.join(path.dirname(path.dirname(git)), "usr", "bin", "openssl.exe"));
    }
    const openssl = candidates.find(
      (value) => spawnSync(value, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0,
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
          "/CN=" + host,
          "-addext",
          "subjectAltName=DNS:" + host,
        ],
        { windowsHide: true, stdio: "ignore" },
      ).status === 0,
      "FIXTURE_CERTIFICATE_FAILED",
    );
    const key = fs.readFileSync(path.join(temporary, "key.pem")),
      cert = fs.readFileSync(path.join(temporary, "cert.pem"));
    const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    await build({
      entryPoints: [path.join(repository, "src/main/network/chromium-transport.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: path.join(temporary, "production.cjs"),
      logLevel: "silent",
    });
    result.productionBundleSha256 = hash(fs.readFileSync(path.join(temporary, "production.cjs")));
    for (const mode of ["positive", "constrained"]) {
      const endpoints = [];
      for (const api of apis) {
        const receiver = {
          mode,
          api,
          port: 0,
          tcpRequests: 0,
          credentialHeaders: 0,
          unexpectedHttpRequests: 0,
          udpDatagrams: 0,
          quicInitialDatagrams: 0,
          quicVersions: new Set(),
          nonLoopbackDatagrams: 0,
          sockets: new Set(),
        };
        receiver.tcp = https.createServer({ key, cert }, (request, response) => {
          receiver.tcpRequests++;
          if (
            request.headers.cookie ||
            request.headers.authorization ||
            request.headers["proxy-authorization"]
          )
            receiver.credentialHeaders++;
          if (request.method !== "GET" || request.url !== "/" + api) receiver.unexpectedHttpRequests++;
          response.writeHead(200, {
            "content-type": "text/plain",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
            "alt-svc": `h3=\":${receiver.port}\"; ma=60`,
          });
          response.end("fixture-ok");
        });
        receiver.tcp.on("connection", (socket) => {
          receiver.sockets.add(socket);
          socket.on("close", () => receiver.sockets.delete(socket));
        });
        receiver.tcp.on("tlsClientError", () => {});
        await new Promise((resolve, reject) => {
          receiver.tcp.once("error", reject);
          receiver.tcp.listen(0, "127.0.0.1", resolve);
        });
        receiver.port = receiver.tcp.address().port;
        receiver.udp = dgram.createSocket("udp4");
        receiver.udp.on("message", (bytes, remote) => {
          receiver.udpDatagrams++;
          if (remote.address !== "127.0.0.1") receiver.nonLoopbackDatagrams++;
          // QUIC v1/v2 Initial long header. No payload, address or connection ID is retained.
          if (bytes.length < 1200 || (bytes[0] & 0xc0) !== 0xc0) return;
          const version = bytes.readUInt32BE(1),
            packetType = (bytes[0] >> 4) & 3;
          if ((version === 1 && packetType === 0) || (version === 0x6b3343cf && packetType === 1)) {
            receiver.quicInitialDatagrams++;
            receiver.quicVersions.add(version.toString(16));
          }
        });
        await new Promise((resolve, reject) => {
          receiver.udp.once("error", reject);
          receiver.udp.bind(receiver.port, "127.0.0.1", resolve);
        });
        receivers.push(receiver);
        endpoints.push({ api, url: `https://${host}:${receiver.port}/${api}`, port: receiver.port });
      }
      const childRoot = path.join(temporary, mode);
      fs.mkdirSync(childRoot);
      fs.writeFileSync(path.join(childRoot, "input.json"), JSON.stringify({ mode, endpoints, fingerprint }));
      const env = { ...process.env, CLIPDOCK_QUIC_SMOKE_ROOT: temporary, CLIPDOCK_QUIC_SMOKE_MODE: mode };
      delete env.ELECTRON_RUN_AS_NODE;
      const processChild = spawn(electron, [script], {
        cwd: repository,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostics = "";
      for (const stream of [processChild.stdout, processChild.stderr])
        stream.on("data", (chunk) => {
          diagnostics = (diagnostics + chunk.toString()).slice(-1800);
        });
      const watchdog = setTimeout(() => processChild.kill(), 30000);
      const childExit = await new Promise((resolve) => {
        processChild.once("error", () => resolve(1));
        processChild.once("exit", (code) => resolve(code ?? 1));
      });
      clearTimeout(watchdog);
      await delay(150);
      const reportPath = path.join(childRoot, "result.json");
      const run = fs.existsSync(reportPath)
        ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
        : { mode, error: "CHILD_REPORT_MISSING", diagnosticTail: diagnostics };
      run.exitCode = childExit;
      run.receivers = receivers
        .filter((value) => value.mode === mode)
        .map(({ sockets, tcp, udp, quicVersions, ...value }) => ({
          ...value,
          quicVersions: [...quicVersions],
        }));
      result.runs.push(run);
    }
    const positive = result.runs.find((value) => value.mode === "positive"),
      constrained = result.runs.find((value) => value.mode === "constrained");
    const check = (name, value) => result.checks.push({ name, passed: !!value });
    check(
      "both isolated children completed",
      result.runs.every((run) => run.exitCode === 0),
    );
    check(
      "positive control retains forced QUIC without production disable",
      positive?.switches?.enableQuic &&
        positive?.switches?.forceExactOrigins &&
        !positive?.transport?.disableQuicSwitchPresent,
    );
    check(
      "production startup module ran before ready with forced QUIC flags still present",
      constrained?.configuredWhenReady === false &&
        constrained?.transport?.configuredBeforeReady &&
        constrained?.transport?.disableQuicSwitchPresent &&
        constrained?.switches?.enableQuic &&
        constrained?.switches?.forceExactOrigins,
    );
    for (const api of apis) {
      const p = positive?.receivers?.find((row) => row.api === api),
        c = constrained?.receivers?.find((row) => row.api === api);
      const request = constrained?.requests?.find((row) => row.api === api);
      check(api + " has real positive QUIC Initial UDP reception", p?.quicInitialDatagrams > 0);
      check(
        api + " is successful TCP with zero UDP after production disable",
        c?.tcpRequests === 1 && c?.udpDatagrams === 0 && request?.ok === true,
      );
    }
    check(
      "all HTTP requests are credential-free exact local fixture GETs",
      receivers.every((value) => value.credentialHeaders === 0 && value.unexpectedHttpRequests === 0),
    );
    check(
      "all UDP packets received are loopback",
      receivers.every((value) => value.nonLoopbackDatagrams === 0),
    );
    check(
      "no global certificate bypass flags",
      result.runs.every((value) => value.globalCertificateBypass === false),
    );
    check(
      "module source unchanged during experiment",
      result.sourceHashes["src/main/network/chromium-transport.ts"] ===
        hash(fs.readFileSync(path.join(repository, "src/main/network/chromium-transport.ts"))),
    );
    result.qualification.quicConstraintValidated = result.checks.every((check) => check.passed);
    exitCode = result.qualification.quicConstraintValidated ? 0 : 1;
  } catch (error) {
    result.error = String(error.message);
  } finally {
    for (const receiver of receivers) {
      for (const socket of receiver.sockets) socket.destroy();
      await new Promise((resolve) => receiver.tcp.close(resolve));
      await new Promise((resolve) => receiver.udp.close(resolve));
    }
    const target = path.resolve(temporary);
    assert(
      path.dirname(target) === path.resolve(os.tmpdir()) &&
        path.basename(target).startsWith("sv-quic-constraint-"),
      "UNSAFE_CLEANUP_TARGET",
    );
    try {
      fs.rmSync(target, { recursive: true, force: true });
      result.temporaryDataRemoved = true;
    } catch {
      result.temporaryDataRemoved = false;
      exitCode = 1;
    }
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(repository, "docs", stem + ".results.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        passed: result.checks.filter((item) => item.passed).length,
        total: result.checks.length,
        qualification: result.qualification,
        error: result.error,
      }),
    );
    process.exitCode = exitCode;
  }
}

async function child() {
  // Synchronous imports and configuration before the first await: Electron readiness cannot win this race.
  const { app, BrowserWindow, session, net } = require("electron");
  const temporary = process.env.CLIPDOCK_QUIC_SMOKE_ROOT,
    mode = process.env.CLIPDOCK_QUIC_SMOKE_MODE;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("sv-quic-constraint-") &&
      ["positive", "constrained"].includes(mode),
    "ISOLATED_CHILD_REQUIRED",
  );
  const childRoot = path.join(temporary, mode),
    input = JSON.parse(fs.readFileSync(path.join(childRoot, "input.json"), "utf8"));
  const production = require(path.join(temporary, "production.cjs"));
  app.setPath("userData", path.join(childRoot, "userData"));
  app.setPath("sessionData", path.join(childRoot, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", `MAP ${host} 127.0.0.1, MAP * ~NOTFOUND`);
  app.commandLine.appendSwitch("enable-quic");
  app.commandLine.appendSwitch(
    "origin-to-force-quic-on",
    input.endpoints.map((value) => `${host}:${value.port}`).join(","),
  );
  const configuredWhenReady = app.isReady();
  if (mode === "constrained") production.configureChromiumTransport(app);
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const result = {
    mode,
    executedAt: new Date().toISOString(),
    configuredWhenReady,
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      packaged: app.isPackaged,
    },
    transport: production.readChromiumTransportState(app),
    switches: {
      enableQuic: app.commandLine.hasSwitch("enable-quic"),
      forceExactOrigins:
        app.commandLine.getSwitchValue("origin-to-force-quic-on") ===
        input.endpoints.map((value) => `${host}:${value.port}`).join(","),
    },
    globalCertificateBypass:
      app.commandLine.hasSwitch("ignore-certificate-errors") ||
      app.commandLine.hasSwitch("ignore-certificate-errors-spki-list"),
    fixtureTrust: "private-session-exact-host-and-certificate-fingerprint-with-exact-url-request-filter",
    requests: [],
  };
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((_, callback) => callback({ cancel: true }));
    for (const endpoint of input.endpoints) {
      const ses = session.fromPartition("quic-fixture-" + crypto.randomUUID(), { cache: false });
      let window;
      const abort = new AbortController();
      await ses.setProxy({ mode: "direct" });
      await ses.closeAllConnections();
      ses.allowNTLMCredentialsForDomains("");
      ses.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: details.url !== endpoint.url && !details.url.startsWith("data:") }),
      );
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        for (const key of Object.keys(headers))
          if (/^(cookie|authorization|proxy-authorization)$/i.test(key)) delete headers[key];
        callback({ requestHeaders: headers });
      });
      ses.setCertificateVerifyProc((request, callback) => {
        let allowed = false;
        try {
          allowed =
            request.hostname === host &&
            new crypto.X509Certificate(request.certificate.data).fingerprint256 === input.fingerprint;
        } catch {}
        callback(allowed ? 0 : -2);
      });
      const record = { api: endpoint.api, ok: false, startedAtMono: performance.now() };
      let request;
      const timer = setTimeout(() => {
        abort.abort();
        request?.abort();
      }, 2500);
      try {
        let work;
        if (endpoint.api === "page-fetch") {
          window = new BrowserWindow({
            show: false,
            webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
          });
          await window.loadURL(
            "data:text/html,<meta charset=utf-8><link rel=icon href=data:,><title>Loopback fixture</title>",
          );
          work = window.webContents.executeJavaScript(
            `(async()=>{ const c = new AbortController(); const timer = setTimeout(()=>c.abort(), 2300); try { const r = await fetch(${JSON.stringify(endpoint.url)}, {credentials:'omit',cache:'no-store',redirect:'manual',signal:c.signal}); return {status:r.status,body:await r.text()}; } finally {clearTimeout(timer);} })()`,
          );
        } else if (endpoint.api === "session-fetch") {
          work = ses
            .fetch(endpoint.url, {
              credentials: "omit",
              cache: "no-store",
              redirect: "manual",
              signal: abort.signal,
            })
            .then(async (response) => ({ status: response.status, body: await response.text() }));
        } else {
          work = new Promise((resolve, reject) => {
            request = net.request({
              method: "GET",
              url: endpoint.url,
              session: ses,
              credentials: "omit",
              useSessionCookies: false,
              redirect: "manual",
            });
            request.setHeader("Cache-Control", "no-cache");
            request.on("login", (callback) => {
              callback();
              request.abort();
            });
            request.on("error", reject);
            request.on("abort", () => reject(Error("FIXTURE_REQUEST_ABORTED")));
            request.on("response", (response) => {
              let body = "";
              response.on("data", (bytes) => {
                body += bytes.toString();
                if (body.length > 1024) {
                  request.abort();
                  reject(Error("FIXTURE_BODY_LIMIT"));
                }
              });
              response.on("error", reject);
              response.on("end", () => resolve({ status: response.statusCode, body }));
            });
            request.end();
          });
        }
        const response = await bounded(work, 3200, "FIXTURE_DEADLINE");
        record.status = response.status;
        record.ok = response.status === 200 && response.body === "fixture-ok";
      } catch (error) {
        record.error = String(error.message).replaceAll(endpoint.url, "<loopback-fixture>").slice(0, 250);
      } finally {
        clearTimeout(timer);
        abort.abort();
        request?.abort();
        if (window && !window.isDestroyed()) window.destroy();
        await bounded(ses.closeAllConnections(), 3000, "FIXTURE_CONNECTION_CLEANUP");
        await ses.clearStorageData();
        record.completedAtMono = performance.now();
        result.requests.push(record);
      }
    }
  } catch (error) {
    result.error = String(error.message).slice(0, 250);
  } finally {
    fs.writeFileSync(path.join(childRoot, "result.json"), JSON.stringify(result));
    app.exit(result.error ? 1 : 0);
  }
}
