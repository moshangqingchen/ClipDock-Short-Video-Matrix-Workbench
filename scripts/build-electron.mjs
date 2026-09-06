import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");
const outDir = path.join(root, "dist-electron");

fs.mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
  },
  alias: {
    "@shared": path.join(root, "src/shared"),
    "@main": path.join(root, "src/main"),
  },
};

// The main process is emitted as ESM (package.json "type": "module"). Electron
// and Node built-ins stay external so the runtime binaries are used.
await build({
  ...shared,
  entryPoints: [path.join(root, "src/main/index.ts")],
  outfile: path.join(outDir, "main.js"),
  format: "esm",
  external: ["electron", "node:*"],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

// Sandboxed preload scripts must be CommonJS. Only `electron` is external; the
// bundle contains no Node built-ins because sandboxed preloads cannot use them.
await build({
  ...shared,
  entryPoints: [path.join(root, "src/preload/index.ts")],
  outfile: path.join(outDir, "preload.cjs"),
  format: "cjs",
  external: ["electron"],
});
