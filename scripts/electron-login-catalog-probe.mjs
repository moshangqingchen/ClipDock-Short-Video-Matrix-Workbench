/**
 * Stage-2 anonymous static login-shell inventory. No production app is started.
 * node scripts/electron-login-catalog-probe.mjs [--fixture-only] [--followup]
 *
 * One hidden 20-second page per platform; no interactions, screenshots, body or
 * URL logging. XHR/fetch, WebSocket, workers, writes and unregistered third-party
 * hosts are blocked. This deliberately cannot certify a complete login flow.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const followup = process.argv.includes("--followup");
const resultFile = path.join(repository, followup ? "docs/network-stage2-login-catalog-followup.results.json" : "docs/network-stage2-login-catalog.results.json");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeError = (error) => /\bERR_[A-Z_]+\b/.exec(String(error?.message ?? error))?.[0] ?? "REQUEST_FAILED";
const fixtureOnly = process.argv.includes("--fixture-only");
const reviewTargets = {
  douyin: ["lf3-short.ibytedapm.com", "unpkg.byted-static.com"],
  kuaishou: ["p1-plat.wsbkwai.com", "p1-plat.wskwai.com", "p2-plat.wsbkwai.com", "p2-plat.wskwai.com", "p23-plat.wsbkwai.com", "p23-plat.wskwai.com", "p3-plat.wsbkwai.com", "p3-plat.wskwai.com", "p4-plat.wsbkwai.com", "p5-plat.wsbkwai.com", "p5-plat.wskwai.com", "p66-plat.wsbkwai.com", "p66-plat.wskwai.com"],
};

async function controllerSnapshot() {
  const read = async (endpoint) => {
    const response = await fetch(`http://127.0.0.1:9790/${endpoint}`, {
      redirect: "error", signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) throw new Error("CONTROLLER_UNREADABLE");
    return response.json();
  };
  const [configs, rules, version] = await Promise.all([read("configs"), read("rules"), read("version")]);
  // Hash the actual running rules; never emit the rules or proxy node labels.
  return {
    mode: configs.mode, tunEnabled: configs.tun?.enable === true,
    kernelVersion: version.version ?? null, ruleCount: rules.rules?.length ?? 0,
    rulesHash: digest(rules.rules ?? []),
    contextHash: digest({ mode: configs.mode, tun: configs.tun, processMode: configs["find-process-mode"], dns: configs.dns, rules: rules.rules }),
  };
}

if (!process.versions.electron) {
  const { default: electron } = await import("electron");
  const { spawn } = await import("node:child_process");
  const { build } = await import("esbuild");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-login-catalog-"));
  // Read the authoritative registry through its real TS module, not copied hosts.
  await build({ entryPoints: [path.join(repository, "src/shared/platforms.ts")], outfile: path.join(temporary, "platforms.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  await build({ entryPoints: [path.join(repository, "src/main/browser/user-agent.ts")], outfile: path.join(temporary, "user-agent.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const env = { ...process.env, SV_LOGIN_CATALOG_ROOT: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [script, ...(fixtureOnly ? ["--fixture-only"] : []), ...(followup ? ["--followup"] : [])], { cwd: repository, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  // Electron diagnostics can contain complete URLs. Never forward or persist them.
  child.stdout.resume();
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 180_000);
  const code = await new Promise((resolve) => { child.once("error", () => resolve(1)); child.once("exit", (value) => resolve(value ?? 1)); });
  clearTimeout(timer);
  const isolatedResult = path.join(temporary, "result.json");
  const exists = fs.existsSync(isolatedResult);
  if (exists) {
    const result = JSON.parse(fs.readFileSync(isolatedResult, "utf8"));
    if (!fixtureOnly) fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output: fixtureOnly ? null : resultFile, isolationPassed: result.fixture?.passed, summary: result.summary, failure: result.failure ?? null }, null, 2));
  } else {
    const progressFile = path.join(temporary, "progress.json");
    console.error(JSON.stringify({ failure: "ISOLATED_CHILD_NO_RESULT", lastSafeCheckpoint: fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, "utf8")) : null }));
  }
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("sv-login-catalog-")) throw new Error("Unsafe cleanup target");
  await delay(300);
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { console.error("Isolated temporary profile remains locked."); }
  process.exitCode = exists ? code : 1;
} else {
  void run().catch(() => process.exit(1));
}

async function run() {
  const { app, BrowserWindow, session } = await import("electron");
  const temporary = process.env.SV_LOGIN_CATALOG_ROOT;
  if (!temporary || path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("sv-login-catalog-")) throw new Error("Isolated profile required");
  const { toChromeUserAgent } = await import(`file:///${path.join(temporary, "user-agent.mjs").replaceAll("\\", "/")}`);
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("disable-quic");
  app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  app.on("login", (event, _contents, _details, _authInfo, callback) => { event.preventDefault(); callback(); });
  const result = {
    executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, packaged: app.isPackaged },
    isolation: { temporaryUserData: true, temporarySessionData: true, productionAppOpened: false, realAccountOpened: false, interactions: 0, responseBodyRecorded: false, fullUrlRecorded: false, screenshots: false, controllerReadOnly: true, setProxyThenClose: true, userAgent: "same toChromeUserAgent implementation and locale as configureAccountSession" },
    fixture: null, controllerBefore: null, platforms: [], controllerAfter: null, followup,
    limitations: ["Static anonymous login shell only; no complete QR, captcha, authenticated flow, upload or CDN allowlist is certified", "XHR/fetch, WebSocket, workers, non-GET/HEAD and business endpoint patterns denied", followup ? "Existing platform or verification roots plus exact static hosts with a bounded official HTML/script reference chain may load; unexpected hosts recorded and canceled" : "Only existing platform or verification domain roots may load static resources; unexpected hosts recorded and canceled", "Incoming Set-Cookie removed; outgoing headers allowlisted; script-set cookies may exist transiently but are never sent", "No physical route guarantee, account permit, or packaged process equivalence inferred", "A sample cannot prove a domain never appears later; explicit unobserved verification seeds remain unverified"],
  };
  const windows = new Set();
  const checkpoint = (stage, details = {}) => fs.writeFileSync(path.join(temporary, "progress.json"), JSON.stringify({ at: new Date().toISOString(), stage, ...details }));
  let loopback;
  const safeHeaders = (headers) => {
    const allowed = new Set(["accept", "accept-language", "accept-encoding", "user-agent", "cache-control", "pragma", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "host", "connection"]);
    return Object.fromEntries(Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())));
  };
  const install = (isolated, decide, events, acceptResponse = () => true) => {
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let cancel = true;
      try { cancel = !decide(details, new URL(details.url)); } catch { /* malformed URL stays denied */ }
      callback({ cancel });
    });
    isolated.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = safeHeaders(details.requestHeaders);
      events.headerSanitizedRequests += 1;
      callback({ requestHeaders });
    });
    isolated.webRequest.onHeadersReceived((details, callback) => {
      if (!acceptResponse(details)) { callback({ cancel: true }); return; }
      const responseHeaders = { ...details.responseHeaders };
      for (const key of Object.keys(responseHeaders)) if (/^(set-cookie|set-cookie2)$/i.test(key)) { delete responseHeaders[key]; events.responseCookieHeadersStripped += 1; }
      // Preserve the site's policies while additionally forbidding background
      // workers and form submissions in this strictly anonymous read-only pass.
      const cspKey = Object.keys(responseHeaders).find((key) => /^content-security-policy$/i.test(key)) ?? "Content-Security-Policy";
      responseHeaders[cspKey] = [...(responseHeaders[cspKey] ?? []), "worker-src 'none'; object-src 'none'; form-action 'none'"];
      callback({ responseHeaders });
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", (event) => event.preventDefault());
  };
  const initialize = async (isolated) => {
    isolated.setUserAgent(toChromeUserAgent(app.userAgentFallback), "zh-CN,zh;q=0.9,en;q=0.8");
    await isolated.setProxy({ mode: "direct" });
    await isolated.closeAllConnections();
  };
  const reviewOfficialReferences = async (platform, hostMatches) => {
    checkpoint("reference-review-initialize", { platformId: platform.id });
    const isolated = session.fromPartition(`catalog-source-review-${platform.id}-${crypto.randomUUID()}`, { cache: false });
    const exactUrls = new Set();
    const audit = { entryHost: new URL(platform.routes.login).hostname, maxSources: 4, htmlByteLimit: 524_288, scriptByteLimit: 2_097_152, requestTimeoutMs: 5_000, sources: [], targets: reviewTargets[platform.id].map((host) => ({ host, evidence: [], approvedForAnonymousStaticFollowup: false })), headerSanitizedRequests: 0, responseCookieHeadersStripped: 0 };
    install(isolated, (details, url) => details.method === "GET" && url.protocol === "https:" && !url.username && !url.password && exactUrls.has(url.href), audit);
    await initialize(isolated);
    checkpoint("reference-review-ready", { platformId: platform.id });
    const readSource = async (url, kind, parentSourceIndex = null) => {
      const index = audit.sources.length;
      if (index >= audit.maxSources) return null;
      exactUrls.add(url.href);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), audit.requestTimeoutMs);
      const source = { index, host: url.hostname, kind, parentSourceIndex, status: null, bytes: 0, hash: null, result: "PENDING" };
      audit.sources.push(source);
      let reader;
      try {
        checkpoint("source-fetch-start", { platformId: platform.id, host: url.hostname, sourceIndex: index });
        const response = await isolated.fetch(url.href, { credentials: "omit", cache: "no-store", redirect: "error", signal: abort.signal });
        checkpoint("source-headers", { platformId: platform.id, host: url.hostname, status: response.status });
        source.status = response.status;
        if (!response.ok || !response.body) { source.result = "HTTP_NOT_OK"; return null; }
        const cap = kind === "official-login-html" ? audit.htmlByteLimit : audit.scriptByteLimit;
        const parts = [];
        reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          source.bytes += chunk.value.byteLength;
          if (source.bytes > cap) { source.result = "SOURCE_BYTE_LIMIT"; abort.abort(); return null; }
          parts.push(Buffer.from(chunk.value));
        }
        const bytes = Buffer.concat(parts);
        source.hash = crypto.createHash("sha256").update(bytes).digest("hex");
        source.result = "BOUNDED_SOURCE_READ";
        checkpoint("source-read-complete", { platformId: platform.id, host: url.hostname, bytes: source.bytes });
        const text = bytes.toString("utf8");
        const scripts = [];
        const attributeHosts = new Map();
        for (const match of text.matchAll(/<(script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
          try {
            const reference = new URL(match[2].replaceAll("&amp;", "&"), url);
            if (reference.protocol !== "https:" || reference.username || reference.password) continue;
            attributeHosts.set(reference.hostname, match[1].toLowerCase() === "script" ? "script-src" : "link-href");
            if (match[1].toLowerCase() === "script" && /\.(?:m?js)$/i.test(reference.pathname)) scripts.push(reference);
          } catch { /* Ignore malformed references without logging them. */ }
        }
        const normalized = text.replaceAll("\\/", "/").toLowerCase();
        for (const target of audit.targets) {
          const pattern = new RegExp(`(^|[^a-z0-9.-])${target.host.replaceAll(".", "\\.")}([^a-z0-9.-]|$)`);
          if (!pattern.test(normalized)) continue;
          target.evidence.push({ sourceIndex: index, referenceKind: attributeHosts.get(target.host) ?? "exact-host-literal" });
          target.approvedForAnonymousStaticFollowup = true;
        }
        return { scripts, attributeHosts };
      } catch (error) { source.result = safeError(error); return null; }
      finally {
        checkpoint("source-cleanup-start", { platformId: platform.id, host: url.hostname });
        clearTimeout(timer);
        abort.abort();
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        exactUrls.delete(url.href);
        checkpoint("source-cleanup-complete", { platformId: platform.id, host: url.hostname });
      }
    };
    try {
      const initial = await readSource(new URL(platform.routes.login), "official-login-html");
      if (initial && audit.targets.some((target) => !target.approvedForAnonymousStaticFollowup)) {
        // At most one level of scripts explicitly referenced by the official
        // HTML. Do not crawl arbitrary URLs found inside a script body.
        const scripts = [...new Map(initial.scripts.map((url) => [url.href, url])).values()];
        scripts.sort((a, b) => Number(!reviewTargets[platform.id].includes(a.hostname)) - Number(!reviewTargets[platform.id].includes(b.hostname)));
        for (const url of scripts) {
          if (audit.sources.length >= audit.maxSources || audit.targets.every((target) => target.approvedForAnonymousStaticFollowup)) break;
          const known = platform.login.topLevelHosts.some((host) => hostMatches(url.hostname, host)) || reviewTargets[platform.id].includes(url.hostname);
          if (known) await readSource(url, "official-html-referenced-script", 0);
        }
      }
      return audit;
    } finally {
      checkpoint("reference-session-cleanup-start", { platformId: platform.id });
      await isolated.clearStorageData(); await isolated.closeAllConnections();
      checkpoint("reference-session-cleanup-complete", { platformId: platform.id });
    }
  };
  try {
    if (process.versions.electron !== "43.3.0") throw new Error("ELECTRON_VERSION_MISMATCH");
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    const fixtureRequests = [];
    loopback = http.createServer((request, response) => {
      fixtureRequests.push({ forbiddenHeaderReceived: Object.keys(request.headers).some((key) => /cookie|authorization|token|secret/i.test(key)), rejectedEndpointReceived: request.url !== "/fixture" });
      response.writeHead(200, { "content-type": "text/plain", "set-cookie": "synthetic_response_cookie=fixture_only; HttpOnly; Path=/" });
      response.end("fixture");
    });
    await new Promise((resolve) => loopback.listen(0, "127.0.0.1", resolve));
    const fixtureOrigin = `http://127.0.0.1:${loopback.address().port}`;
    const fixtureSession = session.fromPartition(`catalog-fixture-${crypto.randomUUID()}`, { cache: false });
    const fixtureEvents = { headerSanitizedRequests: 0, responseCookieHeadersStripped: 0 };
    install(fixtureSession, (_details, url) => url.origin === fixtureOrigin && url.pathname === "/fixture", fixtureEvents);
    await initialize(fixtureSession);
    await fixtureSession.cookies.set({ url: fixtureOrigin, name: "synthetic_request_cookie", value: "fixture_only", httpOnly: true });
    await fixtureSession.fetch(`${fixtureOrigin}/fixture`, { credentials: "include", headers: { Authorization: "Bearer fixture_only", "X-Api-Token": "fixture_only", "X-Arbitrary-Secret": "fixture_only" } }).then((response) => response.arrayBuffer());
    const fixtureWindow = new BrowserWindow({ show: false, webPreferences: { session: fixtureSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.add(fixtureWindow);
    fixtureWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await fixtureWindow.loadURL(`${fixtureOrigin}/fixture`);
    await fixtureWindow.webContents.executeJavaScript(`fetch('/fixture',{credentials:'include',headers:{Authorization:'Bearer fixture_only','X-Api-Token':'fixture_only','X-Arbitrary-Secret':'fixture_only'}}).then(response=>response.text()).then(()=>true)`);
    await fixtureSession.fetch(`${fixtureOrigin}/rejected-user-info`, { credentials: "include" }).catch(() => {});
    const fixtureCookieNames = (await fixtureSession.cookies.get({})).map((cookie) => cookie.name);
    result.fixture = { controlledReceiverRequests: fixtureRequests.length, forbiddenHeaderReceived: fixtureRequests.some((entry) => entry.forbiddenHeaderReceived), deniedEndpointReachedReceiver: fixtureRequests.some((entry) => entry.rejectedEndpointReceived), responseCookieStored: fixtureCookieNames.includes("synthetic_response_cookie"), ...fixtureEvents };
    result.fixture.paths = ["session.fetch", "page navigation", "page fetch"];
    result.fixture.passed = result.fixture.controlledReceiverRequests === 3 && !result.fixture.forbiddenHeaderReceived && !result.fixture.deniedEndpointReachedReceiver && !result.fixture.responseCookieStored && result.fixture.responseCookieHeadersStripped === 3;
    if (!fixtureWindow.isDestroyed()) fixtureWindow.webContents.close({ waitForBeforeUnload: false });
    await fixtureSession.clearStorageData();
    await fixtureSession.closeAllConnections();
    await new Promise((resolve) => loopback.close(resolve));
    loopback = null;
    if (!result.fixture.passed) throw new Error("HEADER_ISOLATION_FIXTURE_FAILED");
    checkpoint("isolation-fixture-passed");
    if (!fixtureOnly) {
      result.controllerBefore = await controllerSnapshot();
      if (result.controllerBefore.mode !== "rule") throw new Error("RULE_MODE_REQUIRED_NO_EXTERNAL_SAMPLE_SENT");
      const { PLATFORM_LIST, hostMatches } = await import(`file:///${path.join(temporary, "platforms.mjs").replaceAll("\\", "/")}`);
      for (const platform of PLATFORM_LIST.filter((platform) => !followup || platform.id in reviewTargets)) {
        const before = await controllerSnapshot();
        if (before.contextHash !== result.controllerBefore.contextHash) throw new Error("CONTROLLER_CHANGED_REMAINING_SAMPLES_SKIPPED");
        const referenceAudit = followup ? await reviewOfficialReferences(platform, hostMatches) : null;
        checkpoint("platform-page-start", { platformId: platform.id });
        const reviewedExactStatic = new Set(referenceAudit?.targets.filter((target) => target.approvedForAnonymousStaticFollowup).map((target) => target.host) ?? []);
        const isolated = session.fromPartition(`catalog-${platform.id}-${crypto.randomUUID()}`, { cache: false });
        const rows = new Map();
        const entry = {
          platformId: platform.id, entryHost: new URL(platform.routes.login).hostname,
          startedAt: new Date().toISOString(), requestedWindowMs: 20_000,
          kernelContextHash: before.contextHash, requestBudget: followup ? 120 : 180, totalRequestsObserved: 0,
          headerSanitizedRequests: 0, responseCookieHeadersStripped: 0, pageResult: "PENDING",
          externalWindowsDenied: 0, externalSchemeNavigationsDenied: 0, hosts: [], loginFlowCertified: false,
          referenceAudit,
          followupBudget: followup ? { perResourceBytes: 4_194_304, totalDecodedBytes: 16_777_216, receivedDecodedBytes: 0, responseLengthRejections: 0, stopReason: null } : null,
        };
        const rowFor = (url) => {
          const host = url.hostname.toLowerCase().replace(/\.$/, "");
          let row = rows.get(host);
          if (!row) { row = { host, requested: 0, allowed: 0, canceled: 0, resourceTypes: new Set(), statuses: new Map(), cancelReasons: new Map(), errors: new Map() }; rows.set(host, row); }
          return row;
        };
        const staticTypes = new Set(["mainFrame", "subFrame", "script", "stylesheet", "image", "font"]);
        const businessPath = /(?:\/(?:api|rest|cgi-bin|webcast)\/|\/(?:profile|userinfo|user-info|works|auth_data)(?:\/|$)|\/user\/(?:info|profile)(?:\/|$))/i;
        const policy = (details, url) => {
          if (["about:", "data:", "blob:"].includes(url.protocol)) return true;
          entry.totalRequestsObserved += 1;
          const row = rowFor(url);
          row.requested += 1;
          row.resourceTypes.add(details.resourceType);
          let reason;
          if (!["https:", "http:"].includes(url.protocol)) reason = "NON_HTTP_OR_LONG_CONNECTION";
          else if (url.username || url.password) reason = "EMBEDDED_CREDENTIALS";
          else if (entry.totalRequestsObserved > entry.requestBudget) reason = "REQUEST_BUDGET";
          else if (!platform.login.topLevelHosts.some((host) => hostMatches(url.hostname, host)) && !platform.login.verificationHosts.some((host) => hostMatches(url.hostname, host)) && !(reviewedExactStatic.has(url.hostname) && ["script", "stylesheet"].includes(details.resourceType) && /\.(?:m?js|css)$/i.test(url.pathname))) reason = "UNREGISTERED_THIRD_PARTY";
          else if (!["GET", "HEAD"].includes(details.method)) reason = "NON_READ_METHOD";
          else if (!staticTypes.has(details.resourceType)) reason = "DYNAMIC_OR_BACKGROUND_REQUEST";
          else if (businessPath.test(url.pathname)) reason = "BUSINESS_ENDPOINT_PATTERN";
          if (reason) { row.canceled += 1; row.cancelReasons.set(reason, (row.cancelReasons.get(reason) ?? 0) + 1); return false; }
          row.allowed += 1;
          return true;
        };
        install(isolated, policy, entry, (details) => {
          if (!entry.followupBudget) return true;
          const declared = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === "content-length")?.[1]?.[0];
          if (declared && Number(declared) > entry.followupBudget.perResourceBytes) { entry.followupBudget.responseLengthRejections += 1; return false; }
          return true;
        });
        isolated.webRequest.onCompleted((details) => { try { const row = rowFor(new URL(details.url)); row.statuses.set(details.statusCode, (row.statuses.get(details.statusCode) ?? 0) + 1); } catch { /* no raw URL error */ } });
        isolated.webRequest.onErrorOccurred((details) => { try { const row = rowFor(new URL(details.url)); const code = safeError(details.error); row.errors.set(code, (row.errors.get(code) ?? 0) + 1); } catch { /* no raw URL error */ } });
        await initialize(isolated);
        const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true, navigateOnDragDrop: false } });
        windows.add(window);
        if (followup) {
          // Electron may not answer a pre-navigation Debugger command until a
          // renderer document exists. Initialize a local blank page first.
          checkpoint("budget-debugger-blank-start", { platformId: platform.id });
          await window.loadURL("about:blank");
          checkpoint("budget-debugger-blank-ready", { platformId: platform.id });
          const byRequest = new Map();
          window.webContents.debugger.attach("1.3");
          window.webContents.debugger.on("message", (_event, method, params) => {
            if (method !== "Network.dataReceived" || !entry.followupBudget) return;
            const bytes = Number(params.dataLength) || 0;
            const total = (byRequest.get(params.requestId) ?? 0) + bytes;
            byRequest.set(params.requestId, total);
            entry.followupBudget.receivedDecodedBytes += bytes;
            if (total > entry.followupBudget.perResourceBytes || entry.followupBudget.receivedDecodedBytes > entry.followupBudget.totalDecodedBytes) {
              entry.followupBudget.stopReason = total > entry.followupBudget.perResourceBytes ? "RESOURCE_BYTE_LIMIT" : "TOTAL_BYTE_LIMIT";
              if (!window.isDestroyed()) window.webContents.close({ waitForBeforeUnload: false });
            }
          });
          checkpoint("budget-debugger-enable-start", { platformId: platform.id });
          await window.webContents.debugger.sendCommand("Network.enable");
          checkpoint("budget-debugger-enable-complete", { platformId: platform.id });
        }
        window.webContents.setWindowOpenHandler(() => { entry.externalWindowsDenied += 1; return { action: "deny" }; });
        window.webContents.on("will-attach-webview", (event) => event.preventDefault());
        const preventExternalScheme = (event) => {
          try { if (["https:", "http:"].includes(new URL(event.url).protocol)) return; } catch { /* malformed target also denied */ }
          event.preventDefault();
          entry.externalSchemeNavigationsDenied += 1;
        };
        window.webContents.on("will-navigate", preventExternalScheme);
        window.webContents.on("will-redirect", preventExternalScheme);
        // No click, keyboard, DOM, screenshot, response inspection or QR action.
        const loading = window.loadURL(platform.routes.login).then(() => { entry.pageResult = "LOAD_COMPLETED"; }).catch((error) => { entry.pageResult = safeError(error); });
        await delay(entry.requestedWindowMs);
        checkpoint("platform-page-cleanup-start", { platformId: platform.id });
        // Do not pretend stop() alone terminates active renderer connections.
        if (!window.isDestroyed()) window.webContents.close({ waitForBeforeUnload: false });
        await isolated.clearStorageData({ storages: ["serviceworkers"] });
        await isolated.closeAllConnections();
        await Promise.race([loading, delay(200)]);
        entry.cookiesPresentBeforeCleanup = (await isolated.cookies.get({})).length;
        await isolated.clearStorageData();
        const after = await controllerSnapshot();
        entry.kernelContextStable = before.contextHash === after.contextHash;
        entry.endedAt = new Date().toISOString();
        entry.hosts = [...rows.values()].sort((a, b) => a.host.localeCompare(b.host)).map((row) => ({ ...row, resourceTypes: [...row.resourceTypes].sort(), statuses: Object.fromEntries(row.statuses), cancelReasons: Object.fromEntries(row.cancelReasons), errors: Object.fromEntries(row.errors) }));
        result.platforms.push(entry);
        checkpoint("platform-completed", { platformId: platform.id });
        if (!entry.kernelContextStable) throw new Error("CONTROLLER_CHANGED_REMAINING_SAMPLES_SKIPPED");
      }
    }
  } catch (error) {
    result.failure = /^[A-Z][A-Z_]+$/.test(error?.message ?? "") ? error.message : "CATALOG_SAMPLE_FAILED";
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    if (loopback) await new Promise((resolve) => loopback.close(resolve));
    if (!fixtureOnly) { try { result.controllerAfter = await controllerSnapshot(); } catch { result.controllerAfter = { readable: false }; } }
    result.summary = { platformsAttempted: result.platforms.length, platformHostAssociations: result.platforms.reduce((sum, entry) => sum + entry.hosts.length, 0), completeLoginCatalogsCertified: 0, controllerStable: !!result.controllerBefore && result.controllerBefore.contextHash === result.controllerAfter?.contextHash };
    fs.writeFileSync(path.join(temporary, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    app.exit(result.failure ? 1 : 0);
  }
}
