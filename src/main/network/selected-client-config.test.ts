import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveConfigSourceOptions, EffectiveConfigSourceSnapshot } from "./effective-config-source";
import type * as KernelCompatibility from "./kernel-compatibility";

const fixture = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  sources: [] as {
    options: EffectiveConfigSourceOptions;
    read: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    whenIdle: ReturnType<typeof vi.fn>;
    expire: () => void;
  }[],
  open: vi.fn(),
  realpath: vi.fn(),
  lstat: vi.fn(),
  decode: vi.fn(),
  disposeDecoder: vi.fn(),
  makeDecoder: vi.fn(),
}));
const root = "C:\\selected\\resources";
const pkg = Buffer.from("synthetic reviewed package");
const main = Buffer.from("synthetic reviewed source with no executable decoder");
const kernel = Buffer.from("synthetic reviewed kernel bytes");
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
vi.mock("node:fs/promises", () => ({ open: fixture.open, realpath: fixture.realpath, lstat: fixture.lstat }));
vi.mock("./selected-client-protocol", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  return {
    SELECTED_CLIENT_PROFILE: {
      id: "maomaoyun-5.5.6-main-2e66e4eb-v1",
      decoderIdentity: "maomaoyun-5.5.6-aes128cbc-data-v1",
      mainBytes: 52,
      mainSha256: hash("synthetic reviewed source with no executable decoder"),
      packageSha256: hash("synthetic reviewed package"),
    },
    selectedClientDecoder: fixture.makeDecoder,
  };
});
vi.mock("./kernel-compatibility", async (importOriginal) => {
  const actual = await importOriginal<typeof KernelCompatibility>();
  const { createHash } = await import("node:crypto");
  const syntheticHash = createHash("sha256").update("synthetic reviewed kernel bytes").digest("hex");
  return {
    ...actual,
    // A controlled approved-binary boundary for this filesystem fixture. The real
    // constant/hash rejection is independently covered in kernel-compatibility.test.
    createSelectedKernelCompatibility: (
      input: KernelCompatibility.SelectedKernelCompatibilityInput,
    ) =>
      actual.createSelectedKernelCompatibility({
        ...input,
        binary:
          input.binary?.sha256 === syntheticHash
            ? { ...input.binary, sha256: actual.KERNEL_COMPATIBILITY_PROFILE.binarySha256 }
            : input.binary,
      }),
  };
});
vi.mock("./effective-config-source", () => ({
  EffectiveConfigSource: class {
    snapshot: EffectiveConfigSourceSnapshot = { state: "checking", generation: 0 };
    constructor(options: EffectiveConfigSourceOptions) {
      const value = {
        options,
        read: vi.fn(async () => {
          const startedAtMono = performance.now();
          const controller = await options.readController(new AbortController().signal);
          const completedAtMono = performance.now();
          this.snapshot = {
            state: "candidate",
            generation: 0,
            candidate: {
              kind: "local-config-candidate",
              runtimeConfigurationProven: false,
              sourceGeneration: 0,
              sourcePathIdentity: sha(Buffer.from(options.path.toLowerCase())),
              fileFingerprint: "c".repeat(64),
              decoderIdentity: options.decoderIdentity,
              startedAtMono,
              completedAtMono,
              expiresAtMono: completedAtMono + 15000,
              controllerFingerprint: controller.fingerprint,
              controllerStartedAtMono: controller.startedAtMono,
              controllerCompletedAtMono: controller.completedAtMono,
              policy: { fingerprint: "d".repeat(64) },
            } as never,
          };
          options.onChange?.(this.snapshot);
          return this.snapshot;
        }),
        dispose: vi.fn(),
        whenIdle: vi.fn(async () => undefined),
        expire: () => {
          this.snapshot = { state: "unavailable", generation: 1, reason: "EXPIRED" };
          options.onChange?.(this.snapshot);
        },
      };
      fixture.sources.push(value);
      this.read = value.read;
      this.dispose = value.dispose;
      this.whenIdle = value.whenIdle;
    }
    read!: ReturnType<typeof vi.fn>;
    dispose!: ReturnType<typeof vi.fn>;
    whenIdle!: ReturnType<typeof vi.fn>;
    getSnapshot() {
      return this.snapshot;
    }
  },
}));
import { SelectedClientConfig } from "./selected-client-config";

