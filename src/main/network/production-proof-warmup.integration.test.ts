import { createHash } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as realTimeout } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EgressGate, type GateClock } from "./egress-gate";
import { ProofIssuer, type ProofCollectionRequest, type ProofCollectionResult } from "./proof-issuer";
import { ProductionProofRuntime } from "./production-proof-runtime";
import type { AccountProofScope } from "./direct-proof";
import type { ClashReadResult } from "./clash-reader";
import type * as ClashModule from "./clash-reader";
import type { SelectedClientConfigOptions } from "./selected-client-config";
import type { EffectiveConfigSource, EffectiveConfigSourceSnapshot } from "./effective-config-source";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import type { PathInputReaderOptions } from "./path-input-reader";
import type { RetainedPathQualification } from "./path-conformance";
import type { ProductionProofSourceOptions } from "./production-proof-source";

const h = vi.hoisted(() => ({
  file: "",
  controller: null as (() => ClashReadResult) | null,
  candidates: [] as Extract<EffectiveConfigSourceSnapshot, { state: "candidate" }>[],
  unavailable: [] as Extract<EffectiveConfigSourceSnapshot, { state: "unavailable" }>[],
  collections: [] as { request: ProofCollectionRequest; completedAt: number }[],
  sources: [] as EffectiveConfigSource[],
}));

// Retain the real file reader, source change detection and active 15 s expiry. Only the unrelated
// selected application's ASAR/decoder boundary is replaced by this test's explicit temporary YAML.
vi.mock("./selected-client-config", async () => {
  const { EffectiveConfigSource } = await import("./effective-config-source");
  return {
    SelectedClientConfig: class {
      private readonly source: EffectiveConfigSource;
      private loader: KnownSelectedLoaderContract | null = null;
      private disposed = false;
      constructor(readonly options: SelectedClientConfigOptions) {
        this.source = new EffectiveConfigSource({
          path: h.file,
          format: "yaml",
          readController: options.readController,
          onChange: (snapshot) => {
            if (this.disposed) return;
            if (snapshot.state === "candidate") h.candidates.push(snapshot);
            if (snapshot.state === "unavailable") {
              h.unavailable.push(snapshot);
              this.loader = null;
            }
            options.onChange?.(snapshot);
          },
        });
        h.sources.push(this.source);
      }
      async select() {
        if (this.disposed) return null;
        this.loader ??= {
          source: "main-process-selected-loader-contract",
          selectionId: "explicit-synthetic-loader",
          loaderProfileId: "test-yaml-loader",
          sourcePathIdentity: "b".repeat(64),
          decoderIdentity: "plaintext-yaml-v1",
          qualificationEvidenceIds: ["synthetic-loader-boundary"],
          selectedAtMono: performance.now(),
        };
        return this.loader;
      }
      getSnapshot() {
        return this.source.getSnapshot();
      }
      getSelectedLoader() {
        this.getSnapshot();
        return this.loader;
      }
      read() {
        return this.source.read();
      }
      dispose() {
        this.disposed = true;
        this.loader = null;
        this.source.dispose();
      }
      whenIdle() {
        return this.source.whenIdle();
      }
    },
  };
});
vi.mock("./clash-reader", async (original) => ({
  ...(await original<typeof ClashModule>()),
  ClashReader: class {
    async read() {
      return h.controller!();
    }
  },
}));
vi.mock("./path-input-reader", () => ({
  PathInputReader: class {
    constructor(private readonly options: PathInputReaderOptions) {}
    async read() {
      const snapshot = await this.options.configuration.read();
      if (snapshot.state !== "candidate") throw new Error("SYNTHETIC_SOURCE_UNAVAILABLE");
      return snapshot;
    }
    dispose() {}
    async whenIdle() {}
  },
}));
vi.mock("./kernel-dns", () => ({
  KernelDnsReader: class {
    dispose() {}
  },
}));
vi.mock("./windows-controller-owner", () => ({
  WindowsControllerOwnerReader: class {
    dispose() {}
    async whenIdle() {}
  },
}));
vi.mock("./windows-system-hosts", () => ({
  WindowsSystemHostsReader: class {
    dispose() {}
    async whenIdle() {}
  },
}));
vi.mock("./windows-network-fingerprint", () => ({ WindowsNetworkFingerprintReader: class {} }));
vi.mock("./path-conformance", () => ({
  PathConformanceAdapter: class {
    dispose() {}
    async whenIdle() {}
  },
}));
vi.mock("./current-rule-context-producer", () => ({ createConservativeRuleContexts: () => null }));
vi.mock("./anonymous-proof-probe", () => ({
  AnonymousProofProbe: class {
    async invalidate() {}
    async dispose() {}
  },
}));
vi.mock("./anonymous-egress-probe", () => ({
  AnonymousEgressProbe: class {
    async invalidate() {}
    async dispose() {}
  },
}));
vi.mock("./production-proof-source", () => ({
  ProductionProofSource: class {
    constructor(private readonly options: ProductionProofSourceOptions) {}
    async collect(request: ProofCollectionRequest): Promise<ProofCollectionResult> {
      // Only the evidence sampler is synthetic. Every round first performs an actual source read,
      // then consumes 1 s, placing the next warm-up strictly after that source's original expiry.
      await this.options.inputs.read({ ...request, targets: request.scope.targets }, request.signal);
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      h.collections.push({ request, completedAt: performance.now() });
      return syntheticEvidence(request);
    }
    dispose() {}
  },
}));

