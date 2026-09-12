// Read-only Windows startup timing. No platform requests or proxy configuration changes.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "node_modules/.cache/network-startup-benchmark/runtime.cjs");
mkdirSync(path.dirname(bundle), { recursive: true });
await build({
  stdin: {
    contents: `
      export { WindowsNetworkFingerprintReader, WindowsNetworkFingerprintWatcher } from './src/main/network/windows-network-fingerprint';
      export { WindowsProxyStateReader } from './src/main/network/windows-proxy-state';
      export { ExclusiveNetworkSwitch } from './src/main/network/exclusive-switch';
    `,
    resolveDir: root,
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  alias: { "@shared": path.join(root, "src/shared"), "@main": path.join(root, "src/main") },
});
const {
  WindowsNetworkFingerprintReader,
  WindowsNetworkFingerprintWatcher,
  WindowsProxyStateReader,
  ExclusiveNetworkSwitch,
} = createRequire(import.meta.url)(bundle);
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const events = [];
const fingerprints = new WindowsNetworkFingerprintReader();
const proxy = new WindowsProxyStateReader();
const watcher = new WindowsNetworkFingerprintWatcher({
  reader: {
    async read() {
      const at = elapsed();
      const value = await fingerprints.read();
      events.push({ kind: "network-read", at, durationMs: elapsed() - at, available: value.available });
      return value;
    },
  },
  onChange(value) {
    events.push({ kind: "network-change", at: elapsed(), available: value.available });
    if (typeof switching.networkChanged === "function") switching.networkChanged();
    else switching.invalidate("NETWORK_CHANGED");
  },
});
const switching = new ExclusiveNetworkSwitch({
  readNetwork: () => watcher.getSnapshot(),
  async readProxy(signal) {
    const at = elapsed();
    const value = await proxy.read({}, signal);
    events.push({ kind: "proxy-read", at, durationMs: elapsed() - at, state: value.state });
    return value;
  },
  whenIdle: () => proxy.whenIdle(),
});
let finish;
let firstDecisionMs = null;
const result = new Promise((resolve) => {
  finish = resolve;
});
const timeout = setTimeout(() => finish({ state: "timeout", durationMs: elapsed() }), 30_000);
switching.on("state", (value) => {
  events.push({ kind: "switch", at: elapsed(), state: value.state, reason: value.reason });
  if (value.state === "domestic" || value.state === "overseas") {
    firstDecisionMs ??= elapsed();
    if (watcher.getSnapshot().available)
      finish({ state: value.state, firstDecisionMs, durationMs: elapsed() });
  }
});
watcher.start();
switching.start();
const outcome = await result;
clearTimeout(timeout);
watcher.stop();
await switching.dispose();
proxy.dispose();
console.log(JSON.stringify({ ...outcome, events }, null, 2));
if (outcome.state === "timeout") process.exitCode = 1;