const instances: SelectedClientConfig[] = [];
function setup(resourcesPath = root, onChange = vi.fn()) {
  const readController = vi.fn(async () => {
    const at = performance.now();
    return {
      mode: "rule",
      tun: true,
      mixedPort: 7890,
      version: "424c2ef",
      rules: [],
      fingerprint: "a".repeat(64),
      startedAtMono: at,
      completedAtMono: at,
    };
  });
  const factory = new SelectedClientConfig({ resourcesPath, readController, onChange });
  instances.push(factory);
  return { factory, readController, onChange };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.files.clear();
  fixture.sources.length = 0;
  fixture.files.set(`${root}\\app.asar\\package.json`, Buffer.from(pkg));
  fixture.files.set(`${root}\\app.asar\\src\\main\\main.js`, Buffer.from(main));
  fixture.realpath.mockImplementation(async (v) => v);
  fixture.lstat.mockImplementation(async (v: string) => ({
    isSymbolicLink: () => false,
    isDirectory: () => v === root || v.endsWith("\\extra") || v.endsWith("\\app.asar"),
    isFile: () => v !== root && !v.endsWith("\\extra") && !v.endsWith("\\app.asar"),
  }));
  fixture.open.mockImplementation(async (v: string, flags: string) => {
    expect(flags).toBe("r");
    const data = fixture.files.get(v);
    if (!data) throw Error("private-file-error");
    return {
      stat: async () => ({ isFile: () => true, size: data.length, mtimeMs: 0, ino: 1 }),
      read: async (target: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: data.copy(target, offset, position, position + length),
      }),
      close: vi.fn(async () => undefined),
    };
  });
  fixture.makeDecoder.mockImplementation(() => ({ decode: fixture.decode, dispose: fixture.disposeDecoder }));
});
afterEach(() => {
  instances.splice(0).forEach((value) => value.dispose());
  vi.useRealTimers();
});

