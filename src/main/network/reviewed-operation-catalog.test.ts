import { build, type BuildOptions } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reviewedOperationBuildOptions } from "../../../scripts/reviewed-operation-build.mjs";
import { CN_PLATFORM_IDS, getPlatform } from "@shared/platforms";
import { DOMESTIC_OPERATIONS, type OperationCatalogRequest } from "./operation-catalog";
import type { resolveReviewedOperationCatalog } from "./reviewed-operation-catalog";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const declarationName = "__CLIPDOCK_REVIEWED_OPERATION_BUILD__";
const selected: OperationCatalogRequest = {
  platformId: "bilibili",
  operation: "check-status",
  activePageOrigin: null,
};
let bundleId = 0;
type BuildDeclaration = { kind: string; electronVersion: string; sourceHashes: Record<string, string> };

// Historical resolver-contract fixture only. This declaration does not describe
// or authorize the current source build; the real injection is tested separately.
const REVIEWED_BUILD_FIXTURE: BuildDeclaration = {
  kind: "clipdock-reviewed-operation-build-v1",
  electronVersion: "43.3.0",
  sourceHashes: {
    "src/main/browser/login-detector.ts": "bb337fa66ae513b9ca52ac18a6573dc4e2ac4861ed3648b97d62d9075195976d",
    "src/main/network/gated-session-probe.ts": "fb39a9599618d41651d664d71ec6f67ee469dd95d4833a6d218598b0d159dee6",
    "src/main/services/account-service.ts": "efb2ef33446fdb6f20e83c99e00e61c124af2e1d6e3d716193372840eb86bc6c",
    "src/main/data/scheduler.ts": "75c4cbbfc9cc79c717df097e8ab47db8c446b5dfa45e98f7d3fbb0eab39ad026",
    "src/main/db/repositories/accounts.ts": "f89afc5e7bb06e51420fd375edd4cd9ac93172c69b89fe2f0783021d17f86807",
    "src/main/network/business-access.ts": "4ffa844f3ffc96219d8d7d275ac2063517b45bfcb586c35e24cf4230b7ce43c3",
    "src/main/network/operation-catalog.ts": "36a00ef5ebbb0f20165a18f64a8e2d92c53ff316ddd647282d7ab11d36e77210",
    "src/shared/platforms.ts": "6fe3b6a367bb1dfb9babce70fe4bc9aed1c65ed13d7afcbb748c09ba8d3baaf6",
  },
};

