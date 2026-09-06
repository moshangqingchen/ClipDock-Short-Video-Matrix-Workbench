/**
 * One-off diagnostic: where is the current egress, and how do domestic hosts route?
 * Read-only. No credentials, no creator-console endpoints — TLS reachability only.
 */
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";

function get(host, path, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      { host, path, method: "GET", timeout: timeoutMs, headers: { "user-agent": "curl/8.0" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ ok: true, status: res.statusCode, body: body.slice(0, 400), rtt: Date.now() - started }));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout", rtt: Date.now() - started }); });
    req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - started }));
    req.end();
  });
}

function tcpProbe(host, port = 443, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.on("connect", () => { sock.destroy(); resolve({ ok: true, rtt: Date.now() - started }); });
    sock.on("timeout", () => { sock.destroy(); resolve({ ok: false, error: "timeout", rtt: Date.now() - started }); });
    sock.on("error", (e) => resolve({ ok: false, error: e.code, rtt: Date.now() - started }));
  });
}

console.log("=== 当前出口归属 ===");
const geo = await get("ipinfo.io", "/json");
if (geo.ok) {
  try {
    const j = JSON.parse(geo.body);
    console.log(`  IP      : ${j.ip}`);
    console.log(`  国家/地区: ${j.country}`);
    console.log(`  城市    : ${j.city ?? "-"} ${j.region ?? ""}`);
    console.log(`  ASN/组织 : ${j.org ?? "-"}`);
    console.log(`  判定    : ${j.country === "CN" ? "中国大陆 → 国内组可放行" : "非中国大陆 → 严格模式下国内组必须休眠"}`);
  } catch { console.log("  解析失败:", geo.body.slice(0, 120)); }
} else {
  console.log("  查询失败:", geo.error);
}

console.log("\n=== 国内平台域名的 DNS 解析结果 ===");
const domestic = ["www.bilibili.com", "creator.douyin.com", "cp.kuaishou.com", "channels.weixin.qq.com"];
for (const host of domestic) {
  try {
    const addrs = await dns.resolve4(host);
    console.log(`  ${host.padEnd(28)} → ${addrs.slice(0, 3).join(", ")}`);
  } catch (e) {
    console.log(`  ${host.padEnd(28)} → 解析失败 ${e.code}`);
  }
}

console.log("\n=== 国内平台 TCP 可达性(仅握手,不带任何凭据) ===");
for (const host of domestic) {
  const r = await tcpProbe(host);
  console.log(`  ${host.padEnd(28)} ${r.ok ? `通 ${r.rtt}ms` : `不通 ${r.error} ${r.rtt}ms`}`);
}

console.log("\n=== 国外平台 TCP 可达性 ===");
for (const host of ["www.youtube.com", "api.twitter.com", "www.tiktok.com"]) {
  const r = await tcpProbe(host);
  console.log(`  ${host.padEnd(28)} ${r.ok ? `通 ${r.rtt}ms` : `不通 ${r.error} ${r.rtt}ms`}`);
}
