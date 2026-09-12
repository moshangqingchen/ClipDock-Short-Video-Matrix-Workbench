import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createProductionProofComponents } from "./production-proof-components";
import type { ProofBundleInput, ProductionProofRuntimeOptions } from "./production-proof-runtime";
import type { SelectedClientConfigOptions } from "./selected-client-config";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import type { ClashReader, ClashReadResult } from "./clash-reader";
import type { PathInputReaderOptions, PathInputRequest, PathInputResult } from "./path-input-reader";
import type { KernelDnsReaderOptions } from "./kernel-dns";
import type { PathConformanceOptions, RetainedPathQualification } from "./path-conformance";
import type { ProductionProofSourceOptions } from "./production-proof-source";
import type { ProofCollectionRequest, ProofCollectionResult } from "./proof-issuer";
import type { EffectiveConfigCandidate, EffectiveConfigSourceSnapshot } from "./effective-config-source";
import type { ExactOrigin } from "./operation-catalog";
import type { classifyCurrentKernelDnsAddress } from "./kernel-dns-address-policy";
import type { SelectedKernelCompatibility } from "./kernel-compatibility";
import type {
  AnonymousPhysicalRouteCollectorOptions,
  AnonymousPhysicalRouteResult,
} from "./anonymous-physical-route-collector";
import type {
  ObservedPathQualificationProducerOptions,
  PathPreparationReview,
} from "./path-qualification-producer";

type Idle = Mock<() => Promise<void>>;
interface Selection {
  options: SelectedClientConfigOptions;
  loader: KnownSelectedLoaderContract | null;
  select: Mock<() => Promise<KnownSelectedLoaderContract | null>>;
  getSelectedLoader(): KnownSelectedLoaderContract | null;
  getSnapshot: Mock<() => EffectiveConfigSourceSnapshot>;
  read: Mock<() => Promise<{ state: "candidate" }>>;
  dispose: Mock<() => void>;
  whenIdle: Idle;
}
interface Inputs {
  options: PathInputReaderOptions;
  read: Mock<(request: PathInputRequest, signal?: AbortSignal) => Promise<PathInputResult>>;
  dispose: Mock<() => void>;
  whenIdle: Idle;
}
interface Owner {
  read: Mock<() => Promise<unknown>>;
  dispose: Mock<() => void>;
  whenIdle: Idle;
}
interface Adapter {
  options: PathConformanceOptions;
  dispose: Mock<() => void>;
  whenIdle: Idle;
  resolveAddressFamilies: Mock<(origin: ExactOrigin) => readonly ("ipv4" | "ipv6")[] | null>;
}
interface Source {
  options: ProductionProofSourceOptions;
  collect: Mock<(request: ProofCollectionRequest) => Promise<ProofCollectionResult>>;
  dispose: Mock<() => void>;
}
interface Pool {
  options?: { concurrency?: number; timeoutMs?: number };
  poisoned: boolean;
  invalidate: Idle;
  dispose: Idle;
  probe: Mock<() => Promise<{ available: false }>>;
  whenIdle: Idle;
}
interface Physical {
  options: AnonymousPhysicalRouteCollectorOptions;
  collect: Mock<(...args: unknown[]) => Promise<AnonymousPhysicalRouteResult>>;
  invalidate: Mock<() => void>;
  dispose: Idle;
  whenIdle: Idle;
}

const h = vi.hoisted(() => ({
  events: [] as string[],
  selections: [] as Selection[],
  inputs: [] as Inputs[],
  owners: [] as Owner[],
  systemHosts: [] as Owner[],
  classify: vi.fn<typeof classifyCurrentKernelDnsAddress>(() => "unknown"),
  adapters: [] as Adapter[],
  sources: [] as Source[],
  physicals: [] as Physical[],
  producers: [] as {
    options: ObservedPathQualificationProducerOptions;
    prepare: Mock<
      (loader: KnownSelectedLoaderContract, signal: AbortSignal) => Promise<RetainedPathQualification | null>
    >;
    isQualificationCurrent: Mock<
      (qualification: RetainedPathQualification, loader: KnownSelectedLoaderContract) => boolean
    >;
    whenIdle: Idle;
  }[],
  prepared: null as RetainedPathQualification | null,
  tls: [] as Pool[],
  egress: [] as Pool[],
  networks: [] as { readObservation: Mock<() => Promise<unknown>> }[],
  clashes: [] as {
    options: ConstructorParameters<typeof ClashReader>[0];
    read: Mock<() => Promise<ClashReadResult>>;
    readDnsQuery: Mock<(...args: unknown[]) => Promise<unknown>>;
    readConnections: Mock<(...args: unknown[]) => Promise<unknown>>;
    closeConnection: Mock<(...args: unknown[]) => Promise<unknown>>;
    whenIdle: Idle;
  }[],
  dns: [] as {
    options: KernelDnsReaderOptions;
    read: Mock<() => Promise<unknown>>;
    dispose: Mock<() => void>;
  }[],
  loader: {
    source: "main-process-selected-loader-contract",
    selectionId: "test-explicit-selection",
    loaderProfileId: "known-client-profile",
    sourcePathIdentity: "b".repeat(64),
    decoderIdentity: "known-decoder-v1",
    qualificationEvidenceIds: ["test-retained-loader-fact"],
    selectedAtMono: 10,
  } as KnownSelectedLoaderContract,
  controller: {
    mode: "rule",
    tun: true,
    fingerprint: "a".repeat(64),
    rules: [],
    startedAtMono: 20,
    completedAtMono: 21,
  } as unknown as ClashReadResult,
}));

