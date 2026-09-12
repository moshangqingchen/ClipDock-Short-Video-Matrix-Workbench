/**
 * Bounded anonymous egress sample; each of 2 sessions x 2 echo endpoints once.
 *   node scripts/electron-anonymous-egress-sample.mjs
 *
 * Raw public IPs and echo/geo bodies stay in memory. Geo lookup is deduplicated
 * by exact IP, including failed lookups. No retries, account cookies or NetLog.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const reportFile = path.join(root, "docs", "network-stage2-anonymous-egress.results.json");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mask = (ip) => isIP(ip) === 4 ? `${ip.split(".").slice(0, 2).join(".")}.*.*` : `${ip.split(":").slice(0, 2).join(":")}:…`;
const configs = async () => {
  const response = await fetch("http://127.0.0.1:9790/configs", { signal: AbortSignal.timeout(1800), redirect: "error" });
  if (!response.ok) throw new Error("CONTROLLER_UNAVAILABLE");
  const value = await response.json();
  return { mode: value.mode, tunEnabled: value.tun?.enable, mixedPort: value["mixed-port"] };
};

if (!process.versions.electron) {
  const { spawn } = await import("node:child_process");
  const { default: electron } = await import("electron");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-anonymous-egress-"));
  const environment = { ...process.env, SV_ANONYMOUS_EGRESS_ROOT: temporary };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [script], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
  const timeout = setTimeout(() => child.kill(), 85_000);
  const code = await new Promise((resolve) => { child.once("error", () => resolve(1)); child.once("exit", (value) => resolve(value ?? 1)); });
  clearTimeout(timeout);
  const childResult = path.join(temporary, "result.json");
  const exists = fs.existsSync(childResult);
  if (exists) {
    const value = JSON.parse(fs.readFileSync(childResult, "utf8"));
    fs.writeFileSync(reportFile, `${JSON.stringify(value, null, 2)}\n`);
    console.log(JSON.stringify({ output: reportFile, summary: value.summary, failure: value.failure ?? null }, null, 2));
  } else console.error("Isolated anonymous sample produced no result; no raw network output was captured.");
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("sv-anonymous-egress-")) throw new Error("Unsafe cleanup target");
  await wait(300);
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { console.error("Temporary anonymous profile remains locked."); }
  process.exitCode = exists ? code : 1;
} else {
  void run().catch(() => process.exit(1));
}

async function run() {
  const { app, session } = await import("electron");
  const temporary = process.env.SV_ANONYMOUS_EGRESS_ROOT;
  if (!temporary || !path.basename(temporary).startsWith("sv-anonymous-egress-")) throw new Error("Temporary profile required");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const result = {
    executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged },
    isolation: { temporaryUserData: true, temporarySessionData: true, productionAccountsOpened: false, cookiesCopied: false, anyCookieSet: false, credentials: "omit", fullIpPersisted: false, rawResponseBodyPersisted: false, netLogEnabled: false, certificateBypass: false, controllerReadOnly: true },
    samples: [],
    unverified: ["Mainland DirectProof for any platform", "Physical destination behind fake-IP", "Socket address family inside Chromium / proxy transport", "Native mainland IPv6 reachability or absence of IPv6 leakage", "Packaged build", "Future route changes / process rules / account traffic"],
  };
  const sessions = [];
  const geographies = new Map();
  let geoRequests = 0;
  let echoRequests = 0;
  const text = async (ses, url) => {
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), 8000);
    try {
      const response = await ses.fetch(url, { credentials: "omit", redirect: "error", cache: "no-store", signal: aborter.signal });
      if (!response.ok) throw new Error("ENDPOINT_HTTP_ERROR");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("EMPTY_BODY");
      const decoder = new TextDecoder();
      let body = "";
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 32768) { aborter.abort(); throw new Error("RESPONSE_TOO_LARGE"); }
          body += decoder.decode(chunk.value, { stream: true });
        }
        return { body: body + decoder.decode(), status: response.status };
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } finally { clearTimeout(timer); }
  };
  const lookup = async (ses, ip) => {
    if (geographies.has(ip)) return geographies.get(ip);
    const pending = (async () => {
      geoRequests += 1;
      try {
        const response = await text(ses, `https://ipwho.is/${encodeURIComponent(ip)}`);
        const value = JSON.parse(response.body);
        if (value.success !== true || value.ip !== ip || !/^[A-Z]{2}$/.test(value.country_code ?? "")) throw new Error("INVALID_GEOGRAPHY");
        return { verified: true, country: value.country_code, asn: Number.isInteger(value.connection?.asn) ? value.connection.asn : null, source: "ipwho.is; response IP equality checked in memory" };
      } catch { return { verified: false, country: null, asn: null, source: "ipwho.is unavailable or invalid; not retried" }; }
    })();
    geographies.set(ip, pending);
    return pending;
  };
  try {
    if (process.versions.electron !== "43.3.0") throw new Error("UNEXPECTED_ELECTRON_VERSION");
    const before = await configs();
    result.controllerBefore = before;
    if (before.mode !== "rule" || !before.tunEnabled || !Number.isInteger(before.mixedPort) || before.mixedPort < 1) throw new Error("RULE_TUN_PROXY_NOT_VERIFIED");
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    for (const kind of ["direct", "proxy"]) {
      const ses = session.fromPartition(`anonymous-egress-${kind}-${randomUUID()}`, { cache: false });
      sessions.push(ses);
      await ses.setProxy(kind === "direct" ? { mode: "direct" } : { mode: "fixed_servers", proxyRules: `http=127.0.0.1:${before.mixedPort};https=127.0.0.1:${before.mixedPort}`, proxyBypassRules: "<-loopback>" });
      await ses.closeAllConnections();
      ses.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const knownEcho = (url.hostname === "myip.ipip.net" && url.pathname === "/") || (url.hostname === "www.cloudflare.com" && url.pathname === "/cdn-cgi/trace");
        const geo = url.hostname === "ipwho.is" && isIP(decodeURIComponent(url.pathname.slice(1))) !== 0;
        callback({ cancel: url.protocol !== "https:" || Boolean(url.search) || !(knownEcho || geo) });
      });
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        for (const key of Object.keys(headers)) if (/^(cookie|authorization|proxy-authorization)$/i.test(key)) delete headers[key];
        callback({ requestHeaders: headers });
      });
      ses.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        for (const key of Object.keys(headers)) if (/^set-cookie$/i.test(key)) delete headers[key];
        callback({ responseHeaders: headers });
      });
      for (const endpoint of ["https://myip.ipip.net/", "https://www.cloudflare.com/cdn-cgi/trace"]) {
        echoRequests += 1;
        const sampledAt = new Date().toISOString();
        try {
          const response = await text(ses, endpoint);
          const cloudflare = endpoint.includes("cloudflare");
          const ip = cloudflare ? response.body.match(/^ip=(.+)$/m)?.[1]?.trim() : response.body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0];
          if (!ip || !isIP(ip)) throw new Error("ECHO_IP_UNAVAILABLE");
          const geography = await lookup(ses, ip);
          result.samples.push({ sessionMode: kind, endpoint, sampledAt, status: response.status, tls: "HTTPS response validated with normal Chromium certificate checks; no bypass", tlsVersionReportedByEndpoint: cloudflare ? response.body.match(/^tls=(.+)$/m)?.[1]?.trim() ?? null : null, maskedIp: mask(ip), observedEgressAddressFamily: isIP(ip) === 4 ? "IPv4" : "IPv6", chromiumSocketAddressFamily: "UNVERIFIED", country: geography.country, asn: geography.asn, geographyVerified: geography.verified, geographySource: geography.source, platformDirectProof: false });
        } catch {
          result.samples.push({ sessionMode: kind, endpoint, sampledAt, status: "UNAVAILABLE", tls: "UNVERIFIED", maskedIp: null, observedEgressAddressFamily: "UNVERIFIED", chromiumSocketAddressFamily: "UNVERIFIED", country: null, asn: null, geographyVerified: false, platformDirectProof: false });
        }
        await ses.clearStorageData({ storages: ["cookies"] });
      }
    }
  } catch (error) {
    // Fixed error codes only; never include a URL or response carrying a raw IP.
    result.failure = /^(UNEXPECTED_ELECTRON_VERSION|RULE_TUN_PROXY_NOT_VERIFIED|CONTROLLER_UNAVAILABLE)$/.test(error.message) ? error.message : "ANONYMOUS_SAMPLE_FAILED";
  } finally {
    for (const ses of sessions) await ses.closeAllConnections().catch(() => {});
    try { result.controllerAfter = await configs(); } catch { result.controllerAfter = { readable: false }; }
    result.summary = { echoRequests, geoRequests, uniqueIps: geographies.size, returnedSamples: result.samples.length, successfulEchoes: result.samples.filter((value) => value.status === 200).length, verifiedGeographies: result.samples.filter((value) => value.geographyVerified).length, ipv6EgressObserved: result.samples.some((value) => value.observedEgressAddressFamily === "IPv6"), nativeMainlandIpv6ReachabilityVerified: false, packagedVerified: false };
    geographies.clear();
    fs.writeFileSync(path.join(temporary, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    app.exit(result.failure ? 1 : 0);
  }
}
