/** Production remote-media cache, isolated Electron + loopback TLS + synthetic credentials only. */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const reportBase = path.join(repository, "docs", "network-remote-media-smoke");
const host = "clipdock-media.test";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value, name) { if (!value) throw Error(name); }
async function until(test, name, ms = 7000) {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > ms) throw Error(name);
    await delay(20);
  }
}
async function bounded(promise, name, ms = 7000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(name)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function validTemporary(value) {
  return typeof value === "string" &&
    path.dirname(path.resolve(value)) === path.resolve(repository, "docs", ".compare") &&
    /^remote-media-smoke-[a-zA-Z0-9]+$/.test(path.basename(value));
}

if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { spawn, spawnSync } = await import("node:child_process");
  const { build } = await import("esbuild");
  const { default: electron } = await import("electron");
  const temporary = fs.mkdtempSync(path.join(repository, "docs", ".compare", "remote-media-smoke-"));
  let result, exitCode = 1;
  try {
    const candidates = ["openssl"];
    if (process.platform === "win32") {
      const git = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
      for (const file of (git.stdout ?? "").trim().split(/\r?\n/).filter(Boolean))
        candidates.push(path.join(path.dirname(path.dirname(file)), "usr", "bin", "openssl.exe"));
    }
    const openssl = candidates.find((file) =>
      spawnSync(file, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0);
    assert(openssl, "OPENSSL_REQUIRED");
    assert(spawnSync(openssl, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(temporary, "key.pem"),
      "-out", path.join(temporary, "cert.pem"), "-days", "1", "-subj", "/CN=" + host,
      "-addext", "subjectAltName=DNS:" + host,
    ], { windowsHide: true, stdio: "ignore" }).status === 0, "LOCAL_CERTIFICATE_GENERATION_FAILED");
    const buildOptions = {
      stdin: { contents: [
        "export { RemoteMediaService } from './src/main/services/remote-media-service.ts';",
        "export { AssetService, registerAssetSchemePrivileges } from './src/main/services/asset-service.ts';",
        "export { installBusinessNetwork, beginBusinessOperation } from './src/main/network/business-access.ts';",
      ].join("\n"), loader: "ts", resolveDir: repository },
      bundle: true, platform: "node", format: "esm", external: ["electron"], metafile: true,
      outfile: path.join(temporary, "production.mjs"),
      tsconfig: path.join(repository, "tsconfig.electron.json"), logLevel: "silent",
    };
    const bundle = await build(buildOptions);
    const sourceHashes = Object.fromEntries(Object.keys(bundle.metafile.inputs)
      .filter((file) => file !== "<stdin>")
      .map((file) => [file.replaceAll("\\", "/"), hash(fs.readFileSync(path.resolve(repository, file)))]));
    sourceHashes["scripts/electron-remote-media-smoke.mjs"] = hash(fs.readFileSync(script));
    // Rebuild after taking hashes and compare bytes: edits during the first build cannot be silently attributed.
    const sourceContents = fs.readFileSync(path.join(temporary, "production.mjs"));
    await build(buildOptions);
    assert(hash(sourceContents) === hash(fs.readFileSync(path.join(temporary, "production.mjs"))) &&
      Object.entries(sourceHashes).every(([file, digest]) => hash(fs.readFileSync(path.resolve(repository, file))) === digest),
    "SOURCE_CHANGED_DURING_BUNDLE");
    const environment = { ...process.env, CLIPDOCK_REMOTE_MEDIA_SMOKE_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const processChild = spawn(electron, [script], {
      cwd: repository, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    for (const stream of [processChild.stdout, processChild.stderr])
      stream.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-3000); });
    const timer = setTimeout(() => processChild.kill(), 65_000);
    exitCode = await new Promise((resolve) => {
      processChild.once("error", () => resolve(1));
      processChild.once("exit", (code) => resolve(code ?? 1));
    });
    clearTimeout(timer);
    const output = path.join(temporary, "result.json");
    if (!fs.existsSync(output)) throw Error("NO_CHILD_REPORT: " + diagnostic);
    result = JSON.parse(fs.readFileSync(output, "utf8"));
    result.sourceHashes = sourceHashes;
    result.bundleSha256 = hash(sourceContents);
    result.sourcesStillCurrentAtCompletion = Object.entries(sourceHashes).every(([file, digest]) =>
      hash(fs.readFileSync(path.resolve(repository, file))) === digest);
    if (!result.sourcesStillCurrentAtCompletion) exitCode = 1;
  } catch (error) {
    console.error(error.message);
  } finally {
    // Only this invocation's freshly allocated workspace child is eligible. Never touch prior retained probes.
    assert(validTemporary(temporary), "UNSAFE_CLEANUP_TARGET");
    await delay(400);
    let removed = false;
    try { fs.rmSync(path.resolve(temporary), { recursive: true, force: true }); removed = true; } catch { /* Report retained fixture. */ }
    if (result) {
      result.tempDirectoryRemoved = removed;
      if (!removed) result.retainedTemporaryPath = temporary;
      fs.writeFileSync(reportBase + ".results.json", JSON.stringify(result, null, 2) + "\n");
      fs.writeFileSync(reportBase + ".md", renderReport(result));
      console.log(JSON.stringify({
        report: reportBase + ".results.json", runtime: result.runtime, summary: result.summary,
        failure: result.failure ?? null, sourcesStillCurrentAtCompletion: result.sourcesStillCurrentAtCompletion,
        tempDirectoryRemoved: removed,
      }, null, 2));
    }
    process.exitCode = exitCode;
  }
}

