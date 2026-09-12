import type {
  ProofBundleInput,
  ProofSourceBundle,
  ProductionProofRuntimeOptions,
} from "./production-proof-runtime";
import { SelectedClientConfig } from "./selected-client-config";
import { ClashReader, type ClashReadResult } from "./clash-reader";
import { PathInputReader } from "./path-input-reader";
import { KernelDnsReader } from "./kernel-dns";
import { WindowsControllerOwnerReader } from "./windows-controller-owner";
import { WindowsNetworkFingerprintReader } from "./windows-network-fingerprint";
import { PathConformanceAdapter, type RetainedPathQualification } from "./path-conformance";
import { ProductionProofSource } from "./production-proof-source";
import { AnonymousProofProbe } from "./anonymous-proof-probe";
import { AnonymousEgressProbe } from "./anonymous-egress-probe";
import { createConservativeRuleContexts } from "./current-rule-context-producer";
import { classifyCurrentKernelDnsAddress } from "./kernel-dns-address-policy";
import { WindowsSystemHostsReader } from "./windows-system-hosts";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import type { ProofCollectionRequest, ProofCollectionResult } from "./proof-issuer";
import { NETWORK_TIMING } from "@shared/network";
import type { EffectiveConfigCandidate } from "./effective-config-source";
import { AnonymousPhysicalRouteCollector } from "./anonymous-physical-route-collector";
import { ObservedPathQualificationProducer } from "./path-qualification-producer";
import { PathQualificationLifecycle } from "./path-qualification-lifecycle";
import { exactOriginKey, normalizeExactOrigin } from "./operation-catalog";

const unavailable = (): ProofCollectionResult => ({ kind: "unavailable", reason: "CONTEXT_UNVERIFIED" });

function loaderIdentity(loader: KnownSelectedLoaderContract): string {
  // Compatibility observations renew independently. Current DNS classification reads the fresh
  // selection directly; their timestamps must not discard the Source's still-valid exit samples.
  return JSON.stringify([
    loader.source,
    loader.selectionId,
    loader.loaderProfileId,
    loader.sourcePathIdentity,
    loader.decoderIdentity,
    loader.selectedAtMono,
    loader.qualificationEvidenceIds,
  ]);
}

