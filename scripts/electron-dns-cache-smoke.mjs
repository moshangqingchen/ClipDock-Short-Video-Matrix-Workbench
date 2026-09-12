/** Anonymous DNS only; no HTTP, account partitions, OS or mihomo configuration writes. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const stem = "network-dns-cache-smoke";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const host = "api.bilibili.com";
const check = (checks, name, pass) => checks.push({ name, pass: Boolean(pass) });

// Electron waits for entry-point top-level await before emitting ready.
if (process.versions.electron) void child().catch(() => process.exit(1));
else await parent();

async function parent() {
  const { spawn } = await import("node:child_process");
  const resultPath = path.join(repository, "docs", stem + ".results.json");
  if (fs.existsSync(resultPath)) {
    const previous = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const baseline = path.join(repository, "docs", stem + "-startup-initial-observation.results.json");
    if (previous.result !== null || previous.passed || fs.existsSync(baseline))
      throw Error("PRESERVE_EXISTING_DNS_REPORT");
    fs.renameSync(resultPath, baseline);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sv-dns-cache-"));
  const report = {
    executedAt: new Date().toISOString(),
    scope: { anonymousDnsOnly: true, publicHttpRequests: 0, realAccounts: false,
      osConfigurationChanged: false, controllerConfigurationChanged: false },
    sourceHash: sha(fs.readFileSync(script)),
    result: null,
    passed: false,
    qualification: { directPath: false, dnsPathEquivalence: false, addressFamilyConstraint: false },
  };
  try {
    const env = { ...process.env, CLIPDOCK_DNS_SMOKE_DIR: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const childProcess = spawn(require("electron"), [script], {
      env, windowsHide: true, stdio: "ignore",
    });
    const timer = setTimeout(() => childProcess.kill(), 20_000);
    const status = await new Promise((resolve, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", (code) => resolve(code));
    }).finally(() => clearTimeout(timer));
    const childReport = path.join(temporary, "result.json");
    if (fs.existsSync(childReport)) report.result = JSON.parse(fs.readFileSync(childReport, "utf8"));
    report.passed = status === 0 && report.result?.checks.every((item) => item.pass) === true;
  } catch {
    report.error = "DNS_CACHE_EXPERIMENT_UNAVAILABLE";
  } finally {
    report.sourceStable = report.sourceHash === sha(fs.readFileSync(script));
    report.passed &&= report.sourceStable;
    fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(path.join(repository, "docs", stem + ".md"), [
      "# Electron DNS 缓存实验", "", `执行时间：${report.executedAt}。`, "",
      "独立临时 Session 只查询 api.bilibili.com 的 A 记录；webRequest 拒绝 HTTP 请求。没有账号、Cookie、系统 DNS 或 mihomo 配置改动。", "",
      "依次验证：空缓存仅本地查询失败 → 一次匿名解析 → 缓存命中 → closeAllConnections 后查询 → clearHostResolverCache 后查询。报告不保存解析地址。", "",
      `结果：${report.passed ? "通过" : "未通过／不完整，保留原始结论"}。`, "",
      ...(report.result?.checks ?? []).map((item) => `- ${item.pass ? "通过" : "失败"}：${item.name}`), "",
      "这只验证 Session 的 DNS 缓存 API 行为，不证明 DNS 与内核解析一致，也不证明大陆出口或地址族约束。", "",
      "依据：[Electron resolveHost](https://www.electronjs.org/docs/latest/api/session#sesresolvehosthost-options)、[clearHostResolverCache](https://www.electronjs.org/docs/latest/api/session#sesclearhostresolvercache)。", "",
    ].join("\n"));
    const resolved = fs.realpathSync(temporary);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith("sv-dns-cache-"))
      fs.rmSync(resolved, { recursive: true, force: true });
    console.log(JSON.stringify({ passed: report.passed, checks: report.result?.checks,
      report: "docs/" + stem + ".results.json" }));
    process.exitCode = report.passed ? 0 : 1;
  }
}

async function child() {
  const { app, session } = require("electron");
  const temporary = process.env.CLIPDOCK_DNS_SMOKE_DIR;
  if (!temporary || !path.isAbsolute(temporary)) process.exit(1);
  app.setPath("userData", path.join(temporary, "profile"));
  app.commandLine.appendSwitch("disable-quic");
  app.commandLine.appendSwitch("disable-background-networking");
  const result = { electron: process.versions.electron, chromium: process.versions.chrome,
    host, checks: [], requestHooks: 0, stages: [] };
  const flush = () => fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
  const timer = setTimeout(() => {
    check(result.checks, "实验未超时", false);
    flush();
    app.exit(1);
  }, 15_000);
  let ses;
  const resolve = async (name, options) => {
    result.stageStarted = name;
    flush();
    try {
      const value = await ses.resolveHost(host, { queryType: "A", ...options });
      const addresses = [...new Set(value.endpoints.map((item) => item.address))].sort();
      result.stages.push({ name, available: true, addressCount: addresses.length });
      flush();
      return addresses.length ? JSON.stringify(addresses) : null;
    } catch (error) {
      result.stages.push({ name, available: false,
        reason: /ERR_DNS_CACHE_MISS/.test(String(error)) ? "DNS_CACHE_MISS" : "RESOLUTION_UNAVAILABLE" });
      flush();
      return null;
    }
  };
  try {
    await app.whenReady();
    ses = session.fromPartition("sv-dns-cache-" + crypto.randomUUID(), { cache: false });
    ses.webRequest.onBeforeRequest((_details, callback) => { result.requestHooks++; callback({ cancel: true }); });
    await ses.setProxy({ mode: "direct" });
    await ses.closeAllConnections();
    await ses.clearHostResolverCache();
    const empty = await resolve("empty-local-cache", { source: "localOnly", cacheUsage: "allowed" });
    check(result.checks, "初始仅本地缓存查询无结果", empty === null);
    const seeded = await resolve("anonymous-resolution", { cacheUsage: "disallowed" });
    check(result.checks, "匿名解析取得 A 记录", seeded !== null);
    const cached = await resolve("seeded-local-cache", { source: "localOnly", cacheUsage: "allowed" });
    check(result.checks, "仅本地查询命中刚取得的记录", seeded !== null && cached === seeded);
    await ses.closeAllConnections();
    const closed = await resolve("after-close-connections", { source: "localOnly", cacheUsage: "allowed" });
    check(result.checks, "关闭连接后 DNS 缓存仍在", seeded !== null && closed === seeded);
    await ses.clearHostResolverCache();
    const cleared = await resolve("after-clear-resolver-cache", { source: "localOnly", cacheUsage: "allowed" });
    check(result.checks, "显式清理后仅本地查询不再命中", cleared === null);
    check(result.checks, "未产生 HTTP 请求", result.requestHooks === 0);
  } catch {
    check(result.checks, "实验完整执行", false);
  } finally {
    await ses?.closeAllConnections().catch(() => {});
    clearTimeout(timer);
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
    app.exit(result.checks.length === 6 && result.checks.every((item) => item.pass) ? 0 : 1);
  }
}