function renderReport(result) {
  return "# 远程媒体缓存：生产模块 Electron 本机实测\n\n" +
    `执行时间：${result.executedAt}。Electron ${result.runtime.electron} / Chromium ${result.runtime.chromium} / ${result.runtime.platform}。\n\n` +
    "运行 `node scripts/electron-remote-media-smoke.mjs`。直接 bundle 当前 RemoteMediaService、download/format、AssetService 原生协议及 business-access；源码与 bundle 哈希见结果。无真实账号、无公网请求、无 mihomo 修改。临时 userData/sessionData、内存分区、127.0.0.1 TLS 接收端及合成 Cookie/Basic 凭据；证书只在该 Session 按域名及指纹精确放行，没有全局证书忽略或信任存储修改。\n\n" +
    "| 实际验证 | 结果 |\n|---|---|\n" +
    result.checks.map((row) => `| ${row.name} | ${row.passed ? "通过" : "失败"} |`).join("\n") + "\n\n" +
    "同一账号 Session 的普通 include 与媒体 omit 确认在接收端并发重叠；请求钩子只限制本机目标，不改 Cookie、Authorization 或响应 Set-Cookie。服务器逐路由记录凭据是否存在，不落原凭据。正常 PNG 经真实 nativeImage 解码/转 PNG 后写缓存，sv-asset://remote/UUID 由生产 AssetService 分派。缓存未命中没有下载回退。\n\n" +
    "许可由严格范围的测试适配器注入，使用生产 beginBusinessOperation；只允许这个合成账号和本机 TLS origin。它验证缓存的租约消费/撤销，不签发真实 DirectProof，不证明 OS/mihomo 路径、真实平台图床目录或正式打包兼容性。初始化完成顺序为 setProxy(direct) → closeAllConnections。没有声称绕过 TUN。\n\n" +
    "Basic 认证覆盖：" + (result.basicAuth?.primed
      ? "隐藏窗口通过合成 Basic challenge 建立该分区认证缓存；随后普通 session.fetch 实际收到 Authorization，而同一 realm 的媒体请求没有 Authorization、没有触发凭据重试/认证提示，收到 401 后显示不可用。"
      : "未建立可确认的 Basic 认证缓存，不能将本轮解释为认证缓存隔离验证；详情见结果。") +
    " 不代表已覆盖 NTLM/Negotiate、客户端证书、代理认证或所有 Chromium 认证机制。\n\n" +
    "流式撤销分别覆盖纯租约撤销与 suspendAccount：接收端已开始响应后撤销，下载停止且无新增缓存/临时文件；确认撤销后给接收端留出观察时间，再检查无晚到提交。不会把撤销前已收到的合成字节描述成零包。\n\n" +
    (fs.existsSync(reportBase + "-initial-observation.results.json") ?
      "初期观察：首轮测试错误读取 Electron Certificate 上不存在的 fingerprint256，所有 TLS 请求被测试 pin 拒绝；已改成从 certificate.data 计算 X509 指纹，[原结果](./network-remote-media-smoke-initial-observation.results.json)保留。修正后另有一次媒体未到达、普通请求成功的观察，当时尚未记录 fetch 错误码，原因不能追认；后续增加只记录固定错误码的透明观察，并在当前源码完成后复核。最终通过只代表该次受控检查，不把早期失败改写为通过。\n\n" : "") +
    `[脱敏结果](./network-remote-media-smoke.results.json)。源码在完成时${result.sourcesStillCurrentAtCompletion ? "仍一致" : "已变更，本轮不能作为当前源码验收"}；本轮临时目录${result.tempDirectoryRemoved ? "已清理" : "保留"}。` +
    (result.failure ? `\n\n失败阶段：${result.failure}。本轮不能标为通过。` : "") + "\n";
}