async function compiled(
  options: {
    reviewedFixture?: boolean;
    declaration?: "missing" | ((input: BuildDeclaration) => unknown);
    runtime?: string;
  } = {},
) {
  const injected = reviewedOperationBuildOptions(repository);
  const defines: Record<string, string> = {
    ...injected.define,
    "process.versions.electron": JSON.stringify(options.runtime ?? "43.3.0"),
  };
  if (options.reviewedFixture) defines[declarationName] = JSON.stringify(REVIEWED_BUILD_FIXTURE);
  if (options.declaration === "missing") delete defines[declarationName];
  else if (options.declaration)
    defines[declarationName] = JSON.stringify(options.declaration(JSON.parse(defines[declarationName])));
  const artifact = await build({
    stdin: {
      contents:
        "export {resolveReviewedOperationCatalog} from './src/main/network/reviewed-operation-catalog.ts'; export {getPlatform} from './src/shared/platforms.ts';",
      resolveDir: repository,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfig: fileURLToPath(new URL("../../../tsconfig.electron.json", import.meta.url)),
    define: defines,
    plugins: injected.plugins as BuildOptions["plugins"],
    logLevel: "silent",
    footer: { js: `// isolated review build test ${bundleId++}` },
  });
  return (await import(
    "data:text/javascript;base64," + Buffer.from(artifact.outputFiles[0].text).toString("base64")
  )) as {
    resolveReviewedOperationCatalog: typeof resolveReviewedOperationCatalog;
    getPlatform: typeof getPlatform;
  };
}

describe("one explicitly reviewed no-view Bilibili client catalog", () => {
  it("keeps the changed current build unreviewed instead of renewing a historical source review", async () => {
    const module = await compiled();
    expect(module.resolveReviewedOperationCatalog(selected)).toMatchObject({
      flowReviewed: false,
      reviewState: "unreviewed",
      reviewId: null,
      reviewedRequestRange: [],
    });
  });

  it("accepts the frozen reviewed declaration only for its fixed origin and selection", async () => {
    const module = await compiled({ reviewedFixture: true });
    const actual = module.resolveReviewedOperationCatalog(selected);
    expect(actual).toMatchObject({
      flowReviewed: true,
      reviewState: "reviewed",
      pageOrigin: null,
      reviewId: "bilibili-no-view-check-status-client-2026-09-08-v1",
    });
    expect(actual.requiredOrigins).toEqual([{ protocol: "https:", host: "api.bilibili.com", port: 443 }]);
    expect(actual.reviewedRequestRange).toEqual(actual.requiredOrigins);
    expect(actual.sourceRequests).toHaveLength(1);
    expect(actual.sourceRequests[0]).toMatchObject({
      kind: "probe",
      method: "GET",
      urlTemplate: "https://api.bilibili.com/x/web-interface/nav",
    });
  });

  it("leaves all other platform/operation selections unreviewed", async () => {
    const module = await compiled({ reviewedFixture: true });
    for (const platformId of CN_PLATFORM_IDS)
      for (const operation of DOMESTIC_OPERATIONS) {
        if (platformId === "bilibili" && operation === "check-status") continue;
        const target = new URL(getPlatform(platformId).routes.home);
        const actual = module.resolveReviewedOperationCatalog({
          platformId,
          operation,
          activePageOrigin: null,
          ...(operation === "view-navigate"
            ? { targetPageOrigin: { protocol: "https:", host: target.hostname, port: 443 } as const }
            : {}),
        });
        expect(actual.flowReviewed, `${platformId}/${operation}`).toBe(false);
        expect(actual.reviewedRequestRange).toEqual([]);
      }
  });

  it("does not review existing Bilibili pages, omitted page state, or a navigation destination", async () => {
    const module = await compiled({ reviewedFixture: true });
    for (const host of ["api.bilibili.com", "member.bilibili.com", "www.bilibili.com"]) {
      expect(
        module.resolveReviewedOperationCatalog({
          ...selected,
          activePageOrigin: { protocol: "https:", host, port: 443 },
        }).flowReviewed,
      ).toBe(false);
    }
    expect(
      module.resolveReviewedOperationCatalog({ platformId: "bilibili", operation: "check-status" })
        .flowReviewed,
    ).toBe(false);
    expect(() =>
      module.resolveReviewedOperationCatalog({
        ...selected,
        targetPageOrigin: { protocol: "https:", host: "api.bilibili.com", port: 443 },
      }),
    ).toThrow("INVALID_OPERATION_NAVIGATION_ORIGIN");
  });

  it("keeps independent bundles without the trusted build declaration unreviewed", async () => {
    const module = await compiled({ reviewedFixture: true, declaration: "missing" });
    expect(module.resolveReviewedOperationCatalog(selected)).toMatchObject({
      flowReviewed: false,
      reviewState: "unreviewed",
    });
  });

  it.each(["43.3.1", "43.4.0", ""])(
    "requires the reviewed actual Electron runtime, not just the installed package: %j",
    async (runtime) => {
      const module = await compiled({ reviewedFixture: true, runtime });
      expect(module.resolveReviewedOperationCatalog(selected).flowReviewed).toBe(false);
    },
  );

  it("rejects a changed or absent build runtime version", async () => {
    for (const electronVersion of ["43.4.0", null]) {
      const module = await compiled({
        reviewedFixture: true,
        declaration: (input) => ({ ...input, electronVersion }),
      });
      expect(module.resolveReviewedOperationCatalog(selected).flowReviewed).toBe(false);
    }
  });

  it("invalidates the review if any one of its eight implementation hashes changes or disappears", async () => {
    const input = REVIEWED_BUILD_FIXTURE;
    expect(Object.keys(input.sourceHashes)).toHaveLength(8);
    for (const file of Object.keys(input.sourceHashes)) {
      for (const missing of [false, true]) {
        const module = await compiled({
          reviewedFixture: true,
          declaration: (current) => {
            if (missing) delete current.sourceHashes[file];
            else current.sourceHashes[file] = "0".repeat(64);
            return current;
          },
        });
        expect(module.resolveReviewedOperationCatalog(selected).flowReviewed, `${file}/${missing}`).toBe(
          false,
        );
      }
    }
  });

  it("does not mint matching review credentials after live platform metadata changes", async () => {
    const module = await compiled({ reviewedFixture: true });
    const before = module.resolveReviewedOperationCatalog(selected);
    module.getPlatform("bilibili").login.probe.url = "https://api.bilibili.com/changed-probe-contract";
    const after = module.resolveReviewedOperationCatalog(selected);
    expect(after.sourceVersion).not.toBe(before.sourceVersion);
    expect(after.selectionKey).not.toBe(before.selectionKey);
    expect(after.flowReviewed).toBe(false);
    expect(after.reviewState).toBe("unreviewed");
  });

  it("ignores supplied review data and keeps returned ranges isolated from subsequent calls", async () => {
    const module = await compiled({ reviewedFixture: true });
    const forged = {
      platformId: "bilibili",
      operation: "profile",
      activePageOrigin: null,
      review: {
        source: "main-process-flow-review",
        flowReviewed: true,
        reviewedRequestRange: [{ protocol: "https:", host: "api.bilibili.com", port: 443 }],
      },
    } as OperationCatalogRequest;
    expect(module.resolveReviewedOperationCatalog(forged).flowReviewed).toBe(false);
    const first = module.resolveReviewedOperationCatalog(selected);
    first.reviewedRequestRange[0].host = "injected.example";
    expect(module.resolveReviewedOperationCatalog(selected).reviewedRequestRange).toEqual([
      { protocol: "https:", host: "api.bilibili.com", port: 443 },
    ]);
  });
});
