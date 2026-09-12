/** Isolated production source lifecycle. Only the chosen local files and four loopback GETs are allowed. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const preparationCheck = process.argv.includes("--preparation-unavailable");
const resultPath = path.join(
  root,
  preparationCheck
    ? "docs/network-proof-preparation-unavailable-smoke.results.json"
    : "docs/network-proof-source-runtime-smoke.results.json",
);
const resources = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\MAOMAOYUNAPP\\resources";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const assert = (value, code) => {
  if (!value) throw Error(code);
};
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild");
  const parentDirectory = path.join(root, "docs/.compare");
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "proof-source-runtime-smoke-"));
  const sourceHashes = {};
  try {
    const built = await build({
      stdin: {
        contents: [
          "export { ProductionProofRuntime } from './src/main/network/production-proof-runtime.ts';",
          "export { SelectedClientConfig } from './src/main/network/selected-client-config.ts';",
          "export { ClashReader } from './src/main/network/clash-reader.ts';",
        ].join("\n"),
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron", "node:*"],
      tsconfig: path.join(root, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.mjs"),
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "capture-actual-source-inputs",
          setup(builder) {
            builder.onLoad({ filter: /[/\\]src[/\\].*\.tsx?$/ }, (args) => {
              const relative = path.relative(root, args.path).split(path.sep).join("/");
              if (!relative.startsWith("src/")) return;
              const bytes = fs.readFileSync(args.path);
              sourceHashes[relative] = sha(bytes);
              return { contents: bytes.toString("utf8"), loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
            });
          },
        },
      ],
    });
    assert(
      !Object.keys(built.metafile.inputs).some((value) =>
        /(?:babel|@electron\/asar|typescript|node:vm)/.test(value),
      ),
      "UNEXPECTED_EXPLORATION_DEPENDENCY",
    );
    assert(Object.keys(sourceHashes).length > 10, "SOURCE_CAPTURE_INCOMPLETE");
    const stable = () =>
      Object.entries(sourceHashes).every(
        ([file, value]) => sha(fs.readFileSync(path.join(root, file))) === value,
      );
    assert(stable(), "SOURCE_CHANGED_DURING_BUILD");
    if (process.argv.includes("--build-only")) {
      console.log(
        JSON.stringify({
          buildOnly: true,
          capturedSources: Object.keys(sourceHashes).length,
          sourceHashesStable: true,
          electronChildStarted: false,
          controllerRequests: 0,
          publicRequests: 0,
        }),
      );
      return;
    }
    const { spawn } = await import("node:child_process");
    const { default: electron } = await import("electron");
    const environment = { ...process.env, CLIPDOCK_PROOF_SOURCE_RUNTIME_SMOKE_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const startedAt = new Date().toISOString();
    const worker = spawn(electron, [script, ...(preparationCheck ? ["--preparation-unavailable"] : [])], {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const timer = setTimeout(() => worker.kill(), 30000);
    const code = await new Promise((resolve) => {
      worker.once("exit", (value) => resolve(value ?? 1));
      worker.once("error", () => resolve(1));
    });
    clearTimeout(timer);
    const childResult = path.join(temporary, "result.json");
    const result = fs.existsSync(childResult)
      ? JSON.parse(fs.readFileSync(childResult, "utf8"))
      : {
          executedAt: startedAt,
          completedAt: new Date().toISOString(),
          checks: [],
          failure: "CHILD_RESULT_UNAVAILABLE",
          permissionIssued: false,
        };
    result.sourceHashes = sourceHashes;
    result.sourceHashesStable = stable();
    result.scriptHash = sha(fs.readFileSync(script));
    result.bundleHash = sha(fs.readFileSync(path.join(temporary, "production.mjs")));
    result.childExitCode = code;
    result.bundleHasExplorationRuntimeDependencies = false;
    if (fs.existsSync(resultPath)) {
      const previous = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const history = resultPath.replace(
        ".results.json",
        `.${previous.executedAt.replace(/[^0-9TZ]/g, "")}.results.json`,
      );
      if (!fs.existsSync(history)) fs.copyFileSync(resultPath, history, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(
      JSON.stringify(
        {
          checks: result.checks,
          counts: result.counts,
          source: result.source,
          disposal: result.disposal,
          sourceHashesStable: result.sourceHashesStable,
          failure: result.failure ?? null,
        },
        null,
        2,
      ),
    );
    process.exitCode = code || result.failure || !result.sourceHashesStable ? 1 : 0;
  } catch (error) {
    console.error(
      /^[A-Z_]{1,100}$/.test(error.message) ? error.message : "PROOF_SOURCE_RUNTIME_SMOKE_FAILED",
    );
    process.exitCode = 1;
  } finally {
    const resolved = path.resolve(temporary);
    assert(
      path.dirname(resolved) === path.resolve(parentDirectory) &&
        path.basename(resolved).startsWith("proof-source-runtime-smoke-"),
      "UNSAFE_TEMPORARY_PATH",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch {
      /* Isolated data is never reused. */
    }
  }
}

