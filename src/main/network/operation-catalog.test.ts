import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { CN_PLATFORM_IDS, getPlatform, type CnPlatformId } from "@shared/platforms";
import { candidateTargets } from "./catalog";
import {
  DOMESTIC_OPERATIONS,
  createOperationCatalogResolver,
  exactOriginKey,
  getOperationSourceInventory,
  normalizeExactOrigin,
  resolveOperationCatalog,
  type ExactOrigin,
  type MainProcessOperationReview,
  type OperationCatalogRequest,
} from "./operation-catalog";

const origin = (host: string): ExactOrigin => ({ protocol: "https:", host, port: 443 });
const hosts = (origins: readonly ExactOrigin[]) => origins.map((value) => value.host).sort();

function reviewFor(input: OperationCatalogRequest): MainProcessOperationReview {
  const catalog = resolveOperationCatalog(input);
  return {
    source: "main-process-flow-review",
    reviewId: "synthetic-reviewed-flow",
    evidenceRefs: ["synthetic-controlled-flow"],
    platformId: catalog.platformId,
    operation: catalog.operation,
    sourceVersion: catalog.sourceVersion,
    selectionKey: catalog.selectionKey,
    flowReviewed: true,
    additionalRequiredOrigins: [],
    reviewedRequestRange: catalog.requiredOrigins,
  };
}

/** Independent source contract check: inspect actual firstJson calls, never execute a collector. */
function collectorSourceRequests(platformId: CnPlatformId) {
  const file = "src/main/data/collectors/" + platformId.replace("weixin_channels", "weixin-channels") + ".ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string>();
  const result: Array<{ kind: string; method: string; urlTemplate: string }> = [];
  const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteralLike(node.initializer))
      constants.set(node.name.getText(source), node.initializer.text);
  });
  const property = (node: ts.ObjectLiteralExpression, name: string) =>
    node.properties.find(
      (entry): entry is ts.PropertyAssignment =>
        ts.isPropertyAssignment(entry) && entry.name.getText(source) === name,
    )?.initializer;
  const template = (node: ts.Expression): string => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map(
            (span) =>
              (constants.get(span.expression.getText(source)) ??
                "{" + span.expression.getText(source) + "}") + span.literal.text,
          )
          .join("")
      );
    throw new Error("Source changed to a nonliteral collector URL; review inventory");
  };
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText(source) !== "firstJson") return;
    let parent: ts.Node | undefined = node.parent;
    while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
    const name = parent && ts.isFunctionDeclaration(parent) ? parent.name?.getText(source) : undefined;
    expect(["readProfile", "readWorks"]).toContain(name);
    const candidates = node.arguments[1] as ts.ArrayLiteralExpression;
    expect(ts.isArrayLiteralExpression(candidates)).toBe(true);
    for (const candidate of candidates.elements) {
      const object = candidate as ts.ObjectLiteralExpression;
      const init = property(object, "init") as ts.ObjectLiteralExpression | undefined;
      const method = init ? property(init, "method") : undefined;
      result.push({
        kind: name === "readProfile" ? "profile" : "listWorks",
        method: method ? (method as ts.StringLiteral).text : "GET",
        urlTemplate: template(property(object, "url")!),
      });
    }
  });
  return result;
}