async function child() {
  const { app, BrowserWindow, session, protocol, nativeImage } = await import("electron");
  const temporary = process.env.CLIPDOCK_REMOTE_MEDIA_SMOKE_ROOT;
  assert(validTemporary(temporary), "ISOLATED_PROFILE_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP " + host + " 127.0.0.1");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  production.registerAssetSchemePrivileges();
  const result = {
    executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, packaged: app.isPackaged },
    isolation: { localTlsOnly: true, realAccountOpened: false, syntheticCredentialsOnly: true, isolatedProfiles: true,
      globalCertificateBypass: false, sessionCertificatePinOnly: true, testLeaseInjection: true, credentialHeadersModifiedByFixture: false },
    initializationOrder: [], checks: [], receiver: {}, authorizationCalls: [], previewChanges: [], sessionFetchFailures: [], basicAuth: { primed: false, fixtureChallenges: 0, unexpectedChallenges: 0 },
  };
  let phase = "initialization", server, media, uninstallBusiness, browser;
  const sockets = new Set(), responses = new Set(), activePaths = new Map(), leases = new Set();
  const accountId = "synthetic-media-account";
  const cookie = "clipdock_media_fixture=synthetic_local_only";
  const expectedBasic = "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64");
  let origin, ses, gateAllowed = false, epoch = 0, forbiddenRequests = 0;
  const check = (name, value) => { result.checks.push({ name, passed: !!value }); assert(value, name); };
  const count = (name) => result.receiver[name]?.requests ?? 0;
  const total = () => Object.values(result.receiver).reduce((sum, row) => sum + row.requests, 0);
  const subject = (workId) => ({ accountId, kind: "cover", workId });
  const offer = (name, endpoint = name) => media.offer(subject(name), { sourceUrl: origin + "/" + endpoint + "?signed=synthetic-query-marker", sourceRevision: "fixture-revision" });
  const pngFiles = () => fs.readdirSync(path.join(temporary, "media-cache")).filter((name) => /\.(png|tmp)$/.test(name)).sort();
  const revoke = () => { gateAllowed = false; epoch++; for (const abort of leases) abort.abort(); };
  app.on("login", (event, _contents, details, authInfo, callback) => {
    event.preventDefault();
    if (phase === "basic-prime" && new URL(details.url).hostname === host && !authInfo.isProxy && authInfo.realm === "clipdock-media-fixture") {
      result.basicAuth.fixtureChallenges++;
      callback("fixture-user", "fixture-password");
    } else { result.basicAuth.unexpectedChallenges++; callback(); }
  });
  try {
    await app.whenReady();
    const cert = fs.readFileSync(path.join(temporary, "cert.pem"));
    const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    const png = nativeImage.createFromBitmap(Buffer.from([
      0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
    ]), { width: 2, height: 2 }).toPNG();
    server = https.createServer({ key: fs.readFileSync(path.join(temporary, "key.pem")), cert }, (request, response) => {
      const pathname = new URL(request.url, "https://" + host).pathname;
      const row = result.receiver[pathname] ??= { requests: 0, cookieRequests: 0, syntheticCookieRequests: 0,
        authorizationRequests: 0, expectedBasicRequests: 0, proxyAuthorizationRequests: 0, refererRequests: 0,
        onlyLoopback: true, closed: 0, finished: 0, bytesWritten: 0 };
      row.requests++;
      row.cookieRequests += request.headers.cookie ? 1 : 0;
      row.syntheticCookieRequests += request.headers.cookie === cookie ? 1 : 0;
      row.authorizationRequests += request.headers.authorization ? 1 : 0;
      row.expectedBasicRequests += request.headers.authorization === expectedBasic ? 1 : 0;
      row.proxyAuthorizationRequests += request.headers["proxy-authorization"] ? 1 : 0;
      row.refererRequests += request.headers.referer ? 1 : 0;
      row.onlyLoopback &&= ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(request.socket.remoteAddress);
      const other = pathname === "/image" ? "/ordinary" : pathname === "/ordinary" ? "/image" : null;
      if (other && activePaths.get(other)) result.ordinaryImageOverlap = true;
      activePaths.set(pathname, (activePaths.get(pathname) ?? 0) + 1);
      responses.add(response);
      response.once("close", () => { row.closed++; activePaths.set(pathname, activePaths.get(pathname) - 1); responses.delete(response); });
      response.once("finish", () => { row.finished++; });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Security-Policy", "default-src 'none'");
      const sendPng = () => { response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length,
        "Set-Cookie": "remote_media_attempt=must_not_persist; Secure; HttpOnly; Path=/" }); row.bytesWritten += png.length; response.end(png); };
      if (pathname.startsWith("/basic/") && request.headers.authorization !== expectedBasic) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="clipdock-media-fixture"', "Content-Type": "text/plain" });
        response.end("Synthetic authentication required");
      } else if (pathname === "/basic/image") sendPng();
      else if (pathname.startsWith("/basic/")) { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("Synthetic authenticated fixture"); }
      else if (pathname === "/image") setTimeout(sendPng, 200);
      else if (pathname === "/ordinary") setTimeout(() => { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("Synthetic ordinary fixture"); }, 200);
      else if (pathname === "/redirect") { response.writeHead(302, { Location: "/redirect-target" }); response.end(); }
      else if (pathname === "/redirect-target") sendPng();
      else if (pathname.startsWith("/stream-")) {
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
        response.flushHeaders(); response.write(png.subarray(0, 16)); row.bytesWritten += 16;
      } else if (pathname === "/closed") sendPng();
      else { response.writeHead(404); response.end(); }
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = "https://" + host + ":" + server.address().port;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = new URL(details.url).protocol === "sv-asset:";
      if (!allowed) forbiddenRequests++;
      callback({ cancel: !allowed });
    });
    ses = session.fromPartition("clipdock-media-smoke-" + crypto.randomUUID());
    const nativeFetch = ses.fetch.bind(ses);
    ses.fetch = async (...args) => {
      try { return await nativeFetch(...args); }
      catch (error) {
        result.sessionFetchFailures.push({ phase, code: /net::ERR_[A-Z_]+/.exec(String(error.message))?.[0] ?? error.name ?? "FETCH_FAILED" });
        throw error;
      }
    };
    ses.setCertificateVerifyProc((request, callback) => {
      let trusted = false;
      try { trusted = request.hostname === host && new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint; } catch { /* Reject malformed certificate. */ }
      callback(trusted ? 0 : -2);
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = new URL(details.url).origin === origin;
      if (!allowed) forbiddenRequests++;
      callback({ cancel: !allowed });
    });
    await ses.setProxy({ mode: "direct" }); result.initializationOrder.push("setProxy(direct):completed");
    await ses.closeAllConnections(); result.initializationOrder.push("closeAllConnections:completed");
    await ses.cookies.set({ url: origin, name: "clipdock_media_fixture", value: "synthetic_local_only", secure: true, httpOnly: true });
    uninstallBusiness = production.installBusinessNetwork({
      enforcement: "strict",
      check: (id, url) => ({ allowed: gateAllowed && id === accountId && (!url || new URL(url).origin === origin), reason: "CHECKING" }),
      acquire: (id) => {
        if (!gateAllowed || id !== accountId) return null;
        const issued = epoch, abort = new AbortController(); let released = false;
        leases.add(abort);
        return { signal: abort.signal, isCurrent: () => !released && gateAllowed && issued === epoch,
          release: () => { released = true; leases.delete(abort); } };
      },
    });
    media = new production.RemoteMediaService({
      cacheDir: path.join(temporary, "media-cache"),
      authorize: (input, target) => {
        result.authorizationCalls.push({ phase, matchingAccount: input.accountId === accountId,
          matchingTarget: target.protocol === "https:" && target.host === host && target.port === server.address().port, gateAllowed });
        if (input.accountId !== accountId || target.protocol !== "https:" || target.host !== host || target.port !== server.address().port)
          return { state: "unreviewed" };
        if (!gateAllowed) return { state: "waiting-network" };
        return { state: "allowed", session: ses, lease: production.beginBusinessOperation(accountId, origin) };
      },
      onChanged: (_subject, preview) => result.previewChanges.push({ phase, state: preview.state }),
    });
    const assets = new production.AssetService({ assets: { get: () => undefined } }, path.join(temporary, "thumbnails"));
    assets.registerProtocol(media);

    phase = "closed";
    offer("closed");
    await until(() => media.preview(subject("closed")).state === "waiting-network", "CLOSED_STATE");
    check("闭闩媒体不调用 Session 网络", count("/closed") === 0);
    await media.forgetAccount(accountId);
    gateAllowed = true; epoch++;

    phase = "concurrent-cookie";
    offer("image");
    const ordinary = await bounded(ses.fetch(origin + "/ordinary", { credentials: "include", cache: "no-store" }), "ORDINARY_FETCH");
    await ordinary.text();
    await until(() => media.preview(subject("image")).state !== "pending", "IMAGE_COMPLETION");
    check("生产 nativeImage 成功生成本地 PNG", media.preview(subject("image")).state === "cached");
    check("同 Session 普通请求与媒体下载实际并发", result.ordinaryImageOverlap === true);
    check("普通 include 收到原合成 Cookie", result.receiver["/ordinary"].syntheticCookieRequests === 1);
    check("媒体 omit 未发送 Cookie Authorization 或 Referer", result.receiver["/image"].cookieRequests === 0 && result.receiver["/image"].authorizationRequests === 0 && result.receiver["/image"].proxyAuthorizationRequests === 0 && result.receiver["/image"].refererRequests === 0);
    const cookies = await ses.cookies.get({ url: origin });
    check("媒体响应 Set-Cookie 未写入账号分区", !cookies.some((item) => item.name === "remote_media_attempt"));
    check("媒体 omit 未清掉普通业务 Cookie", cookies.some((item) => item.name === "clipdock_media_fixture" && item.value === "synthetic_local_only"));

    phase = "native-protocol";
    const cachedUrl = media.preview(subject("image")).url;
    const beforeProtocol = total();
    const imageResponse = await session.defaultSession.fetch(cachedUrl);
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    const decoded = nativeImage.createFromBuffer(bytes);
    check("生产 sv-asset 协议返回可解码 PNG", imageResponse.status === 200 && imageResponse.headers.get("content-type") === "image/png" && !decoded.isEmpty() && decoded.getSize().width === 2 && decoded.getSize().height === 2);
    const miss = await session.defaultSession.fetch("sv-asset://remote/" + crypto.randomUUID());
    const invalid = await session.defaultSession.fetch(cachedUrl + "?source=https%3A%2F%2Fexample.invalid");
    await delay(100);
    check("原生协议缓存 miss 404 且无网络回退", miss.status === 404 && total() === beforeProtocol);
    check("原生协议拒绝 query 且无网络回退", invalid.status === 400 && total() === beforeProtocol);
    const populatedManifests = fs.readdirSync(path.join(temporary, "media-cache"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => fs.readFileSync(path.join(temporary, "media-cache", name), "utf8")).join("\n");
    check("实际已填充缓存 manifest 不含远程 URL query 或凭据", populatedManifests.includes(cachedUrl.split("/").at(-1)) &&
      !populatedManifests.includes(host) && !populatedManifests.includes("synthetic-query-marker") &&
      !populatedManifests.includes("synthetic_local_only") && !populatedManifests.includes("fixture-password"));

    phase = "redirect";
    offer("redirect");
    await until(() => media.preview(subject("redirect")).state !== "pending", "REDIRECT_COMPLETION");
    check("redirect:error 拒绝第二跳且不缓存", count("/redirect") === 1 && count("/redirect-target") === 0 && media.preview(subject("redirect")).state === "unavailable");

    phase = "basic-prime";
    browser = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await bounded(browser.loadURL(origin + "/basic/prime"), "BASIC_PRIME");
    browser.destroy(); browser = null;
    phase = "basic-cache";
    const basicOrdinary = await bounded(ses.fetch(origin + "/basic/ordinary", { credentials: "include", cache: "no-store" }), "BASIC_ORDINARY");
    await basicOrdinary.text();
    result.basicAuth.primed = basicOrdinary.status === 200 && result.receiver["/basic/ordinary"]?.expectedBasicRequests > 0 && result.basicAuth.fixtureChallenges > 0;
    check("普通分区已实际建立并复用 Basic 认证缓存", result.basicAuth.primed);
    offer("basic-image", "basic/image");
    await until(() => media.preview(subject("basic-image")).state !== "pending", "BASIC_MEDIA_COMPLETION");
    check("媒体 omit 不复用同 realm Basic 缓存或弹认证", result.receiver["/basic/image"]?.requests === 1 && result.receiver["/basic/image"].authorizationRequests === 0 && result.receiver["/basic/image"].cookieRequests === 0 && result.basicAuth.unexpectedChallenges === 0 && media.preview(subject("basic-image")).state === "unavailable");

    for (const kind of ["lease", "suspend"]) {
      phase = "stream-" + kind;
      const before = pngFiles();
      offer(phase);
      await until(() => count("/" + phase) === 1, "STREAM_STARTED");
      if (kind === "lease") revoke();
      else media.suspendAccount(accountId);
      await until(() => media.preview(subject(phase)).state === "waiting-network", "STREAM_WAITING");
      await until(() => result.receiver["/" + phase].closed === 1, "STREAM_CLOSED");
      await delay(250);
      check(kind === "lease" ? "租约撤销中止流且不提交缓存" : "suspendAccount 中止流且不提交缓存",
        media.preview(subject(phase)).url === null && JSON.stringify(pngFiles()) === JSON.stringify(before) && result.receiver["/" + phase].finished === 0);
      if (kind === "lease") {
        offer("post-lease", "closed");
        await until(() => media.preview(subject("post-lease")).state === "waiting-network", "POST_REVOKE_WAITING");
        check("撤销后新增媒体任务零到达", count("/closed") === 0);
        // Retire the cancelled item instead of using recovery to replay it during this isolated test.
        await media.forgetAccount(accountId);
        gateAllowed = true; epoch++;
      }
    }
    phase = "final-invariants";
    const files = fs.readdirSync(path.join(temporary, "media-cache"));
    const manifests = files.filter((name) => name.endsWith(".json")).map((name) => fs.readFileSync(path.join(temporary, "media-cache", name), "utf8")).join("\n");
    check("持久缓存不包含远程 URL query 或凭据", !manifests.includes(host) && !manifests.includes("synthetic-query-marker") && !manifests.includes("synthetic_local_only") && !manifests.includes("fixture-password"));
    check("所有接收请求仅来自 loopback", Object.values(result.receiver).every((row) => row.onlyLoopback));
    check("全部媒体路由均无 Cookie 或认证头", ["/image", "/redirect", "/basic/image", "/stream-lease", "/stream-suspend"]
      .every((pathname) => result.receiver[pathname] && result.receiver[pathname].cookieRequests === 0 &&
        result.receiver[pathname].authorizationRequests === 0 && result.receiver[pathname].proxyAuthorizationRequests === 0));
    check("无非 fixture 网络尝试", forbiddenRequests === 0);
    await media.dispose();
    check("任务全部释放生产业务租约", leases.size === 0);
  } catch (error) {
    result.failure = phase + ":" + (error.message ?? "FIXTURE_FAILED");
  } finally {
    if (browser && !browser.isDestroyed()) browser.destroy();
    await media?.dispose();
    uninstallBusiness?.();
    for (const response of responses) response.destroy();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (await protocol.isProtocolHandled("sv-asset")) protocol.unhandle("sv-asset");
    result.summary = { passed: result.checks.filter((row) => row.passed).length, failed: result.checks.filter((row) => !row.passed).length, completed: !result.failure };
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result, null, 2) + "\n");
    app.exit(result.failure ? 1 : 0);
  }
}