/** App-lifetime anonymous pools: changing configuration cannot replace poisoned slots with new Sessions. */
export function createProductionProofComponents(options: ProductionProofRuntimeOptions) {
  if (options.preparation && options.getQualification) throw new Error("AMBIGUOUS_PATH_QUALIFICATION_SOURCE");
  const tls = new AnonymousProofProbe(options.preparation ? { concurrency: 2, timeoutMs: 10_000 } : {}),
    egress = new AnonymousEgressProbe();
  const network = new WindowsNetworkFingerprintReader();
  return {
    create(input: ProofBundleInput): ProofSourceBundle {
      const abort = new AbortController();
      let busy = false,
        disposed = false,
        latest: ClashReadResult | null = null;
      let controllerTail: Promise<unknown> = Promise.resolve();
      let renewalTimer: ReturnType<typeof setTimeout> | null = null;
      let renewalDue = false;
      let maintenance: Promise<boolean> | null = null;
      const clearRenewal = () => {
        if (renewalTimer !== null) clearTimeout(renewalTimer);
        renewalTimer = null;
        renewalDue = false;
      };
      const scheduleRenewal = (candidate: EffectiveConfigCandidate) => {
        clearRenewal();
        if (options.enforcement !== "strict" || disposed || abort.signal.aborted) return;
        // A new controller observation must not silently keep a different Gate version alive.
        let version;
        try {
          version = options.readVersion();
        } catch {
          input.onInvalidated();
          return;
        }
        if (disposed || abort.signal.aborted) return;
        const now = performance.now();
        const lifetime = candidate.expiresAtMono - candidate.completedAtMono;
        if (
          (version && version.rulesVersion !== candidate.controllerFingerprint) ||
          !Number.isFinite(lifetime) ||
          lifetime <= 0 ||
          !Number.isFinite(candidate.completedAtMono) ||
          candidate.completedAtMono > now ||
          candidate.expiresAtMono <= now
        ) {
          input.onInvalidated();
          return;
        }
        // Use the real source completion/deadline. This reads again; it does not extend a sample.
        const due =
          candidate.completedAtMono +
          Math.min(NETWORK_TIMING.renewMs, (lifetime * NETWORK_TIMING.renewMs) / NETWORK_TIMING.proofTtlMs);
        renewalTimer = setTimeout(
          () => {
            renewalTimer = null;
            if (disposed || abort.signal.aborted) return;
            renewalDue = true;
            renewSource();
          },
          Math.max(1, due - now),
        );
        renewalTimer.unref?.();
      };
      const work = new Set<Promise<unknown>>();
      // Reader cleanup must never await its enclosing preparation/collection operation.
      const operations = new Set<Promise<unknown>>();
      const track = <T>(promise: Promise<T>): Promise<T> => {
        work.add(promise);
        void promise.then(
          () => work.delete(promise),
          () => work.delete(promise),
        );
        return promise;
      };
      const guard = (signal?: AbortSignal) => {
        if (disposed || abort.signal.aborted || signal?.aborted) throw new Error("PROOF_SOURCE_REVOKED");
      };
      const reader = new ClashReader({
        controllerUrl: input.settings.controllerUrl,
        getSecret: options.getSecret,
      });
      // This source owns its reader. Serial calls preserve each real start time, never relabel a
      // concurrent observer read as a later same-round controller sample.
      const readController = (signal: AbortSignal): Promise<ClashReadResult> => {
        const result = track(
          controllerTail
            .catch(() => undefined)
            .then(async () => {
              guard(signal);
              const value = await reader.read();
              guard(signal);
              if (options.enforcement === "strict") {
                // The selected file's postflight can await I/O. Revoke a known controller
                // change now, before returning the observation to that slower validation.
                let version;
                try {
                  version = options.readVersion();
                } catch {
                  guard(signal);
                  input.onInvalidated();
                  guard(signal);
                  throw new Error("PROOF_CONTROLLER_VERSION_UNAVAILABLE");
                }
                guard(signal);
                if (version && version.rulesVersion !== value.fingerprint) {
                  input.onInvalidated();
                  guard(signal);
                  throw new Error("PROOF_CONTROLLER_VERSION_CHANGED");
                }
              }
              latest = value;
              return value;
            }),
        );
        controllerTail = result;
        return result;
      };
      const selection = new SelectedClientConfig({
        resourcesPath: input.settings.selectedClientResourcesPath,
        readController,
        onChange: (value) => {
          if (disposed || abort.signal.aborted) return;
          if (value.state === "unavailable") {
            clearRenewal();
            input.onInvalidated();
          } else if (value.state === "candidate") scheduleRenewal(value.candidate);
        },
      });
      const owner = new WindowsControllerOwnerReader({ controllerUrl: input.settings.controllerUrl });
      const systemHosts = new WindowsSystemHostsReader();
      const dns = new KernelDnsReader({
        reader: { readDnsQuery: (host, type, signal) => track(reader.readDnsQuery(host, type, signal)) },
        readControllerVersion: async (signal) => {
          const value = await readController(signal);
          return {
            controllerVersion: value.fingerprint,
            startedAtMono: value.startedAtMono!,
            completedAtMono: value.completedAtMono!,
          };
        },
        classifyAddress: (address, controllerVersion) => {
          const snapshot = selection.getSnapshot();
          const loader = selection.getSelectedLoader();
          if (disposed || abort.signal.aborted) return "unknown";
          return classifyCurrentKernelDnsAddress(
            address,
            controllerVersion,
            {
              candidate: snapshot.state === "candidate" ? snapshot.candidate : null,
              loader,
            },
            performance.now(),
          );
        },
      });
      const inputs = new PathInputReader({
        configuration: selection,
        owner,
        dns,
        systemHosts,
        network: { readObservation: () => track(network.readObservation()) },
        readVersion: options.readVersion,
      });
      const readersWhenIdle = async () => {
        const settled = await Promise.allSettled([
          selection.whenIdle(),
          owner.whenIdle(),
          systemHosts.whenIdle(),
          reader.whenIdle(),
        ]);
        // A cancelled/failed read is not an uncertain cleanup. Await its actual completion;
        // only an explicit idle-barrier failure says the underlying resource did not drain.
        await Promise.allSettled([controllerTail]);
        while (work.size) {
          await Promise.allSettled([...work]);
        }
        if (settled.some((result) => result.status === "rejected"))
          throw new Error("PATH_READER_CLEANUP_FAILED");
      };
      const physical = options.preparation
        ? new AnonymousPhysicalRouteCollector({
            inputs,
            dns,
            probe: tls,
            readController,
            readConnections: (hosts, signal) =>
              track(
                (async () => {
                  guard(signal);
                  const snapshot = await reader.readConnections(hosts);
                  guard(signal);
                  return snapshot;
                })(),
              ),
            closeConnection: (id, signal) =>
              track(
                (async () => {
                  guard(signal);
                  const response = await reader.closeConnection(id, signal);
                  guard(signal);
                  return response;
                })(),
              ),
            readVersion: options.readVersion,
            isQuiescent: options.preparation.isQuiescent,
            readersWhenIdle,
          })
        : null;
      const preparation = physical
        ? new PathQualificationLifecycle({
            readVersion: options.readVersion,
            producer: new ObservedPathQualificationProducer({
              collector: physical,
              readReview: options.preparation!.readReview,
              readVersion: options.readVersion,
            }),
          })
        : null;
      let adapter: PathConformanceAdapter | null = null,
        source: ProductionProofSource | null = null;
      // This adapter is only used for synchronous projections; it never starts a route reader.
      let familyAdapter: PathConformanceAdapter | null = null;
      let familyQualification: RetainedPathQualification | null = null;
      let familyLoaderIdentity: string | null = null;
      let projectingFamilies = false;
      let familyProjectionRevision = 0;
      let currentLoaderIdentity: string | null = null,
        qualification: RetainedPathQualification | null = null;
      const pendingAdapters = new Set<PathConformanceAdapter>();
      const selected = async () => {
        const loader = selection.getSelectedLoader() ?? (await selection.select());
        guard();
        return loader;
      };
      const run = async <T>(body: () => Promise<T>, closed: T): Promise<T> => {
        if (busy || disposed || abort.signal.aborted) return closed;
        busy = true;
        const pending = Promise.resolve().then(() => {
          guard();
          return body();
        });
        operations.add(pending);
        try {
          return await pending;
        } catch {
          return closed;
        } finally {
          operations.delete(pending);
          busy = false;
          renewSource();
        }
      };
      const inspect = () =>
        run(async () => {
          if (!(await selected())) return false;
          const snapshot = await selection.read();
          guard();
          return snapshot.state === "candidate";
        }, false);
      function renewSource() {
        if (!renewalDue || busy || maintenance || disposed || abort.signal.aborted) return;
        renewalDue = false;
        // Defer entry until maintenance is registered, including synchronous source callbacks.
        const pending = Promise.resolve().then(inspect);
        maintenance = pending;
        void pending.then(() => {
          if (maintenance === pending) maintenance = null;
          renewSource();
        });
      }
      const invalidate = () => {
        clearRenewal();
        preparation?.invalidate();
        physical?.invalidate();
        abort.abort();
        source?.dispose();
        adapter?.dispose();
        familyAdapter?.dispose();
        familyAdapter = null;
        familyQualification = null;
        familyLoaderIdentity = null;
        familyProjectionRevision++;
        inputs.dispose();
        owner.dispose();
        dns.dispose();
        systemHosts.dispose();
        selection.dispose();
      };
      return {
        inspect,
        resolveAddressFamilies: (origin) => {
          if (projectingFamilies) {
            familyProjectionRevision++;
            return null;
          }
          if (options.enforcement !== "strict" || disposed || abort.signal.aborted) return null;
          const revision = familyProjectionRevision;
          projectingFamilies = true;
          const withdraw = () => {
            try {
              input.onInvalidated();
            } finally {
              invalidate();
            }
          };
          try {
            const target = normalizeExactOrigin(origin);
            if (!target || target.protocol !== "https:") return null;
            // getSelectedLoader performs only an in-memory expiry check, never selects/reads a file.
            const loader = selection.getSelectedLoader();
            guard();
            if (!loader) return null;
            const identity = loaderIdentity(loader);
            const readQualification = () =>
              preparation
                ? preparation.getQualification(loader)
                : (options.getQualification?.(loader) ?? null);
            const next = readQualification();
            guard();
            if (!next) {
              if (familyQualification || qualification) withdraw();
              return null;
            }
            const sourceMatches = () => {
              const snapshot = selection.getSnapshot();
              guard();
              if (snapshot.state !== "candidate" || loaderIdentity(next.loader) !== identity) return false;
              const current = snapshot.candidate;
              const original = next.inputs.configurationAfter;
              return (
                current.expiresAtMono > performance.now() &&
                current.sourceGeneration === original.sourceGeneration &&
                current.sourcePathIdentity === original.sourcePathIdentity &&
                current.decoderIdentity === original.decoderIdentity &&
                current.fileFingerprint === original.fileFingerprint &&
                current.controllerFingerprint === original.controllerFingerprint &&
                current.policy.fingerprint === original.policy.fingerprint &&
                current.currentDirectPolicy.policyFingerprint ===
                  original.currentDirectPolicy.policyFingerprint
              );
            };
            if (!sourceMatches()) {
              withdraw();
              return null;
            }
            // An unreviewed origin is not a reason to discard valid qualification for other accounts.
            if (!next.origins.some((entry) => exactOriginKey(entry.origin) === exactOriginKey(target)))
              return null;
            if (next !== familyQualification || identity !== familyLoaderIdentity) {
              familyAdapter?.dispose();
              familyAdapter = new PathConformanceAdapter({
                loader,
                qualification: next,
                readVersion: options.readVersion,
                getController: () => latest,
              });
              familyQualification = next;
              familyLoaderIdentity = identity;
            }
            const families = familyAdapter!.resolveAddressFamilies(target);
            const currentLoader = selection.getSelectedLoader();
            guard();
            if (
              !families ||
              !currentLoader ||
              loaderIdentity(currentLoader) !== identity ||
              readQualification() !== next ||
              !sourceMatches() ||
              revision !== familyProjectionRevision
            ) {
              withdraw();
              return null;
            }
            guard();
            return Object.freeze([...families]);
          } catch {
            if (!disposed && !abort.signal.aborted && (familyQualification || qualification)) withdraw();
            return null;
          } finally {
            projectingFamilies = false;
          }
        },
        prepareQualification: (signal) => {
          if (options.enforcement !== "strict" || !preparation || signal.aborted)
            return Promise.resolve(false);
          return run(async () => {
            guard(signal);
            if (!options.preparation!.isQuiescent()) return false;
            guard(signal);
            const loader = await selected();
            if (!loader) return false;
            const cancel = () => preparation.invalidate();
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
            try {
              guard(signal);
              const ready = await preparation.prepare(loader);
              // Cancellation may settle the public preparation before its actual native cleanup.
              await preparation.whenIdle();
              guard(signal);
              return ready !== null && preparation.getQualification(loader) === ready;
            } finally {
              // Reserve this bundle's shared slot through failures and real nested drain as well.
              try {
                await preparation.whenIdle();
              } finally {
                signal.removeEventListener("abort", cancel);
              }
            }
          }, false);
        },
        collect: async (request: ProofCollectionRequest) => {
          // Source-only maintenance cannot count as a failed second warmup sample. Preserve the
          // caller's original timestamp/signal while waiting for this already owned read.
          if (maintenance) await maintenance;
          if (request.signal.aborted || disposed || abort.signal.aborted) return unavailable();
          return run(async () => {
            guard(request.signal);
            const loader = await selected();
            if (!loader) return unavailable();
            const next = preparation
              ? preparation.getQualification(loader)
              : (options.getQualification?.(loader) ?? null);
            guard(request.signal);
            const withdraw = () => {
              // The owner closes the Gate before local sources and their native work are revoked.
              try {
                input.onInvalidated();
              } finally {
                invalidate();
              }
            };
            // Missing facts stop before DNS, route queries or public HTTP. No sample report is a default.
            if (!next) {
              if (preparation && qualification) withdraw();
              return unavailable();
            }
            const checkPrepared = () => {
              if (preparation && preparation.getQualification(loader) !== next) {
                withdraw();
                throw new Error("PATH_REVIEW_REVOKED");
              }
              guard(request.signal);
            };
            const identity = loaderIdentity(loader);
            if (next !== qualification || identity !== currentLoaderIdentity) {
              source?.dispose();
              if (adapter) {
                adapter.dispose();
                pendingAdapters.add(adapter);
                await adapter.whenIdle();
                pendingAdapters.delete(adapter);
              }
              guard(request.signal);
              checkPrepared();
              qualification = next;
              currentLoaderIdentity = identity;
              adapter = new PathConformanceAdapter({
                loader,
                qualification,
                readVersion: options.readVersion,
                getController: () => latest,
                readRuleContexts: (value) => createConservativeRuleContexts(value, performance.now()),
              });
              source = new ProductionProofSource({
                inputs,
                readController,
                readVersion: options.readVersion,
                conformance: adapter,
                tls,
                egress,
              });
            }
            checkPrepared();
            const result = await source!.collect(request);
            checkPrepared();
            return result;
          }, unavailable());
        },
        invalidate,
        dispose: async () => {
          disposed = true;
          invalidate();
          const cleanup = await Promise.allSettled([tls.invalidate(), egress.invalidate()]);
          // Public cancellation may finish before nested file/PowerShell/controller work; retain all
          // old instances until their actual slots drain before permitting another configuration.
          const drained = await Promise.allSettled([
            preparation?.dispose(),
            physical?.dispose(),
            selection.whenIdle(),
            inputs.whenIdle(),
            owner.whenIdle(),
            systemHosts.whenIdle(),
            maintenance,
            adapter?.whenIdle(),
            ...[...pendingAdapters].map((value) => value.whenIdle()),
          ]);
          while (work.size) await Promise.allSettled([...work]);
          while (operations.size) await Promise.allSettled([...operations]);
          if ([...cleanup, ...drained].some((result) => result.status === "rejected"))
            throw new Error("PROOF_CLEANUP_FAILED");
        },
      };
    },
    dispose: async () => {
      await Promise.all([tls.dispose(), egress.dispose()]);
    },
  };
}
