// Read-only, pre-TLS CONNECT diagnostics. No account, HTTP payload or proxy configuration changes.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { isIP, BlockList } from "node:net";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
if (process.argv.slice(2).join(" ") !== "--run-once") throw Error("EXPLICIT_RUN_REQUIRED");
const root = process.cwd(), folder = fs.mkdtempSync(path.join(root, "docs/.compare/domestic-context-"));
await build({ stdin: { contents: "export { ProxyTunnelReader } from './src/main/api/proxy-tunnel-reader.ts'; export { verifyDomesticTunnelEvidence, directTunnelChainFingerprint } from './src/main/api/proxy-tunnel-evidence.ts';", resolveDir: root }, bundle: true, platform: "node", format: "esm", outfile: path.join(folder, "production.mjs"), tsconfig: path.join(root, "tsconfig.electron.json") });
const { ProxyTunnelReader, verifyDomesticTunnelEvidence, directTunnelChainFingerprint } = await import(pathToFileURL(path.join(folder, "production.mjs")));
const proxy = { host: "127.0.0.1", port: 10090 }, controller = { host: "127.0.0.1", port: 9790 }, version = { generation: 1, revision: "anonymous-domestic-context" };
const results = [];
for (const [platformId, host] of [["xiaohongshu","edith.xiaohongshu.com"],["xiaohongshu","apm-fe.xiaohongshu.com"],["xiaohongshu","fe-static.xhscdn.com"]]) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 14000);
  const reader = new ProxyTunnelReader({ controllerUrl: "http://127.0.0.1:9790", proxy, targetScope: "domestic", readVersion: () => version, getSecret: () => null });
  const item = { platformId }; let socket, request;
  try {
    socket = await new Promise((resolve,reject) => {
      request = http.request({ hostname: proxy.host, port: proxy.port, method: "CONNECT", path: `${host}:443`, agent:false, signal: abort.signal });
      request.on("error", reject); request.on("connect", (res,sock,head) => { sock.on("error",()=>{}); if(res.statusCode===200 && !head.length) resolve(sock); else { sock.destroy(); reject(Error()); } }); request.end();
    });
    const context = { id: randomUUID(), platformId, target: { host, port:443 }, proxy, socket: { localAddress:socket.localAddress,localPort:socket.localPort,remoteAddress:socket.remoteAddress,remotePort:socket.remotePort }, connectedAtMono:performance.now() };
    const readStartedAtMono = performance.now();
    const evidence = await reader.readTunnel(context,abort.signal); await reader.whenIdle();
    item.evidenceAvailable = !!evidence;
    if(evidence) {
      const row = evidence.connections.value.connections[0], meta = row?.metadata;
      Object.assign(item, { verified:!!verifyDomesticTunnelEvidence({context,evidence,controller,proxy,...version,nowMono:performance.now(),readStartedAtMono}), mode:evidence.controllerBefore.mode, chainDirect:!!directTunnelChainFingerprint(row?.chains,evidence.proxies.value), targetMatched:meta?.host===host, transport:meta?.type, destinationFamily:isIP(meta?.destinationIP??""), remoteFamily:isIP(meta?.remoteDestination??""), readMs:Math.round(performance.now()-readStartedAtMono) });
    }
  } catch { item.error="CONTEXT_UNAVAILABLE"; }
  finally { clearTimeout(timer); abort.abort(); socket?.destroy(); request?.destroy(); await reader.dispose(); results.push(item); }
}
fs.writeFileSync(path.join(folder,"results.json"),JSON.stringify(results,null,2));
console.log(JSON.stringify({folder,results}));