const VERSION = "a".repeat(64),
  HASH = "b".repeat(64);
const scope: AccountProofScope = {
  accountId: "single-synthetic-account",
  platformId: "bilibili",
  contextId: "synthetic-session-context",
  catalogVersion: "synthetic-reviewed-operation",
  catalogReviewed: true,
  targets: [{ protocol: "https:", host: "api.bilibili.com", port: 443, addressFamily: "ipv4" }],
};
function syntheticEvidence(request: ProofCollectionRequest): ProofCollectionResult {
  const at = request.startedAtMono;
  return {
    kind: "evidence",
    requestId: request.requestId,
    batch: {
      sampleId: request.requestId,
      generation: request.generation,
      rulesVersion: request.rulesVersion,
      contextId: request.scope.contextId,
      catalogVersion: request.scope.catalogVersion,
      observedAtMono: at,
      targets: request.scope.targets.map((target) => ({
        target,
        route: {
          source: "correlated-connection",
          contextId: request.scope.contextId,
          rulesVersion: request.rulesVersion,
          ruleDecision: "direct",
          connectionId: `fixture-${request.requestId}`,
          correlationVerified: true,
          chains: ["DIRECT"],
          observedAtMono: at,
        },
        egress: {
          target,
          contextId: request.scope.contextId,
          ip: "192.0.2.1",
          countryCode: "CN",
          asn: 64512,
          source: "synthetic-clock-test-receiver",
          applicabilityVerified: true,
          observedAtMono: at,
        },
        tls: { verified: true, observedAtMono: at },
        dns: { status: "resolved", addressFamily: target.addressFamily, observedAtMono: at },
      })),
    },
  };
}
function controller(): ClashReadResult {
  const at = performance.now();
  const modeHash = createHash("sha256").update(JSON.stringify("rule")).digest("hex");
  return {
    mode: "rule",
    tun: true,
    mixedPort: 10090,
    version: "synthetic-kernel",
    fingerprint: VERSION,
    rules: [{ type: "Domain", payload: "api.bilibili.com", proxy: "DIRECT" }],
    configFieldHashes: { mode: modeHash },
    configPathHashes: { "/mode": modeHash },
    startedAtMono: at,
    completedAtMono: at,
    directPolicy: {
      kind: "direct",
      interfaceName: null,
      dialer: "none",
      ipVersion: null,
      policyFingerprint: HASH,
      startedAtMono: at,
      completedAtMono: at,
    },
  };
}

const disposals: (() => Promise<void>)[] = [];
const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
// Fake time must not outrun real filesystem I/O. Advancing timers never pretends the file read is done.
async function settle(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (predicate()) {
      await realTurn();
      return;
    }
    await new Promise<void>((resolve) => realTimeout(resolve, 1));
  }
  throw new Error("SYNTHETIC_IO_DID_NOT_SETTLE");
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(Date.parse("2026-09-08T00:00:00Z"));
  h.candidates.length = 0;
  h.unavailable.length = 0;
  h.collections.length = 0;
  h.sources.length = 0;
  h.controller = controller;
});
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});

