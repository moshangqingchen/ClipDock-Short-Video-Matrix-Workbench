/**
 * Build a real electron-builder acceptance package and compare its process identity
 * with the development Electron binary. The acceptance entry is fixed and anonymous;
 * production src/main receives no probe switch or eval interface.
 *
 * node scripts/electron-packaged-process-context.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { build as buildRenderer } from "vite";
import { build as packageApplication, Platform, Arch } from "electron-builder";
import { default as electronPath } from "electron";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryParent = path.join(repository, "docs", ".compare");
const reportPath = path.join(repository, "docs", "network-packaged-process-context.results.json");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const assert = (value, name) => {
  if (!value) throw Error(name);
};
fs.mkdirSync(temporaryParent, { recursive: true });
const temporary = fs.mkdtempSync(path.join(temporaryParent, "packaged-context-"));
const application = path.join(temporary, "app");
const output = path.join(temporary, "package");
const fixturePath = path.join(application, "scripts", "context-probe.mjs");
const result = {
  executedAt: new Date().toISOString(),
  kind: "real electron-builder acceptance package; fixed anonymous entry",
  productionEntryExecuted: false,
  productionSourceModified: false,
  sourceHashes: {},
  development: null,
  packaged: null,
  comparison: [],
  limits: [
    "The packaged acceptance entry is not ClipDock's final production entry.",
    "Only public HTTPS IP echo is sampled; no creator or account endpoints.",
    "Different targets, process rules, address families or final install paths cannot inherit this evidence.",
    "No production data directory, account Cookie, token, proxy password or controller secret is used.",
  ],
};
let stage = "prepare";
try {
  assert(process.platform === "win32", "WINDOWS_REQUIRED");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
  assert(packageJson.devDependencies.electron === "43.3.0", "PINNED_ELECTRON_REQUIRED");
  fs.mkdirSync(path.join(application, "scripts"), { recursive: true });
  const originalProbe = fs.readFileSync(
    path.join(repository, "scripts", "electron-process-context-probe.mjs"),
    "utf8",
  );
  let fixture = originalProbe;
  const patch = (before, after) => {
    assert(
      fixture.includes(before) && fixture.indexOf(before) === fixture.lastIndexOf(before),
      "PROBE_PATCH_ANCHOR_CHANGED",
    );
    fixture = fixture.replace(before, after);
  };
  patch(
    "packaged: app.isPackaged }",
    "packaged: app.isPackaged, executableName: path.basename(process.execPath), executablePath: process.execPath, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }",
  );
  patch(
    '"No packaged-build process identity"',
    '"Fixed packaged acceptance entry, not final ClipDock entry; exact executable path matters"',
  );
  patch(
    'await isolated.setProxy({ mode: "direct" });',
    'await isolated.setProxy({ mode: "direct" });\n    await isolated.closeAllConnections();',
  );
  patch(
    'const configs = await control("configs");\n    result.controller =',
    'const configs = await control("configs");\n    const rulesBefore = await control("rules");\n    result.controllerFingerprint = crypto.createHash("sha256").update(JSON.stringify([configs,rulesBefore])).digest("hex");\n    result.controller =',
  );
  patch(
    'result.controllerAfter = { mode: configs.mode, tunEnabled: configs.tun?.enable, findProcessMode: configs["find-process-mode"] };',
    'result.controllerAfter = { mode: configs.mode, tunEnabled: configs.tun?.enable, findProcessMode: configs["find-process-mode"] };\n      const rulesAfter = await control("rules");\n      result.controllerFingerprintAfter = crypto.createHash("sha256").update(JSON.stringify([configs,rulesAfter])).digest("hex");',
  );
  patch(
    "packagedIdentityVerified: false,",
    'packagedIdentityVerified: app.isPackaged && result.paths.length === 4 && result.paths.every(entry => entry.observed.length > 0 && entry.observed.every(item => typeof item.processPath === "string" && path.resolve(item.processPath).toLowerCase() === path.resolve(process.execPath).toLowerCase())),\n      controllerStable: result.controllerFingerprint === result.controllerFingerprintAfter,',
  );
  fs.writeFileSync(fixturePath, fixture);
  result.probe = {
    sourceSha256: hash(originalProbe),
    acceptanceSha256: hash(fixture),
    fixedTarget: "https://myip.ipip.net/json",
    modifiedForAcceptance: [
      "report actual app.isPackaged/executable/resource paths",
      "close old connection pool after setProxy(direct)",
      "compare controller rules/config before and after each run",
      "verify matched process paths equal the launched executable",
    ],
    arbitraryInputOrEvalSwitch: false,
  };
  const files = ["src/main/index.ts", "src/preload/index.ts", "vite.config.ts", "package.json"];
  result.sourceHashes = Object.fromEntries(
    files.map((file) => [file, hash(fs.readFileSync(path.join(repository, file)))]),
  );
  stage = "compile-production-resources";
  const shared = {
    bundle: true,
    platform: "node",
    target: "node22",
    minify: true,
    sourcemap: false,
    logLevel: "silent",
    legalComments: "none",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    alias: { "@shared": path.join(repository, "src/shared"), "@main": path.join(repository, "src/main") },
  };
  await bundle({
    ...shared,
    entryPoints: [path.join(repository, "src/main/index.ts")],
    outfile: path.join(application, "dist-electron", "main.js"),
    format: "esm",
    external: ["electron", "node:*"],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
  });
  await bundle({
    ...shared,
    entryPoints: [path.join(repository, "src/preload/index.ts")],
    outfile: path.join(application, "dist-electron", "preload.cjs"),
    format: "cjs",
    external: ["electron"],
  });
  await buildRenderer({
    configFile: path.join(repository, "vite.config.ts"),
    root: repository,
    logLevel: "error",
    build: { outDir: path.join(application, "dist"), emptyOutDir: true },
  });
  assert(
    files.every((file) => hash(fs.readFileSync(path.join(repository, file))) === result.sourceHashes[file]),
    "PRODUCTION_SOURCES_CHANGED_DURING_BUILD",
  );
  fs.writeFileSync(
    path.join(application, "package.json"),
    JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        description: packageJson.description,
        author: packageJson.author,
        private: true,
        type: "module",
        main: "scripts/context-probe.mjs",
      },
      null,
      2,
    ),
  );
  stage = "package";
  await packageApplication({
    projectDir: application,
    targets: Platform.WINDOWS.createTarget(["dir"], Arch.x64),
    publish: "never",
    config: {
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      electronVersion: packageJson.devDependencies.electron,
      electronDist: path.dirname(electronPath),
      directories: { output },
      asar: true,
      npmRebuild: false,
      files: ["dist/**/*", "dist-electron/**/*", "scripts/context-probe.mjs", "package.json"],
      win: { target: "dir", signAndEditExecutable: packageJson.build.win.signAndEditExecutable },
    },
  });
  const executable = path.join(output, "win-unpacked", packageJson.build.productName + ".exe");
  const archive = path.join(output, "win-unpacked", "resources", "app.asar");
  assert(fs.existsSync(executable) && fs.existsSync(archive), "PACKAGED_ARTIFACTS_MISSING");
  result.packaging = {
    tool: "electron-builder",
    toolVersion: packageJson.devDependencies["electron-builder"],
    appId: packageJson.build.appId,
    productName: packageJson.build.productName,
    electronVersion: packageJson.devDependencies.electron,
    format: "win-unpacked x64 + resources/app.asar",
    executableName: path.basename(executable),
    archiveSha256: hash(fs.readFileSync(archive)),
    productionResourcesIncluded: ["dist", "dist-electron/main.js", "dist-electron/preload.cjs"],
    acceptanceEntry: "scripts/context-probe.mjs",
    productionEntry: "dist-electron/main.js",
    productionEntryExecuted: false,
    signAndEditExecutable: packageJson.build.win.signAndEditExecutable,
    existingReleaseDirectoryTouched: false,
  };
  const run = async (exe, args, label) => {
    const profile = path.join(temporary, "sv-context-probe-" + label);
    fs.mkdirSync(profile);
    const env = { ...process.env, SV_CONTEXT_PROBE_ROOT: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, args, {
      cwd: application,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    child.stdout.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-1800);
    });
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-1800);
    });
    const watchdog = setTimeout(() => child.kill(), 90_000);
    const code = await new Promise((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (value) => resolve(value ?? 1));
    });
    clearTimeout(watchdog);
    const received = path.join(profile, "result.json");
    if (!fs.existsSync(received)) {
      console.error("Acceptance child did not produce its report:", diagnostic);
      throw Error("ACCEPTANCE_REPORT_MISSING_" + label);
    }
    const report = JSON.parse(fs.readFileSync(received, "utf8"));
    report.processExitCode = code;
    return report;
  };
  stage = "development-probe";
  result.development = await run(electronPath, [fixturePath], "development");
  stage = "packaged-probe";
  result.packaged = await run(executable, [], "packaged");
  for (const dev of result.development.paths) {
    const packed = result.packaged.paths.find((entry) => entry.path === dev.path);
    result.comparison.push({
      path: dev.path,
      developmentStatus: dev.status,
      packagedStatus: packed?.status ?? "NOT_RUN",
      developmentProcesses: [...new Set(dev.observed.map((entry) => entry.process))],
      packagedProcesses: [...new Set((packed?.observed ?? []).map((entry) => entry.process))],
      developmentInbound: [...new Set(dev.observed.map((entry) => entry.inboundType))],
      packagedInbound: [...new Set((packed?.observed ?? []).map((entry) => entry.inboundType))],
      developmentRoutes: [...new Set(dev.observed.map((entry) => entry.routeClass))],
      packagedRoutes: [...new Set((packed?.observed ?? []).map((entry) => entry.routeClass))],
      matchedBoth:
        dev.status === "CONNECTION_AND_PROCESS_CONTEXT_OBSERVED" &&
        packed?.status === "CONNECTION_AND_PROCESS_CONTEXT_OBSERVED",
    });
  }
  result.summary = {
    realAcceptancePackageStarted: result.packaged.runtime.packaged === true,
    packagedExecutablePathMatchesKernel: result.packaged.summary.packagedIdentityVerified,
    allFourPathsObservedBoth:
      result.comparison.length === 4 && result.comparison.every((row) => row.matchedBoth),
    configurationStableAcrossComparison:
      result.development.summary.controllerStable &&
      result.packaged.summary.controllerStable &&
      result.development.controllerFingerprint === result.packaged.controllerFingerprint,
    finalProductionEntryIdentityVerified: false,
  };
  if (result.development.failure || result.packaged.failure) result.failure = "PROBE_INCOMPLETE";
  if (
    !result.summary.allFourPathsObservedBoth ||
    !result.summary.packagedExecutablePathMatchesKernel ||
    !result.summary.configurationStableAcrossComparison
  )
    result.failure ??= "CONTEXT_EVIDENCE_INCOMPLETE";
} catch (error) {
  result.failure = stage + ":" + error.message;
} finally {
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
  const rows = result.comparison
    .map(
      (row) =>
        "| " +
        row.path +
        " | " +
        row.developmentProcesses.join(", ") +
        " | " +
        row.packagedProcesses.join(", ") +
        " | " +
        (row.matchedBoth ? "已匹配" : "未验证") +
        " |",
    )
    .join("\n");
  const report =
    "# 打包验收入口的进程归因\n\n" +
    "执行时间：" +
    result.executedAt +
    "。脚本：node scripts/electron-packaged-process-context.mjs。\n\n" +
    "**本次创建真实 electron-builder 验收包，不是手动重命名 electron.exe。** 使用项目相同 productName/appId、Electron 43.3.0、x64、asar 与 signAndEditExecutable 设置；包含本轮编译的 main/preload/renderer 资源。临时 package.main 指向固定匿名验收脚本，正式主进程入口未执行，生产源文件没有植入实验开关或任意 eval 接口。\n\n" +
    "开发版与打包版使用同一验收脚本，仅访问公开端点 https://myip.ipip.net/json；分别使用新建隐藏窗口、临时 userData/sessionData、无登录态分区。请求 credentials:omit，Cookie/Authorization/proxy Authorization 被移除，响应 Set-Cookie 被移除；没有真实账号或公网凭据。Clash 控制器只读。\n\n" +
    "| 通路 | 开发版内核记录进程 | 打包版内核记录进程 | 归因 |\n|---|---|---|---|\n" +
    rows +
    "\n\n" +
    "归因依据是本次新增连接 ID、精确目标 host:443、Node socket 或 Chromium NetLog 独立记录的源端口；不能拿另一进程的 DIRECT 连接替代。具体连接与源码/包哈希见 [network-packaged-process-context.results.json](./network-packaged-process-context.results.json)。\n\n" +
    "证据边界：这是验收入口打包进程的实测，**仍不是正式 ClipDock 入口及最终安装路径的验收**。本次没有启动真实账号，也没有替各平台登录/API/CDN、IPv6/QUIC 签发证明；目标、地址族、安装路径、内核规则或运行上下文改变必须重新确认。不能只把进程 basename 相同当作路径等价。\n\n" +
    "打包目录与两份临时数据目录均位于本仓库新建的独立 .compare 子目录，不覆盖 release 或已安装程序；完成后按精确目录边界清理。" +
    (result.failure ? "\n\n本次未满足的项：" + result.failure + "。" : "") +
    "\n";
  fs.writeFileSync(path.join(repository, "docs", "network-packaged-process-context.md"), report);
  const resolved = path.resolve(temporary);
  assert(
    path.dirname(resolved) === path.resolve(temporaryParent) &&
      path.basename(resolved).startsWith("packaged-context-"),
    "UNSAFE_CLEANUP_TARGET",
  );
  await delay(600);
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    result.temporaryDirectoryRemoved = true;
  } catch {
    result.temporaryDirectoryRemoved = false;
    console.error("Acceptance package directory remains locked; no production path was touched.");
  }
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        output: reportPath,
        summary: result.summary ?? null,
        failure: result.failure ?? null,
        temporaryDirectoryRemoved: result.temporaryDirectoryRemoved,
      },
      null,
      2,
    ),
  );
  process.exitCode = result.failure ? 1 : 0;
}
