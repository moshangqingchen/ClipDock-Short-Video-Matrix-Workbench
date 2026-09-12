/**
 * Production network integration smoke, isolated Electron + loopback TLS only.
 * Run: node scripts/electron-network-runtime-smoke.mjs [--http2]
 * Requires OpenSSL (PATH or bundled with Git for Windows). No certificate-store changes.
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http2 from "node:http2";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const http2Mode = process.argv.includes("--http2");
const reportName = http2Mode ? "network-runtime-http2-smoke" : "network-runtime-smoke";
const resultPath = path.join(repository, "docs", reportName + ".results.json");
const sourceFiles = [
  "src/main/network/runtime.ts",
  "src/main/network/egress-gate.ts",
  "src/main/network/proof-coordinator.ts",
  "src/main/network/proof-issuer.ts",
  "src/main/network/direct-proof.ts",
  "src/main/network/live-rule-evidence.ts",
  "src/main/network/direct-session.ts",
  "src/main/network/session-observer.ts",
  "src/main/network/shell-network-guard.ts",
  "src/main/network/anonymous-proof-probe.ts",
  "src/main/network/anonymous-session-privacy.ts",
  "src/main/network/operation-catalog.ts",
  "src/main/network/business-access.ts",
  "src/main/network/gated-session-fetch.ts",
  "src/main/network/close-account-view.ts",
  "src/main/network/page-evaluation.ts",
  "src/main/data/collectors/shared.ts",
];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value, name) {
  if (!value) throw Error(name);
}
async function until(test, name, ms = 7000) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > ms) throw Error(name);
    await delay(20);
  }
}
async function bounded(promise, name, ms = 10000) {
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
if (!process.versions.electron) {
  await parent();
} else {
  // Electron must finish module evaluation before app.whenReady can settle.
  void child().catch(() => process.exit(1));
}
async function parent() {
  const { spawn, spawnSync } = await import("node:child_process");
  const { build } = await import("esbuild");
  const { default: electron } = await import("electron");
  const parentDirectory = path.join(repository, "docs", ".compare");
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "runtime-smoke-"));
  let exitCode = 1;
  try {
    const candidates = ["openssl"];
    if (process.platform === "win32") {
      const located = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
      for (const git of (located.stdout ?? "").trim().split(/\r?\n/).filter(Boolean))
        candidates.push(path.join(path.dirname(path.dirname(git)), "usr", "bin", "openssl.exe"));
    }
    const openssl = candidates.find(
      (executable) => spawnSync(executable, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0,
    );
    assert(openssl, "OPENSSL_REQUIRED");
    const certificate = spawnSync(
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
        "/CN=clipdock-runtime.test",
        "-addext",
        "subjectAltName=DNS:clipdock-runtime.test",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    assert(certificate.status === 0, "LOCAL_CERTIFICATE_GENERATION_FAILED");
    const hashes = Object.fromEntries(
      sourceFiles.map((file) => [file, hash(fs.readFileSync(path.join(repository, file)))]),
    );
    const exports = [
      "export {NetworkRuntime} from './src/main/network/runtime.ts';",
      "export {EgressGate} from './src/main/network/egress-gate.ts';",
      "export {ProofCoordinator} from './src/main/network/proof-coordinator.ts';",
      "export {ensureSessionObservation,installSessionNetworkPolicy,initializeAccountSessionNetwork,setBlockedRequestSink} from './src/main/network/session-observer.ts';",
      "export {installBusinessNetwork,bindAccountWebContents,withBusinessTaskSignal} from './src/main/network/business-access.ts';",
      "export {gatedSessionFetch} from './src/main/network/gated-session-fetch.ts';",
      "export {pageFetch} from './src/main/data/collectors/shared.ts';",
      "export {closeAccountView} from './src/main/network/close-account-view.ts';",
      "export {ensureShellNetworkGuard} from './src/main/network/shell-network-guard.ts';",
      "export {AnonymousProofProbe} from './src/main/network/anonymous-proof-probe.ts';",
    ].join("\n");
    await build({
      stdin: { contents: exports, resolveDir: repository, loader: "ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron"],
      outfile: path.join(temporary, "production.mjs"),
      tsconfig: path.join(repository, "tsconfig.electron.json"),
      logLevel: "silent",
    });
    assert(
      sourceFiles.every((file) => hash(fs.readFileSync(path.join(repository, file))) === hashes[file]),
      "SOURCE_CHANGED_DURING_BUNDLE",
    );
    fs.writeFileSync(path.join(temporary, "source-hashes.json"), JSON.stringify(hashes));
    const environment = { ...process.env, CLIPDOCK_RUNTIME_SMOKE_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const processChild = spawn(electron, [script, ...(http2Mode ? ["--http2"] : [])], {
      cwd: repository,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    processChild.stdout.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-3000);
    });
    processChild.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-3000);
    });
    const watchdog = setTimeout(() => processChild.kill(), 75_000);
    exitCode = await new Promise((resolve) => {
      processChild.once("error", () => resolve(1));
      processChild.once("exit", (code) => resolve(code ?? 1));
    });
    clearTimeout(watchdog);
    const output = path.join(temporary, "result.json");
    if (!fs.existsSync(output)) {
      console.error("Isolated production runtime smoke did not produce a report:", diagnostic);
      return;
    }
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    result.sourceHashes = hashes;
    result.sourcesStillCurrentAtCompletion = sourceFiles.every(
      (file) => hash(fs.readFileSync(path.join(repository, file))) === hashes[file],
    );
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    const rows = result.checks
      .map((check) => "| " + check.name + " | " + (check.passed ? "通过" : "失败") + " |")
      .join("\n");
    const report =
      "# 生产网络模块集成实测" +
      (http2Mode ? "：HTTP/2" : "") +
      "\n\n" +
      "执行时间：" +
      result.executedAt +
      "。运行时：Electron " +
      result.runtime.electron +
      " / Chromium " +
      result.runtime.chromium +
      " / " +
      result.runtime.platform +
      "。\n\n" +
      "本脚本直接打包并加载当前生产 NetworkRuntime、EgressGate、Session 请求钩子、gatedSessionFetch、pageFetch 与 closeAccountView。入口：node scripts/electron-network-runtime-smoke.mjs" +
      (http2Mode ? " --http2" : "") +
      "。\n\n" +
      "**只使用隔离 userData/sessionData、临时分区、本机 TLS 接收端和合成 Cookie。没有打开真实账号，没有访问公网，没有修改 mihomo 或系统证书存储。** 未配置 fixture 信任时先验证匿名探针拒绝自签证书。正向匿名测试仅在隔离子进程包装该私有测试 Session.fetch：生产初始化完成后，核对本机 host/port 与 /robots.txt 完整 URL，安装本轮证书指纹 pin，再委托原始 Chromium fetch；其余 URL 拒绝。业务与壳 fixture 仍仅使用各自 Session 的指纹 pin。没有 ignore-certificate-errors 等开关；正向 fixture 信任覆盖不代表公网默认信任已实测。\n\n" +
      "| 生产模块检查 | 结果 |\n|---|---|\n" +
      rows +
      "\n\n" +
      "受控接收端统计与模块源码哈希见 [结果](./" +
      reportName +
      ".results.json)。初始化顺序：" +
      result.initializationOrder.slice(0, 4).join(" → ") +
      "。\n\n" +
      "许可明确由测试依赖注入：临时域名映射到 127.0.0.1，模型的 DIRECT/CN 等证据是测试数据，不能当作真实出口证明。只把 warmup 间隔缩短至 50ms，使用 30s 许可和 60s 控制器时效供隔离测试；这些数值不是产品默认值的验收结论。\n\n" +
      (http2Mode
        ? "本次服务器仅接受 ALPN h2，接收端逐请求核对 HTTP/2；额外覆盖同一 H2 会话上的多路页面响应和合成流式上传。上传在撤销前后的接收字节数分别记录，不能把停止后已排队字节描述成零窗口。它不证明 QUIC、平台真实上传或 ServiceWorker 恢复兼容性。"
        : "本次覆盖 HTTPS 新请求、受控流式响应、主进程撤销与实际页面销毁。它不证明 HTTP/2、QUIC 或真实上传。") +
      (http2Mode && result.uploadAfterDestruction
        ? " 本轮合成上传预定 " +
          result.receiver["/upload"].expectedUploadBytes +
          " 字节，撤销前收到 " +
          result.uploadAtRevocation.bytes +
          " 字节，确认销毁后累计 " +
          result.uploadAfterDestruction.bytes +
          " 字节；RST code=" +
          result.receiver["/upload"].uploadResetCode +
          "，aborted=" +
          result.receiver["/upload"].uploadAborted +
          "。读取端的 end 事件与完整接收分开统计。"
        : "") +
      "两种本地实验都不证明外部网络、平台登录完整性、打包版路由等价性或外部 TUN 改路由竞态。审计零记录也不能替代接收端零到达证据。" +
      (http2Mode &&
      fs.existsSync(path.join(repository, "docs", "network-runtime-http2-initial-observation.results.json"))
        ? "\n\n首次实验误将 readable end 事件当成完整上传，导致一项断言失败；[原始观察](./network-runtime-http2-initial-observation.results.json)已保留。现同时核对预定字节数、实际字节数、aborted、RST 和销毁后字节稳定性，未把第一次失败改写成通过。"
        : "") +
      (result.failure ? "\n\n本次失败阶段：" + result.failure + "。" : "") +
      (fs.existsSync(path.join(repository, "docs", reportName + "-certificate-pin-failure-20260907.results.json"))
        ? "\n\n本轮旧 fixture 的 Session pin 被生产探针恢复默认验证所覆盖，正向匿名检查失败；[失败记录](./" + reportName + "-certificate-pin-failure-20260907.results.json)已独立保存。随后仅修正隔离测试的本机信任设置，生产证书验证没有放宽。"
        : "") +
      (fs.existsSync(path.join(repository, "docs", reportName + "-certificate-app-event-failure-20260907.results.json"))
        ? "\n\n隔离 app certificate-error 替代尝试中，该次 main-process fetch 未触发监听器，正向检查仍失败；[该次记录](./" + reportName + "-certificate-app-event-failure-20260907.results.json)保留。这里只报告该次未触发，不推断 Electron 永久不支持。"
        : "") +
      "\n";
    fs.writeFileSync(path.join(repository, "docs", reportName + ".md"), report);
    console.log(
      JSON.stringify(
        {
          output: resultPath,
          runtime: result.runtime,
          summary: result.summary,
          failure: result.failure ?? null,
          sourcesStillCurrentAtCompletion: result.sourcesStillCurrentAtCompletion,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    exitCode = 1;
  } finally {
    const resolved = path.resolve(temporary);
    assert(
      path.dirname(resolved) === path.resolve(parentDirectory) &&
        path.basename(resolved).startsWith("runtime-smoke-"),
      "UNSAFE_CLEANUP_TARGET",
    );
    await delay(400);
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch {
      console.error("Isolated smoke directory could not be removed; production data was not touched.");
    }
    process.exitCode = exitCode;
  }
}
async function child() {
  const { app, BrowserWindow, session } = await import("electron");
  const temporary = process.env.CLIPDOCK_RUNTIME_SMOKE_ROOT;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(repository, "docs", ".compare") &&
      path.basename(temporary).startsWith("runtime-smoke-"),
    "ISOLATED_PROFILE_REQUIRED",
  );
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP clipdock-runtime.test 127.0.0.1");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const result = {
    executedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      packaged: app.isPackaged,
      requestedProtocol: http2Mode ? "h2" : "http/1.1",
    },
    isolation: {
      localTlsOnly: true,
      realAccountOpened: false,
      syntheticCookieOnly: true,
      temporaryProfiles: true,
      sessionCertificatePinOnly: false,
      anonymousFixtureTrust: "isolated-private-session-fetch-exact-url-and-fingerprint",
      systemTrustModified: false,
      globalCertificateBypass: false,
      testEvidenceInjection: true,
    },
    checks: [],
    initializationOrder: [],
    receiver: {},
    summary: null,
  };
  const windows = [];
  const anonymousProbes = [];
  const sockets = new Set();
  const h2Sessions = new Map();
  const responses = new Set();
  const blocked = [];
  const cookie = "clipdock_fixture_cookie=synthetic_local_fixture";
  let runtime, coordinator, server, uninstallBusiness, uninstallPolicy, uninstallFixtureCertificateTrust;
  let phase = "initialization";
  function check(name, value) {
    result.checks.push({ name, passed: !!value });
    assert(value, name);
  }
  const count = (pathname) => result.receiver[pathname]?.requests ?? 0;
  try {
    await app.whenReady();
    const key = fs.readFileSync(path.join(temporary, "key.pem"));
    const cert = fs.readFileSync(path.join(temporary, "cert.pem"));
    const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    const receive = (request, response) => {
      const pathname = new URL(request.url, "https://clipdock-runtime.test").pathname;
      const row = (result.receiver[pathname] ??= {
        requests: 0,
        syntheticCookieRequests: 0,
        credentialHeaderRequests: 0,
        chunks: 0,
        closed: 0,
        onlyLoopback: true,
        httpVersions: [],
        negotiatedProtocols: [],
        h2Sessions: [],
        h2StreamIds: [],
      });
      row.requests++;
      row.syntheticCookieRequests += request.headers.cookie === cookie ? 1 : 0;
      row.credentialHeaderRequests +=
        request.headers.cookie || request.headers.authorization || request.headers["proxy-authorization"] ? 1 : 0;
      row.onlyLoopback &&= ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(request.socket.remoteAddress);
      row.httpVersions.push(request.httpVersion);
      row.negotiatedProtocols.push(request.socket.alpnProtocol || null);
      if (request.stream) {
        const h2Session = request.stream.session;
        if (!h2Sessions.has(h2Session)) h2Sessions.set(h2Session, h2Sessions.size + 1);
        row.h2Sessions.push(h2Sessions.get(h2Session));
        row.h2StreamIds.push(request.stream.id);
        request.stream.on("error", () => {});
      }
      response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("cache-control", "no-store");
      if (pathname === "/robots.txt") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "set-cookie": "anonymous_fixture=must_not_persist; Secure; HttpOnly; Path=/",
        });
        response.end("User-agent: *\nDisallow: /\n");
      } else if (pathname === "/upload") {
        responses.add(response);
        row.uploadBytes = 0;
        row.uploadReadableEnded = false;
        row.uploadBodyComplete = false;
        row.uploadAborted = false;
        row.expectedUploadBytes = 128 * 65536;
        request.on("data", (chunk) => {
          row.uploadBytes += chunk.length;
        });
        request.on("aborted", () => {
          row.uploadAborted = true;
        });
        request.on("end", () => {
          row.uploadReadableEnded = true;
          row.uploadBodyComplete = row.uploadBytes === row.expectedUploadBytes;
        });
        response.once("close", () => {
          row.closed++;
          row.uploadResetCode = request.stream?.rstCode ?? null;
          responses.delete(response);
        });
        response.writeHead(200, { "content-type": "text/plain" });
        response.flushHeaders();
      } else if (pathname.startsWith("/stream-")) {
        responses.add(response);
        response.writeHead(200, { "content-type": "text/plain" });
        response.flushHeaders();
        const timer = setInterval(() => {
          row.chunks++;
          response.write("fixture-stream\n");
        }, 40);
        response.once("close", () => {
          row.closed++;
          clearInterval(timer);
          responses.delete(response);
        });
      } else if (pathname === "/page") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local runtime fixture</title><p>local fixture</p>',
        );
      } else {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("fixture-ok");
      }
    };
    server = http2Mode
      ? http2.createSecureServer({ key, cert, allowHTTP1: false }, receive)
      : https.createServer({ key, cert }, receive);
    if (http2Mode)
      server.on("session", (h2Session) => {
        if (!h2Sessions.has(h2Session)) h2Sessions.set(h2Session, h2Sessions.size + 1);
        h2Session.on("error", () => {});
      });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const origin = "https://clipdock-runtime.test:" + port;
    const target = { protocol: "https:", host: "clipdock-runtime.test", port, addressFamily: "ipv4" };
    phase = "anonymous-proof-probe";
    const untrustedProbe = new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 3000 });
    anonymousProbes.push(untrustedProbe);
    const untrusted = await bounded(
      untrustedProbe.probeTls({ host: target.host, port }, new AbortController().signal),
      "UNTRUSTED_PROBE_TIMEOUT",
    );
    check("anonymous TLS probe rejects an untrusted certificate", !untrusted.available);
    check("untrusted anonymous probe has zero HTTP receiver arrivals", count("/robots.txt") === 0);
    await untrustedProbe.dispose();

    // Production explicitly restores default verification, so install the fixture's
    // narrowly pinned trust only immediately before its original Chromium fetch.
    // This private test wrapper is not in production and does not bypass its hooks.
    let probeSession = null;
    let originalProbeFetch = null;
    result.anonymousFixtureCertificateTrust = { accepted: 0, rejected: 0, wrappedFetchCalls: 0, removedAfterProbe: false };
    const captureProbeSession = (created) => {
      probeSession = created;
      originalProbeFetch = created.fetch;
      created.fetch = (url, options) => {
        assert(typeof url === "string" && url === origin + "/robots.txt", "FIXTURE_FETCH_URL_NOT_ALLOWLISTED");
        assert(options?.credentials === "omit" && options?.redirect === "manual", "FIXTURE_FETCH_MUST_STAY_ANONYMOUS");
        result.anonymousFixtureCertificateTrust.wrappedFetchCalls++;
        created.setCertificateVerifyProc((request, callback) => {
          let trusted = false;
          try {
            trusted = request.hostname === target.host &&
              new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
          } catch {}
          result.anonymousFixtureCertificateTrust[trusted ? "accepted" : "rejected"]++;
          callback(trusted ? 0 : -2);
        });
        return originalProbeFetch.call(created, url, options);
      };
    };
    app.once("session-created", captureProbeSession);
    uninstallFixtureCertificateTrust = () => {
      app.removeListener("session-created", captureProbeSession);
      if (probeSession && originalProbeFetch) {
        probeSession.fetch = originalProbeFetch;
        probeSession.setCertificateVerifyProc(null);
      }
      result.anonymousFixtureCertificateTrust.removedAfterProbe = true;
    };
    const trustedProbe = new production.AnonymousProofProbe({ concurrency: 1, timeoutMs: 3000 });
    anonymousProbes.push(trustedProbe);
    const anonymous = await bounded(
      trustedProbe.probeTls({ host: target.host, port }, new AbortController().signal),
      "ANONYMOUS_PROBE_TIMEOUT",
    );
    uninstallFixtureCertificateTrust();
    uninstallFixtureCertificateTrust = null;
    check("anonymous probe observes a fresh pinned fixture response", anonymous.available &&
      anonymous.observation.statusCode === 200 && anonymous.observation.responseFromCache === false);
    check("anonymous receiver sees no credential headers", count("/robots.txt") === 1 &&
      result.receiver["/robots.txt"].credentialHeaderRequests === 0);
    check("anonymous response Cookie is not retained", probeSession &&
      (await probeSession.cookies.get({})).length === 0);
    check("anonymous fixture trust is exact, exercised and removed after the sample",
      result.anonymousFixtureCertificateTrust.accepted >= 1 &&
      result.anonymousFixtureCertificateTrust.wrappedFetchCalls === 1 &&
      result.anonymousFixtureCertificateTrust.removedAfterProbe &&
      !app.commandLine.hasSwitch("ignore-certificate-errors") &&
      !app.commandLine.hasSwitch("ignore-certificate-errors-spki-list"));
    check("TLS observation makes no exit or address-family claim", anonymous.available &&
      !["addressFamily", "exit", "remoteAddress", "route"].some((field) => field in anonymous.observation));
    await trustedProbe.dispose();
    const afterDispose = await trustedProbe.probeTls({ host: target.host, port }, new AbortController().signal);
    check("disposed anonymous sampler cannot send another request", !afterDispose.available && count("/robots.txt") === 1);
    phase = "initialization";
    const ses = session.fromPartition("runtime-fixture-" + crypto.randomUUID(), { cache: false });
    let sessionFetchCalls = 0;
    const rawFetch = ses.fetch.bind(ses);
    ses.fetch = (...args) => {
      sessionFetchCalls++;
      return rawFetch(...args);
    };
    const rawSetProxy = ses.setProxy.bind(ses),
      rawClose = ses.closeAllConnections.bind(ses);
    ses.setProxy = async (options) => {
      result.initializationOrder.push("setProxy:direct:start");
      assert(options.mode === "direct", "ONLY_DIRECT_INITIALIZATION");
      await rawSetProxy(options);
      result.initializationOrder.push("setProxy:direct:done");
    };
    ses.closeAllConnections = async () => {
      result.initializationOrder.push("closeAllConnections:start");
      await rawClose();
      result.initializationOrder.push("closeAllConnections:done");
    };
    ses.setCertificateVerifyProc((request, callback) => {
      let trusted = false;
      try {
        trusted =
          request.hostname === target.host &&
          new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      } catch {}
      callback(trusted ? 0 : -2);
    });
    const accountId = crypto.randomUUID();
    const gate = new production.EgressGate({
      enforcement: "strict",
      timing: { warmupGapMs: 50, proofTtlMs: 30_000, controllerTtlMs: 60_000 },
    });
    let scope;
    const suspensionClosed = [];
    runtime = new production.NetworkRuntime({
      enforcement: "strict",
      networkReadiness: () => true, // Synthetic loopback fixture; never production OS evidence.
      gate,
      resolveScope: (registration) =>
        (scope = {
          accountId: registration.accountId,
          platformId: registration.platformId,
          contextId: registration.contextId,
          catalogVersion: "TEST_ONLY_LOOPBACK_FIXTURE",
          catalogReviewed: true,
          targets: [target],
        }),
      resolveTarget: ({ url }) =>
        url.hostname === target.host && Number(url.port) === port && url.protocol === "https:"
          ? target
          : null,
      onSuspend: () => {
        suspensionClosed.push(!runtime.check(accountId).allowed);
        return Promise.all(
          windows.filter((w) => !w.isDestroyed()).map((w) => production.closeAccountView(w.webContents)),
        ).then(() => undefined);
      },
    });
    uninstallBusiness = production.installBusinessNetwork(runtime);
    uninstallPolicy = production.installSessionNetworkPolicy(runtime);
    production.setBlockedRequestSink((event) =>
      blocked.push({
        phase,
        path: new URL(event.url).pathname,
        reason: event.reason,
        resourceType: event.resourceType,
      }),
    );
    production.ensureSessionObservation(ses, "douyin", accountId);
    await production.initializeAccountSessionNetwork(ses, accountId, "douyin");
    check(
      "direct initialization awaits setProxy then closeAllConnections",
      JSON.stringify(result.initializationOrder.slice(0, 4)) ===
        JSON.stringify([
          "setProxy:direct:start",
          "setProxy:direct:done",
          "closeAllConnections:start",
          "closeAllConnections:done",
        ]),
    );
    check("startup remains closed after initialization", !runtime.check(accountId).allowed);
    await ses.cookies.set({
      url: origin,
      name: "clipdock_fixture_cookie",
      value: "synthetic_local_fixture",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    });
    const createWindow = async (data = true) => {
      const window = new BrowserWindow({
        show: false,
        width: 500,
        height: 350,
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      windows.push(window);
      production.bindAccountWebContents(window.webContents, accountId);
      if (data) await window.loadURL("data:text/html,<title>Local fixture</title>");
      return window;
    };
    let window = await createWindow();
    const rejected = (promise) =>
      bounded(
        Promise.resolve(promise).then(
          () => false,
          () => true,
        ),
        "REQUEST_DID_NOT_SETTLE",
      );
    phase = "shell-guard";
    // This default Session is the production shell's boundary, separate from the account fixture.
    const shellSession = session.defaultSession;
    await shellSession.setProxy({ mode: "direct" });
    await shellSession.closeAllConnections();
    shellSession.setCertificateVerifyProc((request, callback) => {
      let trusted = false;
      try {
        trusted =
          request.hostname === "clipdock-runtime.test" &&
          new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      } catch {}
      callback(trusted ? 0 : -2);
    });
    production.ensureShellNetworkGuard(shellSession, null);
    check(
      "strict shell refuses signed remote image requests",
      await rejected(
        shellSession.fetch(origin + "/shell-blocked?signature=synthetic_fixture_only", {
          credentials: "omit",
        }),
      ),
    );
    check("strict shell request has zero receiver arrivals", count("/shell-blocked") === 0);
    const removeObserve = production.installBusinessNetwork({ enforcement: "observe" });
    try {
      const response = await shellSession.fetch(origin + "/shell-observe", { credentials: "omit" });
      await response.text();
      check(
        "observation preserves shell request behavior on the same transport",
        response.ok && count("/shell-observe") === 1,
      );
    } finally {
      removeObserve();
      production.installBusinessNetwork(runtime);
      await shellSession.closeAllConnections();
    }
    const rendererFetch = (wc, url) =>
      wc.executeJavaScript(
        "(async()=>{try{const r=await fetch(" +
          JSON.stringify(url) +
          ",{credentials:'include'});await r.text();return true}catch{return false}})()",
      );
    const xhr = (wc, url) =>
      wc.executeJavaScript(
        "new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET'," +
          JSON.stringify(url) +
          ");x.withCredentials=true;x.onload=()=>resolve(true);x.onerror=()=>resolve(false);x.onabort=()=>resolve(false);x.send()})",
      );
    phase = "closed";
    const beforeClosedGated = sessionFetchCalls;
    check(
      "closed gatedSessionFetch rejects before business send",
      await rejected(production.gatedSessionFetch(accountId, ses, origin + "/closed-gated")),
    );
    check("closed gatedSessionFetch does not call session.fetch", sessionFetchCalls === beforeClosedGated);
    check(
      "closed raw session.fetch is cancelled by production Session hook",
      await rejected(ses.fetch(origin + "/closed-session", { credentials: "include" })),
    );
    check(
      "closed renderer fetch is cancelled",
      !(await bounded(rendererFetch(window.webContents, origin + "/closed-page"), "CLOSED_PAGE_TIMEOUT")),
    );
    check(
      "closed renderer XHR is cancelled",
      !(await bounded(xhr(window.webContents, origin + "/closed-xhr"), "CLOSED_XHR_TIMEOUT")),
    );
    check(
      "closed requests have zero receiver arrivals",
      ["/closed-gated", "/closed-session", "/closed-page", "/closed-xhr"].every((p) => count(p) === 0),
    );
    check(
      "production hook cancelled each raw closed request",
      ["/closed-session", "/closed-page", "/closed-xhr"].every((p) =>
        blocked.some((event) => event.path === p),
      ),
    );
    phase = "grant";
    gate.setNetworkState({
      controllerReadable: true,
      mode: "rule",
      tun: true,
      rulesVersion: "TEST_ONLY_RULES",
    });
    await runtime.registerSession(ses, accountId, "douyin").ready;
    let sample = 0;
    const evidence = (request) => {
      const at = performance.now(),
        id = ++sample;
      return {
        sampleId: request.requestId,
        generation: gate.generation,
        rulesVersion: "TEST_ONLY_RULES",
        contextId: scope.contextId,
        catalogVersion: scope.catalogVersion,
        observedAtMono: at,
        targets: [
          {
            target,
            route: {
              source: "correlated-connection",
              contextId: scope.contextId,
              rulesVersion: "TEST_ONLY_RULES",
              ruleDecision: "direct",
              connectionId: "TEST_ONLY_CONNECTION_" + id,
              correlationVerified: true,
              chains: ["DIRECT"],
              observedAtMono: at,
            },
            egress: {
              target,
              contextId: scope.contextId,
              ip: "192.0.2.1",
              countryCode: "CN",
              asn: 64512,
              source: "TEST_ONLY_INJECTED_EVIDENCE_NOT_REAL_EGRESS",
              applicabilityVerified: true,
              observedAtMono: at,
            },
            tls: { verified: true, observedAtMono: at },
            dns: { status: "resolved", addressFamily: "ipv4", observedAtMono: at },
          },
        ],
      };
    };
    coordinator = new production.ProofCoordinator({
      gate, scopes: runtime,
      issuerOptions: { warmupGapMs: 50 },
      source: { collect: async (request) => ({
        kind: "evidence", requestId: request.requestId, batch: evidence(request),
      }) },
    });
    check("coordinator construction does not sample or restore permission", sample === 0 && !runtime.check(accountId).allowed);
    coordinator.start();
    await until(() => sample >= 1, "COORDINATOR_FIRST_ROUND_TIMEOUT");
    check("one injected coordinator round does not grant permission", !runtime.check(accountId).allowed);
    await until(() => runtime.check(accountId).allowed, "COORDINATOR_WARMUP_TIMEOUT");
    check(
      "two fresh test evidence rounds grant exact fixture target",
      sample === 2 &&
        runtime.check(accountId, origin + "/allowed-gated").allowed,
    );
    phase = "allowed";
    const main = await production.gatedSessionFetch(accountId, ses, origin + "/allowed-gated");
    check(
      "granted production gatedSessionFetch reaches local TLS receiver",
      main.status === 200 && count("/allowed-gated") === 1,
    );
    check(
      "granted main request carries only the synthetic test Cookie",
      result.receiver["/allowed-gated"].syntheticCookieRequests === 1,
    );
    window = await createWindow(false);
    await window.loadURL(origin + "/page");
    const page = await production.pageFetch(window.webContents, origin + "/allowed-page");
    check(
      "granted production pageFetch reaches receiver",
      page.ok &&
        count("/allowed-page") === 1 &&
        result.receiver["/allowed-page"].syntheticCookieRequests === 1,
    );
    check(
      "granted renderer XHR reaches receiver",
      await bounded(xhr(window.webContents, origin + "/allowed-xhr"), "ALLOWED_XHR_TIMEOUT"),
    );
    phase = "task-cancel";
    const taskAbort = new AbortController();
    let taskOutcome = "pending";
    const taskPending = production
      .withBusinessTaskSignal(taskAbort.signal, () =>
        production.pageFetch(window.webContents, origin + "/stream-task"),
      )
      .then(
        () => {
          taskOutcome = "resolved";
        },
        (error) => {
          taskOutcome = error.name === "AbortError" ? "task-cancelled" : "rejected";
        },
      );
    await until(() => result.receiver["/stream-task"]?.chunks >= 2, "TASK_STREAM_NOT_STARTED");
    taskAbort.abort();
    await bounded(taskPending, "TASK_CANCEL_DID_NOT_SETTLE");
    await until(() => result.receiver["/stream-task"].closed === 1, "TASK_RECEIVER_NOT_CLOSED");
    check("single-task cancellation settles production pageFetch", taskOutcome === "task-cancelled");
    check(
      "single-task cancellation closes its receiver stream",
      result.receiver["/stream-task"].closed === 1,
    );
    check(
      "single-task cancellation preserves the view and account permission",
      !window.webContents.isDestroyed() && runtime.check(accountId).allowed,
    );
    phase = "revoke";
    const operationOutcomes = (result.operationOutcomes = { main: "pending", page: "pending" });
    const activeContents = window.webContents;
    const mainPending = production.gatedSessionFetch(accountId, ses, origin + "/stream-main").then(
      () => {
        operationOutcomes.main = "resolved";
      },
      (error) => {
        operationOutcomes.main = error.code === "NETWORK_DORMANT" ? "network-dormant" : "rejected";
      },
    );
    const pagePending = production.pageFetch(activeContents, origin + "/stream-page").then(
      () => {
        operationOutcomes.page = "resolved";
      },
      (error) => {
        operationOutcomes.page = error.code === "NETWORK_DORMANT" ? "network-dormant" : "rejected";
      },
    );
    const extraPending = [];
    if (http2Mode) {
      operationOutcomes.pageSecond = "pending";
      extraPending.push(
        production.pageFetch(activeContents, origin + "/stream-page-second").then(
          () => {
            operationOutcomes.pageSecond = "resolved";
          },
          (error) => {
            operationOutcomes.pageSecond = error.code === "NETWORK_DORMANT" ? "network-dormant" : "rejected";
          },
        ),
      );
      // The browser owns this synthetic upload, as it owns platform form uploads. Runtime teardown
      // must end it even though it is not a gatedSessionFetch operation. Cap fixture bytes at 8 MiB.
      await activeContents.executeJavaScript(`(() => {
        let chunks = 0;
        const body = new ReadableStream({ async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 20));
          if (++chunks > 128) controller.close();
          else controller.enqueue(new Uint8Array(65536));
        }});
        globalThis.fixtureUpload = fetch(${JSON.stringify(origin + "/upload")}, {
          method: 'POST', credentials: 'include', body, duplex: 'half',
          headers: { 'content-type': 'application/octet-stream' },
        }).then(r => r.text()).then(() => 'completed', () => 'cancelled');
        return true;
      })()`);
    }
    await until(
      () => result.receiver["/stream-main"]?.chunks >= 2 && result.receiver["/stream-page"]?.chunks >= 2,
      "STREAMS_NOT_STARTED",
    );
    check(
      "both in-flight streams carried synthetic Cookie",
      result.receiver["/stream-main"].syntheticCookieRequests === 1 &&
        result.receiver["/stream-page"].syntheticCookieRequests === 1,
    );
    if (http2Mode) {
      await until(
        () =>
          result.receiver["/stream-page-second"]?.chunks >= 2 &&
          result.receiver["/upload"]?.uploadBytes >= 65536,
        "H2_EXTRA_STREAMS_NOT_STARTED",
      );
      check(
        "HTTP/2 fixture negotiates h2 for every received request",
        Object.values(result.receiver).every(
          (row) =>
            row.httpVersions.every((v) => v === "2.0") && row.negotiatedProtocols.every((p) => p === "h2"),
        ),
      );
      check(
        "parallel renderer response streams share one HTTP/2 connection",
        result.receiver["/stream-page"].h2Sessions[0] ===
          result.receiver["/stream-page-second"].h2Sessions[0] &&
          result.receiver["/stream-page"].h2StreamIds[0] !==
            result.receiver["/stream-page-second"].h2StreamIds[0],
      );
      check(
        "synthetic HTTP/2 upload carries only the test Cookie before revocation",
        result.receiver["/upload"].syntheticCookieRequests === 1 &&
          !result.receiver["/upload"].uploadReadableEnded,
      );
      result.uploadAtRevocation = {
        bytes: result.receiver["/upload"].uploadBytes,
        atMono: performance.now(),
      };
    }
    coordinator.stop();
    check("revoke closes authority synchronously", !runtime.check(accountId).allowed);
    check("stopped coordinator has no active source scheduling", !coordinator.snapshot().running);
    await bounded(Promise.all([mainPending, pagePending, ...extraPending]), "REVOKED_OPERATIONS_NOT_SETTLED");
    await runtime.registerSession(ses, accountId, "douyin").ready;
    await until(
      () => result.receiver["/stream-main"].closed === 1 && result.receiver["/stream-page"].closed === 1,
      "RECEIVER_STREAMS_NOT_CLOSED",
    );
    check(
      "in-flight gatedSessionFetch aborts with dormant outcome",
      operationOutcomes.main === "network-dormant",
    );
    check("in-flight pageFetch aborts with dormant outcome", operationOutcomes.page === "network-dormant");
    check("production closeAccountView completes actual destruction", activeContents.isDestroyed());
    if (http2Mode) {
      await until(
        () => result.receiver["/stream-page-second"].closed === 1 && result.receiver["/upload"].closed === 1,
        "H2_EXTRA_STREAMS_NOT_CLOSED",
      );
      result.uploadAfterDestruction = {
        bytes: result.receiver["/upload"].uploadBytes,
        atMono: performance.now(),
      };
      await delay(300);
      check(
        "revocation closes every tested multiplexed response stream",
        operationOutcomes.pageSecond === "network-dormant" &&
          result.receiver["/stream-page-second"].closed === 1,
      );
      check(
        "HTTP/2 upload stops without completing its declared fixture body",
        !result.receiver["/upload"].uploadBodyComplete &&
          result.receiver["/upload"].uploadBytes < result.receiver["/upload"].expectedUploadBytes,
      );
      check(
        "HTTP/2 receiver upload bytes remain stable after confirmed destruction",
        result.receiver["/upload"].uploadBytes === result.uploadAfterDestruction.bytes,
      );
    }
    check(
      "receiver sees both in-flight responses closed",
      result.receiver["/stream-main"].closed === 1 && result.receiver["/stream-page"].closed === 1,
    );
    check(
      "suspend callbacks only observe already closed authority",
      suspensionClosed.length > 0 && suspensionClosed.every(Boolean),
    );
    phase = "after-revoke";
    check(
      "revoked raw session.fetch stays cancelled",
      await rejected(ses.fetch(origin + "/after-session", { credentials: "include" })),
    );
    check(
      "revoked gatedSessionFetch stays rejected",
      await rejected(production.gatedSessionFetch(accountId, ses, origin + "/after-gated")),
    );
    const after = await createWindow();
    check(
      "new renderer remains closed after old view destruction",
      !(await bounded(rendererFetch(after.webContents, origin + "/after-page"), "AFTER_PAGE_TIMEOUT")),
    );
    check(
      "all post-revoke paths have zero receiver arrivals",
      ["/after-session", "/after-gated", "/after-page"].every((p) => count(p) === 0),
    );
    check(
      "all received traffic came from loopback",
      Object.values(result.receiver).every((row) => row.onlyLoopback),
    );
    check(
      "production request hook recorded closed paths",
      blocked.some((e) => e.phase === "closed") && blocked.some((e) => e.phase === "after-revoke"),
    );
    result.blockedByPhase = Object.fromEntries(
      [...new Set(blocked.map((e) => e.phase))].map((p) => [p, blocked.filter((e) => e.phase === p).length]),
    );
  } catch (error) {
    result.failure = phase + ":" + error.message;
  } finally {
    uninstallFixtureCertificateTrust?.();
    coordinator?.dispose();
    for (const probe of anonymousProbes) await probe.dispose().catch(() => undefined);
    if (runtime) await runtime.dispose().catch(() => undefined);
    uninstallPolicy?.();
    uninstallBusiness?.();
    await session.defaultSession.closeAllConnections().catch(() => undefined);
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    for (const response of responses) response.destroy();
    for (const h2Session of h2Sessions.keys()) h2Session.destroy();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    result.summary = {
      passed: result.checks.filter((c) => c.passed).length,
      failed:
        result.checks.filter((c) => !c.passed).length +
        (result.failure && !result.checks.some((c) => !c.passed) ? 1 : 0),
      completed: !result.failure,
    };
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result, null, 2) + "\n");
    app.exit(result.failure ? 1 : 0);
  }
}
