import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionProofRuntime,
  type ProofBundleInput,
  type ProofSourceBundle,
} from "./production-proof-runtime";
import type { NetworkSettings } from "@shared/network";
import type { ProofCollectionRequest, ProofCollectionResult, ProofScopeVersion } from "./proof-issuer";

vi.mock("electron", () => ({ app: {}, session: {} }));
const V = "a".repeat(64);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const runtimes: ProductionProofRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
function fixture(enforcement: "observe" | "strict" = "strict") {
  let settings: NetworkSettings = {
    controllerUrl: "http://127.0.0.1:9790",
    diagnosticProxyPort: 10090,
    selectedClientResourcesPath: "C:\\Client\\resources",
  };
  let version = { generation: 3, rulesVersion: V };
  const bundles: (ProofSourceBundle & { input: ProofBundleInput })[] = [];
  const request = (): ProofCollectionRequest => ({
    ...version,
    requestId: "round-1",
    startedAtMono: 100,
    signal: new AbortController().signal,
    scope: {
      accountId: "account-1",
      platformId: "bilibili",
      contextId: "scope-1",
      catalogVersion: "reviewed",
      catalogReviewed: true,
      targets: [{ host: "api.bilibili.com", protocol: "https:", port: 443, addressFamily: "ipv4" }],
    },
  });
  const result = (): ProofCollectionResult => ({
    kind: "evidence",
    requestId: "round-1",
    batch: {
      sampleId: "round-1",
      ...version,
      contextId: "scope-1",
      catalogVersion: "reviewed",
      observedAtMono: 100,
      targets: [],
    },
  });
  const components = {
    create: vi.fn((input: ProofBundleInput): ProofSourceBundle => {
      const bundle = {
        input,
        inspect: vi.fn(async () => true),
        prepareQualification: vi.fn(async (_signal: AbortSignal) => true),
        resolveAddressFamilies: vi.fn((): readonly ("ipv4" | "ipv6")[] | null => ["ipv4"]),
        collect: vi.fn(async () => result()),
        invalidate: vi.fn(),
        dispose: vi.fn(async () => undefined),
      };
      bundles.push(bundle);
      return bundle;
    }),
    dispose: vi.fn(async () => undefined),
  };
  const onInvalidated = vi.fn();
  const readVersion = vi.fn((): ProofScopeVersion | null => version);
  const runtime = new ProductionProofRuntime({
    enforcement,
    settings: () => settings,
    getSecret: () => null,
    readVersion,
    onInvalidated,
    components,
  });
  runtimes.push(runtime);
  return {
    runtime,
    components,
    bundles,
    onInvalidated,
    readVersion,
    request,
    result,
    settings: () => settings,
    setSettings: (next: NetworkSettings) => {
      settings = next;
    },
    changeVersion: () => {
      version = { ...version, generation: version.generation + 1 };
    },
    start: async () => {
      runtime.start();
      await runtime.refresh();
    },
  };
}

