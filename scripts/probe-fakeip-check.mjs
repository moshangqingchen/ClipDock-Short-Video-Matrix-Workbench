/**
 * One-off diagnostic: confirm fake-ip TUN behaviour and find a probe signal
 * that actually works in this environment.
 *
 * Compares three signal strengths per host:
 *   1. TCP connect        (worthless under fake-ip — always instant)
 *   2. TLS handshake done (needs the tunnel to reach a real server)
 *   3. Full HTTP response (the only trustworthy reachability signal)
 *
 * Read-only. Public pages only, no credentials, no creator-console APIs.
 */
import net from "node:net";
import tls from "node:tls";
import https from "node:https";

const HOSTS = [
  ["www.bilibili.com", "国内"],
  ["creator.douyin.com", "国内"],
  ["www.youtube.com", "国外"],
];

function tcpConnect(host, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port: 443, timeout: timeoutMs });
    s.on("connect", () => {
      const peer = s.remoteAddress;
      s.destroy();
      resolve({ ok: true, rtt: Date.now() - t0, peer });
    });
    s.on("timeout", () => { s.destroy(); resolve({ ok: false, error: "timeout", rtt: Date.now() - t0 }); });
    s.on("error", (e) => resolve({ ok: false, error: e.code, rtt: Date.now() - t0 }));
  });
}

function tlsHandshake(host, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = s.getPeerCertificate();
      const info = {
        ok: true,
        rtt: Date.now() - t0,
        peer: s.remoteAddress,
        authorized: s.authorized,
        issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? "-",
        subject: cert?.subject?.CN ?? "-",
      };
      s.destroy();
      resolve(info);
    });
    s.on("timeout", () => { s.destroy(); resolve({ ok: false, error: "timeout", rtt: Date.now() - t0 }); });
    s.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - t0 }));
  });
}

function httpHead(host, timeoutMs = 9000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      { host, path: "/", method: "GET", timeout: timeoutMs, headers: { "user-agent": "curl/8.0" } },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode, rtt: Date.now() - t0, server: res.headers.server ?? "-" });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout", rtt: Date.now() - t0 }); });
    req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - t0 }));
    req.end();
  });
}

for (const [host, group] of HOSTS) {
  console.log(`\n=== ${host}  [${group}] ===`);
  const a = await tcpConnect(host);
  console.log(`  1 TCP连接   : ${a.ok ? `通 ${a.rtt}ms  对端=${a.peer}` : `不通 ${a.error} ${a.rtt}ms`}`);
  const b = await tlsHandshake(host);
  console.log(`  2 TLS握手   : ${b.ok ? `成功 ${b.rtt}ms  对端=${b.peer}  证书=${b.subject}  签发=${b.issuer}  可信=${b.authorized}` : `失败 ${b.error} ${b.rtt}ms`}`);
  const c = await httpHead(host);
  console.log(`  3 HTTP响应  : ${c.ok ? `${c.status}  ${c.rtt}ms  server=${c.server}` : `失败 ${c.error} ${c.rtt}ms`}`);

  if (a.ok && a.rtt <= 5 && a.peer && a.peer.startsWith("198.18.")) {
    console.log(`  ** fake-ip 确认:对端是合成地址 ${a.peer},TCP 握手由 TUN 本地应答 **`);
  }
}

console.log("\n=== 结论 ===");
console.log("  若上面 TCP 全部 0-1ms 且对端为 198.18.x.x → TCP探测在此环境完全无效");
console.log("  可用的探测信号 = 完整 HTTP 响应 + 出口IP归属,二者缺一不可");
