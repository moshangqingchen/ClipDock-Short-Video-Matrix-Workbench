/**
 * Generate traffic to representative hosts, then read Clash /connections to see
 * which chain each host actually took. This is the only per-host ground truth
 * available under a fake-ip TUN.
 *
 * Read-only w.r.t. the platforms: public pages only, no cookies, no credentials.
 * usage: node scripts/probe-chains.mjs [clashPort]
 */
import https from "node:https";
import http from "node:http";

const PORT = process.argv[2] ?? "9790";
const API = `http://127.0.0.1:${PORT}`;

const TARGETS = [
  ["www.bilibili.com", "cn"],
  ["creator.douyin.com", "cn"],
  ["cp.kuaishou.com", "cn"],
  ["channels.weixin.qq.com", "cn"],
  ["creator.xiaohongshu.com", "cn"],
  ["baijiahao.baidu.com", "cn"],
  ["www.youtube.com", "global"],
  ["api.x.com", "global"],
  ["www.tiktok.com", "global"],
];

function touch(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      { host, path: "/", method: "GET", timeout: 8000, headers: { "user-agent": "curl/8.0" } },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode, rtt: Date.now() - t0 });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout", rtt: Date.now() - t0 }); });
    req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - t0 }));
    req.end();
  });
}

function apiGet(path) {
  return new Promise((resolve) => {
    const req = http.request(`${API}${path}`, { timeout: 4000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

console.log("1) 产生流量(公开首页,无凭据)\n");
const results = new Map();
for (const [host, group] of TARGETS) {
  const r = await touch(host);
  results.set(host, { group, ...r });
  console.log(`   ${host.padEnd(30)} ${r.ok ? `${r.status} ${r.rtt}ms` : `失败 ${r.error} ${r.rtt}ms`}`);
}

console.log("\n2) 读取 Clash /connections 的实际链路\n");
await new Promise((r) => setTimeout(r, 1200));
const conns = await apiGet("/connections");
if (!conns) {
  console.log("   Clash API 读取失败");
  process.exit(0);
}

const chainByHost = new Map();
for (const c of conns.connections ?? []) {
  const h = c.metadata?.host;
  if (!h) continue;
  if (!chainByHost.has(h)) chainByHost.set(h, (c.chains ?? []).join(" <- "));
}

console.log("   host                           组      实际链路");
console.log("   " + "-".repeat(74));
let cnDirect = 0, cnProxied = 0, cnUnknown = 0;
for (const [host, group] of TARGETS) {
  const chain = chainByHost.get(host);
  const shown = chain ?? "(本次未捕获)";
  console.log(`   ${host.padEnd(30)} ${group.padEnd(7)} ${shown}`);
  if (group === "cn") {
    if (!chain) cnUnknown++;
    else if (/^DIRECT/.test(chain)) cnDirect++;
    else cnProxied++;
  }
}

console.log("\n3) 判定\n");
console.log(`   国内平台: DIRECT ${cnDirect} 个 / 走代理 ${cnProxied} 个 / 未捕获 ${cnUnknown} 个`);
if (cnProxied > 0) {
  console.log("   => 有国内平台在走代理。严格模式下这些平台必须休眠。");
} else if (cnDirect > 0 && cnUnknown === 0) {
  console.log("   => 全部国内平台走 DIRECT。严格模式可放行国内组(仍需出口归属佐证)。");
} else {
  console.log("   => 证据不足。严格模式应保守休眠。");
}