async function fixture(enforcement: "strict" | "observe" = "strict") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clipdock-proof-warmup-"));
  const file = path.join(directory, "selected.yaml");
  await writeFile(file, "mode: rule\nrules:\n  - DOMAIN,api.bilibili.com,DIRECT\n");
  h.file = file;
  disposals.push(async () => {
    await unlink(file);
    await rmdir(directory);
  });
  const clock: GateClock = {
    monotonicMs: () => performance.now(),
    wallTimeMs: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const gate = new EgressGate({ clock });
  const network = { controllerReadable: true, mode: "rule", tun: true, rulesVersion: VERSION };
  gate.setNetworkState(network);
  // Model the independent controller observer, so only the selected-source TTL can break warm-up.
  const observer = setInterval(() => gate.setNetworkState(network), 5000);
  const invalidated = vi.fn(() => {
    gate.invalidate("NETWORK_CHANGED");
    runtime.invalidate();
  });
  // Identity-only sampler boundary: this is not a real qualification or a live network experiment.
  const qualification = { evidenceId: "synthetic-sampler-boundary" } as RetainedPathQualification;
  const runtime: ProductionProofRuntime = new ProductionProofRuntime({
    enforcement,
    settings: () => ({
      controllerUrl: "http://127.0.0.1:9790",
      diagnosticProxyPort: 10090,
      selectedClientResourcesPath: directory,
    }),
    getSecret: () => null,
    readVersion: () => gate.currentProofVersion(),
    onInvalidated: invalidated,
    getQualification: () => qualification,
  });
  const issuer = new ProofIssuer({ gate, source: runtime, clock });
  issuer.registerScope(scope, { generation: gate.generation, rulesVersion: VERSION });
  disposals.push(async () => {
    clearInterval(observer);
    issuer.dispose();
    await runtime.dispose();
    gate.dispose();
  });
  runtime.start();
  expect(await runtime.refresh()).toBe(true);
  await Promise.all(h.sources.map((source) => source.whenIdle()));
  await realTurn();
  return { runtime, gate, issuer, invalidated, file, generation: gate.generation };
}

describe("real selected-source TTL through components, runtime, Issuer and Gate", () => {
  it("completes one account's two fresh warm-up rounds across the first candidate expiry", async () => {
    const f = await fixture();
    const firstExpiry = h.candidates[0].candidate.expiresAtMono;
    expect(firstExpiry).toBe(15000);
    f.issuer.start();
    const first = f.issuer.request(scope.accountId);
    let earlyResult: unknown = null;
    void first.then((value) => {
      earlyResult = value;
    });
    await settle(() => h.candidates.length >= 2 || earlyResult !== null);
    expect(earlyResult).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).status).toBe("waiting");
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
    expect(h.collections[0].completedAt).toBe(1000);

    await vi.advanceTimersByTimeAsync(9000);
    await realTurn();
    await Promise.all(h.sources.map((source) => source.whenIdle()));
    await realTurn();
    await vi.advanceTimersByTimeAsync(6000);
    await settle(
      () =>
        f.invalidated.mock.calls.length > 0 ||
        h.candidates.some((item) => item.candidate.completedAtMono === 16000),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await settle(() => f.invalidated.mock.calls.length > 0 || h.collections.length === 2);

    expect(performance.now()).toBeGreaterThan(firstExpiry);
    expect(f.invalidated).not.toHaveBeenCalled();
    expect(h.unavailable).toEqual([]);
    expect(f.gate.generation).toBe(f.generation);
    expect(h.collections.map((value) => value.request.startedAtMono)).toEqual([0, 16000]);
    expect(new Set(h.collections.map((value) => value.request.requestId)).size).toBe(2);
    expect(f.gate.checkAction(scope.accountId, scope.contextId)).toMatchObject({
      allowed: true,
      reason: "READY",
    });
    // Each actual reader's TTL stays 15 s; maintenance neither stretches a candidate nor retimes it.
    for (const { candidate } of h.candidates)
      expect(candidate.expiresAtMono - candidate.completedAtMono).toBe(15000);
    expect(h.candidates[0].candidate.expiresAtMono).toBe(firstExpiry);
  });

  it("keeps observe mode passive and lets the real source expiry revoke it", async () => {
    const f = await fixture("observe");
    expect(h.candidates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(h.candidates).toHaveLength(1);
    expect(h.unavailable.some((value) => value.reason === "EXPIRED")).toBe(true);
    expect(f.invalidated).toHaveBeenCalledOnce();
    expect(f.gate.generation).toBeGreaterThan(f.generation);
  });

  it("revokes before warm-up if maintenance sees a real file and matching runtime rule change", async () => {
    const f = await fixture();
    await writeFile(f.file, "mode: rule\nrules:\n  - DOMAIN,changed.example.com,DIRECT\n");
    h.controller = () => ({
      ...controller(),
      rules: [{ type: "Domain", payload: "changed.example.com", proxy: "DIRECT" }],
    });
    await vi.advanceTimersByTimeAsync(10000);
    await settle(() => f.invalidated.mock.calls.length > 0);
    expect(h.unavailable.some((value) => value.reason === "SOURCE_CHANGED")).toBe(true);
    expect(f.gate.checkAction(scope.accountId, scope.contextId).allowed).toBe(false);
    expect(f.gate.generation).toBeGreaterThan(f.generation);
  });
});
