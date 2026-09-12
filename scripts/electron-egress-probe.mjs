/**
 * Local-only Electron network-hook experiment. No real account data is opened.
 *
 *   node scripts/electron-egress-probe.mjs [--inspect-clash]
 *
 * A hidden Electron child uses temporary userData/sessionData, a new partition,
 * and a synthetic Cookie scoped to 127.0.0.1. Every non-loopback request is denied.
 * Results are written to docs/network-stage2-experiments.results.json.
 * This verifies request cancellation, not a real-world mainland egress route.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(scriptPath), "..");
const outputPath = path.join(repository, "docs", "network-stage2-experiments.results.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = async (promise, ms = 7000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("experiment timeout")), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

if (!process.versions.electron) {
  const { spawn } = await import("node:child_process");
  const { default: electronPath } = await import("electron");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-egress-probe-"));
  const environment = { ...process.env, SV_EGRESS_PROBE_ROOT: temporaryRoot, SV_EGRESS_PROBE_PARENT: String(process.pid) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [scriptPath], {
    cwd: repository,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const watchdog = setTimeout(() => child.kill(), 110_000);
  const exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  clearTimeout(watchdog);
  const resultFile = path.join(temporaryRoot, "results.json");
  const hasResult = fs.existsSync(resultFile);
  if (hasResult) {
    const results = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (process.argv.includes("--inspect-clash")) {
      results.clashReadOnly = { address: "127.0.0.1:9790", routeAttribution: "UNVERIFIED: loopback fixtures do not prove external routing" };
      for (const endpoint of ["version", "configs", "rules"]) {
        try {
          const response = await fetch(`http://127.0.0.1:9790/${endpoint}`, { signal: AbortSignal.timeout(2000), redirect: "error" });
          if (!response.ok) throw new Error(`HTTP_${response.status}`);
          const data = await response.json();
          if (endpoint === "version") results.clashReadOnly.version = { version: data.version, meta: Boolean(data.meta) };
          if (endpoint === "configs") results.clashReadOnly.config = {
            mode: data.mode,
            tunEnabled: data.tun?.enable,
            tunStack: data.tun?.stack,
            autoRoute: data.tun?.["auto-route"],
            findProcessMode: data["find-process-mode"],
          };
          if (endpoint === "rules") results.clashReadOnly.rules = {
            count: Array.isArray(data.rules) ? data.rules.length : null,
            typeCounts: (data.rules ?? []).reduce((counts, rule) => {
              const type = String(rule.type ?? "unknown");
              counts[type] = (counts[type] ?? 0) + 1;
              return counts;
            }, {}),
          };
        } catch (error) {
          results.clashReadOnly[endpoint] = { readable: false, error: error.name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE_OR_UNAUTHORIZED" };
        }
      }
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify({ output: outputPath, runtime: results.runtime, summary: results.summary, failure: results.failure ?? null }, null, 2));
  } else {
    // Only this isolated fixture's output is captured; never output production logs.
    console.error("Electron probe did not produce results:", output.slice(-3000));
  }
  // Verify the resolved recursive cleanup target is our newly-created temp root.
  const resolvedRoot = path.resolve(temporaryRoot);
  const tempParent = path.resolve(os.tmpdir());
  if (path.dirname(resolvedRoot) !== tempParent || !path.basename(resolvedRoot).startsWith("sv-egress-probe-")) {
    throw new Error("Refusing to remove an unexpected temporary directory");
  }
  await sleep(400);
  try { fs.rmSync(resolvedRoot, { recursive: true, force: true }); } catch { console.error("Isolated temporary directory remains locked; no production directory was touched."); }
  process.exitCode = hasResult ? exitCode : exitCode || 1;
} else {
  // Electron waits for the main ESM evaluation before emitting ready. Do not
  // top-level-await the experiment, which itself waits for app.whenReady().
  void runElectronExperiments().catch((error) => {
    console.error("Local fixture startup failed:", error.message);
    process.exit(1);
  });
}

async function runElectronExperiments() {
  const { app, BrowserWindow, session, net } = await import("electron");
  const temporaryRoot = process.env.SV_EGRESS_PROBE_ROOT;
  if (!temporaryRoot || !path.basename(temporaryRoot).startsWith("sv-egress-probe-")) throw new Error("Temporary profile is required");
  app.setPath("userData", path.join(temporaryRoot, "userData"));
  app.setPath("sessionData", path.join(temporaryRoot, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("no-first-run");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => { /* persist observations before app.exit */ });
  const results = {
    executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, os: process.platform, arch: process.arch },
    isolation: { temporaryUserData: true, temporarySessionData: true, productionProfileOpened: false, cookie: "synthetic; loopback only", externalRequestsPermitted: false, windowVisible: false, protocol: "HTTP loopback; HTTPS not tested" },
    processIdentity: { nodeLauncherPid: Number(process.env.SV_EGRESS_PROBE_PARENT), electronMainPid: process.pid, routeAttribution: "UNVERIFIED; fixture identifies local process roles only" },
    tests: [],
    observations: [],
    serverRequests: [],
    hookEvents: [],
    deniedExternalRequests: 0,
    untested: ["HTTPS/TLS/SNI", "real-platform traffic", "real-world egress", "IPv6", "QUIC/HTTP3", "WebRTC", "real platform multipart upload", "service-worker background sync after app suspension", "TCP/TUN route changes between proof and request"],
  };
  const sockets = new Set();
  const windows = [];
  const streams = new Map();
  const uploads = new Map();
  const websocketStates = new Map();
  let server;
  let gate = "allow";
  let blockedPath = null;
  let origin;
  let partitionSession;
  const cleanError = (error) => String(error?.message ?? error).slice(0, 180);
  const hook = (details, callback) => {
    const url = new URL(details.url);
    if (url.hostname !== "127.0.0.1" || url.port !== new URL(origin).port) {
      results.deniedExternalRequests += 1;
      callback({ cancel: true });
      return;
    }
    const cancel = gate === "block" || url.pathname === blockedPath;
    results.hookEvents.push({ path: url.pathname, type: details.resourceType, method: details.method, cancel });
    callback({ cancel });
  };
  const requestCount = (route) => results.serverRequests.filter((request) => request.path === route).length;
  const requestRecord = (request) => {
    const route = new URL(request.url, origin).pathname;
    results.serverRequests.push({ path: route, method: request.method, syntheticCookieSeen: /(?:^|;\s*)egress_probe=synthetic_only(?:;|$)/.test(request.headers.cookie ?? "") });
    return route;
  };
  const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>Local network cancellation fixture</body></html>`;
  const evaluate = (window, expression) => deadline(window.webContents.executeJavaScript(expression));
  const assertCase = async (name, route, blocked, action) => {
    gate = blocked ? "block" : "allow";
    const before = requestCount(route);
    const hookBefore = results.hookEvents.length;
    let client;
    try { client = await deadline(action()); } catch (error) { client = { error: cleanError(error) }; }
    await sleep(80);
    const serverDelta = requestCount(route) - before;
    const matchingHooks = results.hookEvents.slice(hookBefore).filter((entry) => entry.path === route);
    const syntheticCookieSeen = results.serverRequests.slice().reverse().find((entry) => entry.path === route)?.syntheticCookieSeen ?? false;
    const passed = blocked ? serverDelta === 0 && matchingHooks.some((entry) => entry.cancel) : serverDelta > 0 && syntheticCookieSeen;
    results.tests.push({ name, blocked, route, passed, serverRequests: serverDelta, hookObserved: matchingHooks.length > 0, syntheticCookieSeen, client });
    gate = "allow";
  };
  try {
    if (process.versions.electron !== "43.3.0") throw new Error(`Expected Electron 43.3.0; got ${process.versions.electron}`);
    server = http.createServer((request, response) => {
      const route = requestRecord(request);
      response.setHeader("Cache-Control", "no-store");
      if (route === "/bootstrap" || route.startsWith("/iframe") || route.startsWith("/navigation")) {
        response.setHeader("Content-Type", "text/html");
        response.end(page);
      } else if (route === "/redirect/start") {
        response.writeHead(302, { Location: `${origin}/redirect/final` });
        response.end();
      } else if (route.startsWith("/image")) {
        response.setHeader("Content-Type", "image/svg+xml");
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
      } else if (route.startsWith("/script")) {
        response.setHeader("Content-Type", "application/javascript");
        response.end("window.fixtureScriptRan = true;");
      } else if (route.startsWith("/style")) {
        response.setHeader("Content-Type", "text/css");
        response.end("body { color: rgb(1, 2, 3); }");
      } else if (route === "/sw.js") {
        response.setHeader("Content-Type", "application/javascript");
        response.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if(event.data.command === 'background') {
    event.waitUntil(new Promise(resolve => {
      self.fixtureEnd = resolve;
      self.fixtureSocket = new WebSocket(event.data.ws);
      self.fixtureSocket.onopen = () => {
        self.fixtureTimer = setInterval(() => { if(self.fixtureSocket.readyState === 1) self.fixtureSocket.send('synthetic-worker-frame'); }, 40);
        event.source.postMessage({id:event.data.id, started:true});
      };
      self.fixtureSocket.onerror = () => event.source.postMessage({id:event.data.id, started:false});
      self.fixturePoller = setInterval(() => { fetch(event.data.tick,{credentials:'include',cache:'no-store'}).catch(()=>{}); },70);
      fetch(event.data.stream,{credentials:'include'}).then(async response => {
        self.fixtureReader = response.body.getReader();
        try { while(!(await self.fixtureReader.read()).done) {} } catch {}
      }).catch(()=>{});
    }));
    return;
  }
  event.waitUntil(fetch(event.data.url, { credentials: 'include', cache: 'no-store' })
    .then(response => response.text()).then(() => event.source.postMessage({ id: event.data.id, ok: true }))
    .catch(() => event.source.postMessage({ id: event.data.id, ok: false })));
});`);
      } else if (route.startsWith("/upload/")) {
        const state = { bodyBytesReceived: 0, closed: false, complete: false };
        uploads.set(route, state);
        request.on("data", chunk => {
          state.bodyBytesReceived += chunk.length;
          request.pause();
          setTimeout(() => { if (!request.destroyed) request.resume(); }, 60);
        });
        request.once("end", () => { state.complete = true; response.end("synthetic upload received"); });
        request.once("close", () => { state.closed = true; });
        request.on("error", () => {});
      } else if (route.startsWith("/stream/")) {
        const state = { chunksSent: 0, closed: false };
        streams.set(route, state);
        response.writeHead(200, { "Content-Type": "text/plain" });
        const tick = () => { state.chunksSent += 1; response.write("synthetic-stream-chunk\n"); };
        tick();
        const timer = setInterval(tick, 50);
        response.once("close", () => { state.closed = true; clearInterval(timer); });
      } else {
        response.setHeader("Content-Type", "text/plain");
        response.end("synthetic fixture response");
      }
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.on("upgrade", (request, socket) => {
      const route = requestRecord(request);
      const key = request.headers["sec-websocket-key"];
      const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      const state = { dataBytesReceived: 0, dataFramesReceived: 0, closeFramesReceived: 0, closed: false };
      websocketStates.set(route, state);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 2) {
          const opcode = pending[0] & 15;
          const masked = Boolean(pending[1] & 128);
          const length = pending[1] & 127;
          // This fixture sends only small frames; reject unexpected extended frames.
          if (length >= 126) { socket.destroy(); return; }
          const headerLength = masked ? 6 : 2;
          if (pending.length < headerLength + length) return;
          if (opcode === 1 || opcode === 2) { state.dataBytesReceived += length; state.dataFramesReceived += 1; }
          if (opcode === 8) { state.closeFramesReceived += 1; socket.end(Buffer.from([0x88, 0])); }
          pending = pending.subarray(headerLength + length);
        }
      });
      socket.once("close", () => { state.closed = true; });
      socket.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    await app.whenReady();
    // defaultSession is isolated too, and used only for the explicit net.fetch test.
    session.defaultSession.webRequest.onBeforeRequest(hook);
    partitionSession = session.fromPartition(`persist:egress-probe-${crypto.randomUUID()}`);
    partitionSession.webRequest.onBeforeRequest(hook);
    await partitionSession.setProxy({ mode: "direct" });
    await session.defaultSession.setProxy({ mode: "direct" });
    for (const current of [partitionSession, session.defaultSession]) {
      await current.cookies.set({ url: origin, name: "egress_probe", value: "synthetic_only", httpOnly: true, sameSite: "lax" });
    }
    const window = new BrowserWindow({ show: false, webPreferences: { session: partitionSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    windows.push(window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadURL(`${origin}/bootstrap`);
    results.processIdentity.rendererPid = window.webContents.getOSProcessId();
    results.processIdentity.electronUtilities = app.getAppMetrics().filter((entry) => entry.type === "Utility").map((entry) => ({ pid: entry.pid, serviceName: entry.serviceName ?? "unknown" }));

    for (const blocked of [false, true]) {
      const suffix = blocked ? "blocked" : "allowed";
      await assertCase(`session.fetch ${suffix}`, `/session-fetch/${suffix}`, blocked, async () => {
        const response = await partitionSession.fetch(`${origin}/session-fetch/${suffix}`, { credentials: "include" });
        return { status: response.status, bodyRead: Boolean(await response.text()) };
      });
      await assertCase(`net.fetch default isolated session ${suffix}`, `/net-fetch/${suffix}`, blocked, async () => {
        const response = await net.fetch(`${origin}/net-fetch/${suffix}`, { credentials: "include" });
        return { status: response.status, bodyRead: Boolean(await response.text()) };
      });
      await assertCase(`page fetch ${suffix}`, `/page-fetch/${suffix}`, blocked, () => evaluate(window, `fetch(${JSON.stringify(`${origin}/page-fetch/${suffix}`)}, {credentials:'include',cache:'no-store'}).then(r=>r.text()).then(()=>({ok:true})).catch(()=>({ok:false}))`));
      await assertCase(`page XHR ${suffix}`, `/xhr/${suffix}`, blocked, () => evaluate(window, `new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET',${JSON.stringify(`${origin}/xhr/${suffix}`)});xhr.withCredentials=true;xhr.onload=()=>resolve({ok:true,status:xhr.status});xhr.onerror=()=>resolve({ok:false});xhr.send();})`));
      for (const [kind, element, attribute] of [["iframe", "iframe", "src"], ["image", "img", "src"], ["script", "script", "src"], ["style", "link", "href"]]) {
        await assertCase(`${kind} ${suffix}`, `/${kind}/${suffix}`, blocked, () => evaluate(window, `new Promise(resolve=>{const el=document.createElement(${JSON.stringify(element)});el.rel='stylesheet';let done=false;const finish=result=>{if(done)return;done=true;el.remove();resolve(result)};el.onload=()=>finish({event:'load'});el.onerror=()=>finish({event:'error'});el[${JSON.stringify(attribute)}]=${JSON.stringify(`${origin}/${kind}/${suffix}`)};document.body.append(el);setTimeout(()=>finish({event:'timeout'}),900);})`));
      }
      await assertCase(`WebSocket handshake ${suffix}`, `/ws/${suffix}`, blocked, () => evaluate(window, `new Promise(resolve=>{const ws=new WebSocket(${JSON.stringify(`${origin.replace("http:", "ws:")}/ws/${suffix}`)});ws.onopen=()=>{ws.close();resolve({ok:true})};ws.onerror=()=>resolve({ok:false});setTimeout(()=>{ws.close();resolve({timeout:true})},900);})`));
    }
    await assertCase("session.fetch bypassCustomProtocolHandlers still blocked", "/session-fetch/bypass", true, async () => {
      const response = await partitionSession.fetch(`${origin}/session-fetch/bypass`, { credentials: "include", bypassCustomProtocolHandlers: true });
      return { status: response.status };
    });

    blockedPath = "/redirect/final";
    const redirectStart = requestCount("/redirect/start");
    const redirectFinal = requestCount("/redirect/final");
    let redirectError;
    try { await partitionSession.fetch(`${origin}/redirect/start`, { credentials: "include" }); } catch (error) { redirectError = cleanError(error); }
    results.tests.push({ name: "redirect destination rechecked and blocked", passed: requestCount("/redirect/start") - redirectStart === 1 && requestCount("/redirect/final") - redirectFinal === 0 && results.hookEvents.some((entry) => entry.path === "/redirect/final" && entry.cancel), sourceReceived: requestCount("/redirect/start") - redirectStart, targetReceived: requestCount("/redirect/final") - redirectFinal, client: { error: redirectError } });
    blockedPath = null;

    const navigationWindow = new BrowserWindow({ show: false, webPreferences: { session: partitionSession, sandbox: true, nodeIntegration: false } });
    windows.push(navigationWindow);
    await assertCase("top-level navigation blocked before server", "/navigation/blocked", true, () => navigationWindow.loadURL(`${origin}/navigation/blocked`));
    navigationWindow.destroy();

    try {
      await evaluate(window, "navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)");
      for (const blocked of [false, true]) {
        const suffix = blocked ? "blocked" : "allowed";
        await assertCase(`ServiceWorker fetch ${suffix}`, `/worker-fetch/${suffix}`, blocked, () => evaluate(window, `new Promise(async resolve=>{const id=${JSON.stringify(suffix)};const receive=event=>{if(event.data.id===id){navigator.serviceWorker.removeEventListener('message',receive);resolve(event.data)}};navigator.serviceWorker.addEventListener('message',receive);const registration=await navigator.serviceWorker.ready;registration.active.postMessage({id,url:${JSON.stringify(`${origin}/worker-fetch/${suffix}`)}});setTimeout(()=>{navigator.serviceWorker.removeEventListener('message',receive);resolve({timeout:true})},2500);})`));
      }
    } catch (error) {
      results.observations.push({ name: "ServiceWorker setup", supported: false, error: cleanError(error) });
      results.untested.push("ServiceWorker network requests (fixture setup failed)");
    }

    for (const useAbort of [false, true]) {
      gate = "allow";
      const route = useAbort ? "/stream/abort-controller" : "/stream/close-connections";
      const aborter = new AbortController();
      const response = await partitionSession.fetch(`${origin}${route}`, { credentials: "include", signal: aborter.signal });
      const reader = response.body.getReader();
      let chunksRead = 0;
      let readerStopped = false;
      const reading = (async () => {
        try { while (!(await reader.read()).done) chunksRead += 1; } catch { /* observed cancellation */ }
        readerStopped = true;
      })();
      await sleep(130);
      gate = "block";
      const beforeGate = chunksRead;
      await sleep(250);
      const afterGate = chunksRead;
      if (useAbort) aborter.abort();
      await deadline(partitionSession.closeAllConnections(), 3000);
      await sleep(350);
      const afterClose = chunksRead;
      results.observations.push({ name: useAbort ? "in-flight response: abort + closeAllConnections" : "in-flight response: gate change + closeAllConnections only", cookieAlreadySentBeforeGateClosed: true, chunksBeforeGate: beforeGate, chunksAfterGate: afterGate, gateAloneStoppedTransfer: afterGate === beforeGate, chunksAfterClose: afterClose, readerStopped, serverSocketClosed: streams.get(route)?.closed ?? null });
      aborter.abort();
      await deadline(reading, 1500).catch(() => {});
      gate = "allow";
    }

    const streamingWindow = new BrowserWindow({ show: false, webPreferences: { session: partitionSession, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    windows.push(streamingWindow);
    await streamingWindow.loadURL(`${origin}/bootstrap`);
    await evaluate(streamingWindow, `fetch(${JSON.stringify(`${origin}/stream/page-destroy`)},{credentials:'include'}).then(response=>{window.fixtureReader=response.body.getReader();window.fixtureReadChunks=0;window.fixtureReading=(async()=>{try{while(!(await window.fixtureReader.read()).done)window.fixtureReadChunks++}catch{}})();return true;})`);
    await sleep(130);
    gate = "block";
    const pageBeforeGate = streams.get("/stream/page-destroy")?.chunksSent;
    await sleep(200);
    await partitionSession.closeAllConnections();
    await sleep(200);
    const pageAfterClose = streams.get("/stream/page-destroy")?.chunksSent;
    streamingWindow.webContents.stop();
    await sleep(200);
    const pageAfterStop = streams.get("/stream/page-destroy")?.chunksSent;
    streamingWindow.destroy();
    await sleep(300);
    const pageAfterDestroy = streams.get("/stream/page-destroy")?.chunksSent;
    await sleep(200);
    results.observations.push({ name: "page in-flight response: closeAllConnections, stop, destroy", serverChunksBeforeGate: pageBeforeGate, serverChunksAfterClose: pageAfterClose, serverChunksAfterStop: pageAfterStop, serverChunksAfterDestroy: pageAfterDestroy, serverChunksAfterDestroySettled: streams.get("/stream/page-destroy")?.chunksSent, serverSocketClosedAfterDestroy: streams.get("/stream/page-destroy")?.closed });

    gate = "allow";
    const activeWsRoute = "/ws/active";
    await evaluate(window, `new Promise(resolve=>{window.fixtureSocket=new WebSocket(${JSON.stringify(`${origin.replace("http:", "ws:")}${activeWsRoute}`)});window.fixtureSocket.onopen=()=>{window.fixtureSocketTimer=setInterval(()=>{if(window.fixtureSocket.readyState===1)window.fixtureSocket.send('synthetic-frame')},40);resolve(true)};window.fixtureSocket.onerror=()=>resolve(false);})`);
    await sleep(130);
    gate = "block";
    const wsBeforeGate = websocketStates.get(activeWsRoute)?.dataBytesReceived ?? 0;
    await sleep(250);
    const wsAfterGate = websocketStates.get(activeWsRoute)?.dataBytesReceived ?? 0;
    await partitionSession.closeAllConnections();
    await sleep(350);
    const wsAfterClose = websocketStates.get(activeWsRoute)?.dataBytesReceived ?? 0;
    results.observations.push({ name: "established WebSocket: gate change + closeAllConnections", bytesBeforeGate: wsBeforeGate, bytesAfterGate: wsAfterGate, gateAloneStoppedFrames: wsAfterGate === wsBeforeGate, bytesAfterClose: wsAfterClose, closeAllConnectionsStoppedFrames: wsAfterClose === wsAfterGate, serverSocketClosed: websocketStates.get(activeWsRoute)?.closed ?? null });
    window.webContents.stop();
    await sleep(200);
    const wsAfterStop = websocketStates.get(activeWsRoute)?.dataBytesReceived ?? 0;
    window.destroy();
    await sleep(350);
    const wsAfterDestroy = websocketStates.get(activeWsRoute)?.dataBytesReceived ?? 0;
    await sleep(200);
    results.observations.push({ name: "established WebSocket: webContents.stop versus destroy", bytesAfterClose: wsAfterClose, bytesAfterStop: wsAfterStop, stopStoppedFrames: wsAfterStop === wsAfterClose, bytesAfterDestroy: wsAfterDestroy, bytesAfterDestroySettled: websocketStates.get(activeWsRoute)?.dataBytesReceived ?? 0, serverSocketClosedAfterDestroy: websocketStates.get(activeWsRoute)?.closed ?? null });

    const fixtureWindow = async () => {
      const value = new BrowserWindow({ show: false, webPreferences: { session: partitionSession, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
      windows.push(value);
      await value.loadURL(`${origin}/bootstrap`);
      return value;
    };
    const startWindowSocket = (value, route) => evaluate(value, `new Promise(resolve=>{window.fixtureSocket=new WebSocket(${JSON.stringify(`${origin.replace("http:", "ws:")}${route}`)});window.fixtureSocket.onopen=()=>{window.fixtureSocketTimer=setInterval(()=>{if(window.fixtureSocket.readyState===1)window.fixtureSocket.send('synthetic-frame')},40);resolve(true)};window.fixtureSocket.onerror=()=>resolve(false);})`);
    const startWindowUpload = async (value, route) => {
      // Server backpressure keeps a 16 MiB body demonstrably unfinished.
      // Emulator throughput did not pace loopback uploads reliably.
      await evaluate(value, `(()=>{window.fixtureUploadState='running';fetch(${JSON.stringify(`${origin}${route}`)},{method:'POST',credentials:'include',body:new Uint8Array(16777216).fill(65)}).then(()=>window.fixtureUploadState='done').catch(()=>window.fixtureUploadState='failed');return true})()`);
      for (let attempt = 0; attempt < 20 && !(uploads.get(route)?.bodyBytesReceived > 0); attempt += 1) await sleep(100);
      const state = uploads.get(route);
      return Boolean(state && state.bodyBytesReceived > 0 && state.bodyBytesReceived < 16777216 && !state.complete);
    };

    gate = "allow";
    const closeWindow = await fixtureWindow();
    const closeWs = "/ws/close-api";
    const closeUpload = "/upload/close-api";
    await startWindowSocket(closeWindow, closeWs);
    const closeUploadStarted = await startWindowUpload(closeWindow, closeUpload);
    const closeBefore = { wsBytes: websocketStates.get(closeWs)?.dataBytesReceived, uploadBytes: uploads.get(closeUpload)?.bodyBytesReceived ?? 0 };
    gate = "block";
    closeWindow.webContents.close({ waitForBeforeUnload: false });
    await sleep(350);
    const closeAfter = { wsBytes: websocketStates.get(closeWs)?.dataBytesReceived, uploadBytes: uploads.get(closeUpload)?.bodyBytesReceived ?? 0 };
    await sleep(250);
    results.observations.push({ name: "webContents.close(waitForBeforeUnload:false): renderer WebSocket and upload", uploadStarted: closeUploadStarted, before: closeBefore, after350ms: closeAfter, after600ms: { wsBytes: websocketStates.get(closeWs)?.dataBytesReceived, uploadBytes: uploads.get(closeUpload)?.bodyBytesReceived ?? 0 }, wsSocketClosed: websocketStates.get(closeWs)?.closed, uploadClosed: uploads.get(closeUpload)?.closed, windowDestroyed: closeWindow.isDestroyed() });
    partitionSession.disableNetworkEmulation();

    gate = "allow";
    const offlineWindow = await fixtureWindow();
    const offlineWs = "/ws/offline";
    const offlineUpload = "/upload/offline";
    await startWindowSocket(offlineWindow, offlineWs);
    await evaluate(offlineWindow, `fetch(${JSON.stringify(`${origin}/stream/page-offline`)},{credentials:'include'}).then(response=>{window.offlineReader=response.body.getReader();window.offlineChunks=0;window.offlineStopped=false;void(async()=>{try{while(!(await window.offlineReader.read()).done)window.offlineChunks++}catch{}window.offlineStopped=true})();return true})`);
    const offlineAborter = new AbortController();
    const offlineResponse = await partitionSession.fetch(`${origin}/stream/main-offline`, { credentials: "include", signal: offlineAborter.signal });
    const offlineReader = offlineResponse.body.getReader();
    let offlineMainChunks = 0;
    let offlineMainStopped = false;
    const offlineReading = (async () => { try { while (!(await offlineReader.read()).done) offlineMainChunks += 1; } catch {} offlineMainStopped = true; })();
    const offlineUploadStarted = await startWindowUpload(offlineWindow, offlineUpload);
    await sleep(150);
    const offlineBefore = { wsBytes: websocketStates.get(offlineWs)?.dataBytesReceived, uploadBytes: uploads.get(offlineUpload)?.bodyBytesReceived ?? 0, mainChunks: offlineMainChunks, pageChunks: await evaluate(offlineWindow, "window.offlineChunks") };
    gate = "block";
    partitionSession.enableNetworkEmulation({ offline: true });
    await partitionSession.closeAllConnections();
    await sleep(350);
    const offlineAfter = { wsBytes: websocketStates.get(offlineWs)?.dataBytesReceived, uploadBytes: uploads.get(offlineUpload)?.bodyBytesReceived ?? 0, mainChunks: offlineMainChunks, pageChunks: await evaluate(offlineWindow, "window.offlineChunks") };
    await sleep(250);
    results.observations.push({ name: "offline network emulation + closeAllConnections: existing renderer/main streams, WebSocket, upload", uploadStarted: offlineUploadStarted, before: offlineBefore, after350ms: offlineAfter, after600ms: { wsBytes: websocketStates.get(offlineWs)?.dataBytesReceived, uploadBytes: uploads.get(offlineUpload)?.bodyBytesReceived ?? 0, mainChunks: offlineMainChunks, pageChunks: await evaluate(offlineWindow, "window.offlineChunks") }, mainReaderStopped: offlineMainStopped, pageReaderStopped: await evaluate(offlineWindow, "window.offlineStopped"), mainSocketClosed: streams.get("/stream/main-offline")?.closed, pageSocketClosed: streams.get("/stream/page-offline")?.closed, wsSocketClosed: websocketStates.get(offlineWs)?.closed, uploadClosed: uploads.get(offlineUpload)?.closed });
    offlineAborter.abort();
    await deadline(offlineReading, 1000).catch(() => {});
    offlineWindow.webContents.close({ waitForBeforeUnload: false });
    partitionSession.disableNetworkEmulation();

    gate = "allow";
    const workerWindow = await fixtureWindow();
    await evaluate(workerWindow, "navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)");
    const workerWs = "/ws/worker-background";
    const workerStream = "/stream/worker-background";
    const workerTick = "/worker-background/tick";
    const workerStarted = await evaluate(workerWindow, `new Promise(async resolve=>{const id='background-start';const receive=event=>{if(event.data.id===id){navigator.serviceWorker.removeEventListener('message',receive);resolve(event.data)}};navigator.serviceWorker.addEventListener('message',receive);const registration=await navigator.serviceWorker.ready;registration.active.postMessage({id,command:'background',ws:${JSON.stringify(`${origin.replace("http:", "ws:")}${workerWs}`)},stream:${JSON.stringify(`${origin}${workerStream}`)},tick:${JSON.stringify(`${origin}${workerTick}`)}});setTimeout(()=>resolve({timeout:true}),2500)})`);
    await sleep(250);
    const workerBefore = { wsBytes: websocketStates.get(workerWs)?.dataBytesReceived, streamChunks: streams.get(workerStream)?.chunksSent, requests: requestCount(workerTick), runningWorkers: Object.keys(partitionSession.serviceWorkers.getAllRunning()).length };
    gate = "block";
    await deadline(partitionSession.clearStorageData({ storages: ["serviceworkers"] }), 4000);
    await partitionSession.closeAllConnections();
    await sleep(350);
    const workerAfter = { wsBytes: websocketStates.get(workerWs)?.dataBytesReceived, streamChunks: streams.get(workerStream)?.chunksSent, requests: requestCount(workerTick), runningWorkers: Object.keys(partitionSession.serviceWorkers.getAllRunning()).length };
    await sleep(250);
    results.observations.push({ name: "ServiceWorker background traffic: clear serviceworkers storage + closeAllConnections", started: workerStarted, publicStopMethodAvailable: false, before: workerBefore, after350ms: workerAfter, after600ms: { wsBytes: websocketStates.get(workerWs)?.dataBytesReceived, streamChunks: streams.get(workerStream)?.chunksSent, requests: requestCount(workerTick), runningWorkers: Object.keys(partitionSession.serviceWorkers.getAllRunning()).length }, wsSocketClosed: websocketStates.get(workerWs)?.closed, streamSocketClosed: streams.get(workerStream)?.closed, syntheticCookiePreserved: (await partitionSession.cookies.get({ name: "egress_probe", url: origin })).length === 1 });
    workerWindow.webContents.close({ waitForBeforeUnload: false });
    partitionSession.enableNetworkEmulation({ offline: true });
    await partitionSession.closeAllConnections();
    await sleep(350);
    const workerAfterOffline = { wsBytes: websocketStates.get(workerWs)?.dataBytesReceived, streamChunks: streams.get(workerStream)?.chunksSent, requests: requestCount(workerTick) };
    await sleep(250);
    results.observations.push({ name: "ServiceWorker after storage clear: close renderer + offline + closeAllConnections", after350ms: workerAfterOffline, after600ms: { wsBytes: websocketStates.get(workerWs)?.dataBytesReceived, streamChunks: streams.get(workerStream)?.chunksSent, requests: requestCount(workerTick) }, wsSocketClosed: websocketStates.get(workerWs)?.closed, streamSocketClosed: streams.get(workerStream)?.closed, runningWorkers: Object.keys(partitionSession.serviceWorkers.getAllRunning()).length });
    partitionSession.disableNetworkEmulation();
  } catch (error) {
    results.failure = cleanError(error);
  } finally {
    for (const window of windows) { if (!window.isDestroyed()) window.destroy(); }
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    results.summary = { passed: results.tests.filter((test) => test.passed).length, failed: results.tests.filter((test) => !test.passed).length, observations: results.observations.length, externalRequestsDenied: results.deniedExternalRequests };
    fs.writeFileSync(path.join(temporaryRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    app.exit(results.failure || results.summary.failed ? 1 : 0);
  }
}
