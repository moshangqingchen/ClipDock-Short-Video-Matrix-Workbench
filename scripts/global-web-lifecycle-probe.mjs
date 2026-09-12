/** Native production launcher, owned profile and service; synthetic revoked eligibility.
 * All website CONNECTs are refused inside the loopback relay. No external target receives data.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
if (process.platform !== "win32" || process.argv.slice(2).join(" ") !== "--run-once") throw new Error("EXPLICIT_WINDOWS_RUN_REQUIRED");
const root = process.cwd(), stamp = new Date().toISOString().replace(/[-:.]/g, ""),
  folder = fs.mkdtempSync(path.join(root, "docs", ".compare", "global-web-lifecycle-")), bundle = path.join(folder, "production.mjs");
await build({ stdin: { contents: `export { GlobalWebService } from ${JSON.stringify(path.join(root, "src/main/services/global-web-service.ts"))};`, resolveDir: root },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node24", external: ["node:*"], alias: { "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main") } });
const { GlobalWebService } = await import(pathToFileURL(bundle).href);
const id = randomUUID(), abort = new AbortController(), states = [];
const account = { id, platformId: "youtube", displayName: "Controlled lifecycle fixture", authStatus: "unauthorized", remoteId: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const result = { startedAt: new Date().toISOString(), productionLauncher: true, syntheticEligibilityOnly: true,
  externalConnections: 0, refusedConnects: 0, realAccountUsed: false, systemProxyChanged: false, states, passed: false };
let preflight = true;
const service = new GlobalWebService({ dataDirectory: folder, getAccount: (key) => key === id ? account : undefined,
  acquireEligibility: async () => ({ generation: 1, signal: abort.signal, isCurrent: () => !abort.signal.aborted, release() {} }),
  openTunnel: async () => {
    if (preflight) { preflight = false; const stream = new PassThrough(); return { stream, close: () => stream.destroy(), closed: Promise.resolve() }; }
    result.refusedConnects++; throw new Error("CONTROLLED_NO_EXTERNAL_CONNECTION");
  },
  onChanged: ({ phase, errorCode }) => states.push({ phase, errorCode }) });
try {
  const opened = await service.open(id);
  if (opened.phase !== "open") throw new Error(opened.errorCode ?? "NATIVE_OPEN_FAILED");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  abort.abort();
  await service.close(id);
  if (service.state(id).phase !== "dormant") throw new Error("NATIVE_REVOKE_FAILED");
  result.passed = true;
} catch (error) { result.error = /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : "NATIVE_LIFECYCLE_FAILED"; process.exitCode = 1; }
finally {
  abort.abort();
  try { await service.dispose(); result.cleanupComplete = true; } catch { result.cleanupComplete = false; result.passed = false; process.exitCode = 1; }
  result.completedAt = new Date().toISOString();
  const output = path.join(root, "docs", ".compare", `global-web-lifecycle-${stamp}.results.json`);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: result.passed, error: result.error, result: output }) + "\n");
}
