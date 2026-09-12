import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { getPlatform, isCnPlatformId, isPlatformHost, type CnPlatformId } from "@shared/platforms";

export const DOMESTIC_OPERATIONS = [
  "view-home",
  "view-login",
  "view-upload",
  "view-navigate",
  "check-status",
  "profile",
  "collect",
  "keepalive",
] as const;
export type DomesticOperation = (typeof DOMESTIC_OPERATIONS)[number];

/** An origin is a catalog boundary, not a route proof or an inferred address family. */
export interface ExactOrigin {
  protocol: "https:" | "wss:";
  host: string;
  port: number;
}

export interface CatalogSource {
  file: string;
  symbol: string;
  variant?: number;
}

export interface SourceRequest {
  kind: "navigation" | "probe" | "profile" | "listWorks";
  method: "GET" | "POST";
  /** Static code only, with placeholders for dynamic values; never an observed account URL. */
  urlTemplate: string;
  origin: ExactOrigin;
  source: CatalogSource;
}

export interface OperationSourceInventory {
  platformId: CnPlatformId;
  sourceVersion: string;
  /** Only the enumerated source inputs are frozen. This says nothing about a complete login flow. */
  sourceInventoryFrozen: true;
  routes: Readonly<Record<string, SourceRequest>>;
  probe: SourceRequest;
  probeFromMain: boolean;
  collectorRequests: readonly SourceRequest[];
  verificationCandidates: readonly ExactOrigin[];
}

export interface CatalogReviewIdentity {
  platformId: CnPlatformId;
  operation: DomesticOperation;
  sourceVersion: string;
  /** Binds the actual page selection as well as fixed source requirements. */
  selectionKey: string;
}

/**
 * Trusted main-process review input, never accepted through IPC/settings/observed-host storage.
 * The reviewer owns the evidence that page resources, redirects and selected branches are complete.
 */
export interface MainProcessOperationReview extends CatalogReviewIdentity {
  source: "main-process-flow-review";
  reviewId: string;
  evidenceRefs: readonly string[];
  flowReviewed: boolean;
  /** Reviewed page resources/redirects that are necessary in addition to fixed source origins. */
  additionalRequiredOrigins: readonly ExactOrigin[];
  /** Eligibility for target proof, not permission to send and not all startup requirements. */
  reviewedRequestRange: readonly ExactOrigin[];
}

export interface OperationCatalogRequest {
  platformId: CnPlatformId;
  operation: DomesticOperation;
  /** Actual current account page, supplied by the main process. Omission means no existing page. */
  activePageOrigin?: ExactOrigin | null;
  /** Exact main-process navigation destination; required only for view-navigate. */
  targetPageOrigin?: ExactOrigin;
}

export interface ResolvedOperationCatalog extends CatalogReviewIdentity {
  catalogVersion: string;
  sourceInventoryFrozen: true;
  sourceRequests: readonly SourceRequest[];
  fixedRequestOrigins: readonly ExactOrigin[];
  requiredOrigins: readonly ExactOrigin[];
  /** Source metadata candidates only. The historical captcha entries remain unreviewed here. */
  candidateRequestRange: readonly ExactOrigin[];
  reviewedRequestRange: readonly ExactOrigin[];
  pageOrigin: ExactOrigin | null;
  executionSupported: boolean;
  flowReviewed: boolean;
  reviewState: "unreviewed" | "partial" | "reviewed" | "invalid";
  reviewId: string | null;
  limitations: readonly string[];
}

type EndpointDefinition = readonly [kind: "profile" | "listWorks", path: string, method?: "GET" | "POST"];

