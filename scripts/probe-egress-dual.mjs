/**
 * Two remaining questions for the strict-routing design:
 *   1. What is the egress attribution on each path (direct vs proxy)?
 *   2. Does physical-NIC binding work now that Clash is in rule mode?
 *
 * Read-only. IP-echo endpoints only — no platform hosts, no credentials.
 * usage: node scripts/probe-egress-dual.mjs [proxyPort]
 */
import https from "node:https";
import http from "node:http";
import os from "node:os";

const PROXY_PORT = Number(process.argv[2] ?? 10090);

// Domestic echo services route DIRECT under rule mode; the .io one goes abroad.
const ECHO_CN = { host: "myip.ipip.net", path: "/json", label: "ipip.net (国内)" };
const ECHO_INTL = { host: "api.ipify.org", path: "/?format=json", label: "ipify (国外)" };

function plainGet(ep, localAddress, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      { host: ep.host, path: ep.path, method: "GET", localAddress, timeout: timeoutMs,
        headers: { "user-agent": "curl/8.0", accept: "*/*" } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ ok: true, status: res.statusCode, body: b.trim().slice(0, 300), rtt: Date.now() - t0 }));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout", rtt: Date.now() - t0 }); });
    req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - t0 }));
    req.end();
  });
}

/** GET through an HTTP proxy using a CONNECT tunnel — zero dependencies. */
function proxyGet(ep, port, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({
      host: "127.0.0.1", port, method: "CONNECT", path: `${ep.host}:443`, timeout: timeoutMs,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ ok: false, error: `CONNECT ${res.statusCode}`, rtt: Date.now() - t0 });
      }
      const tls = https.request({
        host: ep.host, path: ep.path, method: "GET", socket, agent: false, timeout: timeoutMs,
        headers: { "user-agent": "curl/8.0", accept: "*/*" },
      }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => { socket.destroy(); resolve({ ok: true, status: r.statusCode, body: b.trim().slice(0, 300), rtt: Date.now() - t0 }); });
      });
      tls.on("error", (e) => { socket.destroy(); resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - t0 }); });
      tls.end();
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "proxy timeout", rtt: Date.now() - t0 }); });
    req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - t0 }));
    req.end();
  });
}

function summarize(body) {
  if (!body) return null;
  try {
    const j = JSON.parse(body);
    if (j.ip) return { ip: j.ip, extra: "" };
    if (j.data) return { ip: j.data.ip, extra: (j.data.location ?? []).filter(Boolean).join(" ") };
  } catch {
    if (/^[\d.]+$/.test(body)) return { ip: body, extra: "" };
  }
  return { ip: "(未解析)", extra: body.slice(0, 90) };
}

console.log("=== 1. 默认路由(rule 模式,应命中 DIRECT)===");
for (const ep of [ECHO_CN, ECHO_INTL]) {
  const r = await plainGet(ep);
  const s = r.ok ? summarize(r.body) : null;
  console.log(`  ${ep.label.padEnd(18)} ${r.ok ? `${s.ip}  ${s.extra}  ${r.rtt}ms` : `失败 ${r.error} ${r.rtt}ms`}`);
}

console.log(`\n=== 2. 经代理 127.0.0.1:${PROXY_PORT} (CONNECT 隧道) ===`);
for (const ep of [ECHO_CN, ECHO_INTL]) {
  const r = await proxyGet(ep, PROXY_PORT);
  const s = r.ok ? summarize(r.body) : null;
  console.log(`  ${ep.label.padEnd(18)} ${r.ok ? `${s.ip}  ${s.extra}  ${r.rtt}ms` : `失败 ${r.error} ${r.rtt}ms`}`);
}

console.log("\n=== 3. 绑定物理网卡重测(rule 模式下是否可行)===");
const nics = [];
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === "IPv4" && !a.internal && !a.address.startsWith("198.18.") && !/vEthernet|Meta|WSL/i.test(name)) {
      nics.push({ name, address: a.address });
    }
  }
}
for (const nic of nics) {
  const r = await plainGet(ECHO_CN, nic.address, 6000);
  const s = r.ok ? summarize(r.body) : null;
  console.log(`  绑 ${nic.address} (${nic.name})  ${r.ok ? `成功 → ${s.ip} ${s.extra} ${r.rtt}ms` : `失败 ${r.error} ${r.rtt}ms`}`);
}
if (nics.length === 0) console.log("  未找到物理网卡");