describe("SelectedClientConfig current explicit selection", () => {
  const binaryPath = `${root}\\extra\\mihomo-windows-386.exe`;
  it("adds compatibility only after this source/controller round and both actual binary reads", async () => {
    fixture.files.set(binaryPath, Buffer.from(kernel));
    const { factory, readController } = setup();
    const selected = await factory.select();
    expect(selected?.kernelCompatibility).toBeUndefined();
    const value = await factory.read();
    expect(value.state).toBe("candidate");
    if (value.state !== "candidate") throw Error("EXPECTED_CANDIDATE");
    const loader = factory.getSelectedLoader();
    expect(loader?.selectionId).toBe(selected?.selectionId);
    expect(loader?.kernelCompatibility).toMatchObject({
      controllerVersion: "424c2ef",
      controllerFingerprint: value.candidate.controllerFingerprint,
      sourceGeneration: 0,
      fileFingerprint: value.candidate.fileFingerprint,
      controllerStartedAtMono: value.candidate.controllerStartedAtMono,
      controllerCompletedAtMono: value.candidate.controllerCompletedAtMono,
      expiresAtMono: value.candidate.expiresAtMono,
    });
    expect(selected?.kernelCompatibility).toBeUndefined();
    expect(Object.isFrozen(loader)).toBe(true);
    expect(Object.isFrozen(loader?.kernelCompatibility)).toBe(true);
    expect(readController).toHaveBeenCalledOnce();
    expect(fixture.open.mock.calls.filter(([path]) => path === binaryPath)).toHaveLength(3);
    expect(JSON.stringify(loader)).not.toMatch(/C:|synthetic reviewed kernel|private-file-error/);
  });
  it.each(["missing", "unknown", "symlink", "oversized"])(
    "keeps supported source reading when optional kernel compatibility is %s",
    async (state) => {
      if (state !== "missing") fixture.files.set(binaryPath, Buffer.from("unreviewed kernel"));
      if (state === "symlink")
        fixture.realpath.mockImplementation(async (value: string) =>
          value === binaryPath ? "C:\\other\\kernel.exe" : value,
        );
      if (state === "oversized") {
        const original = fixture.open.getMockImplementation()!;
        fixture.open.mockImplementation(async (path: string, flags: string) => {
          const file = await original(path, flags);
          if (path === binaryPath)
            file.stat = async () => ({ isFile: () => true, size: 64 * 1024 * 1024 + 1, mtimeMs: 0, ino: 1 });
          return file;
        });
      }
      const { factory } = setup();
      expect(await factory.select()).not.toBeNull();
      expect((await factory.read()).state).toBe("candidate");
      expect(factory.getSelectedLoader()?.kernelCompatibility).toBeUndefined();
    },
  );
  it.each(["before", "during"])(
    "withdraws source and compatibility when binary bytes change %s source read",
    async (when) => {
      fixture.files.set(binaryPath, Buffer.from(kernel));
      const { factory } = setup();
      await factory.select();
      await factory.read();
      const old = factory.getSelectedLoader();
      expect(old?.kernelCompatibility).toBeDefined();
      if (when === "before") fixture.files.set(binaryPath, Buffer.from("replacement kernel"));
      else {
        const original = fixture.sources[0].read.getMockImplementation()!;
        fixture.sources[0].read.mockImplementation(async () => {
          const value = await original();
          fixture.files.set(binaryPath, Buffer.from("replacement kernel"));
          return value;
        });
      }
      expect((await factory.read()).state).toBe("unavailable");
      expect(factory.getSelectedLoader()).toBeNull();
      // Withdrawal never mutates a record already held by another operation.
      expect(old?.kernelCompatibility).toBeDefined();
      await factory.whenIdle();
      expect(await factory.select()).not.toBeNull();
      expect((await factory.read()).state).toBe("candidate");
      expect(factory.getSelectedLoader()?.kernelCompatibility).toBeUndefined();
    },
  );
  it("withdraws optional compatibility when the actual controller version changes without invalidating readable configuration", async () => {
    fixture.files.set(binaryPath, Buffer.from(kernel));
    const { factory, readController } = setup();
    await factory.select();
    await factory.read();
    const old = factory.getSelectedLoader();
    const original = readController.getMockImplementation()!;
    readController.mockImplementation(async () => ({
      ...(await original()),
      version: "different-version",
      fingerprint: "e".repeat(64),
    }));
    expect((await factory.read()).state).toBe("candidate");
    expect(factory.getSelectedLoader()?.kernelCompatibility).toBeUndefined();
    expect(old?.kernelCompatibility?.controllerVersion).toBe("424c2ef");
  });
  it("does not substitute a prior controller version when this source adapter omitted a current read", async () => {
    fixture.files.set(binaryPath, Buffer.from(kernel));
    const { factory } = setup();
    await factory.select();
    const previous = await factory.read();
    expect(factory.getSelectedLoader()?.kernelCompatibility).toBeDefined();
    fixture.sources[0].read.mockResolvedValue(previous);
    expect((await factory.read()).state).toBe("candidate");
    expect(factory.getSelectedLoader()?.kernelCompatibility).toBeUndefined();
  });
  it("withdraws selection if a formerly missing binary appears during a later read", async () => {
    const { factory } = setup();
    await factory.select();
    await factory.read();
    fixture.files.set(binaryPath, Buffer.from(kernel));
    expect((await factory.read()).state).toBe("unavailable");
    expect(factory.getSelectedLoader()).toBeNull();
  });
  it("does not read or silently select before explicit select", async () => {
    const { factory, readController } = setup();
    expect(factory.getSnapshot().state).toBe("checking");
    expect(factory.getSelectedLoader()).toBeNull();
    expect((await factory.read()).state).toBe("unavailable");
    expect(fixture.open).not.toHaveBeenCalled();
    expect(readController).not.toHaveBeenCalled();
  });
  it("qualifies pinned artifacts then checks both sides of the source read before publication", async () => {
    const { factory, readController, onChange } = setup();
    const loader = await factory.select();
    expect(loader?.sourcePathIdentity).toBe(sha(Buffer.from(`${root}\\extra\\config.yaml`.toLowerCase())));
    expect(loader?.selectedAtMono).toBeLessThanOrEqual(performance.now());
    expect(fixture.sources[0].options.readController).not.toBe(readController);
    expect(readController).not.toHaveBeenCalled();
    expect(fixture.open).toHaveBeenCalledTimes(3);
    const result = await factory.read();
    expect(result.state).toBe("candidate");
    expect(fixture.open).toHaveBeenCalledTimes(9);
    expect(readController).toHaveBeenCalledOnce();
    expect(fixture.sources[0].read).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.filter(([v]) => v.state === "candidate")).toHaveLength(1);
    expect(await factory.select()).toBe(loader);
    expect(JSON.stringify(loader)).not.toContain(root);
  });
  it.each(["package.json", "src\\main\\main.js"])(
    "rejects a changed pinned %s before creating decoder/source",
    async (name) => {
      fixture.files.set(`${root}\\app.asar\\${name}`, Buffer.from("modified installed artifact"));
      const { factory } = setup();
      expect(await factory.select()).toBeNull();
      expect(factory.getSnapshot()).toMatchObject({ state: "unavailable", reason: "SOURCE_UNAVAILABLE" });
      expect(fixture.makeDecoder).not.toHaveBeenCalled();
      expect(fixture.sources).toHaveLength(0);
    },
  );
  it.each([
    "\\\\server\\share",
    "\\\\?\\C:\\selected",
    "C:relative",
    "C:\\selected:stream",
    "C:\\selected\\bad.\\resources",
    "C:\\selected\n\\resources",
  ])("rejects non-local or ambiguous selection %s", async (value) => {
    const { factory } = setup(value);
    expect(await factory.select()).toBeNull();
    expect(fixture.open).not.toHaveBeenCalled();
  });
  it("rejects a resolved junction/path change without reading another archive", async () => {
    fixture.realpath.mockResolvedValue("C:\\other\\resources");
    const { factory } = setup();
    expect(await factory.select()).toBeNull();
    expect(fixture.open).not.toHaveBeenCalled();
  });
  it("rejects a source artifact change before asking the inner reader", async () => {
    const { factory } = setup();
    await factory.select();
    fixture.files.set(`${root}\\app.asar\\package.json`, Buffer.from("changed"));
    expect((await factory.read()).state).toBe("unavailable");
    expect(fixture.sources[0].read).not.toHaveBeenCalled();
    expect(factory.getSelectedLoader()).toBeNull();
    expect(fixture.disposeDecoder).toHaveBeenCalledOnce();
  });
  it("never publishes the inner candidate when the artifact changes during that read", async () => {
    const { factory, onChange } = setup();
    await factory.select();
    const original = fixture.sources[0].read.getMockImplementation()!;
    fixture.sources[0].read.mockImplementation(async () => {
      const value = await original();
      fixture.files.set(`${root}\\app.asar\\package.json`, Buffer.from("changed"));
      return value;
    });
    expect((await factory.read()).state).toBe("unavailable");
    expect(factory.getSelectedLoader()).toBeNull();
    expect(onChange.mock.calls.filter(([v]) => v.state === "candidate")).toHaveLength(0);
  });
  it("joins concurrent reads without additional work", async () => {
    const { factory } = setup();
    await factory.select();
    const [first, second] = await Promise.all([factory.read(), factory.read()]);
    expect(first).toBe(second);
    expect(fixture.sources[0].read).toHaveBeenCalledOnce();
    expect(fixture.open).toHaveBeenCalledTimes(9);
  });
  it("expiry withdraws selection synchronously; it cannot be reused through getSelectedLoader", async () => {
    const { factory } = setup();
    const before = await factory.select();
    await factory.read();
    fixture.sources[0].expire();
    expect(factory.getSelectedLoader()).toBeNull();
    expect(factory.getSnapshot()).toMatchObject({ state: "unavailable", reason: "EXPIRED" });
    expect((await factory.read()).state).toBe("unavailable");
    const after = await factory.select();
    expect(after?.selectionId).not.toBe(before?.selectionId);
  });
  it("dispose settles an in-flight artifact read and rejects late selection, retaining one I/O slot", async () => {
    let resume!: (v: string) => void;
    fixture.realpath.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resume = resolve;
        }),
    );
    const { factory } = setup();
    const pending = factory.select();
    await tick();
    factory.dispose();
    expect(await pending).toBeNull();
    expect(await factory.select()).toBeNull();
    const settled = vi.fn();
    const idle = factory.whenIdle().then(settled);
    await tick();
    expect(settled).not.toHaveBeenCalled();
    resume(root);
    await idle;
    expect(settled).toHaveBeenCalledOnce();
    expect(fixture.makeDecoder).not.toHaveBeenCalled();
    expect(factory.getSnapshot()).toMatchObject({ state: "unavailable", reason: "DISPOSED" });
  });
  it("drains the withdrawn nested source even after its public read has already cancelled", async () => {
    const { factory } = setup();
    await factory.select();
    const inner = fixture.sources[0];
    let finishPublic!: (value: EffectiveConfigSourceSnapshot) => void;
    let finishIo!: () => void;
    inner.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPublic = resolve;
        }),
    );
    const underlyingIo = new Promise<void>((resolve) => {
      finishIo = resolve;
    });
    inner.whenIdle.mockImplementation(() => underlyingIo);
    inner.dispose.mockImplementation(() =>
      finishPublic({ state: "unavailable", generation: 1, reason: "DISPOSED" }),
    );
    const pending = factory.read();
    await tick();
    factory.invalidate();
    expect(await pending).toMatchObject({ state: "unavailable" });
    expect(factory.getSelectedLoader()).toBeNull();
    const settled = vi.fn();
    const idle = factory.whenIdle().then(settled);
    await tick();
    expect(inner.whenIdle).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) expect(await factory.select()).toBeNull();
    expect(fixture.sources).toHaveLength(1);
    finishIo();
    await idle;
    expect(settled).toHaveBeenCalledOnce();
    expect(await factory.select()).not.toBeNull();
    expect(fixture.sources).toHaveLength(2);
  });
  it("invalidate settles a pending inner read immediately and its late candidate cannot revive selection", async () => {
    const { factory, onChange } = setup();
    await factory.select();
    let resume!: (v: EffectiveConfigSourceSnapshot) => void;
    fixture.sources[0].read.mockImplementation(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    const pending = factory.read();
    await tick();
    factory.invalidate();
    expect((await pending).state).toBe("unavailable");
    expect(await factory.select()).toBeNull();
    resume({
      state: "candidate",
      generation: 0,
      candidate: { expiresAtMono: performance.now() + 15000 } as never,
    });
    await tick();
    expect(factory.getSelectedLoader()).toBeNull();
    expect(onChange.mock.calls.filter(([v]) => v.state === "candidate")).toHaveLength(0);
  });
  it("deadline retains the busy slot until blocked filesystem work exits, and hides raw errors", async () => {
    vi.useFakeTimers();
    let resume!: (v: string) => void;
    fixture.realpath.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resume = resolve;
        }),
    );
    const { factory, onChange } = setup();
    const pending = factory.select();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toBeNull();
    expect(factory.getSnapshot()).toMatchObject({ state: "unavailable", reason: "READ_TIMEOUT" });
    for (let i = 0; i < 5; i++) expect(await factory.select()).toBeNull();
    expect(fixture.realpath).toHaveBeenCalledOnce();
    resume(root);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(onChange.mock.calls)).not.toContain("private-file-error");
  });
  it("subscriber failure does not fail selection or bypass the candidate post-check", async () => {
    const { factory } = setup(
      root,
      vi.fn(() => {
        throw Error("subscriber");
      }),
    );
    expect(await factory.select()).not.toBeNull();
    expect((await factory.read()).state).toBe("candidate");
  });
  it.each(["invalidate", "dispose"] as const)(
    "returns unavailable when candidate notification synchronously calls %s",
    async (action) => {
      const onChange = vi.fn((snapshot: EffectiveConfigSourceSnapshot) => {
        if (snapshot.state === "candidate") factory[action]();
      });
      const { factory } = setup(root, onChange);
      await factory.select();
      expect(await factory.read()).toMatchObject({ state: "unavailable" });
      expect(factory.getSelectedLoader()).toBeNull();
      expect(onChange.mock.calls.at(-1)?.[0].state).toBe("unavailable");
    },
  );
  it("source-change notifications cannot synchronously start a replacement selection or recursive read", async () => {
    const reentrant: Promise<unknown>[] = [];
    const onChange = vi.fn((snapshot: EffectiveConfigSourceSnapshot) => {
      if (snapshot.state === "unavailable") reentrant.push(factory.select(), factory.read());
    });
    const { factory } = setup(root, onChange);
    await factory.select();
    await factory.read();
    const reads = fixture.open.mock.calls.length;
    fixture.sources[0].expire();
    expect(await Promise.all(reentrant)).toEqual([null, expect.objectContaining({ state: "unavailable" })]);
    expect(fixture.open).toHaveBeenCalledTimes(reads);
    expect(fixture.makeDecoder).toHaveBeenCalledOnce();
    expect(factory.getSelectedLoader()).toBeNull();
  });
});