describe("operation source inventory", () => {
  it("matches all 37 real collector URL/method alternatives and all platform navigation/probe metadata", () => {
    let count = 0;
    for (const platformId of CN_PLATFORM_IDS) {
      const inventory = getOperationSourceInventory(platformId);
      expect(
        inventory.collectorRequests.map(({ kind, method, urlTemplate }) => ({
          kind,
          method,
          urlTemplate,
        })),
      ).toEqual(collectorSourceRequests(platformId));
      count += inventory.collectorRequests.length;
      const platform = getPlatform(platformId);
      expect(
        Object.fromEntries(
          Object.entries(inventory.routes).map(([route, entry]) => [route, entry.urlTemplate]),
        ),
      ).toEqual(platform.routes);
      expect(inventory.probe.urlTemplate).toBe(platform.login.probe.url);
      expect(inventory.probe.method).toBe(platform.login.probe.method ?? "GET");
      expect(inventory.probeFromMain).toBe(platform.login.probeFromMain);
      expect(inventory.sourceVersion).toMatch(/^cn-operation-source-v1:[a-f0-9]{64}$/);
    }
    expect(count).toBe(37);
    expect(candidateTargets()).toHaveLength(30);
  });

  it("freezes source enumeration without granting operation flows or request ranges", () => {
    for (const platformId of CN_PLATFORM_IDS) {
      for (const operation of DOMESTIC_OPERATIONS) {
        const catalog = resolveOperationCatalog({
          platformId,
          operation,
          ...(operation === "view-navigate"
            ? { targetPageOrigin: origin(new URL(getPlatform(platformId).routes.home).hostname) }
            : {}),
        });
        expect(catalog.sourceInventoryFrozen).toBe(true);
        expect(catalog.flowReviewed).toBe(false);
        expect(catalog.reviewState).toBe("unreviewed");
        expect(catalog.reviewedRequestRange).toEqual([]);
        expect(catalog.requiredOrigins.length).toBeGreaterThan(0);
        expect(catalog.requiredOrigins.every((target) => Object.keys(target).length === 3)).toBe(true);
      }
    }
  });

  it("does not turn Kuaishou historical captcha candidates or a consumer homepage into collect requirements", () => {
    const catalog = resolveOperationCatalog({ platformId: "kuaishou", operation: "collect" });
    expect(hosts(catalog.requiredOrigins)).toEqual(["cp.kuaishou.com"]);
    expect(hosts(catalog.candidateRequestRange)).toContain("captcha.kuaishou.com");
    expect(hosts(catalog.candidateRequestRange)).toContain("sec.kuaishou.com");
    expect(hosts(catalog.candidateRequestRange)).not.toContain("www.kuaishou.com");
    for (const platformId of CN_PLATFORM_IDS) {
      const site = getPlatform(platformId).routes.site;
      if (!site) continue;
      const selected = resolveOperationCatalog({ platformId, operation: "collect" });
      expect(hosts(selected.requiredOrigins)).not.toContain(new URL(site).hostname);
    }
  });

  it("separates Bilibili profile API from its page prerequisite, and keepalive uses the complete collect scope", () => {
    const profile = resolveOperationCatalog({ platformId: "bilibili", operation: "profile" });
    expect(hosts(profile.fixedRequestOrigins)).toEqual(["api.bilibili.com"]);
    expect(hosts(profile.requiredOrigins)).toEqual(["api.bilibili.com", "member.bilibili.com"]);
    const status = resolveOperationCatalog({ platformId: "bilibili", operation: "check-status" });
    expect(hosts(status.requiredOrigins)).toEqual(["api.bilibili.com"]);
    expect(status.pageOrigin).toBeNull();
    for (const platformId of CN_PLATFORM_IDS) {
      const collect = resolveOperationCatalog({ platformId, operation: "collect" });
      const keepalive = resolveOperationCatalog({ platformId, operation: "keepalive" });
      expect(keepalive.sourceRequests).toEqual(collect.sourceRequests);
      expect(keepalive.requiredOrigins).toEqual(collect.requiredOrigins);
      expect(keepalive.selectionKey).not.toBe(collect.selectionKey);
    }
  });

  it("binds existing pages explicitly and does not certify page-only probes without a page", () => {
    const input = { platformId: "kuaishou", operation: "check-status" } as const;
    expect(resolveOperationCatalog(input).executionSupported).toBe(false);
    const review = reviewFor(input);
    expect(resolveOperationCatalog({ ...input, review }).flowReviewed).toBe(false);
    const withPage = resolveOperationCatalog({ ...input, activePageOrigin: origin("cp.kuaishou.com") });
    expect(withPage.executionSupported).toBe(true);
    expect(withPage.selectionKey).not.toBe(resolveOperationCatalog(input).selectionKey);

    const home = resolveOperationCatalog({ platformId: "bilibili", operation: "profile" });
    const site = resolveOperationCatalog({
      platformId: "bilibili",
      operation: "profile",
      activePageOrigin: origin("www.bilibili.com"),
    });
    expect(hosts(site.requiredOrigins)).toEqual(["api.bilibili.com", "www.bilibili.com"]);
    expect(site.selectionKey).not.toBe(home.selectionKey);
    expect(() =>
      resolveOperationCatalog({
        platformId: "bilibili",
        operation: "profile",
        activePageOrigin: origin("unrelated.example.test"),
      }),
    ).toThrow("INVALID_OPERATION_PAGE_ORIGIN");
  });

  it("keeps view routes separate and does not invent actual upload API endpoints", () => {
    for (const platformId of CN_PLATFORM_IDS) {
      for (const [operation, route] of [
        ["view-home", "home"],
        ["view-login", "login"],
        ["view-upload", "upload"],
      ] as const) {
        const catalog = resolveOperationCatalog({ platformId, operation });
        expect(catalog.sourceRequests).toHaveLength(1);
        expect(catalog.sourceRequests[0].urlTemplate).toBe(getPlatform(platformId).routes[route]);
        expect(catalog.sourceRequests[0].kind).toBe("navigation");
        expect(catalog.flowReviewed).toBe(false);
      }
    }
  });

  it("binds custom navigation and site to their actual exact destination without retaining path/query", () => {
    const input = {
      platformId: "bilibili",
      operation: "view-navigate",
      targetPageOrigin: origin("www.bilibili.com"),
    } as const;
    const site = resolveOperationCatalog(input);
    expect(hosts(site.requiredOrigins)).toEqual(["www.bilibili.com"]);
    expect(site.pageOrigin).toEqual(input.targetPageOrigin);
    expect(site.sourceRequests).toHaveLength(1);
    expect(site.sourceRequests[0].source.symbol).toBe("main-process navigation destination");
    expect(site.selectionKey).not.toBe(
      resolveOperationCatalog({ platformId: "bilibili", operation: "view-home" }).selectionKey,
    );
    expect(
      resolveOperationCatalog({ ...input, targetPageOrigin: { ...input.targetPageOrigin, port: 8443 } })
        .selectionKey,
    ).not.toBe(site.selectionKey);
    const review = reviewFor(input);
    expect(
      resolveOperationCatalog({ ...input, targetPageOrigin: origin("member.bilibili.com"), review })
        .flowReviewed,
    ).toBe(false);
  });

  it("rejects implicit, foreign and non-HTTPS custom navigation destinations", () => {
    for (const targetPageOrigin of [
      undefined,
      origin("attacker.test"),
      { ...origin("www.bilibili.com"), protocol: "wss:" as const },
    ])
      expect(() =>
        resolveOperationCatalog({ platformId: "bilibili", operation: "view-navigate", targetPageOrigin }),
      ).toThrow("INVALID_OPERATION_NAVIGATION_ORIGIN");
    expect(() =>
      resolveOperationCatalog({
        platformId: "bilibili",
        operation: "view-home",
        targetPageOrigin: origin("www.bilibili.com"),
      }),
    ).toThrow("INVALID_OPERATION_NAVIGATION_ORIGIN");
  });
});