// Source contract: ordered candidates, including duplicate paths with different query/body variants.
// Tests compare these against the real collectors so changes require an explicit catalog update.
const COLLECTOR_ENDPOINTS: Record<CnPlatformId, readonly EndpointDefinition[]> = {
  douyin: [
    ["profile", "/web/api/media/user/info/"],
    ["profile", "/aweme/v1/creator/user/info/"],
    ["profile", "/web/api/creator/user/info/"],
    ["listWorks", "/web/api/media/aweme/post/?status=0&count=30&scene=star_atlas&max_cursor=0"],
    ["listWorks", "/web/api/media/aweme/post/?count=30&max_cursor=0"],
    ["listWorks", "/aweme/v1/creator/item/list/?count=30&cursor=0"],
  ],
  kuaishou: [
    ["profile", "/rest/cp/creator/pc/home/infoV2", "POST"],
    ["profile", "/rest/cp/creator/pc/home/info", "POST"],
    ["profile", "/rest/pc/creator/user/info"],
    ["profile", "/rest/cp/creator/pc/user/info", "POST"],
    ["listWorks", "/rest/cp/works/v2/video/pc/photo/list", "POST"],
    ["listWorks", "/rest/cp/works/v2/video/pc/photo/list?pcursor=&count=30"],
    ["listWorks", "/rest/pc/works/photo/list", "POST"],
  ],
  xiaohongshu: [
    ["profile", "/api/galaxy/user/info"],
    ["profile", "/api/galaxy/creator/user/info"],
    ["profile", "/api/galaxy/creator/home/personal_info"],
    ["profile", "/api/galaxy/creator/data/home/overview"],
    ["profile", "/api/galaxy/creator/home/data"],
    ["listWorks", "/api/galaxy/creator/note/user/posted?tab=0&page=1&pageSize=30"],
    ["listWorks", "/api/galaxy/creator/note/user/posted?tab=0&page=1"],
    ["listWorks", "/api/galaxy/creator/notes?page=1&page_size=30"],
  ],
  bilibili: [
    ["profile", "/x/web-interface/nav"],
    ["profile", "/x/web-interface/nav/stat"],
    ["profile", "/x/space/upstat?mid={mid}"],
    ["listWorks", "/x/web/archives?status=is_pubing,pubed,not_pubed&pn=1&ps=30&coop=1&interactive=1"],
    ["listWorks", "/x/web/archives?status=pubed&pn=1&ps=30"],
  ],
  baijiahao: [
    ["profile", "/builder/app/appinfo"],
    ["profile", "/pcui/user/getinfo"],
    ["profile", "/builder/author/appinfo"],
    ["profile", "/builder/author/statistic/overview"],
    ["profile", "/pcui/statistic/overview"],
    ["profile", "/builder/author/data/overview"],
    ["listWorks", "/pcui/article/lists?type=video&collection=&pageSize=30&currentPage=1"],
    ["listWorks", "/pcui/article/lists?type=&collection=&pageSize=30&currentPage=1"],
    ["listWorks", "/builder/author/article/list?type=video&page=1&size=30"],
  ],
  weixin_channels: [
    ["listWorks", "/cgi-bin/mmfinderassistant-bin/post/post_list", "POST"],
    ["listWorks", "/cgi-bin/mmfinderassistant-bin/post/post_list", "POST"],
  ],
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeExactOrigin(input: ExactOrigin): ExactOrigin | null {
  if (
    !input ||
    !["https:", "wss:"].includes(input.protocol) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535 ||
    typeof input.host !== "string" ||
    /[\s/:@?#%\\]/.test(input.host)
  )
    return null;
  const host = domainToASCII(input.host.toLowerCase().replace(/\.$/, ""));
  if (
    !host ||
    host.length > 253 ||
    isIP(host) ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  try {
    if (new URL("https://" + host).hostname !== host) return null;
  } catch {
    return null;
  }
  return { protocol: input.protocol, host, port: input.port };
}

export function exactOriginKey(origin: ExactOrigin): string | null {
  const normalized = normalizeExactOrigin(origin);
  return normalized ? JSON.stringify(normalized) : null;
}

function originFromUrl(raw: string): ExactOrigin {
  const url = new URL(raw);
  const normalized = normalizeExactOrigin({
    protocol: url.protocol as ExactOrigin["protocol"],
    host: url.hostname,
    port: Number(url.port || 443),
  });
  if (!normalized || url.username || url.password) throw new Error("INVALID_OPERATION_CATALOG_SOURCE");
  return normalized;
}

function uniqueOrigins(origins: readonly ExactOrigin[]): ExactOrigin[] {
  const normalized = origins.map(normalizeExactOrigin);
  if (normalized.some((origin) => !origin)) throw new Error("INVALID_OPERATION_CATALOG_ORIGIN");
  return [...new Map(normalized.map((origin) => [exactOriginKey(origin!), origin!])).values()].sort((a, b) =>
    exactOriginKey(a)!.localeCompare(exactOriginKey(b)!),
  );
}

/** New data objects on every call: callers cannot mutate the source inventory for later resolutions. */
export function getOperationSourceInventory(platformId: CnPlatformId): OperationSourceInventory {
  if (!isCnPlatformId(platformId)) throw new Error("INVALID_OPERATION_CATALOG_PLATFORM");
  const platform = getPlatform(platformId);
  const routes: Record<string, SourceRequest> = {};
  for (const [route, url] of Object.entries(platform.routes)) {
    if (!url) continue;
    routes[route] = {
      kind: "navigation",
      method: "GET",
      urlTemplate: url,
      origin: originFromUrl(url),
      source: { file: "src/shared/platforms.ts", symbol: platformId + ".routes." + route },
    };
  }
  const probe: SourceRequest = {
    kind: "probe",
    method: platform.login.probe.method ?? "GET",
    urlTemplate: platform.login.probe.url,
    origin: originFromUrl(platform.login.probe.url),
    source: { file: "src/shared/platforms.ts", symbol: platformId + ".login.probe" },
  };
  const collectorRequests = COLLECTOR_ENDPOINTS[platformId].map(([kind, endpoint, method], index) => {
    const host =
      platformId === "bilibili" && kind === "profile" ? "api.bilibili.com" : routes.home.origin.host;
    const urlTemplate = "https://" + host + endpoint;
    return {
      kind,
      method: method ?? "GET",
      urlTemplate,
      origin: originFromUrl(urlTemplate),
      source: {
        file: "src/main/data/collectors/" + platformId.replace("weixin_channels", "weixin-channels") + ".ts",
        symbol: kind === "profile" ? "readProfile" : "readWorks",
        variant: index + 1,
      },
    } satisfies SourceRequest;
  });
  const verificationCandidates = uniqueOrigins(
    platform.login.verificationHosts.map((host) => ({ protocol: "https:", host, port: 443 })),
  );
  const source = {
    platformId,
    routes,
    probe,
    probeFromMain: platform.login.probeFromMain,
    collectorRequests,
  };
  return {
    ...source,
    sourceVersion: "cn-operation-source-v1:" + digest({ ...source, verificationCandidates }),
    sourceInventoryFrozen: true,
    verificationCandidates,
  };
}

const LIMITATIONS = [
  "Source enumeration is frozen; authenticated page resources, redirects, QR/captcha branches and upload endpoints are not thereby reviewed.",
  "Every actual request needs both reviewed range membership and current evidence for its exact transport target.",
  "An existing page can continue background traffic; coordinate concurrent operations before changing a Session scope.",
] as const;

function resolveSourceSelection(input: OperationCatalogRequest): ResolvedOperationCatalog {
  if (!(DOMESTIC_OPERATIONS as readonly string[]).includes(input.operation))
    throw new Error("INVALID_OPERATION_CATALOG_OPERATION");
  const source = getOperationSourceInventory(input.platformId);
  const page = input.activePageOrigin ? normalizeExactOrigin(input.activePageOrigin) : null;
  if (
    input.activePageOrigin &&
    (!page || page.protocol !== "https:" || !isPlatformHost(input.platformId, page.host))
  )
    throw new Error("INVALID_OPERATION_PAGE_ORIGIN");
  const destination = input.targetPageOrigin ? normalizeExactOrigin(input.targetPageOrigin) : null;
  if (
    input.operation === "view-navigate"
      ? !destination ||
        destination.protocol !== "https:" ||
        !isPlatformHost(input.platformId, destination.host)
      : input.targetPageOrigin !== undefined
  )
    throw new Error("INVALID_OPERATION_NAVIGATION_ORIGIN");
  const viewRoute = {
    "view-home": "home",
    "view-login": "login",
    "view-upload": "upload",
  }[input.operation as "view-home" | "view-login" | "view-upload"];
  // Dynamic navigation carries an origin placeholder only; never retain the user's path/query.
  const dynamicNavigation: SourceRequest | null = destination
    ? {
        kind: "navigation",
        method: "GET",
        urlTemplate: `${destination.protocol}//${destination.host}${destination.port === 443 ? "" : ":" + destination.port}/{main-process-navigation-path}`,
        origin: destination,
        source: {
          file: "src/main/services/account-service.ts",
          symbol: "main-process navigation destination",
        },
      }
    : null;
  const requests = dynamicNavigation
    ? [dynamicNavigation]
    : viewRoute
      ? [source.routes[viewRoute]]
      : input.operation === "check-status"
        ? [source.probe]
        : source.collectorRequests.filter(
            (request) => input.operation !== "profile" || request.kind === "profile",
          );
  const fixedRequestOrigins = uniqueOrigins(requests.map((request) => request.origin));
  // collect/keepalive can navigate workingUrl even when an existing view was supplied.
  const canPrepareHome = input.operation === "collect" || input.operation === "keepalive";
  const pageOrigin =
    destination ??
    (viewRoute
      ? source.routes[viewRoute].origin
      : input.operation === "check-status"
        ? page
        : (page ?? source.routes.home.origin));
  const requiredOrigins = uniqueOrigins([
    ...fixedRequestOrigins,
    ...(pageOrigin ? [pageOrigin] : []),
    ...(canPrepareHome ? [source.routes.home.origin] : []),
  ]);
  const candidateRequestRange = uniqueOrigins([
    ...requiredOrigins,
    source.routes.login.origin,
    ...source.verificationCandidates,
  ]);
  const selectionKey =
    "cn-operation-selection-v1:" +
    digest({
      platformId: input.platformId,
      operation: input.operation,
      sourceVersion: source.sourceVersion,
      pageOrigin,
      requiredOrigins,
    });
  return {
    platformId: input.platformId,
    operation: input.operation,
    sourceVersion: source.sourceVersion,
    selectionKey,
    catalogVersion: selectionKey + ":unreviewed",
    sourceInventoryFrozen: true,
    sourceRequests: requests,
    fixedRequestOrigins,
    requiredOrigins,
    candidateRequestRange,
    reviewedRequestRange: [],
    pageOrigin,
    executionSupported: input.operation !== "check-status" || source.probeFromMain || page !== null,
    flowReviewed: false,
    reviewState: "unreviewed",
    reviewId: null,
    limitations: [...LIMITATIONS],
  };
}

function validReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

/** Resolves policy metadata only; never checks connectivity, reads observed hosts, or issues proof. */
export function resolveOperationCatalog(
  input: OperationCatalogRequest & { review?: MainProcessOperationReview | null },
): ResolvedOperationCatalog {
  const result = resolveSourceSelection(input);
  if (!input.review) return result;
  try {
    const review = input.review;
    if (
      review.source !== "main-process-flow-review" ||
      review.platformId !== result.platformId ||
      review.operation !== result.operation ||
      review.sourceVersion !== result.sourceVersion ||
      review.selectionKey !== result.selectionKey ||
      !validReference(review.reviewId) ||
      !Array.isArray(review.evidenceRefs) ||
      !review.evidenceRefs.length ||
      !review.evidenceRefs.every(validReference) ||
      typeof review.flowReviewed !== "boolean" ||
      !Array.isArray(review.additionalRequiredOrigins) ||
      !Array.isArray(review.reviewedRequestRange)
    )
      throw new Error("INVALID_OPERATION_REVIEW");
    const reviewedRequestRange = uniqueOrigins(review.reviewedRequestRange);
    const additionalRequiredOrigins = uniqueOrigins(review.additionalRequiredOrigins);
    const requiredOrigins = uniqueOrigins([...result.requiredOrigins, ...additionalRequiredOrigins]);
    const range = new Set(reviewedRequestRange.map(exactOriginKey));
    if (
      additionalRequiredOrigins.some((origin) => !range.has(exactOriginKey(origin))) ||
      (review.flowReviewed && requiredOrigins.some((origin) => !range.has(exactOriginKey(origin))))
    )
      throw new Error("INCOMPLETE_OPERATION_REVIEW");
    const flowReviewed = review.flowReviewed && result.executionSupported;
    return {
      ...result,
      catalogVersion:
        "cn-operation-catalog-v1:" +
        digest({
          selectionKey: result.selectionKey,
          reviewId: review.reviewId,
          evidenceRefs: [...review.evidenceRefs].sort(),
          requiredOrigins,
          reviewedRequestRange,
          flowReviewed,
        }),
      requiredOrigins,
      reviewedRequestRange,
      flowReviewed,
      reviewState: flowReviewed ? "reviewed" : "partial",
      reviewId: review.reviewId,
    };
  } catch {
    // Invalid or stale review data never exposes a partially trusted range.
    return { ...result, reviewState: "invalid" };
  }
}

/** Adapter for a main-process reviewed manifest store. It has no renderer/observation fallback. */
export function createOperationCatalogResolver(
  trustedReviewLookup: (identity: CatalogReviewIdentity) => MainProcessOperationReview | null | undefined,
): (input: OperationCatalogRequest) => ResolvedOperationCatalog {
  return (input) => {
    // Extra runtime properties cannot become a review fallback if the trusted store fails.
    const source = resolveSourceSelection(input);
    try {
      const review = trustedReviewLookup({
        platformId: source.platformId,
        operation: source.operation,
        sourceVersion: source.sourceVersion,
        selectionKey: source.selectionKey,
      });
      return resolveOperationCatalog({ ...input, review });
    } catch {
      return { ...source, reviewState: "invalid" };
    }
  };
}
