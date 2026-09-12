import {
  resolveOperationCatalog,
  type MainProcessOperationReview,
  type OperationCatalogRequest,
  type ResolvedOperationCatalog,
} from "./operation-catalog";

/** Injected only by the main-process build. Unbuilt scripts have no review authority. */
declare const __CLIPDOCK_REVIEWED_OPERATION_BUILD__: unknown;

const REVIEWED_ELECTRON = "43.3.0";
const REVIEWED_SOURCES: Readonly<Record<string, string>> = {
  "src/main/browser/login-detector.ts": "bb337fa66ae513b9ca52ac18a6573dc4e2ac4861ed3648b97d62d9075195976d",
  "src/main/network/gated-session-probe.ts": "fb39a9599618d41651d664d71ec6f67ee469dd95d4833a6d218598b0d159dee6",
  "src/main/services/account-service.ts": "efb2ef33446fdb6f20e83c99e00e61c124af2e1d6e3d716193372840eb86bc6c",
  "src/main/data/scheduler.ts": "75c4cbbfc9cc79c717df097e8ab47db8c446b5dfa45e98f7d3fbb0eab39ad026",
  "src/main/db/repositories/accounts.ts": "f89afc5e7bb06e51420fd375edd4cd9ac93172c69b89fe2f0783021d17f86807",
  "src/main/network/business-access.ts": "4ffa844f3ffc96219d8d7d275ac2063517b45bfcb586c35e24cf4230b7ce43c3",
  "src/main/network/operation-catalog.ts": "36a00ef5ebbb0f20165a18f64a8e2d92c53ff316ddd647282d7ab11d36e77210",
  "src/shared/platforms.ts": "6fe3b6a367bb1dfb9babce70fe4bc9aed1c65ed13d7afcbb748c09ba8d3baaf6",
};

// Review credentials are fixed, never manufactured from a newly resolved selection.
const REVIEW: MainProcessOperationReview = {
  source: "main-process-flow-review",
  reviewId: "bilibili-no-view-check-status-client-2026-09-08-v1",
  platformId: "bilibili",
  operation: "check-status",
  sourceVersion: "cn-operation-source-v1:8db2f3856739449e33160976fa7ce25102f3fc9cbf2086cb98aaeb3e1d592074",
  selectionKey: "cn-operation-selection-v1:52ae5cf4f3cf423f619047b96ca1257443f5017dbf47296a3d4932182c99bc4f",
  evidenceRefs: [
    "docs/network-bilibili-no-view-client-review-2026-09-08.results.json#2026-09-07T22:28:32.389Z",
    "evidence-sha256:41dfdfe30699333a6302844e039a9ac5c273ca1e14edac14f3788264a1846165",
    "docs/network-bilibili-check-status-smoke.md#固定-api-目录与出口证据分别验收",
    "client-contract:original-session-get;same-https-origin-redirects<=5;explicit-auth-json-or-401;unconfirmed-preserves-auth",
  ],
  flowReviewed: true,
  additionalRequiredOrigins: [],
  reviewedRequestRange: [{ protocol: "https:", host: "api.bilibili.com", port: 443 }],
};

function matchesReviewedImplementation(): boolean {
  try {
    if (
      typeof __CLIPDOCK_REVIEWED_OPERATION_BUILD__ === "undefined" ||
      process.versions.electron !== REVIEWED_ELECTRON
    )
      return false;
    const input = __CLIPDOCK_REVIEWED_OPERATION_BUILD__;
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const build = input as Record<string, unknown>;
    if (build.kind !== "clipdock-reviewed-operation-build-v1" || build.electronVersion !== REVIEWED_ELECTRON)
      return false;
    const hashes = build.sourceHashes;
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) return false;
    return Object.entries(REVIEWED_SOURCES).every(
      ([file, expected]) =>
        Object.hasOwn(hashes, file) && (hashes as Record<string, unknown>)[file] === expected,
    );
  } catch {
    return false;
  }
}

/**
 * Main bootstrap selects this resolver for one reviewed client branch. It neither sends
 * requests nor proves actual platform compatibility, authentication or mainland egress.
 * Other branches remain unreviewed; enforcement and proof installation are separate.
 */
export function resolveReviewedOperationCatalog(input: OperationCatalogRequest): ResolvedOperationCatalog {
  // Deliberately discard any caller-supplied review fields.
  const selection: OperationCatalogRequest = {
    platformId: input.platformId,
    operation: input.operation,
    activePageOrigin: input.activePageOrigin,
    ...(input.targetPageOrigin !== undefined ? { targetPageOrigin: input.targetPageOrigin } : {}),
  };
  const original = resolveOperationCatalog(selection);
  if (
    selection.platformId !== "bilibili" ||
    selection.operation !== "check-status" ||
    selection.activePageOrigin !== null ||
    selection.targetPageOrigin !== undefined ||
    original.sourceVersion !== REVIEW.sourceVersion ||
    original.selectionKey !== REVIEW.selectionKey ||
    !matchesReviewedImplementation()
  )
    return original;
  return resolveOperationCatalog({ ...selection, review: REVIEW });
}
