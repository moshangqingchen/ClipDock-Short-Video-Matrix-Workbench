/** One isolated loopback TLS request; retain a synthetic, replayable NetLog projection. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), "..");
const host = "clipdock-netlog-local.test";
const reportPath = path.join(root, "docs/network-netlog-socket-local.results.json");
const fixturePath = path.join(root, "docs/network-netlog-socket-local.fixture.json");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const assert = (condition, code) => { if (!condition) throw Error(code); };
const safe = error => /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : "LOCAL_FIXTURE_ERROR";
let lastResort = () => {};
async function bounded(work, ms = 10000) { let timer; try { return await Promise.race([work,
  new Promise((_, reject) => { timer = setTimeout(() => reject(Error("FIXTURE_TIMEOUT")), ms); })]); } finally { clearTimeout(timer); } }
if (!process.versions.electron) await parent(); else void child().catch(error => { lastResort(error); process.exit(1); });
async function parent() {
  assert(!fs.existsSync(reportPath) && !fs.existsSync(fixturePath), "EXISTING_LOCAL_RESULT");
  const temporaryParent = path.join(root, "docs/.compare"), temporary = fs.mkdtempSync(path.join(temporaryParent, "netlog-local-"));
  let result;
  try {
    const candidates = ["openssl"], git = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
    for (const value of (git.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)) candidates.push(path.join(path.dirname(path.dirname(value)), "usr/bin/openssl.exe"));
    const openssl = candidates.find(exe => spawnSync(exe, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0);
    assert(openssl, "OPENSSL_REQUIRED");
    assert(spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(temporary, "key.pem"),
      "-out", path.join(temporary, "cert.pem"), "-days", "1", "-subj", "/CN=" + host, "-addext", "subjectAltName=DNS:" + host],
      { windowsHide: true, stdio: "ignore" }).status === 0, "CERTIFICATE_GENERATION_FAILED");
    const { build } = await import("esbuild"), { default: electron } = await import("electron");
    const built = await build({ stdin: { contents: [
      "export {AnonymousProofProbe,ANONYMOUS_TLS_FACTORY_ID} from './src/main/network/anonymous-proof-probe.ts';",
      "export {configureChromiumTransport,readChromiumTransportState} from './src/main/network/chromium-transport.ts';",
      "export {parseAnonymousRequestSocket} from './src/main/network/anonymous-request-socket.ts';",
    ].join("\n"), loader: "ts", resolveDir: root }, bundle: true, platform: "node", format: "esm", external: ["electron", "node:*"],
      tsconfig: path.join(root, "tsconfig.electron.json"), outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const hashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter(file => file.startsWith("src/")).map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    if (process.argv.includes("--build-only")) { console.log(JSON.stringify({ buildOnly: true, sourceFiles: Object.keys(hashes), localRequests: 0 })); return; }
    const env = { ...process.env, CLIPDOCK_NETLOG_LOCAL_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], { cwd: root, env, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => worker.kill(), 25000);
    const code = await new Promise(resolve => { worker.once("error", () => resolve(1)); worker.once("exit", value => resolve(value ?? 1)); }); clearTimeout(timer);
    result = fs.existsSync(path.join(temporary, "result.json")) ? JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8")) : { failure: "CHILD_RESULT_MISSING" };
    result.childExitCode = code; result.sourceHashes = hashes; result.sourceHashesStable = Object.entries(hashes).every(([file, hash]) => sha(fs.readFileSync(path.join(root, file))) === hash);
    result.scriptHash = sha(fs.readFileSync(script));
    if (fs.existsSync(path.join(temporary, "fixture.json"))) { fs.copyFileSync(path.join(temporary, "fixture.json"), fixturePath); result.fixtureHash = sha(fs.readFileSync(fixturePath)); }
  } finally {
    const exact = path.resolve(temporary); assert(path.dirname(exact) === path.resolve(temporaryParent) && path.basename(exact).startsWith("netlog-local-") &&
      fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(), "UNSAFE_TEMPORARY_PATH");
    await new Promise(resolve => setTimeout(resolve, 250));
    try { fs.rmSync(exact, { recursive: true, force: true }); } catch { /* One exact attempt only. */ }
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (result) { fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.failure || result.childExitCode ? 1 : 0; }
}
async function child() {
  const { app, session, net } = await import("electron"), temporary = process.env.CLIPDOCK_NETLOG_LOCAL_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") && path.basename(temporary).startsWith("netlog-local-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData")); app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("host-resolver-rules", "MAP " + host + " 127.0.0.1");
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update"); app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href); production.configureChromiumTransport(app);
  const result = { executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome,
    transport: production.readChromiumTransportState(app) }, isolation: { onlyLoopback: true, syntheticCertificate: true, globalTlsIgnore: false,
    accounts: false, credentials: false, controllerRequests: 0, osConfigurationChanged: false, netLog: "isolated-child-only" },
    counts: { localRequests: 0, nativeRequests: 0, unexpectedRequests: 0, cookieOrAuthHeaders: 0 }, checks: [], qualificationGranted: false };
  const checkpoint = phase => { result.phase = phase; fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); };
  const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); assert(value, name); };
  lastResort = error => { result.failure = safe(error); checkpoint("top-level-failure"); };
  for (const event of ["uncaughtException", "unhandledRejection"]) process.on(event, error => { result.failure = safe(error); result.fatalEvent = event; checkpoint("fatal"); app.exit(1); });
  let server, probe, creating = false, selectedSession, logging = false, originalFetch;
  const logFile = path.join(temporary, "original.netlog.json");
  const deadline = new AbortController(); checkpoint("startup");
  try {
    await app.whenReady(); session.defaultSession.webRequest.onBeforeRequest((_details, callback) => { result.counts.unexpectedRequests++; callback({ cancel: true }); });
    const cert = fs.readFileSync(path.join(temporary, "cert.pem")), fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    server = https.createServer({ cert, key: fs.readFileSync(path.join(temporary, "key.pem")) }, (request, response) => {
      result.counts.localRequests++; result.counts.cookieOrAuthHeaders += Number(Boolean(request.headers.cookie || request.headers.authorization || request.headers["proxy-authorization"]));
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.method !== "GET" || request.url !== "/robots.txt") {
        result.counts.unexpectedRequests++; response.writeHead(400); response.end(); return;
      }
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }); response.end("User-agent: *\nDisallow: /\n");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port, url = `https://${host}:${port}/robots.txt`; result.origin = { host, port };
    const { default: http } = await import("node:http"), { syncBuiltinESMExports } = await import("node:module");
    const deny = () => { result.counts.unexpectedRequests++; throw Error("EXTERNAL_REQUEST_FORBIDDEN"); };
    http.request = http.get = https.request = https.get = deny; globalThis.fetch = deny; net.fetch = deny; syncBuiltinESMExports();
    const rawRequest = net.request;
    net.request = options => { assert(options?.session === selectedSession && options?.url === url && options.method === "GET" && options.credentials === "omit" &&
      options.redirect === "manual" && result.counts.nativeRequests === 0, "EXACT_LOCAL_FACTORY_REQUIRED"); result.counts.nativeRequests++; return rawRequest.call(net, options); };
    app.on("session-created", created => { if (!creating) return; selectedSession = created; originalFetch = created.fetch;
      created.fetch = async (input, options) => {
        assert(input === url && options?.method === "GET" && options.credentials === "omit", "EXACT_LOCAL_FETCH_REQUIRED");
        created.setCertificateVerifyProc((request, callback) => { let match = false; try { match = request.hostname === host &&
          new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint; } catch { /* Reject. */ } callback(match ? 0 : -2); });
        return originalFetch.call(created, input, options);
      };
    });
    await session.defaultSession.netLog.startLogging(logFile, { captureMode: "default", maxFileSize: 6 * 1024 * 1024 }); logging = true;
    probe = new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 10000 }); creating = true;
    const pending = probe.probeTls({ host, port }, deadline.signal); creating = false; checkpoint("local-factory-started");
    result.factory = await bounded(pending, 12000);
    await session.defaultSession.netLog.stopLogging(); logging = false;
    check("ONE_LOCAL_ANONYMOUS_200", result.factory.available && result.factory.observation.statusCode === 200 && result.counts.localRequests === 1 && result.counts.nativeRequests === 1 &&
      result.counts.cookieOrAuthHeaders === 0 && result.counts.unexpectedRequests === 0);
    const text = fs.readFileSync(logFile, "utf8"), log = JSON.parse(text);
    result.originalParser = production.parseAnonymousRequestSocket(text, { host, port });
    const eventNames = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
    const sourceNames = Object.fromEntries(Object.entries(log.constants.logSourceType ?? {}).map(([name, id]) => [id, name]));
    const shared = /HOST_RESOLVER|DNS_|PROXY_|CERT_VERIFIER/;
    const roots = new Set(log.events.filter(row => row.params?.url === url && /URL_REQUEST/.test(eventNames[row.type])).map(row => row.source.id));
    const edges = new Map(); const link = (a, b) => { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); };
    for (const row of log.events) { if (shared.test(eventNames[row.type])) continue; const dep = row.params?.source_dependency?.id;
      if (Number.isInteger(dep)) { link(row.source.id, dep); link(dep, row.source.id); } }
    const reached = new Set(roots), queue = [...roots]; for (let index = 0; index < queue.length; index++) for (const next of edges.get(queue[index]) ?? [])
      if (!reached.has(next)) { reached.add(next); queue.push(next); }
    const related = log.events.filter(row => reached.has(row.source.id));
    result.sourceEvents = [...reached].map(id => ({ id, sourceType: sourceNames[related.find(row => row.source.id === id)?.source.type] ?? null,
      sourceTypeId: related.find(row => row.source.id === id)?.source.type,
      eventTypes: [...new Set(related.filter(row => row.source.id === id).map(row => eventNames[row.type]))],
      excludedByEventName: related.filter(row => row.source.id === id && shared.test(eventNames[row.type])).map(row => eventNames[row.type]) }));
    const keys = ["source_dependency", "address_list", "source_address", "local_address", "address", "remote_address"];
    const cropped = { constants: { logEventTypes: log.constants.logEventTypes, logSourceType: log.constants.logSourceType },
      events: related.map(row => { const params = {}; for (const key of keys) if (Object.hasOwn(row.params ?? {}, key)) params[key] = row.params[key];
        if (row.params?.url === url) params.url = url;
        return { source: { id: row.source.id, type: row.source.type }, type: row.type, phase: row.phase, time: row.time, params }; }) };
    // The only retained endpoint-bearing fields must contain fixture loopback addresses.
    const allEndpoints = cropped.events.flatMap(row => Object.entries(row.params).filter(([key]) => keys.includes(key) && key !== "source_dependency")
      .flatMap(([, value]) => Array.isArray(value) ? value : [value]));
    check("REPLAY_ENDPOINTS_ARE_SYNTHETIC_LOOPBACK", allEndpoints.every(value => typeof value === "string" && /^(127\.0\.0\.1:\d+|\[::1\]:\d+)$/.test(value)));
    const fixtureText = JSON.stringify(cropped, null, 2) + "\n"; result.croppedParser = production.parseAnonymousRequestSocket(fixtureText, { host, port });
    check("CROPPED_REPLAY_PRESERVES_PARSER_RESULT", JSON.stringify(result.originalParser) === JSON.stringify(result.croppedParser));
    fs.writeFileSync(path.join(temporary, "fixture.json"), fixtureText);
    result.reproduction = { rootIds: [...roots], relatedEventCount: related.length, sourceCount: reached.size, fixtureRetained: true,
      headersCertificatesAndBytesRemoved: true, originalLogRetained: false };
    checkpoint("local-analysis-completed");
  } catch (error) { result.failure = safe(error); checkpoint("failed"); }
  finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => deadline.abort()), Promise.resolve().then(() => bounded(probe?.dispose() ?? Promise.resolve(), 4000)),
      Promise.resolve().then(() => logging ? bounded(session.defaultSession.netLog.stopLogging(), 3000) : undefined),
      Promise.resolve().then(() => { if (selectedSession && originalFetch) selectedSession.fetch = originalFetch; }),
      Promise.resolve().then(() => server ? new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) : undefined),
    ]);
    result.cleanup = cleanup.map(value => value.status); result.completedAt = new Date().toISOString(); checkpoint("completed"); app.exit(result.failure ? 1 : 0);
  }
}
