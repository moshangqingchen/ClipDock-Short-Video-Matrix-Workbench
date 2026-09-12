/** Default builds only. --run-once performs one anonymous CONNECT + TLS handshake, no application HTTP. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const host = "oauth2.googleapis.com",
  mixedPort = 10090,
  controllerPort = 9790;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const assert = (value, code) => {
  if (!value) throw new Error(code);
};
const safeError = (error) =>
  /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message ?? "") ? error.message : "PROBE_UNAVAILABLE";
const normalizeAddress = (address) => (address?.startsWith("::ffff:") ? address.slice(7) : address);
function summarizeOwn(raw, tuple, parseScopedConnections, scope) {
  const parsed = parseScopedConnections(raw, scope);
  const matches = parsed.filter(
    (row) =>
      row.host === host &&
      normalizeAddress(row.sourceAddress) === normalizeAddress(tuple.localAddress) &&
      row.sourcePort === tuple.localPort &&
      row.destinationPort === 443 &&
      row.network === "tcp",
  );
  return matches.map((row) => {
    const original = raw.connections.find((entry) => entry.id === row.id),
      meta = original.metadata;
    const chains =
      Array.isArray(original.chains) &&
      original.chains.length > 0 &&
      original.chains.length < 64 &&
      original.chains.every((value) => typeof value === "string" && value.length > 0 && value.length < 1024)
        ? original.chains
        : null;
    const processValue = [meta.process, meta.processName, meta.processPath].find(
      (value) => typeof value === "string" && value.length > 0,
    );
    const processName = processValue ? path.win32.basename(path.posix.basename(processValue)) : null;
    return {
      idHash: sha(row.id),
      targetHost: host,
      destinationPort: row.destinationPort,
      sourceAddressHash: sha(normalizeAddress(row.sourceAddress)),
      sourcePort: row.sourcePort,
      type: row.inboundType,
      expectedHttpsType: row.inboundType === "HTTPS",
      network: row.network,
      route: row.route,
      chainCount: chains?.length ?? null,
      containsDirect: chains ? chains.includes("DIRECT") : null,
      containsReject: chains ? chains.some((name) => name === "REJECT" || name === "REJECT-DROP") : null,
      processName: processName && /^[A-Za-z0-9._ -]{1,128}$/.test(processName) ? processName : null,
      processIdentity: row.processIdentity,
      startAtMs: row.startedAtMs,
      sniffHostMatches: row.sniffHost === host,
      sniffHostAbsent: row.sniffHost === null,
    };
  });
}

if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const run = process.argv.includes("--run-once");
  assert(
    process.argv.slice(2).every((arg) => ["--run-once", "--build-only"].includes(arg)) &&
      !(run && process.argv.includes("--build-only")),
    "INVALID_ARGUMENTS",
  );
  const { build } = await import("esbuild"),
    { spawn } = await import("node:child_process"),
    { default: electron } = await import("electron");
  const base = path.join(repository, "docs/.compare");
  fs.mkdirSync(base, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(base, "global-proxy-context-"));
  let report = null,
    reportFile = null,
    watchdog = false,
    childExit = null;
  try {
    const built = await build({
      stdin: {
        contents: [
          "export {ClashReader} from './src/main/network/clash-reader.ts';",
          "export {parseScopedConnections,connectionHostScope} from './src/main/network/connection-evidence.ts';",
        ].join("\n"),
        resolveDir: repository,
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      external: ["electron"],
      tsconfig: path.join(repository, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.mjs"),
      metafile: true,
      logLevel: "silent",
    });
    const hashes = Object.fromEntries(
      Object.keys(built.metafile.inputs)
        .filter((file) => file.startsWith("src/"))
        .map((file) => [file, sha(fs.readFileSync(path.join(repository, file)))]),
    );
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    const tuple = {
      localAddress: "127.0.0.1",
      localPort: 45678,
      remoteAddress: "127.0.0.1",
      remotePort: mixedPort,
    };
    const makeRow = (id, metadata = {}) => ({
      id,
      start: new Date().toISOString(),
      chains: ["private-node", "private-group"],
      metadata: {
        host,
        sourceIP: tuple.localAddress,
        sourcePort: String(tuple.localPort),
        destinationPort: "443",
        network: "tcp",
        type: "HTTPS",
        processPath: "C:\\private-user\\electron.exe",
        ...metadata,
      },
    });
    const raw = {
      connections: [
        makeRow("own"),
        makeRow("other-port", { sourcePort: "45679" }),
        makeRow("other-host", { host: "unrelated.test" }),
      ],
    };
    const projected = summarizeOwn(
      raw,
      tuple,
      production.parseScopedConnections,
      production.connectionHostScope([host]),
    );
    assert(
      projected.length === 1 && projected[0].type === "HTTPS" && projected[0].containsDirect === false,
      "LOCAL_OWNERSHIP_FAILED",
    );
    assert(
      !JSON.stringify(projected).includes("private-") && projected[0].processName === "electron.exe",
      "LOCAL_REDACTION_FAILED",
    );
    raw.connections[0].chains = ["DIRECT", "REJECT"];
    const rejected = summarizeOwn(
      raw,
      tuple,
      production.parseScopedConnections,
      production.connectionHostScope([host]),
    )[0];
    assert(rejected.containsDirect && rejected.containsReject, "LOCAL_ROUTE_FLAGS_FAILED");
    if (!run) {
      console.log(
        JSON.stringify({ buildOnly: true, localChecks: 3, controllerReads: 0, connect: 0, tls: 0 }),
      );
      return;
    }
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
    reportFile = path.join(repository, `docs/global-proxy-context.${timestamp}.results.json`);
    const env = { ...process.env, CLIPDOCK_GLOBAL_PROXY_PROBE_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, "--run-once"], {
      cwd: repository,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const timer = setTimeout(() => {
      watchdog = true;
      worker.kill();
    }, 40_000);
    childExit = await new Promise((resolve) => {
      worker.once("exit", (code) => resolve(code ?? 1));
      worker.once("error", () => resolve(1));
    });
    clearTimeout(timer);
    const checkpoint = path.join(temporary, "result.json");
    report = fs.existsSync(checkpoint)
      ? JSON.parse(fs.readFileSync(checkpoint, "utf8"))
      : { failure: "CHILD_NO_CHECKPOINT" };
    report.scriptHash = sha(fs.readFileSync(script));
    report.sourceHashes = hashes;
    report.sourceHashesStable = Object.entries(hashes).every(
      ([file, hash]) => sha(fs.readFileSync(path.join(repository, file))) === hash,
    );
    report.parent = { childExit, watchdog, localChecks: 3 };
  } catch (error) {
    if (run) report = { ...(report ?? {}), failure: safeError(error), parent: { childExit, watchdog } };
    else {
      console.error(safeError(error));
      process.exitCode = 1;
    }
  } finally {
    const resolved = path.resolve(temporary);
    assert(
      path.dirname(resolved) === path.resolve(base) &&
        path.basename(resolved).startsWith("global-proxy-context-"),
      "UNSAFE_TEMPORARY_PATH",
    );
    let removed = false;
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      removed = !fs.existsSync(resolved);
    } catch {
      /* Retain no raw body or log files. */
    }
    if (report) {
      report.rawTemporaryDataRemoved = removed;
      reportFile ??= path.join(repository, `docs/global-proxy-context.${Date.now()}.results.json`);
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
      console.log(
        JSON.stringify({
          report: path.relative(repository, reportFile),
          failure: report.failure ?? null,
          stages: report.stages?.map((stage) => ({
            phase: stage.phase,
            unique: stage.unique,
            exactHttpsCount: stage.exactHttpsCount,
            type: stage.matches.map((row) => row.type),
            containsDirect: stage.matches.map((row) => row.containsDirect),
          })),
          tls: report.tls,
          counts: report.counts,
          cleanup: report.cleanup,
          sourceHashesStable: report.sourceHashesStable,
          rawTemporaryDataRemoved: removed,
        }),
      );
      process.exitCode = report.failure || childExit !== 0 || !removed || !report.sourceHashesStable ? 1 : 0;
    }
  }
}

