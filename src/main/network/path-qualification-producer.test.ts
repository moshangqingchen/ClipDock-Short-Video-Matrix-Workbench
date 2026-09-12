import { describe, expect, it, vi } from "vitest";
import { CHROMIUM_TRANSPORT_PROFILE_ID } from "./chromium-transport";
import {
  PathConformanceAdapter,
  type PathConformanceOptions,
  type RetainedPathQualification,
} from "./path-conformance";
import { ObservedPathQualificationProducer, type PathPreparationReview } from "./path-qualification-producer";
import { PathQualificationLifecycle } from "./path-qualification-lifecycle";
import { physicalRouteFixture } from "./fixtures/physical-route";
import { mutable, V } from "./fixtures/resolver-flow";
import { validateResolverFlowMapping } from "./resolver-flow-mapping";

vi.mock("electron", () => ({ app: {}, session: {} }));
const runtime = () => ({
  profileId: CHROMIUM_TRANSPORT_PROFILE_ID,
  electronVersion: "43.3.0",
  configuredBeforeReady: true,
  disableQuicSwitchPresent: true,
});
function setup() {
  const s = physicalRouteFixture();
  const tls = s.f.transportProfileId;
  const review: PathPreparationReview = {
    source: "main-process-path-preparation-review",
    evidenceId: "fixture-review",
    reviewedAtMono: 0,
    expiresAtMono: 100000,
    electronVersion: "43.3.0",
    transport: {
      evidenceId: "fixture-transport",
      accountProfileId: "fixture-account",
      tlsProfileId: tls,
      egressProfileId: "fixture-egress",
      tlsFactoryId: "clipdock-anonymous-tls-v1",
      egressFactoryId: "clipdock-anonymous-egress-v1",
    },
    tcpQualification: {
      evidenceId: "fixture-tcp",
      switch: "disable-quic",
      startupProfileId: CHROMIUM_TRANSPORT_PROFILE_ID,
      sourceEvidenceIds: ["fixture-startup-negative-test"],
    },
    // This is an explicit synthetic test constraint, never a production inference from DNS flags.
    origins: [s.f.target, { ...s.f.target, host: "myip.ipip.net" }].map((origin) => ({
      origin,
      possibleAddressFamilies: ["ipv4"],
      familyConstraint: { evidenceId: "fixture-family", sourceEvidenceIds: ["fixture-only-constraint"] },
    })),
    diagnosticPaths: [
      {
        kind: "tls",
        origin: s.f.target,
        possibleAddressFamilies: ["ipv4"],
        basis: "reviewed-path-equivalence",
        evidenceId: "fixture-tls-path",
        sourceEvidenceIds: ["fixture-tls-review"],
      },
      {
        kind: "egress",
        origin: { ...s.f.target, host: "myip.ipip.net" },
        possibleAddressFamilies: ["ipv4"],
        basis: "validated-path-constraint",
        evidenceId: "fixture-egress-path",
        sourceEvidenceIds: ["fixture-egress-review"],
      },
    ],
    representatives: [s.f.target],
    resolver: {
      evidenceId: "fixture-resolver",
      sourceEvidenceIds: ["fixture-resolver-review"],
      profileEquivalences: ["fixture-account", "fixture-egress"].map((toProfileId) => ({
        evidenceId: `fixture-${toProfileId}-resolver`,
        fromProfileId: tls,
        toProfileId,
        addressFamilies: ["ipv4"],
        sourceEvidenceIds: ["fixture-default-resolver-policy"],
      })),
    },
    routeProfileEvidenceIds: ["fixture-physical-profile-review"],
  };
  let selected: PathPreparationReview | null = review;
  const options = {
    collector: s.collector,
    readReview: vi.fn(() => selected),
    readVersion: vi.fn(() => ({ generation: 1, rulesVersion: V })),
    readChromiumRuntime: vi.fn(runtime),
    now: s.getNow,
  };
  const producer = new ObservedPathQualificationProducer(options);
  return {
    ...s,
    review,
    options,
    producer,
    setReview: (v: PathPreparationReview | null) => {
      selected = v;
    },
    prepare: () => producer.prepare(s.f.loader, s.outer.signal),
  };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("ObservedPathQualificationProducer", () => {
  it("assembles original two-flow observations with their own input window and a later postflight anchor", async () => {
    const s = setup();
    const collect = vi.spyOn(s.collector, "collect");
    const q = await s.prepare();
    expect(q).not.toBeNull();
    expect(collect).toHaveBeenCalledTimes(1);
    if (!q) return;
    expect(q.inputs.sampleId).toBe("actual-postflight");
    const context = q.resolver.observationContexts![0];
    expect(context.inputs.sampleId).toBe(s.f.inputs.sampleId);
    expect(context.inputs.completedAtMono).toBe(s.f.inputs.completedAtMono);
    expect(context.configuration.expiresAtMono).toBeLessThan(q.qualifiedAtMono);
    expect(q.resolver.observations).toHaveLength(2);
    for (const mapping of q.resolver.observations) {
      expect(mapping.kind).toBe("fake-ip-kernel-destination");
      if (mapping.kind === "fake-ip-kernel-destination")
        expect(
          validateResolverFlowMapping(
            mapping,
            context.inputs,
            context.loader,
            context.configuration,
            q.qualifiedAtMono,
          ),
        ).toBe(true);
    }
    expect(q.routes[0].samples.map((v) => v.socket.remoteAddress)).toEqual(
      s.physical.map((v) => v.remoteAddress),
    );
    expect(q.expiresAtMono).toBe(s.review.expiresAtMono);
    expect(Object.isFrozen(q)).toBe(true);
    const adapter = new PathConformanceAdapter({
      loader: s.f.loader,
      qualification: q,
      getController: () => null,
      readVersion: s.options.readVersion,
      readChromiumRuntime: runtime,
      now: s.getNow,
    });
    expect(adapter.hasValidRetainedQualification()).toBe(true);
    adapter.dispose();
    expect(adapter.hasValidRetainedQualification()).toBe(false);
  });

  it("publishes the original object through the lifecycle only after preparation and drains", async () => {
    const s = setup();
    const life = new PathQualificationLifecycle({
      producer: s.producer,
      now: s.getNow,
      readVersion: s.options.readVersion,
    });
    expect(life.getQualification(s.f.loader)).toBeNull();
    const q = await life.prepare(s.f.loader);
    expect(q).not.toBeNull();
    expect(life.getQualification(s.f.loader)).toBe(q);
    life.invalidate();
    expect(life.getQualification(s.f.loader)).toBeNull();
    await life.dispose();
  });
  it("checks the original qualification against current review content and the stable loader without collecting", async () => {
    const s = setup(),
      collect = vi.spyOn(s.collector, "collect"),
      q = await s.prepare();
    expect(q).not.toBeNull();
    if (!q) return;
    const before = q.expiresAtMono;
    expect(s.producer.isQualificationCurrent(q, structuredClone(s.f.loader))).toBe(true);
    s.setReview(structuredClone(s.review));
    expect(s.producer.isQualificationCurrent(q, s.f.loader)).toBe(true);
    expect(q.expiresAtMono).toBe(before);
    expect(collect).toHaveBeenCalledTimes(1);
    const reviewReads = s.options.readReview.mock.calls.length;
    expect(s.producer.isQualificationCurrent(structuredClone(q), s.f.loader)).toBe(false);
    expect(s.options.readReview).toHaveBeenCalledTimes(reviewReads);
    expect(s.producer.isQualificationCurrent(q, s.f.loader)).toBe(true);
  });
  it.each(["removed", "changed", "same-id-content-changed", "throws"] as const)(
    "withdraws a published qualification when its review is %s without implicit recollection",
    async (kind) => {
      const s = setup(),
        collect = vi.spyOn(s.collector, "collect");
      const life = new PathQualificationLifecycle({
        producer: s.producer,
        now: s.getNow,
        readVersion: s.options.readVersion,
      });
      const q = await life.prepare(s.f.loader);
      expect(q).not.toBeNull();
      if (!q) return;
      if (kind === "removed") s.setReview(null);
      if (kind === "changed") s.setReview({ ...s.review, evidenceId: "replacement-review" });
      if (kind === "same-id-content-changed")
        s.setReview({ ...s.review, routeProfileEvidenceIds: ["replacement-route-review"] });
      if (kind === "throws")
        s.options.readReview.mockImplementationOnce(() => {
          throw Error("private-review-error");
        });
      expect(life.getQualification(s.f.loader)).toBeNull();
      s.setReview(s.review);
      expect(life.getQualification(s.f.loader)).toBeNull();
      expect(s.producer.isQualificationCurrent(q, s.f.loader)).toBe(false);
      expect(collect).toHaveBeenCalledTimes(1);
      await life.dispose();
    },
  );
  it("honors synchronous lifecycle invalidation inside the current review reader", async () => {
    const s = setup(),
      collect = vi.spyOn(s.collector, "collect");
    const life = new PathQualificationLifecycle({
      producer: s.producer,
      now: s.getNow,
      readVersion: s.options.readVersion,
    });
    expect(await life.prepare(s.f.loader)).not.toBeNull();
    s.options.readReview.mockImplementationOnce(() => {
      life.invalidate();
      return s.review;
    });
    expect(life.getQualification(s.f.loader)).toBeNull();
    expect(life.getQualification(s.f.loader)).toBeNull();
    expect(collect).toHaveBeenCalledTimes(1);
    await life.dispose();
  });
  it("does not turn a stale ready-review lookup inside prepare into implicit new collection", async () => {
    const s = setup(),
      collect = vi.spyOn(s.collector, "collect");
    const life = new PathQualificationLifecycle({
      producer: s.producer,
      now: s.getNow,
      readVersion: s.options.readVersion,
    });
    expect(await life.prepare(s.f.loader)).not.toBeNull();
    s.setReview(null);
    expect(await life.prepare(s.f.loader)).toBeNull();
    await life.whenIdle();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(life.getQualification(s.f.loader)).toBeNull();
    await life.dispose();
  });
  it.each(["different-loader", "expired", "invalid-clock", "backwards-clock"] as const)(
    "does not keep an original qualification current for %s",
    async (kind) => {
      const s = setup(),
        q = await s.prepare();
      expect(q).not.toBeNull();
      if (!q) return;
      if (kind === "expired") s.setNow(q.expiresAtMono);
      if (kind === "invalid-clock") s.setNow(NaN);
      if (kind === "backwards-clock") s.setNow(q.qualifiedAtMono - 1);
      const selected = kind === "different-loader" ? { ...s.f.loader, selectionId: "different" } : s.f.loader;
      expect(s.producer.isQualificationCurrent(q, selected)).toBe(false);
      s.setNow(q.qualifiedAtMono);
      expect(s.producer.isQualificationCurrent(q, s.f.loader)).toBe(false);
    },
  );
  it("does not brand a fully assembled qualification until the actual final cleanup completes", async () => {
    const s = setup(),
      entered = deferred(),
      release = deferred();
    let assembled: RetainedPathQualification | null = null;
    const original = PathConformanceAdapter.prototype.hasValidRetainedQualification;
    const inspect = vi
      .spyOn(PathConformanceAdapter.prototype, "hasValidRetainedQualification")
      .mockImplementation(function (this: PathConformanceAdapter) {
        assembled = (Reflect.get(this, "options") as PathConformanceOptions).qualification;
        return original.call(this);
      });
    vi.spyOn(s.collector, "whenIdle").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      const pending = s.prepare();
      await entered.promise;
      expect(assembled).not.toBeNull();
      expect(s.producer.isQualificationCurrent(assembled!, s.f.loader)).toBe(false);
      release.resolve();
      const q = await pending;
      expect(q).toBe(assembled);
      expect(s.producer.isQualificationCurrent(q!, s.f.loader)).toBe(true);
    } finally {
      release.resolve();
      inspect.mockRestore();
    }
  });
  it("rejects a reentrant current-review check instead of reviving the old brand", async () => {
    const s = setup(),
      q = await s.prepare();
    expect(q).not.toBeNull();
    if (!q) return;
    s.options.readReview.mockImplementationOnce(() => {
      expect(s.producer.isQualificationCurrent(q, s.f.loader)).toBe(false);
      return s.review;
    });
    expect(s.producer.isQualificationCurrent(q, s.f.loader)).toBe(false);
    expect(s.producer.isQualificationCurrent(q, s.f.loader)).toBe(false);
  });

  it.each([
    "missing",
    "expired",
    "future",
    "no-equivalence",
    "wrong-factory",
    "missing-family-representative",
  ])("does not send when review is %s", async (kind) => {
    const s = setup(),
      collect = vi.spyOn(s.collector, "collect");
    if (kind === "missing") s.setReview(null);
    if (kind === "expired") mutable(s.review).expiresAtMono = 100;
    if (kind === "future") mutable(s.review).reviewedAtMono = 101;
    if (kind === "no-equivalence") mutable(s.review).resolver.profileEquivalences = [];
    if (kind === "wrong-factory") mutable(s.review).transport.tlsFactoryId = "wrong" as never;
    if (kind === "missing-family-representative")
      mutable(s.review).origins[0].possibleAddressFamilies = ["ipv4", "ipv6"];
    expect(await s.prepare()).toBeNull();
    expect(collect).not.toHaveBeenCalled();
  });

  it.each([
    "empty",
    "duplicate",
    "wrong-origin",
    "invalid-basis",
    "empty-reference",
    "missing-tls",
    "missing-egress",
    "family-mismatch",
    "dual-family-egress",
    "missing-constraint",
    "empty-constraint-reference",
  ])("does not start physical collection for %s diagnostic metadata", async (kind) => {
    const s = setup(),
      collect = vi.spyOn(s.collector, "collect");
    const review = mutable(s.review);
    const tls = review.diagnosticPaths.find((p) => p.kind === "tls")!;
    const egress = review.diagnosticPaths.find((p) => p.kind === "egress")!;
    if (kind === "empty") review.diagnosticPaths = [];
    if (kind === "duplicate") review.diagnosticPaths.push(structuredClone(tls));
    if (kind === "wrong-origin") tls.origin = { ...tls.origin, host: "unreviewed.example.com" };
    if (kind === "invalid-basis") tls.basis = "guessed" as never;
    if (kind === "empty-reference") tls.sourceEvidenceIds = [];
    if (kind === "missing-tls") review.diagnosticPaths = [egress];
    if (kind === "missing-egress") review.diagnosticPaths = [tls];
    if (kind === "family-mismatch") tls.possibleAddressFamilies = ["ipv6"];
    if (kind === "dual-family-egress") egress.possibleAddressFamilies = ["ipv4", "ipv6"];
    if (kind === "missing-constraint") review.origins[0].familyConstraint = null;
    if (kind === "empty-constraint-reference") review.origins[0].familyConstraint!.sourceEvidenceIds = [];
    expect(await s.prepare()).toBeNull();
    expect(collect).not.toHaveBeenCalled();
    await s.producer.whenIdle();
  });

  it.each(["close-failed", "route-failed", "changed-owner", "bad-http"])(
    "does not qualify failed physical evidence: %s",
    async (kind) => {
      const s = setup();
      if (kind === "close-failed") s.flags.failClose = true;
      if (kind === "route-failed") s.flags.badRoute = true;
      if (kind === "changed-owner") s.flags.changeOwner = true;
      if (kind === "bad-http") s.flags.echoStatus = 503;
      expect(await s.prepare()).toBeNull();
      await s.producer.whenIdle();
    },
  );

  it("rejects JSON-restored observations instead of restoring a proof brand", async () => {
    const s = setup(),
      original = s.collector.collect.bind(s.collector);
    vi.spyOn(s.collector, "collect").mockImplementation(async (...args) =>
      structuredClone(await original(...args)),
    );
    expect(await s.prepare()).toBeNull();
  });

  it.each(["review", "version", "expiry", "abort", "clock-invalid", "clock-backwards"])(
    "rechecks %s after actual collector cleanup",
    async (kind) => {
      const s = setup(),
        entered = deferred(),
        release = deferred();
      vi.spyOn(s.collector, "whenIdle").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const pending = s.prepare();
      await entered.promise;
      if (kind === "review") s.setReview({ ...s.review, evidenceId: "changed" });
      if (kind === "version") s.options.readVersion.mockReturnValue({ generation: 2, rulesVersion: V });
      if (kind === "expiry") s.setNow(s.review.expiresAtMono);
      if (kind === "abort") s.outer.abort();
      if (kind === "clock-invalid") s.setNow(NaN);
      if (kind === "clock-backwards") s.setNow(0);
      release.resolve();
      expect(await pending).toBeNull();
    },
  );

  it("retains the busy slot and idle barrier until real cleanup, with no second collection", async () => {
    const s = setup(),
      entered = deferred(),
      release = deferred(),
      collect = vi.spyOn(s.collector, "collect");
    vi.spyOn(s.collector, "whenIdle").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = s.prepare();
    await entered.promise;
    let idle = false;
    const drained = s.producer.whenIdle().then(() => {
      idle = true;
    });
    expect(await s.prepare()).toBeNull();
    expect(idle).toBe(false);
    expect(collect).toHaveBeenCalledTimes(1);
    release.resolve();
    expect(await pending).not.toBeNull();
    await drained;
    expect(idle).toBe(true);
  });

  it("does not publish or restart after an uncertain cleanup", async () => {
    const s = setup(),
      collect = vi.spyOn(s.collector, "collect");
    vi.spyOn(s.collector, "whenIdle").mockRejectedValue(Error("private-error"));
    expect(await s.prepare()).toBeNull();
    await expect(s.producer.whenIdle()).rejects.toThrow("PATH_PREPARATION_CLEANUP_FAILED");
    expect(await s.prepare()).toBeNull();
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a different actual Chromium startup instead of trusting the review", async () => {
    const s = setup();
    s.options.readChromiumRuntime.mockReturnValue({ ...runtime(), disableQuicSwitchPresent: false });
    expect(await s.prepare()).toBeNull();
  });
});
