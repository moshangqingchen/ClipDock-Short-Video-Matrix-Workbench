/**
 * One-off diagnostic: can binding a source address escape a TUN default route?
 *
 * Compares the egress IP seen by:
 *   A) a plain request (whatever the OS routing table picks)
 *   B) a request bound to the physical NIC's address via localAddress
 *
 * Read-only. Hits IP-echo endpoints only — no platform hosts, no credentials.
 * usage: node scripts/probe-routing-test.mjs [physicalIp]
 */
import https from "node:https";
import os from "node:os";

const ECHO = [
  { name: "ipify", host: "api.ipify.org", path: "/?format=json" },
  { name: "ip.sb", host: "api-ipv4.ip.sb", path: "/ip" },
];

function physicalCandidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // Skip known virtual/tunnel ranges: Clash fake-ip 198.18/16, Hyper-V 172.x
      const virtual = a.address.startsWith("198.18.") || /vEthernet|Meta|WSL/i.test(name);
      out.push({ name, address: a.address, virtual });
    }
  }
  return out;
}

function fetchEgress(endpoint, localAddress, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      {
        host: endpoint.host,
        path: endpoint.path,
        method: "GET",
        localAddress,
        headers: { "user-agent": "curl/8.0", accept: "*/*" },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            rtt: Date.now() - started,
            body: body.trim().slice(0, 200),
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout", rtt: Date.now() - started });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.code ?? e.message, rtt: Date.now() - started }));
    req.end();
  });
}

function parseIp(body) {
  if (!body) return null;
  try {
    const j = JSON.parse(body);
    return j.ip ?? null;
  } catch {
    return /^[\d.]+$/.test(body) ? body : null;
  }
}

const argIp = process.argv[2];
const candidates = physicalCandidates();

console.log("本机 IPv4 接口:");
for (const c of candidates) {
  console.log(`  ${c.virtual ? "[虚拟]" : "[物理]"} ${c.name.padEnd(28)} ${c.address}`);
}

const physical = argIp ?? candidates.find((c) => !c.virtual)?.address;
console.log(`\n将测试绑定源地址: ${physical ?? "(未找到物理网卡)"}\n`);

for (const endpoint of ECHO) {
  console.log(`--- ${endpoint.name} (${endpoint.host}) ---`);

  const plain = await fetchEgress(endpoint, undefined);
  const plainIp = plain.ok ? parseIp(plain.body) : null;
  console.log(
    `  A 默认路由        : ${plain.ok ? `出口 ${plainIp}  ${plain.rtt}ms` : `失败 ${plain.error ?? plain.status}  ${plain.rtt}ms`}`,
  );

  if (physical) {
    const bound = await fetchEgress(endpoint, physical);
    const boundIp = bound.ok ? parseIp(bound.body) : null;
    console.log(
      `  B 绑定 ${physical} : ${bound.ok ? `出口 ${boundIp}  ${bound.rtt}ms` : `失败 ${bound.error ?? bound.status}  ${bound.rtt}ms`}`,
    );

    if (plain.ok && bound.ok) {
      if (plainIp === boundIp) {
        console.log(`  => 出口相同 (${plainIp}) :绑定网卡【未能】逃出隧道`);
      } else {
        console.log(`  => 出口不同:A=${plainIp}  B=${boundIp} :绑定网卡【成功】改变了出口`);
      }
    } else if (plain.ok && !bound.ok) {
      console.log(`  => 绑定后不通:该源地址无法出网(隧道抢占路由的典型表现)`);
    }
  }
  console.log("");
}