async function child() {
  const { app, BrowserWindow, webContents } = await import("electron"),
    http = await import("node:http"),
    net = await import("node:net"),
    tls = await import("node:tls");
  const temporary = process.env.CLIPDOCK_GLOBAL_PROXY_PROBE_ROOT;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(repository, "docs/.compare") &&
      path.basename(temporary).startsWith("global-proxy-context-"),
    "ISOLATION_REQUIRED",
  );
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const result = {
    executedAt: new Date().toISOString(),
    runtime: { electron: process.versions.electron, node: process.versions.node },
    target: { host, port: 443 },
    controller: { host: "127.0.0.1", port: controllerPort },
    mixed: { host: "127.0.0.1", port: mixedPort },
    isolation: {
      temporaryUserData: true,
      accountCreated: false,
      accountSessionCreated: false,
      cookieOrTokenProvided: false,
      applicationHttpSent: false,
      systemProxyChanged: false,
      tunChanged: false,
      kernelConfigChanged: false,
      otherConnectionsClosed: false,
      sourceProfile: "isolated-electron-main-node-connect-anonymous-tls",
      productionTransportChanged: false,
    },
    counts: {
      controllerBatches: 0,
      scopedConnectionReads: 0,
      connectRequests: 0,
      tlsHandshakes: 0,
      applicationHttp: 0,
    },
    stages: [],
    tls: null,
    configuration: null,
    tuple: null,
    cleanup: null,
    failure: null,
  };
  const save = () => fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
  save();
  const abort = new AbortController(),
    ownSockets = new Set(),
    ownRequests = new Set(),
    drains = [];
  const deadline = performance.now() + 30_000;
  const own = (socket) => {
    ownSockets.add(socket);
    socket.on("error", () => {});
    drains.push(
      new Promise((resolve) =>
        socket.once("close", () => {
          ownSockets.delete(socket);
          resolve();
        }),
      ),
    );
    return socket;
  };
  const stop = () => {
    for (const socket of ownSockets) socket.destroy();
    for (const req of ownRequests) req.destroy();
  };
  abort.signal.addEventListener("abort", stop);
  const timer = setTimeout(() => abort.abort(), 30_000);
  const guard = () => {
    assert(!abort.signal.aborted && performance.now() < deadline, "PROBE_DEADLINE");
  };
  const timed = (promise, ms, code) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const end = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        abort.signal.removeEventListener("abort", cancelled);
        error ? reject(error) : resolve(value);
      };
      const cancelled = () => end(new Error("PROBE_DEADLINE"));
      const t = setTimeout(() => end(new Error(code)), ms);
      abort.signal.addEventListener("abort", cancelled, { once: true });
      promise.then(
        (value) => end(null, value),
        (error) => end(error),
      );
      if (abort.signal.aborted) cancelled();
    });
  let reader, production, tuple;
  try {
    await app.whenReady();
    guard();
    assert(process.versions.electron === "43.3.0", "ELECTRON_VERSION_CHANGED");
    production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    reader = new production.ClashReader({
      controllerUrl: `http://127.0.0.1:${controllerPort}`,
      getSecret: () => null,
    });
    result.counts.controllerBatches++;
    const before = await reader.read();
    guard();
    result.configuration = {
      before: {
        mode: before.mode,
        tun: before.tun,
        mixedPort: before.mixedPort,
        version: before.version,
        fingerprint: before.fingerprint,
        startedAtMono: before.startedAtMono,
        completedAtMono: before.completedAtMono,
      },
      after: null,
      stable: false,
    };
    assert(before.mixedPort === mixedPort, "MIXED_PORT_CHANGED");
    save();
    const tunnel = own(net.createConnection({ host: "127.0.0.1", port: mixedPort }));
    await timed(
      new Promise((resolve, reject) => {
        tunnel.once("connect", resolve);
        tunnel.once("error", () => reject(new Error("MIXED_CONNECT_FAILED")));
      }),
      3000,
      "MIXED_CONNECT_TIMEOUT",
    );
    tuple = {
      localAddress: tunnel.localAddress,
      localPort: tunnel.localPort,
      remoteAddress: tunnel.remoteAddress,
      remotePort: tunnel.remotePort,
    };
    assert(
      tuple.localAddress === "127.0.0.1" &&
        tuple.remoteAddress === "127.0.0.1" &&
        tuple.remotePort === mixedPort &&
        tuple.localPort > 0,
      "TUPLE_INVALID",
    );
    result.tuple = {
      localAddressHash: sha(tuple.localAddress),
      localPort: tuple.localPort,
      remoteAddressHash: sha(tuple.remoteAddress),
      remotePort: tuple.remotePort,
      tupleHash: sha(JSON.stringify(tuple)),
    };
    const phase = async (name) => {
      guard();
      const startedAtMono = performance.now();
      result.counts.scopedConnectionReads++;
      const raw = await new Promise((resolve, reject) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: controllerPort,
            path: "/connections",
            method: "GET",
            agent: false,
            headers: { Accept: "application/json", Connection: "close" },
            maxHeaderSize: 8192,
          },
          (incoming) => {
            if (incoming.statusCode !== 200 || incoming.headers["content-encoding"]) {
              incoming.destroy();
              reject(new Error("CONNECTION_READ_UNAVAILABLE"));
              return;
            }
            const chunks = [];
            let length = 0;
            incoming.on("data", (chunk) => {
              length += chunk.length;
              if (length > 8 * 1024 * 1024) {
                incoming.destroy();
                reject(new Error("CONNECTION_READ_TOO_LARGE"));
              } else chunks.push(chunk);
            });
            incoming.once("error", () => reject(new Error("CONNECTION_READ_FAILED")));
            incoming.once("end", () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              } catch {
                reject(new Error("CONNECTION_READ_INVALID"));
              }
            });
          },
        );
        ownRequests.add(request);
        request.once("close", () => ownRequests.delete(request));
        request.once("socket", own);
        request.once("error", () => reject(new Error("CONNECTION_READ_FAILED")));
        request.setTimeout(2000, () => {
          request.destroy();
          reject(new Error("CONNECTION_READ_TIMEOUT"));
        });
        request.end();
      });
      guard();
      const matches = summarizeOwn(
        raw,
        tuple,
        production.parseScopedConnections,
        production.connectionHostScope([host]),
      );
      result.stages.push({
        phase: name,
        startedAtMono,
        completedAtMono: performance.now(),
        matches,
        unique: matches.length === 1,
        exactHttpsCount: matches.filter((row) => row.expectedHttpsType).length,
      });
      save();
    };
    await phase("before-connect-request");
    guard();
    result.counts.connectRequests++;
    const connected = new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const receive = (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 16_384) {
          tunnel.off("data", receive);
          reject(new Error("CONNECT_HEADER_TOO_LARGE"));
          return;
        }
        const boundary = bytes.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        tunnel.off("data", receive);
        tunnel.pause();
        const line = bytes.subarray(0, bytes.indexOf("\r\n")).toString("ascii");
        if (!/^HTTP\/1\.[01] 200(?: |$)/.test(line) || boundary + 4 !== bytes.length)
          reject(new Error("CONNECT_RESPONSE_REJECTED"));
        else resolve();
      };
      tunnel.on("data", receive);
      tunnel.once("error", () => reject(new Error("CONNECT_FAILED")));
      tunnel.once("end", () => reject(new Error("CONNECT_ENDED")));
      tunnel.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nConnection: close\r\n\r\n`);
    });
    await timed(connected, 8000, "CONNECT_TIMEOUT");
    guard();
    result.connectCompletedAtMono = performance.now();
    save();
    await phase("after-connect-before-tls");
    guard();
    result.counts.tlsHandshakes++;
    const startedAtMono = performance.now();
    const secured = own(
      tls.connect({
        socket: tunnel,
        servername: host,
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"],
      }),
    );
    try {
      await timed(
        new Promise((resolve, reject) => {
          secured.once("secureConnect", resolve);
          secured.once("error", (error) =>
            reject(new Error(/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code ?? "") ? error.code : "TLS_FAILED")),
          );
        }),
        10_000,
        "TLS_TIMEOUT",
      );
      result.tls = {
        available: secured.authorized === true,
        startedAtMono,
        completedAtMono: performance.now(),
        certificateAuthorized: secured.authorized === true,
        protocol: secured.getProtocol(),
        alpn: secured.alpnProtocol || null,
      };
    } catch (error) {
      result.tls = {
        available: false,
        startedAtMono,
        completedAtMono: performance.now(),
        error: safeError(error),
      };
    }
    save();
    await phase("after-tls-attempt");
    result.counts.controllerBatches++;
    const after = await reader.read();
    guard();
    result.configuration.after = {
      mode: after.mode,
      tun: after.tun,
      mixedPort: after.mixedPort,
      version: after.version,
      fingerprint: after.fingerprint,
      startedAtMono: after.startedAtMono,
      completedAtMono: after.completedAtMono,
    };
    result.configuration.stable =
      before.fingerprint === after.fingerprint && before.mixedPort === after.mixedPort;
    assert(result.configuration.stable, "CONTROLLER_CHANGED");
    assert(
      result.counts.connectRequests === 1 &&
        result.counts.tlsHandshakes === 1 &&
        result.counts.applicationHttp === 0,
      "REQUEST_BOUND_EXCEEDED",
    );
    if (!result.tls.available) result.failure = "TLS_UNAVAILABLE";
  } catch (error) {
    result.failure = safeError(error);
  } finally {
    clearTimeout(timer);
    abort.abort();
    stop();
    let drained = false;
    await Promise.race([
      Promise.allSettled(drains).then(() => {
        drained = true;
      }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await reader?.whenIdle();
    result.cleanup = {
      ownSocketCloseObserved: drained && ownSockets.size === 0,
      remainingSockets: ownSockets.size,
      remainingRequests: ownRequests.size,
      windows: BrowserWindow.getAllWindows().length,
      webContents: webContents.getAllWebContents().length,
      listenerCreated: false,
      sessionCreated: false,
      controllerBatchNativeCloseObserved: false,
    };
    if (!result.cleanup.ownSocketCloseObserved || result.cleanup.remainingRequests)
      result.failure ??= "CLEANUP_UNCERTAIN";
    result.completedAt = new Date().toISOString();
    save();
    app.exit(result.failure ? 1 : 0);
  }
}