async function child() {
  const { app, net, session, BaseWindow, webContents } = await import("electron");
  const temporary = process.env.CLIPDOCK_PROOF_SOURCE_RUNTIME_SMOKE_ROOT;
  assert(
    temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
      path.basename(temporary).startsWith("proof-source-runtime-smoke-"),
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
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome },
    isolation: {
      temporaryUserData: true,
      defaultComponents: true,
      enforcement: preparationCheck ? "strict-isolated-no-review" : "observe",
      readVersion: preparationCheck ? "current-controller" : null,
      explicitlySelectedClient: "MAOMAOYUNAPP-5.5.6",
      controller: "http://127.0.0.1:9790",
      accountCreated: false,
      configurationChanged: false,
      previousReportUsedAsInput: false,
      vendorCodeExecuted: false,
      decoderMaterialPersisted: false,
      productionDefaultSelectionChanged: false,
    },
    counts: {
      controllerRequests: 0,
      controllerReads: 0,
      sourceReads: 0,
      sourceCandidates: 0,
      sessionAttempts: 0,
      electronRequestAttempts: 0,
      defaultSessionRequests: 0,
      dnsAttempts: 0,
      nonControllerHttpAttempts: 0,
      httpsAttempts: 0,
      fetchAttempts: 0,
      commandAttempts: 0,
      invalidations: 0,
      versionReads: 0,
      reviewReads: 0,
      quietChecks: 0,
    },
    controllerEndpoints: {},
    checks: [],
    source: null,
    collect: null,
    disposal: null,
    permissionIssued: false,
    pathQualificationCreated: false,
  };
  const check = (name, value) => {
    result.checks.push({ name, passed: Boolean(value) });
    assert(value, name);
  };
  const boundaryCounts = () => ({ ...result.counts, invalidations: 0 });
  const requestsUnchanged = (before) => JSON.stringify(before) === JSON.stringify(boundaryCounts());
  const ioCounts = () => ({ ...boundaryCounts(), versionReads: 0, reviewReads: 0, quietChecks: 0 });
  let runtime;
  try {
    await app.whenReady();
    const [{ default: http }, { default: https }, { default: dns }, childProcess, { syncBuiltinESMExports }] =
      await Promise.all([
        import("node:http"),
        import("node:https"),
        import("node:dns"),
        import("node:child_process"),
        import("node:module"),
      ]);
    const endpoints = new Set(["/configs", "/rules", "/version", "/proxies/DIRECT"]);
    const originalRequest = http.request;
    http.request = function (options, callback) {
      if (String(options?.path ?? "").startsWith("/dns/")) result.counts.dnsAttempts++;
      if (!(
        options &&
        options.hostname === "127.0.0.1" &&
        Number(options.port) === 9790 &&
        options.method === "GET" &&
        endpoints.has(options.path)
      )) {
        result.counts.nonControllerHttpAttempts++;
        throw Error("NON_CONTROLLER_HTTP_FORBIDDEN");
      }
      assert(
        !Object.keys(options.headers ?? {}).some((key) => /cookie|authorization/i.test(key)),
        "AUTH_HEADER_FORBIDDEN",
      );
      assert(result.counts.controllerRequests < 8, "CONTROLLER_REQUEST_LIMIT");
      result.counts.controllerRequests++;
      result.controllerEndpoints[options.path] = (result.controllerEndpoints[options.path] ?? 0) + 1;
      return originalRequest.call(this, options, callback);
    };
    http.get = () => {
      result.counts.nonControllerHttpAttempts++;
      throw Error("HTTP_GET_FORBIDDEN");
    };
    https.request = https.get = () => {
      result.counts.httpsAttempts++;
      throw Error("HTTPS_FORBIDDEN");
    };
    dns.lookup = () => {
      result.counts.dnsAttempts++;
      throw Error("DNS_FORBIDDEN");
    };
    dns.promises.lookup = dns.promises.resolve = () => {
      result.counts.dnsAttempts++;
      throw Error("DNS_FORBIDDEN");
    };
    for (const name of ["spawn", "exec", "execFile", "spawnSync", "execSync", "execFileSync"])
      childProcess.default[name] = () => {
        result.counts.commandAttempts++;
        throw Error("COMMAND_FORBIDDEN");
      };
    syncBuiltinESMExports();
    globalThis.fetch = () => {
      result.counts.fetchAttempts++;
      throw Error("FETCH_FORBIDDEN");
    };
    session.fromPartition = () => {
      result.counts.sessionAttempts++;
      throw Error("SESSION_FORBIDDEN");
    };
    net.request = net.fetch = () => {
      result.counts.electronRequestAttempts++;
      throw Error("ELECTRON_REQUEST_FORBIDDEN");
    };
    session.defaultSession.fetch = () => {
      result.counts.electronRequestAttempts++;
      throw Error("DEFAULT_FETCH_FORBIDDEN");
    };
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => {
      result.counts.defaultSessionRequests++;
      callback({ cancel: true });
    });

    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    const originalControllerRead = production.ClashReader.prototype.read;
    production.ClashReader.prototype.read = async function (...args) {
      result.counts.controllerReads++;
      const value = await originalControllerRead.apply(this, args);
      result.controller = {
        mode: value.mode,
        tun: value.tun,
        kernelVersion: value.version,
        ruleCount: value.rules.length,
        fingerprint: value.fingerprint,
        startedAtMono: value.startedAtMono,
        completedAtMono: value.completedAtMono,
      };
      return value;
    };
    const originalSourceRead = production.SelectedClientConfig.prototype.read;
    production.SelectedClientConfig.prototype.read = async function (...args) {
      result.counts.sourceReads++;
      const value = await originalSourceRead.apply(this, args);
      if (value.state === "candidate") {
        result.counts.sourceCandidates++;
        result.source = {
          state: value.state,
          kind: value.candidate.kind,
          runtimeConfigurationProven: value.candidate.runtimeConfigurationProven,
          ruleCount: value.candidate.comparedRuleCount,
          controllerFingerprint: value.candidate.controllerFingerprint,
          startedAtMono: value.candidate.startedAtMono,
          completedAtMono: value.candidate.completedAtMono,
          expiresAtMono: value.candidate.expiresAtMono,
        };
      } else result.source = { state: value.state, reason: value.reason ?? null };
      return value;
    };
    const configFile = path.join(resources, "extra/config.yaml");
    const configHash = () => {
      const stat = fs.statSync(configFile);
      assert(stat.isFile() && stat.size > 0 && stat.size < 8 * 1024 * 1024, "CONFIG_SIZE_INVALID");
      return sha(fs.readFileSync(configFile));
    };
    const beforeConfig = configHash();
    let quietEnabled = true,
      selectedReview = null;
    runtime = new production.ProductionProofRuntime({
      enforcement: preparationCheck ? "strict" : "observe",
      settings: () => ({
        controllerUrl: "http://127.0.0.1:9790",
        diagnosticProxyPort: 10090,
        selectedClientResourcesPath: resources,
      }),
      getSecret: () => null,
      readVersion: () => {
        result.counts.versionReads++;
        return preparationCheck && result.controller
          ? { generation: 1, rulesVersion: result.controller.fingerprint }
          : null;
      },
      onInvalidated: () => {
        result.counts.invalidations++;
      },
      ...(preparationCheck
        ? {
            preparation: {
              readReview: () => {
                result.counts.reviewReads++;
                return selectedReview;
              },
              isQuiescent: () => {
                result.counts.quietChecks++;
                return (
                  quietEnabled &&
                  result.counts.sessionAttempts === 0 &&
                  BaseWindow.getAllWindows().length === 0 &&
                  webContents.getAllWebContents().length === 0
                );
              },
            },
          }
        : {}),
    });
    check(
      "CONSTRUCTION_PERFORMS_NO_SOURCE_OR_CONTROLLER_READ",
      result.counts.sourceReads === 0 && result.counts.controllerRequests === 0,
    );
    check("CONSTRUCTION_CREATES_NO_ANONYMOUS_SESSION", result.counts.sessionAttempts === 0);
    check(
      "REFRESH_BEFORE_START_IS_CLOSED",
      (await runtime.refresh()) === false && result.counts.controllerRequests === 0,
    );
    const familyOrigin = { protocol: "https:", host: "api.bilibili.com", port: 443 };
    check(
      "FAMILY_PROJECTION_BEFORE_START_IS_CLOSED",
      runtime.resolveAddressFamilies(familyOrigin) === null && result.counts.sourceReads === 0,
    );
    runtime.start();
    check("START_AND_JOINED_REFRESH_READ_CURRENT_SOURCE", (await runtime.refresh()) === true);
    check(
      "ONE_CURRENT_SOURCE_AND_CONTROLLER_BATCH",
      result.counts.sourceReads === 1 &&
        result.counts.sourceCandidates === 1 &&
        result.counts.controllerReads === 1 &&
        result.counts.controllerRequests === 4 &&
        Object.keys(result.controllerEndpoints).length === 4,
    );
    check(
      "CURRENT_SOURCE_MATCHES_LIVE_CONTROLLER",
      result.source?.controllerFingerprint === result.controller?.fingerprint &&
        result.source?.ruleCount === result.controller?.ruleCount,
    );
    check("CANDIDATE_IS_NOT_RUNTIME_ATTESTATION", result.source?.runtimeConfigurationProven === false);
    if (preparationCheck) {
      const before = JSON.stringify(ioCounts());
      const prepare = () => runtime.prepareQualification(new AbortController().signal);
      check("EXPLICIT_PREPARATION_WITHOUT_REVIEW_REFUSED", (await prepare()) === false);
      check(
        "MISSING_REVIEW_WAS_READ_WITHOUT_SAMPLING",
        result.counts.reviewReads === 1 && JSON.stringify(ioCounts()) === before,
      );
      quietEnabled = false;
      const reads = result.counts.reviewReads;
      check(
        "NONQUIET_PREPARATION_REFUSED",
        (await prepare()) === false && result.counts.reviewReads === reads,
      );
      quietEnabled = true;
      selectedReview = {}; // Deliberately invalid metadata, never a valid review or evidence artifact.
      check(
        "MALFORMED_REVIEW_REFUSED_BEFORE_SAMPLING",
        (await prepare()) === false && JSON.stringify(ioCounts()) === before,
      );
      const cancelled = new AbortController();
      cancelled.abort();
      check(
        "CANCELLED_PREPARATION_REFUSED",
        (await runtime.prepareQualification(cancelled.signal)) === false,
      );
      check(
        "PREPARATION_USED_SAME_SELECTED_SOURCE",
        result.counts.sourceReads === 1 && result.counts.controllerRequests === 4,
      );
    }
    const beforeFamilies = JSON.stringify(ioCounts());
    check(
      "UNQUALIFIED_FAMILY_PROJECTION_DOES_NOT_SAMPLE",
      runtime.resolveAddressFamilies(familyOrigin) === null && JSON.stringify(ioCounts()) === beforeFamilies,
    );
    const beforeCollect = boundaryCounts();
    const beforeCollectIo = JSON.stringify(ioCounts());
    const output = await runtime.collect({
      generation: 1,
      rulesVersion: preparationCheck ? result.controller.fingerprint : "0".repeat(64),
      requestId: "isolated-no-qualification",
      startedAtMono: performance.now(),
      signal: new AbortController().signal,
      scope: {
        accountId: "00000000-0000-4000-8000-000000000001",
        platformId: "bilibili",
        contextId: "synthetic-not-an-account-session",
        catalogVersion: "synthetic-no-review",
        catalogReviewed: false,
        targets: [{ protocol: "https:", host: "api.bilibili.com", port: 443, addressFamily: "ipv4" }],
      },
    });
    result.collect = { kind: output.kind, reason: output.kind === "unavailable" ? output.reason : null };
    check(
      preparationCheck ? "MISSING_QUALIFICATION_COLLECT_REFUSED" : "OBSERVE_COLLECT_CANNOT_ISSUE_EVIDENCE",
      output.kind === "unavailable",
    );
    check(
      preparationCheck
        ? "COLLECT_DOES_NOT_PREPARE_OR_SAMPLE"
        : "OBSERVE_COLLECT_DOES_NOT_READ_VERSION_OR_START_IO",
      preparationCheck
        ? JSON.stringify(ioCounts()) === beforeCollectIo &&
            result.counts.reviewReads === beforeCollect.reviewReads
        : requestsUnchanged(beforeCollect),
    );
    const disposalStarted = performance.now();
    const disposal = runtime.dispose();
    check("DISPOSE_IS_IDEMPOTENT", runtime.dispose() === disposal);
    await disposal;
    result.disposal = { completed: true, durationMs: performance.now() - disposalStarted };
    check("DISPOSE_DRAINS_COMPONENTS", result.disposal.completed === true);
    const afterDispose = boundaryCounts();
    check(
      "FAMILY_PROJECTION_AFTER_DISPOSE_IS_CLOSED",
      runtime.resolveAddressFamilies(familyOrigin) === null && requestsUnchanged(afterDispose),
    );
    runtime.start();
    check("DISPOSED_RUNTIME_CANNOT_REFRESH", (await runtime.refresh()) === false);
    await new Promise((resolve) => setImmediate(resolve));
    check("DISPOSED_RUNTIME_STARTS_NO_NEW_IO", requestsUnchanged(afterDispose));
    check("CURRENT_CONFIG_UNCHANGED", beforeConfig === configHash());
    check("NO_ACCOUNT_OR_ANONYMOUS_SESSIONS", result.counts.sessionAttempts === 0);
    check(
      "NO_DNS_ELECTRON_OR_PUBLIC_HTTP_ATTEMPTS",
      [
        result.counts.dnsAttempts,
        result.counts.electronRequestAttempts,
        result.counts.defaultSessionRequests,
        result.counts.nonControllerHttpAttempts,
        result.counts.httpsAttempts,
        result.counts.fetchAttempts,
        result.counts.commandAttempts,
      ].every((value) => value === 0),
    );
  } catch (error) {
    result.failure = /^[A-Z_]{1,100}$/.test(error.message)
      ? error.message
      : "PROOF_SOURCE_RUNTIME_UNAVAILABLE";
  } finally {
    try {
      await runtime?.dispose();
    } catch {
      result.cleanupFailure = "RUNTIME_CLEANUP_FAILED";
    }
    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
    app.exit(result.failure || result.cleanupFailure ? 1 : 0);
  }
}
