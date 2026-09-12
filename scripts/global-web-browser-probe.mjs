/** Controlled loopback-only Chrome experiment. No real account, official API or system proxy mutation.
 * The injected proof is synthetic; this does NOT qualify the production mihomo route or website login.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dgram from "node:dgram";
import { X509Certificate, createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const assert = (value, code) => { if (!value) throw new Error(code); };
assert(process.platform === "win32" && fs.existsSync(browser), "BROWSER_UNAVAILABLE");
assert(process.argv.slice(2).every((arg) => arg === "--run-once") && process.argv.includes("--run-once"), "EXPLICIT_RUN_REQUIRED");
const runId = new Date().toISOString().replace(/[-:.]/g, "");
const base = path.join(root, "docs", ".compare");
fs.mkdirSync(base, { recursive: true });
const temporary = fs.mkdtempSync(path.join(base, "global-web-browser-"));
const bundle = path.join(temporary, "modules.mjs");
await build({ stdin: { contents: `export { GlobalWebRelay } from ${JSON.stringify(path.join(root, "src/main/network/global-web-relay.ts"))};
export { GlobalWebTunnelTransport } from ${JSON.stringify(path.join(root, "src/main/network/global-web-tunnel.ts"))};
export { claimGlobalBrowserProfile, configureGlobalBrowserProfile } from ${JSON.stringify(path.join(root, "src/main/browser/global-browser-profile.ts"))};`, resolveDir: root },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node24", external: ["node:*"],
  alias: { "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main") } });
const { GlobalWebRelay, GlobalWebTunnelTransport, claimGlobalBrowserProfile, configureGlobalBrowserProfile } = await import(pathToFileURL(bundle).href);
const profileIds = new Map();
const identity = {
  key: fs.readFileSync(path.join(root, "src/main/api/test-fixtures/youtube-upload-key.pem")),
  cert: fs.readFileSync(path.join(root, "src/main/api/test-fixtures/youtube-upload-cert.pem")),
};
const spki = createHash("sha256").update(new X509Certificate(identity.cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
const sockets = new Set(), cleanups = [], cases = [];
const own = (socket) => { sockets.add(socket); socket.on("error", () => undefined); socket.once("close", () => sockets.delete(socket)); };
const listen = async (server) => {
  server.on("connection", own);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return server.address().port;
};
const receipt = new Map();
let activeAbort, heldSocketClosed = false, afterRevokeRequests = 0, directRequests = 0, udpPackets = 0;
const udp = dgram.createSocket("udp4");
udp.on("message", () => udpPackets++);
await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
cleanups.push(() => new Promise((resolve) => udp.close(resolve)));
const target = https.createServer(identity, (request, response) => {
  const url = new URL(request.url, "https://www.googleapis.com");
  const label = url.searchParams.get("case") ?? "none";
  const entry = receipt.get(label);
  const synthetic = request.headers.cookie?.includes("clipdock_web_synthetic=") ?? false;
  if (entry) {
    entry.requests++;
    entry.browserVersion ??= /Chrome\/[\d.]+/.exec(request.headers["user-agent"] ?? "")?.[0] ?? null;
  }
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/boot" && entry) {
    entry.initialOwnCookie = request.headers.cookie?.includes(`clipdock_web_synthetic=${entry.owner}`) ?? false;
    entry.initialOtherCookie = synthetic && !entry.initialOwnCookie;
    if (url.searchParams.get("seed") === "yes")
      response.setHeader("Set-Cookie", `clipdock_web_synthetic=${entry.owner}; Secure; HttpOnly; Path=/; Max-Age=3600; SameSite=Lax`);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const mode = url.searchParams.get("mode") ?? "ordinary";
    response.end(`<!doctype html><html><body>Controlled browser fixture${mode === "webrtc" ? `<img src="/rtc-load?case=${label}">` : ""}<script>
      let rtcStage = 'receipt';
      (async () => {
        await fetch('/receipt?case=${label}', { credentials: 'include' });
        ${mode === "revoke" ? `try { await fetch('/hold?case=${label}', {credentials:'include'}); } catch {}
          try { await fetch('/after-revoke?case=${label}', {credentials:'include'}); } catch {}` : ""}
        ${mode === "webrtc" ? `rtcStage = 'media'; const media = await navigator.mediaDevices.getUserMedia({audio:true});
          rtcStage = 'connection';
          const pc = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});
          for (const track of media.getTracks()) pc.addTrack(track, media);
          pc.createDataChannel('synthetic'); rtcStage = 'offer'; await pc.setLocalDescription(await pc.createOffer());
          rtcStage = 'gathering';
          await fetch('/rtc-wait?case=${label}'); pc.close(); media.getTracks().forEach(track => track.stop());` : ""}
        document.body.dataset.complete = 'true';
      })().catch((error) => { document.body.dataset.error = 'true';
        document.body.dataset.stage = rtcStage;
        document.body.dataset.errorName = /^[A-Za-z]+Error$/.test(error?.name ?? '') ? error.name : 'unknown';
      });
    </script></body></html>`);
  } else if (url.pathname === "/receipt" && entry) {
    entry.receiptOwnCookie = request.headers.cookie?.includes(`clipdock_web_synthetic=${entry.owner}`) ?? false;
    response.end("local receipt");
  } else if (url.pathname === "/rtc-load" && entry) {
    // Keep the load event pending in real time while media/ICE worker tasks run.
    setTimeout(() => { response.writeHead(404); response.end(); }, 4000);
  } else if (url.pathname === "/rtc-wait" && entry) {
    // ICE uses real network time. A virtual browser timer would make a zero-packet
    // control inconclusive by closing the PeerConnection before gathering runs.
    setTimeout(() => response.end("wall clock elapsed"), 2000);
  } else if (url.pathname === "/hold" && entry) {
    entry.heldRequestHadCookie = synthetic;
    request.socket.once("close", () => { heldSocketClosed = true; });
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "1048576" });
    response.write(Buffer.alloc(1024));
    setImmediate(() => activeAbort.abort());
  } else if (url.pathname === "/after-revoke") {
    afterRevokeRequests++;
    response.end("unexpected");
  } else { response.writeHead(404); response.end(); }
});
const result = { runId, startedAt: new Date().toISOString(), browser: "installed Google Chrome", controlledOnly: true,
  proofSource: "synthetic loopback fixture; production mihomo not qualified", systemProxyChanged: false,
  realAccountUsed: false, productionWebsiteReady: false, profileIsolation: {}, cases, scopeLimits: ["Headless controlled pages only", "No real Google/TikTok/X login",
    "No physical zero-packet guarantee", "QUIC, DNS, service workers and interactive browser lifecycle not yet fully measured"] };

async function runChrome({ name, profile, url, endpoint, rtcPolicy = true }) {
  if (!profileIds.has(profile)) profileIds.set(profile, randomUUID());
  const owned = await claimGlobalBrowserProfile({ dataDirectory: temporary, accountId: profileIds.get(profile), platformId: "youtube" });
  if (rtcPolicy) await configureGlobalBrowserProfile(owned);
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions",
    "--disable-quic", `--user-data-dir=${owned.directory}`,
    `--proxy-server=http://${endpoint.host}:${endpoint.port}`, "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    // Test-only pin for the synthetic TLS receiver. Never part of production launch arguments.
    `--ignore-certificate-errors-spki-list=${spki}`,
    ...(name.startsWith("webrtc-") ? ["--allow-loopback-in-peer-connection", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      `--ip-address-space-overrides=127.0.0.1:${udp.address().port}=public`] : []),
    "--dump-dom", "--timeout=8000", ...(name.startsWith("webrtc-") ? [] : ["--virtual-time-budget=2000"]), url];
  const started = Date.now();
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(browser, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderrBytes = 0, timedOut = false;
    child.stdout.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Only the child this probe just started, including its own temporary-profile descendants.
      if (child.pid && child.exitCode === null)
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stderrBytes, completedDom: stdout.includes('data-complete="true"'),
        errorStage: /data-stage="([a-z]+)"/.exec(stdout)?.[1] ?? null,
        errorName: /data-error-name="([A-Za-z]+)"/.exec(stdout)?.[1] ?? null,
        proxyErrorPage: stdout.includes("ERR_PROXY_CONNECTION_FAILED") });
    });
  });
  const item = { name, ...outcome, durationMs: Date.now() - started };
  cases.push(item);
  await owned.release();
  assert(!outcome.timedOut, "BROWSER_TIMEOUT");
  return item;
}

try {
  const targetPort = await listen(target);
  const proxy = http.createServer();
  proxy.on("connect", (request, client, head) => {
    if (request.url !== "www.googleapis.com:443" || head.length) { client.destroy(); return; }
    const upstream = net.connect({ host: "127.0.0.1", port: targetPort });
    own(upstream);
    client.once("end", () => client.end());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream).pipe(client);
    });
  });
  const proxyPort = await listen(proxy);
  const transport = new GlobalWebTunnelTransport({ proxy: { host: "127.0.0.1", port: proxyPort },
    allowTarget: (platform, host) => platform === "youtube" && host === "www.googleapis.com",
    authorize: async (_context, signal) => ({ signal, generation: 1, expiresAtMono: performance.now() + 5_000,
      isCurrent: () => !signal.aborted, release() {} }), whenAuthorizerIdle: async () => undefined });
  cleanups.push(() => transport.dispose());
  activeAbort = new AbortController();
  const relay = new GlobalWebRelay({ platformId: "youtube", signal: activeAbort.signal,
    assertCurrent: () => assert(!activeAbort.signal.aborted, "CONTROLLED_REVOKED"),
    allowTarget: (_platform, host) => host === "www.googleapis.com", openTunnel: (input) => transport.open(input) });
  cleanups.push(() => relay.dispose());
  const endpoint = await relay.start();
  for (const [name, profile, owner, seed, mode, rtcPolicy] of [
    ["profile-a-first", "profile-a", "A", true, "ordinary", true],
    ["profile-b-first", "profile-b", "B", true, "ordinary", true],
    ["profile-a-reopen", "profile-a", "A", false, "ordinary", true],
    ["webrtc-control", "profile-rtc-control", "RTC", true, "webrtc", false],
    ["webrtc-restricted", "profile-rtc-restricted", "RTC", true, "webrtc", true],
    ["inflight-revoke", "profile-a", "A", false, "revoke", true],
  ]) {
    const entry = { owner, requests: 0, initialOwnCookie: false, initialOtherCookie: false, receiptOwnCookie: false };
    receipt.set(name, entry);
    const beforeUdp = udpPackets;
    const item = await runChrome({ name, profile, endpoint, rtcPolicy,
      url: `https://www.googleapis.com/boot?case=${name}&seed=${seed ? "yes" : "no"}&mode=${mode}` });
    item.observation = { ...entry, udpPackets: udpPackets - beforeUdp };
    delete item.observation.owner;
    assert(entry.requests >= 2 && entry.receiptOwnCookie, "LOCAL_BROWSER_RECEIPT_MISSING");
    assert(!entry.initialOtherCookie, "PROFILE_COOKIE_CROSSOVER");
  }
  result.profileIsolation = { firstProfileInitiallyEmpty: !receipt.get("profile-a-first").initialOwnCookie,
    secondProfileInitiallyEmpty: !receipt.get("profile-b-first").initialOwnCookie,
    firstProfilePersistedOnReopen: receipt.get("profile-a-reopen").initialOwnCookie };
  assert(Object.values(result.profileIsolation).every(Boolean), "PROFILE_ISOLATION_FAILED");
  await relay.dispose();
  await transport.whenIdle();
  result.inflightRevocation = { heldRequestHadSyntheticCookie: receipt.get("inflight-revoke").heldRequestHadCookie ?? false,
    receiverObservedClose: heldSocketClosed, subsequentReceiverRequests: afterRevokeRequests };
  assert(heldSocketClosed && afterRevokeRequests === 0, "REVOCATION_FAILED");
  const direct = http.createServer((_request, response) => { directRequests++; response.end("direct receiver"); });
  const directPort = await listen(direct);
  const fallback = await runChrome({ name: "closed-proxy-loopback-no-fallback", profile: "profile-closed-proxy", endpoint,
    url: `http://127.0.0.1:${directPort}/must-not-arrive` });
  result.closedProxy = { proxyErrorPage: fallback.proxyErrorPage, directReceiverRequests: directRequests };
  assert(directRequests === 0 && fallback.proxyErrorPage, "PROXY_FALLBACK_FAILED");
  const control = cases.find((item) => item.name === "webrtc-control").observation.udpPackets;
  const restricted = cases.find((item) => item.name === "webrtc-restricted").observation.udpPackets;
  result.webrtc = { controlPackets: control, restrictedPackets: restricted,
    conclusion: control > 0 && restricted === 0 ? "controlled STUN suppression observed" : "not qualified; further controlled measurement required" };
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message ?? "") ? error.message : "CONTROLLED_PROBE_FAILED";
  process.exitCode = 1;
} finally {
  activeAbort?.abort();
  for (const socket of sockets) socket.destroy();
  for (const close of cleanups.reverse()) await close();
  result.completedAt = new Date().toISOString();
  result.temporaryProfiles = path.relative(root, temporary).replaceAll("\\", "/");
  const output = path.join(base, `global-web-browser-${runId}.results.json`);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: result.passed, error: result.error, result: output }) + "\n");
}
