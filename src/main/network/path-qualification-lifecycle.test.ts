import { describe, expect, it, vi } from "vitest";
import { PathQualificationLifecycle, type PathQualificationProducer } from "./path-qualification-lifecycle";
import type { RetainedPathQualification } from "./path-conformance";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import type { ProofScopeVersion } from "./proof-issuer";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const loader = (selectionId = "selected"): KnownSelectedLoaderContract => ({
  source: "main-process-selected-loader-contract",
  selectionId,
  loaderProfileId: "supported-loader",
  sourcePathIdentity: "a".repeat(64),
  decoderIdentity: "yaml-profile-v1",
  qualificationEvidenceIds: ["retained-loader-review"],
  selectedAtMono: 1,
});
/** Opaque downstream facts: these lifecycle tests do not pretend to perform path qualification. */
const qualification = (selected: KnownSelectedLoaderContract): RetainedPathQualification =>
  ({
    source: "main-process-retained-path-qualification",
    evidenceId: "original-qualified-object",
    loader: selected,
    qualifiedAtMono: 20,
    expiresAtMono: 1000,
    inputs: { generation: 1, rulesVersion: "historical-controller-version" },
    configuration: { evidenceId: "original-brand-bearing-object" },
  }) as RetainedPathQualification;
function fixture() {
  let now = 100;
  let version: ProofScopeVersion | null = { generation: 9, rulesVersion: "current-controller-version" };
  const selected = loader(),
    q = qualification(selected),
    producer = {
      prepare: vi.fn<PathQualificationProducer["prepare"]>(async () => q),
      whenIdle: vi.fn<PathQualificationProducer["whenIdle"]>(async () => {}),
      isQualificationCurrent: undefined as PathQualificationProducer["isQualificationCurrent"],
    },
    readVersion = vi.fn(() => version),
    lifecycle = new PathQualificationLifecycle({ producer, readVersion, now: () => now });
  return {
    lifecycle,
    selected,
    q,
    producer,
    readVersion,
    setVersion: (value: ProofScopeVersion | null) => {
      version = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("explicit path qualification lifecycle", () => {
  it("does not call any producer or version reader on construction or an empty getter", () => {
    const f = fixture();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(f.readVersion).not.toHaveBeenCalled();
    expect(f.producer.prepare).not.toHaveBeenCalled();
    expect(f.producer.whenIdle).not.toHaveBeenCalled();
  });

  it("has no default producer and cannot make a qualification available", async () => {
    const readVersion = vi.fn(() => ({ generation: 1, rulesVersion: "v" }));
    const lifecycle = new PathQualificationLifecycle({ readVersion });
    expect(await lifecycle.prepare(loader())).toBeNull();
    expect(lifecycle.getQualification(loader())).toBeNull();
    expect(readVersion).not.toHaveBeenCalled();
    await lifecycle.dispose();
  });

  it("returns the stable original object and preserves nested provenance without comparing historical generation", async () => {
    const f = fixture(),
      originalBrands = new WeakSet([f.q.configuration]);
    expect(await f.lifecycle.prepare(f.selected)).toBe(f.q);
    expect(f.lifecycle.getQualification(structuredClone(f.selected))).toBe(f.q);
    expect(originalBrands.has(f.lifecycle.getQualification(f.selected)!.configuration)).toBe(true);
    expect(await f.lifecycle.prepare(f.selected)).toBe(f.q);
    expect(f.producer.prepare).toHaveBeenCalledTimes(1);
    expect(f.q.inputs.generation).toBe(1);
  });
  it("checks an optional synchronous producer review before publication and each populated getter", async () => {
    const f = fixture(),
      check = vi.fn(() => true);
    f.producer.isQualificationCurrent = check;
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(await f.lifecycle.prepare(f.selected)).toBe(f.q);
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.getQualification(f.selected)).toBe(f.q);
    expect(check).toHaveBeenCalledTimes(2);
    check.mockReturnValue(false);
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    check.mockReturnValue(true);
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(f.producer.prepare).toHaveBeenCalledTimes(1);
  });
  it.each(["false", "throws", "invalidates", "async-return"] as const)(
    "does not publish when the producer review %s at the final boundary",
    async (kind) => {
      const f = fixture();
      f.producer.isQualificationCurrent = (() => {
        if (kind === "throws") throw Error("private-review-error");
        if (kind === "invalidates") {
          f.lifecycle.invalidate();
          return true;
        }
        if (kind === "async-return") return Promise.resolve(true);
        return false;
      }) as PathQualificationProducer["isQualificationCurrent"];
      expect(await f.lifecycle.prepare(f.selected)).toBeNull();
      await f.lifecycle.whenIdle();
      expect(f.lifecycle.getQualification(f.selected)).toBeNull();
      expect(f.producer.prepare).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["throws", "invalidates", "recurses", "property-throws"] as const)(
    "withdraws ready before returning from a producer review that %s",
    async (kind) => {
      const f = fixture();
      f.producer.isQualificationCurrent = () => true;
      expect(await f.lifecycle.prepare(f.selected)).toBe(f.q);
      if (kind === "property-throws")
        Object.defineProperty(f.producer, "isQualificationCurrent", {
          get: () => {
            throw Error("private");
          },
        });
      else
        f.producer.isQualificationCurrent = () => {
          if (kind === "throws") throw Error("private");
          if (kind === "invalidates") f.lifecycle.invalidate();
          if (kind === "recurses") expect(f.lifecycle.getQualification(f.selected)).toBeNull();
          return true;
        };
      expect(f.lifecycle.getQualification(f.selected)).toBeNull();
      expect(f.lifecycle.getQualification(f.selected)).toBeNull();
      expect(f.producer.prepare).toHaveBeenCalledTimes(1);
    },
  );
  it("does not let an unbranded clone through a producer's original-object check", async () => {
    const f = fixture();
    f.producer.isQualificationCurrent = (q) => q === f.q;
    f.producer.prepare.mockResolvedValue(structuredClone(f.q));
    expect(await f.lifecycle.prepare(f.selected)).toBeNull();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });
  it("checks the current review after real cleanup, not before a pending drain", async () => {
    const f = fixture(),
      release = deferred<void>(),
      check = vi.fn(() => true);
    f.producer.isQualificationCurrent = check;
    f.producer.whenIdle.mockReturnValue(release.promise);
    const pending = f.lifecycle.prepare(f.selected);
    await flush();
    expect(check).not.toHaveBeenCalled();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    check.mockReturnValue(false);
    release.resolve();
    expect(await pending).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.producer.prepare).toHaveBeenCalledTimes(1);
  });

  it("merges the same in-flight loader and current version into the same promise", async () => {
    const f = fixture(),
      pending = deferred<RetainedPathQualification | null>();
    f.producer.prepare.mockReturnValue(pending.promise);
    const first = f.lifecycle.prepare(f.selected),
      second = f.lifecycle.prepare(structuredClone(f.selected));
    expect(second).toBe(first);
    await flush();
    expect(f.producer.prepare).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    pending.resolve(f.q);
    expect(await first).toBe(f.q);
    await f.lifecycle.whenIdle();
  });

  it("does not publish a result before the producer's real nested drain finishes", async () => {
    const f = fixture(),
      drain = deferred<void>();
    f.producer.whenIdle.mockReturnValue(drain.promise);
    const ready = f.lifecycle.prepare(f.selected);
    await flush();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(f.lifecycle.prepare(f.selected)).toBe(ready);
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    drain.resolve();
    expect(await ready).toBe(f.q);
  });

  it("cancels a different loader while keeping the old real work's slot until both barriers finish", async () => {
    const f = fixture(),
      work = deferred<RetainedPathQualification | null>(),
      drain = deferred<void>();
    f.producer.prepare.mockReturnValueOnce(work.promise);
    f.producer.whenIdle.mockReturnValueOnce(drain.promise);
    const old = f.lifecycle.prepare(f.selected);
    await flush();
    const signal = f.producer.prepare.mock.calls[0][1],
      next = loader("replacement");
    expect(await f.lifecycle.prepare(next)).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(await old).toBeNull();
    expect(await f.lifecycle.prepare(next)).toBeNull();
    work.resolve(f.q);
    await flush();
    expect(await f.lifecycle.prepare(next)).toBeNull();
    expect(f.producer.prepare).toHaveBeenCalledTimes(1);
    drain.resolve();
    await f.lifecycle.whenIdle();
    const nextQ = qualification(next);
    f.producer.prepare.mockResolvedValueOnce(nextQ);
    expect(await f.lifecycle.prepare(next)).toBe(nextQ);
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(f.lifecycle.getQualification(next)).toBeNull(); // A mismatched current selection revoked it.
  });

  it("clears first, aborts synchronously, and ignores a late producer completion", async () => {
    const f = fixture(),
      work = deferred<RetainedPathQualification | null>();
    f.producer.prepare.mockImplementationOnce(async (_loader, signal) => {
      signal.addEventListener("abort", () => {
        expect(f.lifecycle.getQualification(f.selected)).toBeNull();
      });
      return work.promise;
    });
    const pending = f.lifecycle.prepare(f.selected);
    await flush();
    f.lifecycle.invalidate();
    expect(await pending).toBeNull();
    work.resolve(f.q);
    await f.lifecycle.whenIdle();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(await f.lifecycle.prepare(f.selected)).toBe(f.q);
  });

  it("does not start a producer if invalidated before its scheduled entry", async () => {
    const f = fixture(),
      pending = f.lifecycle.prepare(f.selected);
    f.lifecycle.invalidate();
    expect(await pending).toBeNull();
    await f.lifecycle.whenIdle();
    expect(f.producer.prepare).not.toHaveBeenCalled();
  });

  it.each(["generation", "rulesVersion", "lost"] as const)(
    "rejects %s changes during prepare",
    async (change) => {
      const f = fixture(),
        work = deferred<RetainedPathQualification | null>();
      f.producer.prepare.mockReturnValue(work.promise);
      const pending = f.lifecycle.prepare(f.selected);
      await flush();
      f.setVersion(
        change === "lost"
          ? null
          : {
              generation: change === "generation" ? 10 : 9,
              rulesVersion: change === "rulesVersion" ? "changed" : "current-controller-version",
            },
      );
      work.resolve(f.q);
      expect(await pending).toBeNull();
      await f.lifecycle.whenIdle();
      expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    },
  );

  it("allows explicit reapplication of an original qualification after a new Gate generation", async () => {
    const f = fixture();
    await f.lifecycle.prepare(f.selected);
    f.setVersion({ generation: 10, rulesVersion: "current-controller-version" });
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(f.producer.prepare).toHaveBeenCalledTimes(1);
    expect(await f.lifecycle.prepare(f.selected)).toBe(f.q);
    expect(f.lifecycle.getQualification(f.selected)).toBe(f.q);
    expect(f.q.inputs.generation).toBe(1);
  });

  it("checks again after an asynchronous drain, not only after the producer result", async () => {
    const f = fixture(),
      drain = deferred<void>();
    f.producer.whenIdle.mockReturnValue(drain.promise);
    const pending = f.lifecycle.prepare(f.selected);
    await flush();
    f.setVersion(null);
    drain.resolve();
    expect(await pending).toBeNull();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });

  it("rejects a version getter that invalidates synchronously without returning an old object", async () => {
    const f = fixture();
    await f.lifecycle.prepare(f.selected);
    f.readVersion.mockImplementationOnce(() => {
      f.lifecycle.invalidate();
      return { generation: 9, rulesVersion: "current-controller-version" };
    });
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });

  it("does not revive preparation after readVersion invalidates synchronously", async () => {
    const f = fixture();
    f.readVersion.mockImplementationOnce(() => {
      f.lifecycle.invalidate();
      return { generation: 9, rulesVersion: "current-controller-version" };
    });
    expect(await f.lifecycle.prepare(f.selected)).toBeNull();
    expect(f.producer.prepare).not.toHaveBeenCalled();
  });

  it("does not restart after an existing getter revokes the explicit prepare during its second version read", async () => {
    const f = fixture();
    await f.lifecycle.prepare(f.selected);
    f.readVersion.mockImplementationOnce(() => ({
      generation: 9,
      rulesVersion: "current-controller-version",
    }));
    f.readVersion.mockImplementationOnce(() => {
      f.lifecycle.invalidate();
      return { generation: 9, rulesVersion: "current-controller-version" };
    });
    expect(await f.lifecycle.prepare(f.selected)).toBeNull();
    await f.lifecycle.whenIdle();
    expect(f.producer.prepare).toHaveBeenCalledOnce();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });

  it("can explicitly prepare a new current generation without rewriting the retained original sample", async () => {
    const f = fixture();
    await f.lifecycle.prepare(f.selected);
    f.setVersion({ generation: 10, rulesVersion: "current-controller-version" });
    expect(await f.lifecycle.prepare(f.selected)).toBe(f.q);
    expect(f.producer.prepare).toHaveBeenCalledTimes(2);
    expect(f.q.inputs.generation).toBe(1);
  });

  it("fails closed on version-reader errors in the getter", async () => {
    const f = fixture();
    await f.lifecycle.prepare(f.selected);
    f.readVersion.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });

  it.each([1000, 1001, Number.NaN, -1])(
    "does not expose an expired or invalid-clock qualification at %s",
    async (now) => {
      const f = fixture();
      await f.lifecycle.prepare(f.selected);
      f.setNow(now);
      expect(f.lifecycle.getQualification(f.selected)).toBeNull();
      f.setNow(100);
      expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    },
  );

  it("does not publish a qualification that expires during cleanup", async () => {
    const f = fixture(),
      drain = deferred<void>();
    f.producer.whenIdle.mockReturnValue(drain.promise);
    const pending = f.lifecycle.prepare(f.selected);
    await flush();
    f.setNow(1000);
    drain.resolve();
    expect(await pending).toBeNull();
  });

  it("does not let mutable producer fields extend a previously accepted lifetime", async () => {
    const f = fixture();
    await f.lifecycle.prepare(f.selected);
    Object.assign(f.q, { expiresAtMono: 2000 });
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });

  it("captures loader input independently while retaining the qualification's actual object", async () => {
    const f = fixture(),
      work = deferred<RetainedPathQualification | null>();
    f.producer.prepare.mockReturnValue(work.promise);
    const pending = f.lifecycle.prepare(f.selected);
    await flush();
    const passed = f.producer.prepare.mock.calls[0][0];
    expect(passed).not.toBe(f.selected);
    expect(Object.isFrozen(passed)).toBe(true);
    Object.assign(f.selected, { selectionId: "changed-while-pending" });
    work.resolve(f.q); // q.loader also changed: it cannot match the captured request.
    expect(await pending).toBeNull();
  });

  it.each(["null", "reject", "wrong loader", "future qualification"] as const)(
    "does not publish a producer %s result",
    async (caseName) => {
      const f = fixture();
      if (caseName === "null") f.producer.prepare.mockResolvedValue(null);
      if (caseName === "reject") f.producer.prepare.mockRejectedValue(new Error("unavailable"));
      if (caseName === "wrong loader") f.producer.prepare.mockResolvedValue(qualification(loader("other")));
      if (caseName === "future qualification") Object.assign(f.q, { qualifiedAtMono: 200 });
      expect(await f.lifecycle.prepare(f.selected)).toBeNull();
      await f.lifecycle.whenIdle();
      expect(f.producer.whenIdle).toHaveBeenCalledOnce();
      expect(f.lifecycle.getQualification(f.selected)).toBeNull();
    },
  );

  it("keeps failed drain permanently closed instead of allocating another producer slot", async () => {
    const f = fixture();
    f.producer.whenIdle.mockRejectedValue(new Error("cleanup failed"));
    expect(await f.lifecycle.prepare(f.selected)).toBeNull();
    await expect(f.lifecycle.whenIdle()).rejects.toThrow("cleanup failed");
    f.producer.whenIdle.mockResolvedValue();
    expect(await f.lifecycle.prepare(f.selected)).toBeNull();
    expect(f.producer.prepare).toHaveBeenCalledOnce();
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });

  it("dispose returns one real drain promise, cancels promptly and never restarts", async () => {
    const f = fixture(),
      work = deferred<RetainedPathQualification | null>(),
      drain = deferred<void>();
    f.producer.prepare.mockReturnValue(work.promise);
    f.producer.whenIdle.mockReturnValue(drain.promise);
    const pending = f.lifecycle.prepare(f.selected);
    await flush();
    const first = f.lifecycle.dispose(),
      second = f.lifecycle.dispose();
    expect(second).toBe(first);
    expect(await pending).toBeNull();
    let disposed = false;
    void first.then(() => {
      disposed = true;
    });
    work.resolve(f.q);
    await flush();
    expect(disposed).toBe(false);
    expect(await f.lifecycle.prepare(f.selected)).toBeNull();
    drain.resolve();
    await first;
    expect(disposed).toBe(true);
    expect(f.lifecycle.getQualification(f.selected)).toBeNull();
  });
});
