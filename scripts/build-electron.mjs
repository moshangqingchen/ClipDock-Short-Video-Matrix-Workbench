import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import { reviewedOperationBuildOptions } from "./reviewed-operation-build.mjs";
import { buildChromeDock } from "./build-chrome-dock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");
const outDir = path.join(root, "dist-electron");

fs.mkdirSync(outDir, { recursive: true });
buildChromeDock(root, outDir);

const shared = {
  bundle: true,
  metafile: true,
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
const reviewedOperations = reviewedOperationBuildOptions(root);
const mainBundle = await build({
  ...shared,
  define: { ...shared.define, ...reviewedOperations.define },
  plugins: reviewedOperations.plugins,
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
const preloadBundle = await build({
  ...shared,
  entryPoints: [path.join(root, "src/preload/index.ts")],
  outfile: path.join(outDir, "preload.cjs"),
  format: "cjs",
  external: ["electron"],
});

// Production packages omit node_modules because these outputs contain their
// dependencies. Refuse a future build that silently reintroduces an external one.
for (const [name, result] of [["main", mainBundle], ["preload", preloadBundle]]) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && dependency.path !== "electron" && !isBuiltin(dependency.path))
        throw new Error(`${name} requires an unbundled runtime dependency: ${dependency.path}`);
    }
  }
}
