import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// This is the limited client's implementation boundary, not the whole route-proof graph.
const sources = [
  "src/main/browser/login-detector.ts",
  "src/main/network/gated-session-probe.ts",
  "src/main/services/account-service.ts",
  "src/main/data/scheduler.ts",
  "src/main/db/repositories/accounts.ts",
  "src/main/network/business-access.ts",
  "src/main/network/operation-catalog.ts",
  "src/shared/platforms.ts",
];

/** Hash and compile the same source snapshot; no generated files or renderer manifest. */
export function reviewedOperationBuildOptions(repositoryRoot) {
  const snapshots = new Map();
  const sourceHashes = {};
  for (const source of sources) {
    const absolute = path.resolve(repositoryRoot, source);
    try {
      const bytes = fs.readFileSync(absolute);
      snapshots.set(absolute, bytes.toString("utf8"));
      sourceHashes[source] = createHash("sha256").update(bytes).digest("hex");
    } catch {
      // A missing build declaration cannot match a reviewed implementation.
    }
  }
  let electronVersion = null;
  try {
    electronVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "node_modules/electron/package.json"), "utf8")).version;
  } catch { /* The resolver stays unreviewed when the runtime package is unknown. */ }
  return {
    define: {
      __CLIPDOCK_REVIEWED_OPERATION_BUILD__: JSON.stringify({
        kind: "clipdock-reviewed-operation-build-v1",
        electronVersion,
        sourceHashes,
      }),
    },
    plugins: [{
      name: "reviewed-operation-source-snapshot",
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, (args) => {
          const contents = snapshots.get(path.resolve(args.path));
          if (contents === undefined) return undefined;
          return { contents, loader: "ts", resolveDir: path.dirname(args.path) };
        });
      },
    }],
  };
}