describe("main-process operation review resolver", () => {
  const input = { platformId: "kuaishou", operation: "collect" } as const;

  it("separates reviewed optional range from required resource dependencies", () => {
    const review = reviewFor(input);
    review.reviewedRequestRange = [...review.reviewedRequestRange, origin("captcha.zt.kuaishou.com")];
    const catalog = resolveOperationCatalog({ ...input, review });
    expect(catalog.flowReviewed).toBe(true);
    expect(hosts(catalog.requiredOrigins)).toEqual(["cp.kuaishou.com"]);
    expect(hosts(catalog.reviewedRequestRange)).toEqual(["captcha.zt.kuaishou.com", "cp.kuaishou.com"]);
    expect(hosts(catalog.reviewedRequestRange)).not.toContain("captcha.kuaishou.com");

    review.additionalRequiredOrigins = [origin("captcha.zt.kuaishou.com")];
    const selectedBranch = resolveOperationCatalog({ ...input, review });
    expect(selectedBranch.requiredOrigins).toEqual(selectedBranch.reviewedRequestRange);
    expect(selectedBranch.catalogVersion).not.toBe(catalog.catalogVersion);
  });

  it("preserves a partial range review without claiming the flow is complete", () => {
    const review = reviewFor(input);
    review.flowReviewed = false;
    review.reviewedRequestRange = [origin("captcha.zt.kuaishou.com")];
    const catalog = resolveOperationCatalog({ ...input, review });
    expect(catalog.reviewState).toBe("partial");
    expect(catalog.flowReviewed).toBe(false);
    expect(hosts(catalog.reviewedRequestRange)).toEqual(["captcha.zt.kuaishou.com"]);
  });

  it("rejects stale, cross-operation, cross-platform, missing-evidence and incomplete review records", () => {
    const base = reviewFor(input);
    const invalid: Array<Partial<MainProcessOperationReview>> = [
      { platformId: "bilibili" },
      { operation: "keepalive" },
      { sourceVersion: "old-source-version" },
      { selectionKey: "another-page-selection" },
      { source: "observed-hosts" as never },
      { evidenceRefs: [] },
      { reviewId: "" },
      { reviewedRequestRange: [] },
      { additionalRequiredOrigins: [origin("captcha.zt.kuaishou.com")] },
      { reviewedRequestRange: [origin("*.kuaishou.com")] },
      { reviewedRequestRange: [origin("127.0.0.1")] },
      { reviewedRequestRange: [{ ...origin("cp.kuaishou.com"), protocol: "http:" as never }] },
    ];
    for (const patch of invalid) {
      const catalog = resolveOperationCatalog({ ...input, review: { ...base, ...patch } });
      expect(catalog.reviewState).toBe("invalid");
      expect(catalog.flowReviewed).toBe(false);
      expect(catalog.reviewedRequestRange).toEqual([]);
      expect(catalog.requiredOrigins).toEqual(resolveOperationCatalog(input).requiredOrigins);
    }
  });

  it("canonicalizes exact origins without inferring suffixes, wildcard targets or address families", () => {
    expect(normalizeExactOrigin(origin("CP.KUAISHOU.COM."))).toEqual(origin("cp.kuaishou.com"));
    expect(normalizeExactOrigin(origin("cp.kuaishou.com/private?signature=secret"))).toBeNull();
    expect(normalizeExactOrigin(origin("user@cp.kuaishou.com"))).toBeNull();
    expect(normalizeExactOrigin({ ...origin("cp.kuaishou.com"), port: 0 })).toBeNull();
    expect(exactOriginKey(origin("cp.kuaishou.com"))).not.toBe(exactOriginKey(origin("kuaishou.com")));
    expect(exactOriginKey(origin("cp.kuaishou.com"))).not.toBe(
      exactOriginKey({ ...origin("cp.kuaishou.com"), protocol: "wss:" }),
    );
  });

  it("keeps versions stable under ordering and returns isolated copies", () => {
    const review = reviewFor(input);
    review.reviewedRequestRange = [...review.reviewedRequestRange, origin("captcha.zt.kuaishou.com")];
    const first = resolveOperationCatalog({ ...input, review });
    const second = resolveOperationCatalog({
      ...input,
      review: { ...review, reviewedRequestRange: [...review.reviewedRequestRange].reverse() },
    });
    expect(second.catalogVersion).toBe(first.catalogVersion);
    (first.requiredOrigins[0] as ExactOrigin).host = "mutated.example.test";
    expect(hosts(resolveOperationCatalog(input).requiredOrigins)).toEqual(["cp.kuaishou.com"]);
    const source = getOperationSourceInventory("kuaishou");
    source.collectorRequests[0].origin.host = "mutated.example.test";
    expect(getOperationSourceInventory("kuaishou").sourceVersion).toBe(source.sourceVersion);
  });

  it("accepts reviews only from the explicit lookup and fails closed when it throws or returns observed data", () => {
    const lookup = vi.fn(() => reviewFor(input));
    const resolver = createOperationCatalogResolver(lookup);
    expect(resolver(input).flowReviewed).toBe(true);
    expect(lookup).toHaveBeenCalledExactlyOnceWith({
      platformId: "kuaishou",
      operation: "collect",
      sourceVersion: resolveOperationCatalog(input).sourceVersion,
      selectionKey: resolveOperationCatalog(input).selectionKey,
    });
    expect(createOperationCatalogResolver(() => null)(input).flowReviewed).toBe(false);
    expect(
      createOperationCatalogResolver(() => {
        throw new Error("private-review-storage-detail");
      })(input).reviewState,
    ).toBe("invalid");
    expect(
      createOperationCatalogResolver(
        () =>
          ({
            hosts: ["cp.kuaishou.com"],
            observed: true,
          }) as never,
      )(input).reviewedRequestRange,
    ).toEqual([]);
  });

  it("never retains an input-supplied review when the trusted review store throws", () => {
    const inputWithExtraReview = { ...input, review: reviewFor(input) };
    // Structural TS typing permits extra fields; the resolver must enforce its trust boundary.
    const resolver = createOperationCatalogResolver(() => {
      throw new Error("private-storage-detail");
    });
    const result = resolver(inputWithExtraReview);
    expect(result.reviewState).toBe("invalid");
    expect(result.flowReviewed).toBe(false);
    expect(result.reviewedRequestRange).toEqual([]);
    expect(result.reviewId).toBeNull();
    expect(result.catalogVersion).toBe(resolveOperationCatalog(input).catalogVersion);
  });
});