describe("production proof lifecycle", () => {
  it("constructs without file, controller, or diagnostic activity", async () => {
    const f = fixture();
    expect(f.components.create).not.toHaveBeenCalled();
    expect((await f.runtime.collect(f.request())).kind).toBe("unavailable");
    expect(f.components.create).not.toHaveBeenCalled();
  });
  it.each([undefined, null, ""])("does not invent a selected directory for %s", async (path) => {
    const f = fixture();
    f.setSettings({ ...f.settings(), selectedClientResourcesPath: path });
    await f.start();
    expect(await f.runtime.refresh()).toBe(false);
    expect(f.components.create).not.toHaveBeenCalled();
  });
  it("inspects only explicit selection in observe and refuses even a supplied evidence producer", async () => {
    const f = fixture("observe");
    await f.start();
    expect(f.bundles[0].inspect).toHaveBeenCalledTimes(1);
    expect((await f.runtime.collect(f.request())).kind).toBe("unavailable");
    expect(f.bundles[0].collect).not.toHaveBeenCalled();
  });
  it("passes a current strict collection through a stable bundle", async () => {
    const f = fixture();
    await f.start();
    expect(await f.runtime.collect(f.request())).toEqual(f.result());
    expect(f.components.create).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched Gate generation before calling the producer", async () => {
    const f = fixture();
    await f.start();
    const request = f.request();
    f.changeVersion();
    expect((await f.runtime.collect(request)).kind).toBe("unavailable");
    expect(f.bundles[0].collect).not.toHaveBeenCalled();
  });
  it.each(["invalidate", "stop", "version", "settings", "cancel"])(
    "rejects a late result after %s",
    async (kind) => {
      const f = fixture();
      await f.start();
      const pending = deferred<ProofCollectionResult>();
      vi.mocked(f.bundles[0].collect).mockReturnValue(pending.promise);
      const controller = new AbortController(),
        request = { ...f.request(), signal: controller.signal };
      const result = f.runtime.collect(request);
      if (kind === "invalidate") f.runtime.invalidate();
      if (kind === "stop") f.runtime.stop();
      if (kind === "version") f.changeVersion();
      if (kind === "settings") f.setSettings({ ...f.settings(), selectedClientResourcesPath: null });
      if (kind === "cancel") controller.abort();
      pending.resolve(f.result());
      expect((await result).kind).toBe("unavailable");
    },
  );
  it("waits for the old real disposal before constructing any replacement, coalescing changed settings", async () => {
    const f = fixture();
    await f.start();
    const drain = deferred<void>();
    vi.mocked(f.bundles[0].dispose).mockReturnValue(drain.promise);
    f.setSettings({ ...f.settings(), selectedClientResourcesPath: "C:\\Second\\resources" });
    f.runtime.configurationChanged();
    await flush();
    for (let i = 0; i < 8; i++) {
      f.runtime.configurationChanged();
      await f.runtime.refresh();
    }
    f.setSettings({ ...f.settings(), selectedClientResourcesPath: "C:\\Final\\resources" });
    expect(f.components.create).toHaveBeenCalledTimes(1);
    drain.resolve();
    await flush();
    await f.runtime.refresh();
    expect(f.components.create).toHaveBeenCalledTimes(2);
    expect(f.bundles[1].input.settings.selectedClientResourcesPath).toBe("C:\\Final\\resources");
  });
  it("restarting during retirement cannot bypass the drain", async () => {
    const f = fixture();
    await f.start();
    const drain = deferred<void>();
    vi.mocked(f.bundles[0].dispose).mockReturnValue(drain.promise);
    f.runtime.stop();
    f.runtime.start();
    await flush();
    expect(f.components.create).toHaveBeenCalledTimes(1);
    drain.resolve();
    await flush();
    expect(f.components.create).toHaveBeenCalledTimes(2);
  });
  it("does not allow configuration replacement to heal failed cleanup", async () => {
    const f = fixture();
    await f.start();
    vi.mocked(f.bundles[0].dispose).mockRejectedValue(new Error("failed"));
    f.runtime.configurationChanged();
    await flush();
    await f.runtime.refresh();
    expect(f.components.create).toHaveBeenCalledTimes(1);
    expect((await f.runtime.collect(f.request())).kind).toBe("unavailable");
  });
  it("revokes Gate ownership before bundle disposal and ignores dispose callback reentry", async () => {
    const f = fixture();
    await f.start();
    const order: string[] = [];
    f.onInvalidated.mockImplementation(() => {
      order.push("gate");
      f.runtime.invalidate();
    });
    vi.mocked(f.bundles[0].invalidate).mockImplementation(() => {
      order.push("abort");
      f.bundles[0].input.onInvalidated();
    });
    f.bundles[0].input.onInvalidated();
    await flush();
    expect(order).toEqual(["gate", "abort"]);
    expect(f.onInvalidated).toHaveBeenCalledTimes(1);
  });
  it("ignores retired callbacks after a replacement is installed", async () => {
    const f = fixture();
    await f.start();
    const old = f.bundles[0];
    f.runtime.configurationChanged();
    await flush();
    await f.runtime.refresh();
    old.input.onInvalidated();
    expect(f.onInvalidated).not.toHaveBeenCalled();
    expect((await f.runtime.collect(f.request())).kind).toBe("evidence");
  });
  it("does not restore a source returned by a factory that synchronously stopped its owner", async () => {
    const f = fixture();
    const create = f.components.create.getMockImplementation()!;
    f.components.create.mockImplementation((input) => {
      f.runtime.stop();
      return create(input);
    });
    f.runtime.start();
    await flush();
    expect(f.bundles[0].invalidate).toHaveBeenCalledTimes(1);
    expect(f.bundles[0].inspect).not.toHaveBeenCalled();
  });
  it("drains a bundle returned after synchronous disposal before disposing shared pools", async () => {
    const f = fixture(),
      drain = deferred<void>();
    const create = f.components.create.getMockImplementation()!;
    f.components.create.mockImplementation((input) => {
      void f.runtime.dispose();
      const bundle = create(input);
      vi.mocked(bundle.dispose).mockReturnValue(drain.promise);
      return bundle;
    });
    f.runtime.start();
    await flush();
    expect(f.components.dispose).not.toHaveBeenCalled();
    drain.resolve();
    await f.runtime.dispose();
    expect(f.components.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not publish an inspection that completed after a directory change", async () => {
    const f = fixture();
    await f.start();
    const pending = deferred<boolean>();
    vi.mocked(f.bundles[0].inspect).mockReturnValue(pending.promise);
    const result = f.runtime.refresh();
    await flush();
    f.setSettings({ ...f.settings(), selectedClientResourcesPath: "C:\\Changed\\resources" });
    pending.resolve(true);
    expect(await result).toBe(false);
  });
  it("still retires a changed source when its owner notification throws", async () => {
    const f = fixture();
    await f.start();
    f.onInvalidated.mockImplementation(() => {
      throw new Error("owner failure");
    });
    f.setSettings({ ...f.settings(), selectedClientResourcesPath: "C:\\Changed\\resources" });
    expect((await f.runtime.collect(f.request())).kind).toBe("unavailable");
    expect(f.bundles[0].invalidate).toHaveBeenCalledTimes(1);
    await flush();
    expect(f.bundles[0].dispose).toHaveBeenCalledTimes(1);
  });
});

describe("synchronous prepared address-family projection", () => {
  const origin = { protocol: "https:" as const, host: "api.bilibili.com", port: 443 };
  it("never creates a source, reads or prepares implicitly", async () => {
    const f = fixture();
    expect(f.runtime.resolveAddressFamilies(origin)).toBeNull();
    expect(f.components.create).not.toHaveBeenCalled();
    await f.start();
    expect(f.runtime.resolveAddressFamilies(origin)).toEqual(["ipv4"]);
    expect(f.bundles[0].inspect).toHaveBeenCalledOnce();
    expect(f.bundles[0].prepareQualification).not.toHaveBeenCalled();
    expect(f.bundles[0].collect).not.toHaveBeenCalled();
    f.runtime.stop();
    expect(f.runtime.resolveAddressFamilies(origin)).toBeNull();
    expect(f.components.create).toHaveBeenCalledOnce();
  });
  it("observe cannot project even an injected qualified source", async () => {
    const f = fixture("observe");
    await f.start();
    expect(f.runtime.resolveAddressFamilies(origin)).toBeNull();
    expect(f.bundles[0].resolveAddressFamilies).not.toHaveBeenCalled();
  });
  it.each([null, [], ["ipv4", "ipv4"], ["unknown"], ["ipv4", "ipv6", "ipv4"]])(
    "rejects invalid family results %j without guessing",
    async (result) => {
      const f = fixture();
      await f.start();
      vi.mocked(f.bundles[0].resolveAddressFamilies!).mockReturnValue(result as never);
      expect(f.runtime.resolveAddressFamilies(origin)).toBeNull();
    },
  );
  it("returns an immutable copy of both reviewed families", async () => {
    const f = fixture();
    await f.start();
    const values: ("ipv4" | "ipv6")[] = ["ipv4", "ipv6"];
    vi.mocked(f.bundles[0].resolveAddressFamilies!).mockReturnValue(values);
    const projected = f.runtime.resolveAddressFamilies(origin);
    values.pop();
    expect(projected).toEqual(["ipv4", "ipv6"]);
    expect(Object.isFrozen(projected)).toBe(true);
  });
  it.each(["version", "settings", "invalidate", "recursive", "throw"])(
    "rejects synchronous %s changes during projection",
    async (kind) => {
      const f = fixture();
      await f.start();
      vi.mocked(f.bundles[0].resolveAddressFamilies!).mockImplementation(() => {
        if (kind === "version") f.changeVersion();
        if (kind === "settings")
          f.setSettings({ ...f.settings(), selectedClientResourcesPath: "C:\\Changed\\resources" });
        if (kind === "invalidate") f.runtime.invalidate();
        if (kind === "recursive") expect(f.runtime.resolveAddressFamilies(origin)).toBeNull();
        if (kind === "throw") throw Error("unavailable");
        return ["ipv4"];
      });
      expect(f.runtime.resolveAddressFamilies(origin)).toBeNull();
    },
  );
});

describe("explicit runtime qualification preparation", () => {
  it("does not prepare during construction, start, source renewal or normal collect", async () => {
    const f = fixture();
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(f.components.create).not.toHaveBeenCalled();
    await f.start();
    await f.runtime.refresh();
    await f.runtime.collect(f.request());
    expect(f.bundles[0].prepareQualification).not.toHaveBeenCalled();
  });

  it.each(["observe", "stopped", "disposed", "cancelled"])(
    "does not enter preparation when %s",
    async (kind) => {
      const f = fixture(kind === "observe" ? "observe" : "strict");
      await f.start();
      const signal = new AbortController();
      if (kind === "stopped") f.runtime.stop();
      if (kind === "disposed") await f.runtime.dispose();
      if (kind === "cancelled") signal.abort();
      expect(await f.runtime.prepareQualification(signal.signal)).toBe(false);
      expect(f.bundles[0].prepareQualification).not.toHaveBeenCalled();
    },
  );

  it("does not create a source when no explicit resources directory is selected", async () => {
    const f = fixture();
    f.setSettings({ ...f.settings(), selectedClientResourcesPath: null });
    await f.start();
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(f.components.create).not.toHaveBeenCalled();
  });

  it("returns false for a bundle with no preparation provider", async () => {
    const f = fixture();
    await f.start();
    delete f.bundles[0].prepareQualification;
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(f.bundles[0].collect).not.toHaveBeenCalled();
  });

  it("invokes explicit current preparation once without collecting account proof", async () => {
    const f = fixture();
    await f.start();
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(true);
    expect(f.bundles[0].prepareQualification).toHaveBeenCalledTimes(1);
    expect(f.bundles[0].collect).not.toHaveBeenCalled();
    expect(f.components.create).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "throws"])("does not enter a provider with %s Gate version", async (kind) => {
    const f = fixture();
    await f.start();
    if (kind === "unavailable") f.readVersion.mockReturnValue(null);
    else
      f.readVersion.mockImplementation(() => {
        throw new Error("private-version-error");
      });
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(f.bundles[0].prepareQualification).not.toHaveBeenCalled();
  });

  it("converts an unavailable or rejected provider into false without retrying", async () => {
    const f = fixture();
    await f.start();
    const prepare = vi.mocked(f.bundles[0].prepareQualification!);
    prepare.mockResolvedValueOnce(false).mockRejectedValueOnce(Error("private-preparation-error"));
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it.each(["invalidate", "stop", "version", "settings", "cancel", "dispose"])(
    "does not publish a preparation completed after %s",
    async (kind) => {
      const f = fixture();
      await f.start();
      const pending = deferred<boolean>(),
        abort = new AbortController();
      vi.mocked(f.bundles[0].prepareQualification!).mockReturnValue(pending.promise);
      const result = f.runtime.prepareQualification(abort.signal);
      await flush();
      expect(f.bundles[0].prepareQualification).toHaveBeenCalledTimes(1);
      if (kind === "invalidate") f.runtime.invalidate();
      if (kind === "stop") f.runtime.stop();
      if (kind === "version") f.changeVersion();
      if (kind === "settings")
        f.setSettings({ ...f.settings(), selectedClientResourcesPath: "C:\\Changed\\resources" });
      if (kind === "cancel") abort.abort();
      if (kind === "dispose") void f.runtime.dispose();
      pending.resolve(true);
      expect(await result).toBe(false);
    },
  );

  it("rechecks a version getter that synchronously invalidates the completed preparation", async () => {
    const f = fixture();
    await f.start();
    const pending = deferred<boolean>();
    vi.mocked(f.bundles[0].prepareQualification!).mockReturnValue(pending.promise);
    const result = f.runtime.prepareQualification(new AbortController().signal);
    await flush();
    f.readVersion.mockImplementationOnce(() => {
      f.runtime.invalidate();
      return { generation: 3, rulesVersion: V };
    });
    pending.resolve(true);
    expect(await result).toBe(false);
  });

  it("preserves the bundle drain boundary before allowing a new explicit preparation", async () => {
    const f = fixture();
    await f.start();
    const pending = deferred<boolean>(),
      drain = deferred<void>();
    vi.mocked(f.bundles[0].prepareQualification!).mockReturnValue(pending.promise);
    vi.mocked(f.bundles[0].dispose).mockReturnValue(drain.promise);
    const old = f.runtime.prepareQualification(new AbortController().signal);
    await flush();
    f.runtime.stop();
    f.runtime.start();
    pending.resolve(true);
    expect(await old).toBe(false);
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(f.components.create).toHaveBeenCalledTimes(1);
    drain.resolve();
    await flush();
    await f.runtime.refresh();
    expect(f.components.create).toHaveBeenCalledTimes(2);
    expect(f.bundles[1].prepareQualification).not.toHaveBeenCalled();
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(true);
    expect(f.bundles[1].prepareQualification).toHaveBeenCalledTimes(1);
  });

  it("does not replace a bundle to bypass failed preparation cleanup", async () => {
    const f = fixture();
    await f.start();
    vi.mocked(f.bundles[0].dispose).mockRejectedValue(Error("uncertain-native-drain"));
    f.runtime.configurationChanged();
    await flush();
    expect(await f.runtime.prepareQualification(new AbortController().signal)).toBe(false);
    expect(f.components.create).toHaveBeenCalledTimes(1);
    expect(f.bundles[0].prepareQualification).not.toHaveBeenCalled();
  });
});
