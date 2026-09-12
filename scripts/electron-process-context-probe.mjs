/**
 * Anonymous, read-only process-context experiment for mihomo rule + TUN.
 *   node scripts/electron-process-context-probe.mjs
 *
 * A hidden Electron process uses temporary profiles and no account cookies.
 * Four paths request only https://myip.ipip.net/json. The controller is read-only.
 * Actual /connections metadata is matched against independently observed socket
 * source ports. No PID is used to infer a mihomo process identity.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const target = new URL("https://myip.ipip.net/json");
const output = path.join(repository, "docs", "network-stage2-process-context.results.json");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const control = async (endpoint) => {
  const response = await fetch(`http://127.0.0.1:9790/${endpoint}`, { signal: AbortSignal.timeout(1800), redirect: "error" });
  if (!response.ok) throw new Error(`controller HTTP_${response.status}`);
  return response.json();
};

if (!process.versions.electron) {
  const { default: electron } = await import("electron");
  const { spawn } = await import("node:child_process");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-context-probe-"));
  const environment = { ...process.env, SV_CONTEXT_PROBE_ROOT: temporary };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [script], { cwd: repository, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  child.stdout.on("data", (chunk) => { diagnostic += chunk; });
  child.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const timer = setTimeout(() => child.kill(), 90_000);
  const code = await new Promise((resolve) => { child.once("error", () => resolve(1)); child.once("exit", (value) => resolve(value ?? 1)); });
  clearTimeout(timer);
  const resultPath = path.join(temporary, "result.json");
  const exists = fs.existsSync(resultPath);
  if (exists) {
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, summary: result.summary, failure: result.failure ?? null }, null, 2));
  } else console.error("Process-context fixture failed:", diagnostic.slice(-2500));
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("sv-context-probe-")) throw new Error("Unsafe cleanup target");
  await delay(300);
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { console.error("Isolated fixture directory remains locked."); }
  process.exitCode = exists ? code : 1;
} else {
  // Do not await app.whenReady() at main-module top level (Electron ESM startup).
  void run().catch((error) => { console.error(error.message); process.exit(1); });
}

async function run() {
  const { app, BrowserWindow, session } = await import("electron");
  const temporary = process.env.SV_CONTEXT_PROBE_ROOT;
  if (!temporary || !path.basename(temporary).startsWith("sv-context-probe-")) throw new Error("Isolated profile required");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const result = {
    executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, packaged: app.isPackaged },
    isolation: { temporaryUserData: true, temporarySessionData: true, realAccountOpened: false, anyCookieSet: false, credentials: "omit; request Cookie/Authorization removed", allowedContentRequestEndpoint: `${target.origin}${target.pathname}`, controllerReadOnly: true },
    paths: [],
    limits: ["Public IP echo only; no creator/account endpoint", "No real account session or cookies", "No packaged-build process identity", "Node HTTPS means node:https inside the Electron main process", "Non-DIRECT node labels are replaced by stable SHA-256 prefixes; the proxy node list is never output", "Observed metadata is a diagnostic sample, not a future business route proof"],
  };
  const windows = [];
  let activeCleanup = async () => {};
  const hostMatches = (connection) => {
    const metadata = connection.metadata ?? {};
    return (metadata.host === target.hostname || metadata.sniffHost === target.hostname) && Number(metadata.destinationPort) === 443;
  };
  const safeChain = (chain) => chain.map((name) => name === "DIRECT" || name === "REJECT" ? name : `non-direct:${crypto.createHash("sha256").update(String(name)).digest("hex").slice(0, 10)}`);
  const portFromAddress = (value) => {
    if (typeof value !== "string") return null;
    const match = /:(\d+)$/.exec(value);
    return match ? Number(match[1]) : null;
  };
  const parseSocketEvidence = (file) => {
    if (!fs.existsSync(file)) return { sourcePorts: [], socketEvents: [], status: "NETLOG_UNAVAILABLE" };
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const types = Object.fromEntries(Object.entries(data.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]));
    const socketEvents = [];
    for (const event of data.events ?? []) {
      const name = types[event.type] ?? String(event.type);
      const params = event.params ?? {};
      const sourceAddress = params.source_address ?? params.local_address ?? params.localAddress;
      if (!sourceAddress || !/TCP_CONNECT|SOCKET/.test(name)) continue;
      const sourcePort = portFromAddress(sourceAddress);
      if (sourcePort) socketEvents.push({ event: name, sourceId: event.source?.id, sourcePort, remoteAddress: params.address ?? params.remote_address ?? null });
    }
    return { sourcePorts: [...new Set(socketEvents.map((entry) => entry.sourcePort))], socketEvents, status: socketEvents.length ? "SOCKET_SOURCE_PORT_OBSERVED" : "SOURCE_PORT_NOT_FOUND_IN_NETLOG" };
  };
  const phase = async (label, start) => {
    const before = await control("connections");
    const existingIds = new Set((before.connections ?? []).map((connection) => connection.id));
    const captured = new Map();
    const operation = await start();
    activeCleanup = operation.cleanup;
    const sampleStart = Date.now();
    let controllerReadFailures = 0;
    // Existing IDs, exact host, target port, and independent source ports are all
    // used. Unrelated connection metadata is never copied into the output.
    while (Date.now() - sampleStart < 3800) {
      try {
        const snapshot = await control("connections");
        for (const connection of snapshot.connections ?? []) {
          if (!existingIds.has(connection.id) && hostMatches(connection)) captured.set(connection.id, connection);
        }
      } catch { controllerReadFailures += 1; }
      await delay(120);
    }
    const socketEvidence = await operation.socketEvidence();
    const sourcePorts = new Set(socketEvidence.sourcePorts);
    const matched = [...captured.values()].filter((connection) => sourcePorts.has(Number(connection.metadata?.sourcePort)));
    const outcome = await operation.outcome();
    const entries = matched.map((connection) => {
      const metadata = connection.metadata;
      return {
        connectionId: connection.id,
        host: metadata.host || metadata.sniffHost,
        sourcePort: Number(metadata.sourcePort),
        destinationIP: metadata.destinationIP,
        destinationPort: Number(metadata.destinationPort),
        inboundType: metadata.type,
        network: metadata.network,
        process: metadata.process || null,
        processPath: metadata.processPath || null,
        chains: safeChain(connection.chains ?? []),
        routeClass: connection.chains?.[0] === "DIRECT" ? "DIRECT" : connection.chains?.length ? "NON_DIRECT" : "UNKNOWN",
        ruleType: connection.rule,
        startedAt: connection.start,
      };
    });
    result.paths.push({
      path: label,
      target: `${target.origin}${target.pathname}`,
      matchBasis: "new connection ID during probe + exact target host:443 + source port independently observed from Node socket or Chromium NetLog; not PID inference",
      status: !matched.length ? "UNVERIFIED_NO_SOCKET_MATCH" : entries.every((entry) => entry.process && entry.processPath) ? "CONNECTION_AND_PROCESS_CONTEXT_OBSERVED" : "CONNECTION_OBSERVED_PROCESS_CONTEXT_MISSING",
      candidateCount: captured.size,
      matchedConnectionCount: matched.length,
      controllerReadFailures,
      socketEvidence,
      unmatchedSocketSourcePortCount: socketEvidence.sourcePorts.filter((port) => !entries.some((entry) => entry.sourcePort === port)).length,
      observed: entries,
      outcome,
    });
    await operation.cleanup();
    activeCleanup = async () => {};
    await delay(200);
  };
  const chromiumOperation = async (label, usePage) => {
    const isolated = session.fromPartition(`context-${label}-${crypto.randomUUID()}`);
    await isolated.setProxy({ mode: "direct" });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: url.protocol !== "data:" && (url.origin !== target.origin || url.pathname !== target.pathname || url.search !== "") });
    });
    isolated.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (/^(cookie|authorization|proxy-authorization)$/i.test(key)) delete headers[key];
      callback({ requestHeaders: headers });
    });
    isolated.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) if (/^set-cookie$/i.test(key)) delete headers[key];
      callback({ responseHeaders: headers });
    });
    const logPath = path.join(temporary, `${label}.netlog.json`);
    await isolated.netLog.startLogging(logPath, { captureMode: "default" });
    const aborter = new AbortController();
    let window;
    let outcome = { completed: false };
    let promise;
    if (usePage) {
      window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      windows.push(window);
      await window.loadURL("data:text/html,<meta charset=utf-8><title>Anonymous context fixture</title>");
      promise = window.webContents.executeJavaScript(`fetch(${JSON.stringify(target.href)},{credentials:'omit',cache:'no-store',redirect:'error'}).then(async response=>({completed:true,status:response.status,responseBytes:(await response.arrayBuffer()).byteLength})).catch(()=>({completed:false,error:'fetch rejected (network or CORS); connection evidence is separate'}))`)
        .then((value) => { outcome = value; }).catch(() => { outcome = { completed: false, error: "renderer request rejected" }; });
    } else {
      promise = isolated.fetch(target.href, { credentials: "omit", cache: "no-store", redirect: "error", signal: aborter.signal })
        .then(async (response) => { outcome = { completed: true, status: response.status, responseBytes: (await response.arrayBuffer()).byteLength }; })
        .catch(() => { outcome = { completed: false, error: "session request rejected or timed out" }; });
    }
    return {
      socketEvidence: async () => { await isolated.netLog.stopLogging(); return parseSocketEvidence(logPath); },
      outcome: async () => outcome,
      cleanup: async () => { aborter.abort(); if (window && !window.isDestroyed()) window.destroy(); await isolated.closeAllConnections(); await Promise.race([promise, delay(500)]); },
    };
  };
  try {
    if (process.versions.electron !== "43.3.0") throw new Error("Electron version is not 43.3.0");
    const configs = await control("configs");
    result.controller = { address: "127.0.0.1:9790", mode: configs.mode, tunEnabled: configs.tun?.enable, findProcessMode: configs["find-process-mode"] };
    if (configs.mode !== "rule" || !configs.tun?.enable) throw new Error("Required rule + TUN environment not present; no anonymous external probes sent");
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    await phase("page-fetch / isolated account-shaped partition", () => chromiumOperation("page-fetch", true));
    await phase("session-fetch / isolated account-shaped partition", () => chromiumOperation("session-fetch", false));
    await phase("anonymous-diagnostic-session / separate Chromium session", () => chromiumOperation("diagnostic-session", false));
    await phase("node-https / Electron main process", async () => {
      const agent = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 10_000 });
      const evidence = { sourcePorts: [], socketEvents: [], status: "WAITING_FOR_SOCKET" };
      let outcome = { completed: false };
      const request = https.request(target, { method: "GET", agent, timeout: 6500, headers: { "user-agent": "ClipDock-Anonymous-Diagnostic/1", accept: "application/json" } }, (response) => {
        let size = 0;
        response.on("data", (chunk) => { size += chunk.length; });
        response.on("end", () => { outcome = { completed: true, status: response.statusCode, responseBytes: size }; });
      });
      request.on("socket", (socket) => socket.once("connect", () => {
        evidence.sourcePorts.push(socket.localPort);
        evidence.socketEvents.push({ event: "node socket connect", sourcePort: socket.localPort, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
        evidence.status = "SOCKET_SOURCE_PORT_OBSERVED";
      }));
      request.on("timeout", () => request.destroy());
      request.on("error", (error) => { outcome = { completed: false, error: error.code ?? "NETWORK_ERROR" }; });
      request.end();
      return { socketEvidence: async () => evidence, outcome: async () => outcome, cleanup: async () => { request.destroy(); agent.destroy(); } };
    });
  } catch (error) {
    result.failure = error.message;
  } finally {
    await activeCleanup().catch(() => {});
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    try {
      const configs = await control("configs");
      result.controllerAfter = { mode: configs.mode, tunEnabled: configs.tun?.enable, findProcessMode: configs["find-process-mode"] };
    } catch { result.controllerAfter = { readable: false }; }
    result.summary = {
      attemptedPaths: result.paths.length,
      sourcePortMatchedPaths: result.paths.filter((entry) => entry.matchedConnectionCount > 0).length,
      processContextObservedPaths: result.paths.filter((entry) => entry.status === "CONNECTION_AND_PROCESS_CONTEXT_OBSERVED").length,
      packagedIdentityVerified: false,
    };
    fs.writeFileSync(path.join(temporary, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    app.exit(result.failure ? 1 : 0);
  }
}