vi.mock("./selected-client-config", () => ({
  SelectedClientConfig: class {
    loader: KnownSelectedLoaderContract | null = null;
    select = vi.fn(async () => {
      h.events.push("select-complete");
      this.loader = h.loader;
      return this.loader;
    });
    getSelectedLoader() {
      return this.loader;
    }
    getSnapshot = vi.fn((): EffectiveConfigSourceSnapshot => ({ state: "checking", generation: 0 }));
    read = vi.fn(async () => {
      h.events.push("source-inspection");
      return { state: "candidate" as const };
    });
    dispose = vi.fn();
    whenIdle = vi.fn(async () => {});
    constructor(readonly options: SelectedClientConfigOptions) {
      h.selections.push(this);
    }
  },
}));
vi.mock("./clash-reader", () => ({
  ClashReader: class {
    read = vi.fn(async () => h.controller);
    readDnsQuery = vi.fn(async (..._args: unknown[]) => ({}));
    readConnections = vi.fn(async (..._args: unknown[]) => ({}));
    closeConnection = vi.fn(async (..._args: unknown[]) => ({}));
    whenIdle = vi.fn(async () => {});
    constructor(readonly options: ConstructorParameters<typeof ClashReader>[0]) {
      h.clashes.push(this);
    }
  },
}));
vi.mock("./path-input-reader", () => ({
  PathInputReader: class {
    read = vi.fn(async (_request: PathInputRequest, _signal?: AbortSignal): Promise<PathInputResult> => {
      h.events.push("input-round");
      return { state: "unavailable", reason: "INPUT_INVALID", startedAtMono: 20, completedAtMono: 21 };
    });
    dispose = vi.fn();
    whenIdle = vi.fn(async () => {});
    constructor(readonly options: PathInputReaderOptions) {
      h.inputs.push(this);
    }
  },
}));
vi.mock("./kernel-dns", () => ({
  KernelDnsReader: class {
    read = vi.fn(async () => ({}));
    dispose = vi.fn();
    constructor(readonly options: KernelDnsReaderOptions) {
      h.dns.push(this);
    }
  },
}));
vi.mock("./windows-controller-owner", () => ({
  WindowsControllerOwnerReader: class {
    read = vi.fn(async () => ({}));
    dispose = vi.fn();
    whenIdle = vi.fn(async () => {});
    constructor() {
      h.owners.push(this);
    }
  },
}));
vi.mock("./kernel-dns-address-policy", () => ({ classifyCurrentKernelDnsAddress: h.classify }));
vi.mock("./windows-system-hosts", () => ({
  WindowsSystemHostsReader: class {
    read = vi.fn(async () => ({}));
    dispose = vi.fn();
    whenIdle = vi.fn(async () => {});
    constructor() {
      h.systemHosts.push(this);
    }
  },
}));
vi.mock("./windows-network-fingerprint", () => ({
  WindowsNetworkFingerprintReader: class {
    readObservation = vi.fn(async () => ({}));
    constructor() {
      h.networks.push(this);
    }
  },
}));
vi.mock("./path-conformance", () => ({
  PathConformanceAdapter: class {
    dispose = vi.fn();
    whenIdle = vi.fn(async () => {});
    resolveAddressFamilies = vi.fn(
      (origin: ExactOrigin) =>
        this.options.qualification?.origins.find((entry) => entry.origin.host === origin.host)
          ?.possibleAddressFamilies ?? null,
    );
    constructor(readonly options: PathConformanceOptions) {
      h.adapters.push(this);
    }
  },
}));
vi.mock("./production-proof-source", () => ({
  ProductionProofSource: class {
    collect = vi.fn(async (request: ProofCollectionRequest): Promise<ProofCollectionResult> => {
      h.events.push("source-collect");
      await this.options.inputs.read(
        {
          generation: request.generation,
          rulesVersion: request.rulesVersion,
          targets: request.scope.targets,
        },
        request.signal,
      );
      return { kind: "unavailable", reason: "EGRESS_UNVERIFIED" };
    });
    dispose = vi.fn();
    constructor(readonly options: ProductionProofSourceOptions) {
      h.sources.push(this);
    }
  },
}));
vi.mock("./anonymous-proof-probe", () => ({
  AnonymousProofProbe: class {
    poisoned = false;
    invalidate = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
    probe = vi.fn(async () => ({ available: false as const }));
    probeTls = this.probe;
    whenIdle = vi.fn(async () => {});
    constructor(readonly options: { concurrency?: number; timeoutMs?: number } = {}) {
      h.tls.push(this);
    }
  },
}));
vi.mock("./anonymous-egress-probe", () => ({
  AnonymousEgressProbe: class {
    poisoned = false;
    invalidate = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
    probe = vi.fn(async () => ({ available: false as const }));
    whenIdle = vi.fn(async () => {});
    constructor() {
      h.egress.push(this);
    }
  },
}));
// Component-boundary substitutes only. The real lifecycle is intentionally not mocked; opaque q
// below checks identity/cancellation/drain wiring, never accepted network evidence or actual routes.
vi.mock("./anonymous-physical-route-collector", () => ({
  AnonymousPhysicalRouteCollector: class {
    collect = vi.fn(async (..._args: unknown[]): Promise<AnonymousPhysicalRouteResult> => ({
      available: true,
      observation: {} as never,
    }));
    invalidate = vi.fn();
    whenIdle = vi.fn(async () => {});
    dispose = vi.fn(async () => this.whenIdle());
    constructor(readonly options: AnonymousPhysicalRouteCollectorOptions) {
      h.physicals.push(this);
    }
  },
}));
vi.mock("./path-qualification-producer", () => ({
  ObservedPathQualificationProducer: class {
    private readonly retained = new WeakMap<RetainedPathQualification, string>();
    prepare = vi.fn(async (loader: KnownSelectedLoaderContract, signal: AbortSignal) => {
      const review = this.options.readReview(loader);
      if (!review || signal.aborted) return null;
      const result = await this.options.collector.collect(
        review.representatives[0],
        loader,
        review.transport.tlsProfileId,
        signal,
      );
      const qualification = result.available ? h.prepared : null;
      if (qualification) this.retained.set(qualification, JSON.stringify(review));
      return qualification;
    });
    isQualificationCurrent = vi.fn(
      (qualification: RetainedPathQualification, loader: KnownSelectedLoaderContract) => {
        const review = this.options.readReview(loader);
        return review !== null && this.retained.get(qualification) === JSON.stringify(review);
      },
    );
    whenIdle = vi.fn(async () => this.options.collector.whenIdle());
    constructor(readonly options: ObservedPathQualificationProducerOptions) {
      h.producers.push(this);
    }
  },
}));
vi.mock("./current-rule-context-producer", () => ({ createConservativeRuleContexts: vi.fn(() => null) }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const input = (path = "C:\\SelectedClient\\resources"): ProofBundleInput => ({
  settings: {
    controllerUrl: "http://127.0.0.1:9790",
    diagnosticProxyPort: 10090,
    selectedClientResourcesPath: path,
  },
  onInvalidated: vi.fn(),
});
function options(qualified = false): ProductionProofRuntimeOptions {
  // Deliberate adapter-boundary identity only: the real conformance/source validators are mocked;
  // these tests never construct accepted proof evidence or claim this object qualifies a path.
  const qualification = { evidenceId: "test-adapter-identity" } as RetainedPathQualification;
  return {
    enforcement: "strict",
    settings: () => input().settings,
    getSecret: () => null,
    readVersion: () => ({ generation: 1, rulesVersion: "a".repeat(64) }),
    onInvalidated: vi.fn(),
    ...(qualified ? { getQualification: vi.fn(() => qualification) } : {}),
  };
}
function request(): ProofCollectionRequest {
  return {
    requestId: "current-request",
    generation: 1,
    rulesVersion: "a".repeat(64),
    startedAtMono: 19,
    signal: new AbortController().signal,
    scope: {
      accountId: "account",
      platformId: "bilibili",
      contextId: "context",
      catalogVersion: "catalog",
      catalogReviewed: true,
      targets: [{ protocol: "https:", host: "api.bilibili.com", port: 443, addressFamily: "ipv4" }],
    },
  };
}
const turn = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};

beforeEach(() => {
  h.events.length = 0;
  h.classify.mockClear();
  h.prepared = null;
  for (const values of [
    h.selections,
    h.inputs,
    h.owners,
    h.systemHosts,
    h.adapters,
    h.sources,
    h.physicals,
    h.producers,
    h.tls,
    h.egress,
    h.networks,
    h.clashes,
    h.dns,
  ])
    values.length = 0;
});
afterEach(() => vi.useRealTimers());

function preparationFixture(enforcement: "observe" | "strict" = "strict") {
  // Deliberately incomplete proof metadata: the assembler/adapter are mocked here. This is only
  // the lifecycle's opaque retained identity; the separate producer tests validate real records.
  h.prepared = {
    source: "main-process-retained-path-qualification",
    evidenceId: "opaque-component-boundary-q",
    loader: h.loader,
    qualifiedAtMono: performance.now(),
    expiresAtMono: performance.now() + 60000,
  } as RetainedPathQualification;
  const review = {
    representatives: request().scope.targets,
    transport: { tlsProfileId: "selected-tls-profile" },
  } as PathPreparationReview;
  const readReview = vi.fn((): PathPreparationReview | null => review);
  const isQuiescent = vi.fn(() => true);
  const opts = { ...options(), enforcement, preparation: { readReview, isQuiescent } };
  const components = createProductionProofComponents(opts),
    owner = input();
  const bundle = components.create(owner);
  return {
    opts,
    components,
    bundle,
    owner,
    readReview,
    isQuiescent,
    prepare: (signal = new AbortController().signal) => bundle.prepareQualification!(signal),
  };
}

describe("prepared family projection from the selected source", () => {
  const origin: ExactOrigin = { protocol: "https:", host: "api.bilibili.com", port: 443 };
  function projectionFixture() {
    const f = preparationFixture();
    // Boundary fixture only; the real adapter has separate original-record projection tests.
    const candidate = {
      sourceGeneration: 1,
      sourcePathIdentity: h.loader.sourcePathIdentity,
      decoderIdentity: h.loader.decoderIdentity,
      fileFingerprint: "f".repeat(64),
      controllerFingerprint: "a".repeat(64),
      expiresAtMono: performance.now() + 60000,
      policy: { fingerprint: "policy" },
      currentDirectPolicy: { policyFingerprint: "direct" },
    } as EffectiveConfigCandidate;
    Object.assign(h.prepared!, {
      inputs: { configurationAfter: structuredClone(candidate) },
      origins: [
        { origin, possibleAddressFamilies: ["ipv4"], familyConstraint: { evidenceId: "boundary-only" } },
      ],
    });
    h.selections[0].getSnapshot.mockReturnValue({ state: "candidate", generation: 1, candidate });
    return { ...f, candidate };
  }
  it("does not select or prepare implicitly, then projects before the first collection", async () => {
    const f = projectionFixture();
    expect(f.bundle.resolveAddressFamilies!(origin)).toBeNull();
    expect(h.selections[0].select).not.toHaveBeenCalled();
    expect(h.producers[0].prepare).not.toHaveBeenCalled();
    expect(await f.prepare()).toBe(true);
    const a = f.bundle.resolveAddressFamilies!(origin);
    expect(a).toEqual(["ipv4"]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(f.bundle.resolveAddressFamilies!(origin)).toEqual(["ipv4"]);
    expect(h.adapters).toHaveLength(1);
    expect(h.sources).toHaveLength(0);
    expect(h.producers[0].prepare).toHaveBeenCalledOnce();
    expect(h.inputs[0].read).not.toHaveBeenCalled();
    expect(h.dns[0].read).not.toHaveBeenCalled();
    expect(h.tls[0].probe).not.toHaveBeenCalled();
    await f.bundle.dispose();
    await f.components.dispose();
  });
  it("does not discard other reviewed origins when the requested origin is unreviewed", async () => {
    const f = projectionFixture();
    await f.prepare();
    expect(f.bundle.resolveAddressFamilies!({ ...origin, host: "unknown.example" })).toBeNull();
    expect(f.owner.onInvalidated).not.toHaveBeenCalled();
    expect(f.bundle.resolveAddressFamilies!(origin)).toEqual(["ipv4"]);
    await f.bundle.dispose();
    await f.components.dispose();
  });
  it.each(["expired", "file", "policy", "direct", "loader", "checking"])(
    "rejects %s current source without new I/O",
    async (kind) => {
      const f = projectionFixture();
      await f.prepare();
      if (kind === "expired") Object.assign(f.candidate, { expiresAtMono: performance.now() - 1 });
      if (kind === "file") Object.assign(f.candidate, { fileFingerprint: "changed" });
      if (kind === "policy") Object.assign(f.candidate, { policy: { fingerprint: "changed" } });
      if (kind === "direct")
        Object.assign(f.candidate, { currentDirectPolicy: { policyFingerprint: "changed" } });
      if (kind === "loader") h.selections[0].loader = { ...h.loader, selectionId: "changed" };
      if (kind === "checking")
        h.selections[0].getSnapshot.mockReturnValue({ state: "checking", generation: 1 });
      expect(f.bundle.resolveAddressFamilies!(origin)).toBeNull();
      expect(h.inputs[0].read).not.toHaveBeenCalled();
      expect(h.dns[0].read).not.toHaveBeenCalled();
      expect(h.producers[0].prepare).toHaveBeenCalledOnce();
      await f.bundle.dispose();
      await f.components.dispose();
    },
  );
  it.each(["review", "invalid-validator", "recursive", "source-change", "invalidate"])(
    "does not publish old families after %s",
    async (kind) => {
      const f = projectionFixture();
      await f.prepare();
      expect(f.bundle.resolveAddressFamilies!(origin)).toEqual(["ipv4"]);
      const validator = h.adapters[0];
      validator.resolveAddressFamilies.mockImplementation(() => {
        if (kind === "review") f.readReview.mockReturnValue(null);
        if (kind === "invalid-validator") return null;
        if (kind === "recursive") expect(f.bundle.resolveAddressFamilies!(origin)).toBeNull();
        if (kind === "source-change") Object.assign(f.candidate, { fileFingerprint: "changed" });
        if (kind === "invalidate") f.bundle.invalidate();
        return ["ipv4"];
      });
      expect(f.bundle.resolveAddressFamilies!(origin)).toBeNull();
      expect(validator.dispose).toHaveBeenCalled();
      expect(h.producers[0].prepare).toHaveBeenCalledOnce();
      expect(h.sources).toHaveLength(0);
      await f.bundle.dispose();
      await f.components.dispose();
    },
  );
});

describe("explicit preparation in the shared source bundle", () => {
  it("injects the same selected source, native readers, DNS and TLS pool into the collector", async () => {
    const f = preparationFixture(),
      physical = h.physicals[0].options;
    expect(physical.inputs).toBe(h.inputs[0]);
    expect(physical.dns).toBe(h.dns[0]);
    expect(physical.probe).toBe(h.tls[0]);
    expect(physical.readController).toBe(h.selections[0].options.readController);
    expect(h.inputs[0].options.configuration).toBe(h.selections[0]);
    expect(h.inputs[0].options.owner).toBe(h.owners[0]);
    expect(h.tls[0].options).toMatchObject({ concurrency: 2, timeoutMs: 10000 });
    expect(h.producers[0].options.collector).toBe(h.physicals[0]);
    expect(h.producers[0].options.readReview).toBe(f.readReview);
    expect(physical.isQuiescent).toBe(f.isQuiescent);
    expect(h.clashes).toHaveLength(1);
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it.each(["observe", "missing-review", "not-quiet"])("does not sample when %s", async (kind) => {
    const f = preparationFixture(kind === "observe" ? "observe" : "strict");
    if (kind === "missing-review") f.readReview.mockReturnValue(null);
    if (kind === "not-quiet") f.isQuiescent.mockReturnValue(false);
    expect(await f.prepare()).toBe(false);
    expect(h.physicals[0].collect).not.toHaveBeenCalled();
    expect(h.inputs[0].read).not.toHaveBeenCalled();
    expect(h.dns[0].read).not.toHaveBeenCalled();
    expect(h.tls[0].probe).not.toHaveBeenCalled();
    expect(h.egress[0].probe).not.toHaveBeenCalled();
    expect(h.clashes[0].readConnections).not.toHaveBeenCalled();
    expect(h.clashes[0].closeConnection).not.toHaveBeenCalled();
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it("inspect and collect do not implicitly invoke the preparation producer", async () => {
    const f = preparationFixture();
    expect(await f.bundle.inspect()).toBe(true);
    expect((await f.bundle.collect(request())).kind).toBe("unavailable");
    expect(h.producers[0].prepare).not.toHaveBeenCalled();
    expect(h.physicals[0].collect).not.toHaveBeenCalled();
    expect(h.dns[0].read).not.toHaveBeenCalled();
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it("retains original q through the real lifecycle and reuses it without another socket preparation", async () => {
    const f = preparationFixture(),
      original = h.prepared;
    expect(await f.prepare()).toBe(true);
    expect(h.producers[0].prepare).toHaveBeenCalledTimes(1);
    expect(h.producers[0].prepare.mock.calls[0][0]).toEqual(h.loader);
    await f.bundle.collect(request());
    expect(h.adapters[0].options.qualification).toBe(original);
    expect(h.sources[0].options.tls).toBe(h.tls[0]);
    expect(await f.bundle.inspect()).toBe(true);
    expect(await f.prepare()).toBe(true);
    expect(h.producers[0].prepare).toHaveBeenCalledTimes(1);
    expect(h.physicals[0].collect).toHaveBeenCalledTimes(1);
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it("revokes a previously used qualification when its live review is withdrawn before collection", async () => {
    const f = preparationFixture();
    expect(await f.prepare()).toBe(true);
    await f.bundle.collect(request());
    const source = h.sources[0];
    f.readReview.mockReturnValue(null);
    expect(await f.bundle.collect(request())).toEqual({ kind: "unavailable", reason: "CONTEXT_UNVERIFIED" });
    expect(f.owner.onInvalidated).toHaveBeenCalledOnce();
    expect(source.dispose).toHaveBeenCalled();
    expect(source.collect).toHaveBeenCalledOnce();
    expect(h.producers[0].prepare).toHaveBeenCalledOnce();
    expect(h.physicals[0].collect).toHaveBeenCalledOnce();
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it("does not construct or collect with a replacement qualification revoked during the old adapter drain", async () => {
    const f = preparationFixture();
    expect(await f.prepare()).toBe(true);
    await f.bundle.collect(request());
    const oldAdapter = h.adapters[0],
      oldSource = h.sources[0],
      draining = deferred();
    const replacementLoader = { ...h.loader, selectedAtMono: h.loader.selectedAtMono + 1 };
    h.selections[0].loader = replacementLoader;
    h.prepared = {
      ...h.prepared!,
      evidenceId: "replacement-component-boundary-q",
      loader: replacementLoader,
    };
    expect(await f.prepare()).toBe(true);
    oldAdapter.whenIdle.mockReturnValue(draining.promise);
    const pending = f.bundle.collect({ ...request(), requestId: "replacement-round" });
    await turn();
    expect(oldAdapter.whenIdle).toHaveBeenCalledOnce();
    expect(h.sources).toHaveLength(1);
    f.readReview.mockReturnValue(null);
    draining.resolve();
    expect(await pending).toEqual({ kind: "unavailable", reason: "CONTEXT_UNVERIFIED" });
    expect(f.owner.onInvalidated).toHaveBeenCalledOnce();
    expect(h.sources).toHaveLength(1);
    expect(h.adapters).toHaveLength(1);
    expect(oldSource.collect).toHaveBeenCalledOnce();
    expect(h.producers[0].prepare).toHaveBeenCalledTimes(2);
    expect(h.physicals[0].collect).toHaveBeenCalledTimes(2);
    expect((await f.bundle.collect(request())).kind).toBe("unavailable");
    expect(oldSource.collect).toHaveBeenCalledOnce();
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it("discards late source evidence and revokes authority when review disappears while collection is pending", async () => {
    const f = preparationFixture();
    expect(await f.prepare()).toBe(true);
    await f.bundle.collect(request());
    const source = h.sources[0],
      sampled = deferred<ProofCollectionResult>();
    source.collect.mockReturnValueOnce(sampled.promise);
    const pending = f.bundle.collect({ ...request(), requestId: "held-source-round" });
    await turn();
    expect(source.collect).toHaveBeenCalledTimes(2);
    expect(f.owner.onInvalidated).not.toHaveBeenCalled();
    f.readReview.mockReturnValue(null);
    // Opaque component-boundary sentinel, never accepted by a real issuer or network validator.
    sampled.resolve({ kind: "evidence", requestId: "held-source-round", batch: {} as never });
    expect(await pending).toEqual({ kind: "unavailable", reason: "CONTEXT_UNVERIFIED" });
    expect(f.owner.onInvalidated).toHaveBeenCalledOnce();
    expect(source.dispose).toHaveBeenCalled();
    expect(h.inputs[0].dispose).toHaveBeenCalled();
    expect(h.producers[0].prepare).toHaveBeenCalledOnce();
    expect(h.physicals[0].collect).toHaveBeenCalledOnce();
    expect((await f.bundle.collect(request())).kind).toBe("unavailable");
    expect(source.collect).toHaveBeenCalledTimes(2);
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it.each(["cancel", "invalidate"])(
    "retains the shared busy slot through actual idle after %s",
    async (kind) => {
      const f = preparationFixture(),
        barrier = deferred(),
        abort = new AbortController();
      h.physicals[0].whenIdle.mockReturnValue(barrier.promise);
      const pending = f.prepare(abort.signal);
      await turn();
      expect(h.producers[0].prepare).toHaveBeenCalledTimes(1);
      if (kind === "cancel") abort.abort();
      else f.bundle.invalidate();
      await turn();
      expect(await f.bundle.inspect()).toBe(false);
      expect(await f.prepare()).toBe(false);
      expect((await f.bundle.collect(request())).kind).toBe("unavailable");
      expect(h.producers[0].prepare).toHaveBeenCalledTimes(1);
      barrier.resolve();
      expect(await pending).toBe(false);
      if (kind === "cancel") {
        expect(await f.bundle.inspect()).toBe(true);
        expect(await f.prepare()).toBe(true);
        expect(h.producers[0].prepare).toHaveBeenCalledTimes(2);
      }
      await f.bundle.dispose();
      await f.components.dispose();
    },
  );

  it("drains the same controller connections and exact DELETE without waiting for its enclosing prepare", async () => {
    const f = preparationFixture(),
      physical = h.physicals[0].options;
    const id = "00000000-0000-4000-8000-000000000001";
    h.clashes[0].closeConnection.mockResolvedValue({ status: 204, startedAtMono: 20, completedAtMono: 21 });
    h.physicals[0].collect.mockImplementation(async (...args) => {
      const signal = args[3] as AbortSignal;
      await physical.readController(signal);
      await physical.readConnections(["api.bilibili.com"], signal);
      expect(await physical.closeConnection(id, signal)).toEqual({
        status: 204,
        startedAtMono: 20,
        completedAtMono: 21,
      });
      await physical.readersWhenIdle(); // Would deadlock if it included the enclosing operation.
      return { available: true, observation: {} as never };
    });
    expect(await f.prepare()).toBe(true);
    expect(h.clashes).toHaveLength(1);
    expect(h.clashes[0].read).toHaveBeenCalledTimes(1);
    expect(h.clashes[0].readConnections).toHaveBeenCalledExactlyOnceWith(["api.bilibili.com"]);
    expect(h.clashes[0].closeConnection).toHaveBeenCalledTimes(1);
    expect(h.clashes[0].closeConnection.mock.calls[0][0]).toBe(id);
    expect(h.clashes[0].whenIdle).toHaveBeenCalled();
    await f.bundle.dispose();
    await f.components.dispose();
  });

  it("keeps dispose pending through a real native DELETE drain after its response has returned", async () => {
    const f = preparationFixture(),
      native = deferred(),
      physical = h.physicals[0].options;
    h.clashes[0].whenIdle.mockReturnValue(native.promise);
    h.physicals[0].collect.mockImplementation(async () => {
      await physical.readersWhenIdle();
      return { available: false, reason: "CANCELLED" };
    });
    const pending = f.prepare();
    await turn();
    let disposed = false;
    const disposal = f.bundle.dispose().then(() => {
      disposed = true;
    });
    await turn();
    expect(disposed).toBe(false);
    native.resolve();
    expect(await pending).toBe(false);
    await disposal;
    expect(disposed).toBe(true);
    await f.components.dispose();
  });

  it("propagates uncertain nested preparation cleanup through bundle dispose", async () => {
    const f = preparationFixture();
    h.physicals[0].whenIdle.mockRejectedValue(Error("uncertain-reader-cleanup"));
    expect(await f.prepare()).toBe(false);
    await expect(f.bundle.dispose()).rejects.toThrow("PROOF_CLEANUP_FAILED");
    await f.components.dispose();
  });

  it("refuses an ambiguous external getter and live preparation provider before constructing pools", () => {
    const f = options(true);
    f.preparation = { readReview: () => null, isQuiescent: () => true };
    expect(() => createProductionProofComponents(f)).toThrow();
    expect(h.tls).toHaveLength(0);
    expect(h.egress).toHaveLength(0);
  });
});

// These synthetic observations exercise scheduling at the component boundary only. The separate
// warmup integration test uses a real EffectiveConfigSource and its actual expiration callback.
function publishCandidate(at = performance.now(), version = "a".repeat(64)) {
  const snapshot = {
    state: "candidate",
    generation: 0,
    candidate: { completedAtMono: at, expiresAtMono: at + 15000, controllerFingerprint: version },
  } as EffectiveConfigSourceSnapshot;
  h.selections[0].options.onChange?.(snapshot);
  return { state: "candidate" as const };
}

describe("strict source maintenance", () => {
  it.each(["changed fingerprint", "version getter throws"] as const)(
    "revokes immediately after the controller returns when %s, before selected-source postflight I/O",
    async (kind) => {
      const opts = options(),
        owner = input(),
        components = createProductionProofComponents(opts),
        bundle = components.create(owner);
      let permitted = true;
      owner.onInvalidated = vi.fn(() => {
        permitted = false;
        bundle.invalidate();
      });
      const raw = deferred<ClashReadResult>(),
        postflight = deferred();
      h.clashes[0].read.mockReturnValueOnce(raw.promise);
      const postflightStarted = vi.fn();
      h.selections[0].read.mockImplementation(async () => {
        const controller = await h.selections[0].options.readController(new AbortController().signal);
        postflightStarted();
        await postflight.promise;
        return publishCandidate(performance.now(), controller.fingerprint);
      });
      const inspection = bundle.inspect();
      try {
        await turn();
        expect(h.clashes[0].read).toHaveBeenCalledOnce();
        expect(permitted).toBe(true);
        if (kind === "version getter throws")
          opts.readVersion = () => {
            throw new Error("Synthetic Gate state failure");
          };
        raw.resolve({ ...h.controller, fingerprint: "c".repeat(64) });
        await turn();
        expect(owner.onInvalidated).toHaveBeenCalledOnce();
        expect(permitted).toBe(false);
        expect(postflightStarted).not.toHaveBeenCalled();
        expect(h.selections[0].dispose).toHaveBeenCalled();
      } finally {
        // Release the deliberately slow postflight even on the old implementation's failed assertion.
        postflight.resolve();
        await inspection;
        await bundle.dispose();
        await components.dispose();
      }
    },
  );

  it.each(["same version", "no current permission", "observe"] as const)(
    "keeps controller reads usable for %s without manufacturing authority",
    async (kind) => {
      const opts = options();
      if (kind === "observe") opts.enforcement = "observe";
      const getVersion = vi.fn(() => {
        if (kind === "observe") throw new Error("Observe must not query Gate authority");
        return kind === "no current permission"
          ? null
          : { generation: 1, rulesVersion: h.controller.fingerprint };
      });
      opts.readVersion = getVersion;
      const owner = input(),
        components = createProductionProofComponents(opts),
        bundle = components.create(owner);
      try {
        const result = await h.selections[0].options.readController(new AbortController().signal);
        expect(result).toBe(h.controller);
        expect(getVersion).toHaveBeenCalledTimes(kind === "observe" ? 0 : 1);
        expect(owner.onInvalidated).not.toHaveBeenCalled();
        expect(h.sources).toHaveLength(0);
        expect(h.tls[0].probe).not.toHaveBeenCalled();
        expect(h.egress[0].probe).not.toHaveBeenCalled();
      } finally {
        await bundle.dispose();
        await components.dispose();
      }
    },
  );

  it.each(["changed fingerprint", "version getter throws"] as const)(
    "does not return an inconsistent controller observation after a notification-only callback: %s",
    async (kind) => {
      const opts = options(),
        owner = input(),
        components = createProductionProofComponents(opts),
        bundle = components.create(owner);
      if (kind === "version getter throws")
        opts.readVersion = () => {
          throw new Error("Synthetic Gate state failure");
        };
      else h.clashes[0].read.mockResolvedValueOnce({ ...h.controller, fingerprint: "c".repeat(64) });
      try {
        await expect(h.selections[0].options.readController(new AbortController().signal)).rejects.toThrow(
          kind === "version getter throws"
            ? "PROOF_CONTROLLER_VERSION_UNAVAILABLE"
            : "PROOF_CONTROLLER_VERSION_CHANGED",
        );
        expect(owner.onInvalidated).toHaveBeenCalledOnce();
      } finally {
        await bundle.dispose();
        await components.dispose();
      }
    },
  );

  it("rechecks cancellation after a version getter synchronously invalidates the bundle", async () => {
    const opts = options(),
      owner = input(),
      components = createProductionProofComponents(opts),
      bundle = components.create(owner);
    opts.readVersion = () => {
      bundle.invalidate();
      return { generation: 1, rulesVersion: h.controller.fingerprint };
    };
    try {
      await expect(h.selections[0].options.readController(new AbortController().signal)).rejects.toThrow(
        "PROOF_SOURCE_REVOKED",
      );
      expect(owner.onInvalidated).not.toHaveBeenCalled();
      expect(h.selections[0].dispose).toHaveBeenCalled();
    } finally {
      await bundle.dispose();
      await components.dispose();
    }
  });

  it("does not read Gate state or invalidate on a controller reply belonging to a cancelled request", async () => {
    const opts = options(),
      owner = input(),
      components = createProductionProofComponents(opts),
      bundle = components.create(owner),
      caller = new AbortController(),
      raw = deferred<ClashReadResult>();
    const getVersion = vi.fn(opts.readVersion);
    opts.readVersion = getVersion;
    h.clashes[0].read.mockReturnValueOnce(raw.promise);
    const result = h.selections[0].options.readController(caller.signal);
    const rejected = expect(result).rejects.toThrow("PROOF_SOURCE_REVOKED");
    try {
      await turn();
      caller.abort();
      raw.resolve({ ...h.controller, fingerprint: "c".repeat(64) });
      await rejected;
      expect(getVersion).not.toHaveBeenCalled();
      expect(owner.onInvalidated).not.toHaveBeenCalled();
    } finally {
      await bundle.dispose();
      await components.dispose();
    }
  });

  it("renews the source before its real deadline without adding observe-mode reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const opts = options();
    const components = createProductionProofComponents(opts);
    const bundle = components.create(input());
    h.selections[0].read.mockImplementation(async () => publishCandidate());
    expect(await bundle.inspect()).toBe(true);
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.selections[0].read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.selections[0].read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.selections[0].read).toHaveBeenCalledTimes(3);
    expect(h.inputs[0].read).not.toHaveBeenCalled();
    expect(h.sources).toHaveLength(0);
    await bundle.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.selections[0].read).toHaveBeenCalledTimes(3);
    await components.dispose();
  });

  it("does not schedule source maintenance in observe mode", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const opts = { ...options(), enforcement: "observe" as const };
    const components = createProductionProofComponents(opts),
      bundle = components.create(input());
    h.selections[0].read.mockImplementation(async () => publishCandidate());
    await bundle.inspect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.selections[0].read).toHaveBeenCalledOnce();
    await bundle.dispose();
    await components.dispose();
  });

  it.each([false, true])(
    "coalesces a renewal due during collection; current collection refresh=%s",
    async (refreshed) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const components = createProductionProofComponents(options(true)),
        bundle = components.create(input());
      h.selections[0].read.mockImplementation(async () => publishCandidate());
      await bundle.inspect();
      await bundle.collect(request());
      const held = deferred<ProofCollectionResult>();
      h.sources[0].collect.mockReturnValueOnce(held.promise);
      const collection = bundle.collect(request());
      await turn();
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.selections[0].read).toHaveBeenCalledOnce();
      if (refreshed) publishCandidate();
      held.resolve({ kind: "unavailable", reason: "EGRESS_UNVERIFIED" });
      await collection;
      await turn();
      expect(h.selections[0].read).toHaveBeenCalledTimes(refreshed ? 1 : 2);
      await bundle.dispose();
      await components.dispose();
    },
  );

  it("waits for a renewal already in progress rather than turning a warmup round into a failed collection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const components = createProductionProofComponents(options(true)),
      bundle = components.create(input());
    h.selections[0].read.mockImplementation(async () => publishCandidate());
    await bundle.inspect();
    const held = deferred<{ state: "candidate" }>();
    h.selections[0].read.mockReturnValueOnce(held.promise);
    await vi.advanceTimersByTimeAsync(10000);
    const collection = bundle.collect(request());
    await turn();
    expect(h.sources).toHaveLength(0);
    held.resolve(publishCandidate());
    await collection;
    expect(h.sources[0].collect).toHaveBeenCalledOnce();
    await bundle.dispose();
    await components.dispose();
  });

  it.each(["changed", "getter revokes"])(
    "does not renew authority when the current Gate version is %s",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const opts = options(),
        owner = input();
      const components = createProductionProofComponents(opts),
        bundle = components.create(owner);
      owner.onInvalidated = vi.fn(() => bundle.invalidate());
      h.selections[0].read.mockImplementation(async () => publishCandidate());
      await bundle.inspect();
      opts.readVersion = () => {
        if (kind === "getter revokes") bundle.invalidate();
        return { generation: 1, rulesVersion: "b".repeat(64) };
      };
      await vi.advanceTimersByTimeAsync(10000);
      if (kind === "changed") expect(owner.onInvalidated).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30000);
      expect(h.selections[0].read).toHaveBeenCalledTimes(2);
      expect(h.selections[0].dispose).toHaveBeenCalled();
      await bundle.dispose();
      await components.dispose();
    },
  );

  it("drains a cancelled renewal and refuses its waiting collection without restarting a timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const components = createProductionProofComponents(options(true));
    const bundle = components.create(input());
    h.selections[0].read.mockImplementation(async () => publishCandidate());
    await bundle.inspect();
    const held = deferred<{ state: "candidate" }>();
    h.selections[0].read.mockReturnValueOnce(held.promise);
    await vi.advanceTimersByTimeAsync(10000);
    const collection = bundle.collect(request());
    const finished = vi.fn();
    const disposal = bundle.dispose().then(finished);
    await turn();
    expect(finished).not.toHaveBeenCalled();
    expect(h.selections[0].dispose).toHaveBeenCalled();
    held.resolve(publishCandidate());
    expect(await collection).toEqual({ kind: "unavailable", reason: "CONTEXT_UNVERIFIED" });
    await disposal;
    expect(finished).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.selections[0].read).toHaveBeenCalledTimes(2);
    expect(h.sources).toHaveLength(0);
    await components.dispose();
  });
});

describe("production proof component orchestration", () => {
  it.each(["renewed", "attached", "withdrawn"] as const)(
    "retains the Source and its cache owner when compatibility is %s, while classification uses the latest loader",
    async (change) => {
      const opts = options(true),
        components = createProductionProofComponents(opts),
        bundle = components.create(input());
      await bundle.inspect();
      const compatibility = {
        profileId: "test-attachment",
        checkedAtMono: 25,
        expiresAtMono: 15025,
      } as SelectedKernelCompatibility;
      const original = {
        ...structuredClone(h.loader),
        ...(change === "attached" ? {} : { kernelCompatibility: compatibility }),
      };
      h.selections[0].loader = original;
      await bundle.collect({ ...request(), requestId: "first-round" });
      const source = h.sources[0],
        adapter = h.adapters[0];
      // The real Source's exit cache belongs to this exact instance. Its cache policy is tested
      // in production-proof-source.test.ts; this boundary must neither dispose nor replace it.
      const current: KnownSelectedLoaderContract = {
        ...structuredClone(h.loader),
        ...(change === "withdrawn"
          ? {}
          : {
              kernelCompatibility: { ...compatibility, checkedAtMono: 125, expiresAtMono: 15125 },
            }),
      };
      h.selections[0].loader = current;
      await bundle.collect({ ...request(), requestId: "second-round", startedAtMono: 119 });
      expect(h.sources).toEqual([source]);
      expect(h.adapters).toEqual([adapter]);
      expect(source.collect.mock.calls.map(([r]) => r.requestId)).toEqual(["first-round", "second-round"]);
      expect(source.dispose).not.toHaveBeenCalled();
      expect(adapter.dispose).not.toHaveBeenCalled();
      expect(opts.getQualification).toHaveBeenLastCalledWith(current);
      expect(adapter.options.loader).toBe(original);
      h.dns[0].options.classifyAddress!("2606:4700:4700::1111", "a".repeat(64));
      expect(h.classify.mock.calls.at(-1)?.[2].loader).toBe(current);
      expect(h.classify.mock.calls.at(-1)?.[2].loader?.kernelCompatibility).toBe(current.kernelCompatibility);
      await bundle.dispose();
      await components.dispose();
    },
  );

  it.each([
    { selectionId: "replacement" },
    { source: "different-source" as KnownSelectedLoaderContract["source"] },
    { loaderProfileId: "replacement-profile" },
    { sourcePathIdentity: "c".repeat(64) },
    { decoderIdentity: "replacement-decoder" },
    { selectedAtMono: 11 },
    { qualificationEvidenceIds: ["new-reviewed-loader-fact"] },
  ])("rebuilds for changed stable loader evidence %j", async (patch) => {
    const components = createProductionProofComponents(options(true)),
      bundle = components.create(input());
    await bundle.collect(request());
    const oldSource = h.sources[0],
      oldAdapter = h.adapters[0];
    h.selections[0].loader = { ...structuredClone(h.loader), ...patch };
    await bundle.collect({ ...request(), requestId: "replacement-round" });
    expect(h.sources).toHaveLength(2);
    expect(h.adapters).toHaveLength(2);
    expect(oldSource.dispose).toHaveBeenCalledOnce();
    expect(oldAdapter.dispose).toHaveBeenCalledOnce();
    expect(oldAdapter.whenIdle).toHaveBeenCalledOnce();
    await bundle.dispose();
    await components.dispose();
  });

  it("uses a captured identity so an in-place selection edit cannot reuse an old Source", async () => {
    const components = createProductionProofComponents(options(true)),
      bundle = components.create(input());
    await bundle.inspect();
    const selected = structuredClone(h.loader);
    h.selections[0].loader = selected;
    await bundle.collect(request());
    Object.assign(selected, { qualificationEvidenceIds: ["changed-in-place"] });
    await bundle.collect({ ...request(), requestId: "new-evidence" });
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0].dispose).toHaveBeenCalledOnce();
    await bundle.dispose();
    await components.dispose();
  });

  it("rebuilds for a different retained qualification even with an identical selection", async () => {
    const opts = options(true),
      components = createProductionProofComponents(opts),
      bundle = components.create(input());
    await bundle.collect(request());
    opts.getQualification = vi.fn(() => ({ evidenceId: "replacement-q" }) as RetainedPathQualification);
    await bundle.collect({ ...request(), requestId: "replacement-q-round" });
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0].dispose).toHaveBeenCalledOnce();
    await bundle.dispose();
    await components.dispose();
  });

  it("reads the current selected source for DNS classification and cannot classify after synchronous invalidation", async () => {
    const components = createProductionProofComponents(options());
    const bundle = components.create(input());
    const classify = h.dns[0].options.classifyAddress!;
    expect(classify("8.8.8.8", "a".repeat(64))).toBe("unknown");
    expect(h.classify).toHaveBeenLastCalledWith(
      "8.8.8.8",
      "a".repeat(64),
      { candidate: null, loader: null },
      expect.any(Number),
    );
    expect(h.selections[0].getSnapshot).toHaveBeenCalledOnce();
    await bundle.inspect();
    expect(classify("8.8.8.8", "a".repeat(64))).toBe("unknown");
    expect(h.classify).toHaveBeenLastCalledWith(
      "8.8.8.8",
      "a".repeat(64),
      { candidate: null, loader: h.loader },
      expect.any(Number),
    );
    h.selections[0].getSnapshot.mockImplementation(() => {
      bundle.invalidate();
      return { state: "unavailable", generation: 1, reason: "EXPIRED" };
    });
    expect(classify("8.8.8.8", "a".repeat(64))).toBe("unknown");
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.systemHosts[0].dispose).toHaveBeenCalled();
    expect(h.systemHosts[0].read).not.toHaveBeenCalled();
    await bundle.dispose();
    await components.dispose();
  });

  it("constructs without I/O and passes only the explicitly selected directory to selection", async () => {
    const components = createProductionProofComponents(options());
    const bundle = components.create(input("D:\\Explicit\\resources"));
    expect(h.selections[0].options.resourcesPath).toBe("D:\\Explicit\\resources");
    expect(h.selections[0].select).not.toHaveBeenCalled();
    expect(h.selections[0].read).not.toHaveBeenCalled();
    expect(h.clashes[0].read).not.toHaveBeenCalled();
    expect(h.inputs[0].read).not.toHaveBeenCalled();
    expect(h.systemHosts[0].read).not.toHaveBeenCalled();
    expect(h.inputs[0].options.systemHosts).toBe(h.systemHosts[0]);
    await bundle.dispose();
    await components.dispose();
  });

  it("waits for explicit selection before qualification lookup or the input observation round", async () => {
    const opts = options(true),
      components = createProductionProofComponents(opts),
      bundle = components.create(input());
    const selection = deferred<KnownSelectedLoaderContract | null>();
    h.selections[0].select.mockImplementation(async () => {
      h.events.push("select-start");
      const loader = await selection.promise;
      h.selections[0].loader = loader;
      h.events.push("select-complete");
      return loader;
    });
    const work = bundle.collect(request());
    await turn();
    expect(opts.getQualification).not.toHaveBeenCalled();
    expect(h.inputs[0].read).not.toHaveBeenCalled();
    selection.resolve(h.loader);
    await work;
    expect(opts.getQualification).toHaveBeenCalledWith(h.loader);
    expect(h.events).toEqual(["select-start", "select-complete", "source-collect", "input-round"]);
    await bundle.dispose();
    await components.dispose();
  });

  it.each(["provider absent", "provider returns null"])(
    "stops before DNS/routes/TLS/egress when qualification %s",
    async (kind) => {
      const opts = options();
      if (kind === "provider returns null") opts.getQualification = vi.fn(() => null);
      const components = createProductionProofComponents(opts),
        bundle = components.create(input());
      expect(await bundle.collect(request())).toEqual({ kind: "unavailable", reason: "CONTEXT_UNVERIFIED" });
      expect(h.selections[0].select).toHaveBeenCalledOnce();
      expect(h.inputs[0].read).not.toHaveBeenCalled();
      expect(h.dns[0].read).not.toHaveBeenCalled();
      expect(h.clashes[0].readDnsQuery).not.toHaveBeenCalled();
      expect(h.owners[0].read).not.toHaveBeenCalled();
      expect(h.networks[0].readObservation).not.toHaveBeenCalled();
      expect(h.adapters).toHaveLength(0);
      expect(h.sources).toHaveLength(0);
      expect(h.tls[0].probe).not.toHaveBeenCalled();
      expect(h.egress[0].probe).not.toHaveBeenCalled();
      await bundle.dispose();
      await components.dispose();
    },
  );

  it("inspects the selected source without requiring path qualification or issuing public probes", async () => {
    const components = createProductionProofComponents(options()),
      bundle = components.create(input());
    expect(await bundle.inspect()).toBe(true);
    expect(h.events).toEqual(["select-complete", "source-inspection"]);
    expect(h.inputs[0].read).not.toHaveBeenCalled();
    expect(h.adapters).toHaveLength(0);
    expect(h.tls[0].probe).not.toHaveBeenCalled();
    expect(h.egress[0].probe).not.toHaveBeenCalled();
    await bundle.dispose();
    await components.dispose();
  });

  it("forwards unavailable-source invalidation synchronously and ignores its late callback after disposal", async () => {
    const selected = input(),
      components = createProductionProofComponents(options()),
      bundle = components.create(selected);
    h.selections[0].options.onChange?.({ state: "checking", generation: 0 });
    expect(selected.onInvalidated).not.toHaveBeenCalled();
    h.selections[0].options.onChange?.({ state: "unavailable", generation: 1, reason: "SOURCE_UNAVAILABLE" });
    expect(selected.onInvalidated).toHaveBeenCalledOnce();
    await bundle.dispose();
    h.selections[0].options.onChange?.({ state: "unavailable", generation: 2, reason: "SOURCE_UNAVAILABLE" });
    expect(selected.onInvalidated).toHaveBeenCalledOnce();
    await components.dispose();
  });

  it("retains the exact anonymous pools and their poisoned state across configuration bundle replacement", async () => {
    const components = createProductionProofComponents(options(true));
    const first = components.create(input());
    await first.collect(request());
    const firstPools = h.sources[0].options;
    h.tls[0].poisoned = true;
    h.egress[0].poisoned = true;
    await first.dispose();
    const second = components.create(input("D:\\AnotherExplicit\\resources"));
    await second.collect(request());
    expect(h.tls).toHaveLength(1);
    expect(h.egress).toHaveLength(1);
    expect(h.sources[1].options.tls).toBe(firstPools.tls);
    expect(h.sources[1].options.egress).toBe(firstPools.egress);
    expect(h.tls[0].poisoned).toBe(true);
    expect(h.egress[0].poisoned).toBe(true);
    expect(h.tls[0].dispose).not.toHaveBeenCalled();
    expect(h.egress[0].dispose).not.toHaveBeenCalled();
    await second.dispose();
    await components.dispose();
    expect(h.tls[0].dispose).toHaveBeenCalledOnce();
    expect(h.egress[0].dispose).toHaveBeenCalledOnce();
  });

  it("waits for every nested idle slot and both anonymous cleanups before bundle disposal finishes", async () => {
    const components = createProductionProofComponents(options(true)),
      bundle = components.create(input());
    await bundle.collect(request());
    const slots = [deferred(), deferred(), deferred(), deferred(), deferred(), deferred(), deferred()];
    h.selections[0].whenIdle.mockReturnValue(slots[0].promise);
    h.inputs[0].whenIdle.mockReturnValue(slots[1].promise);
    h.owners[0].whenIdle.mockReturnValue(slots[2].promise);
    h.adapters[0].whenIdle.mockReturnValue(slots[3].promise);
    h.tls[0].invalidate.mockReturnValue(slots[4].promise);
    h.egress[0].invalidate.mockReturnValue(slots[5].promise);
    h.systemHosts[0].whenIdle.mockReturnValue(slots[6].promise);
    let finished = false;
    const disposal = bundle.dispose().then(() => {
      finished = true;
    });
    expect(h.sources[0].dispose).toHaveBeenCalled();
    expect(h.adapters[0].dispose).toHaveBeenCalled();
    expect(h.systemHosts[0].dispose).toHaveBeenCalled();
    for (const slot of slots.slice(0, -1)) {
      slot.resolve();
      await turn();
      expect(finished).toBe(false);
    }
    slots.at(-1)!.resolve();
    await disposal;
    expect(finished).toBe(true);
    await components.dispose();
  });

  it("does not complete disposal while a non-cancellable controller read remains in flight", async () => {
    const components = createProductionProofComponents(options()),
      bundle = components.create(input());
    const controller = deferred<ClashReadResult>();
    h.clashes[0].read.mockReturnValue(controller.promise);
    h.selections[0].read.mockImplementation(async () => {
      await h.selections[0].options.readController(new AbortController().signal);
      return { state: "candidate" };
    });
    const inspection = bundle.inspect();
    await turn();
    expect(h.clashes[0].read).toHaveBeenCalledOnce();
    let finished = false;
    const disposal = bundle.dispose().then(() => {
      finished = true;
    });
    await turn();
    expect(finished).toBe(false);
    controller.resolve(h.controller);
    expect(await inspection).toBe(false);
    await disposal;
    expect(finished).toBe(true);
    expect(await bundle.inspect()).toBe(false);
    await components.dispose();
  });

  it("serializes owned controller reads and cancels the queued read without hiding the in-flight one", async () => {
    const components = createProductionProofComponents(options()),
      bundle = components.create(input());
    const controller = deferred<ClashReadResult>();
    h.clashes[0].read.mockReturnValue(controller.promise);
    const read = h.selections[0].options.readController,
      signal = new AbortController().signal;
    const reads = Promise.allSettled([read(signal), read(signal)]);
    await turn();
    expect(h.clashes[0].read).toHaveBeenCalledOnce();
    let finished = false;
    const disposal = bundle.dispose().then(() => {
      finished = true;
    });
    await turn();
    expect(finished).toBe(false);
    controller.resolve(h.controller);
    expect((await reads).map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await disposal;
    expect(h.clashes[0].read).toHaveBeenCalledOnce();
    await components.dispose();
  });

  it.each(["DNS controller", "OS network"] as const)(
    "drains an already running %s read after its parent public operation can close",
    async (kind) => {
      const components = createProductionProofComponents(options(true)),
        bundle = components.create(input());
      await bundle.collect(request());
      const raw = deferred<unknown>();
      let nested: Promise<unknown>;
      if (kind === "DNS controller") {
        h.clashes[0].readDnsQuery.mockReturnValue(raw.promise);
        nested = h.dns[0].options.reader.readDnsQuery("api.bilibili.com", "A", new AbortController().signal);
      } else {
        h.networks[0].readObservation.mockReturnValue(raw.promise);
        nested = h.inputs[0].options.network.readObservation();
      }
      let finished = false;
      const disposal = bundle.dispose().then(() => {
        finished = true;
      });
      await turn();
      expect(finished).toBe(false);
      raw.resolve({});
      await nested;
      await disposal;
      expect(finished).toBe(true);
      await components.dispose();
    },
  );

  it("retains a replaced adapter until its pending slot drains, including concurrent bundle disposal", async () => {
    const opts = options(true),
      components = createProductionProofComponents(opts),
      bundle = components.create(input());
    await bundle.collect(request());
    const oldIdle = deferred();
    h.adapters[0].whenIdle.mockReturnValue(oldIdle.promise);
    opts.getQualification = () =>
      ({ evidenceId: "another-test-adapter-identity" }) as RetainedPathQualification;
    const replacing = bundle.collect(request());
    await turn();
    expect(h.adapters[0].dispose).toHaveBeenCalled();
    expect(h.adapters).toHaveLength(1);
    let finished = false;
    const disposal = bundle.dispose().then(() => {
      finished = true;
    });
    await turn();
    expect(finished).toBe(false);
    oldIdle.resolve();
    expect(await replacing).toEqual({ kind: "unavailable", reason: "CONTEXT_UNVERIFIED" });
    await disposal;
    expect(h.adapters).toHaveLength(1);
    expect(h.sources).toHaveLength(1);
    await components.dispose();
  });
});
