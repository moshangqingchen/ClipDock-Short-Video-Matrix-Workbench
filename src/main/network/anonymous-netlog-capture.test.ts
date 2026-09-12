import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NetLog } from "electron";
import type { AnonymousNetLogCapture } from "./anonymous-netlog-capture";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    unlink: vi.fn(actual.unlink),
    rmdir: vi.fn(actual.rmdir),
    mkdtemp: vi.fn(actual.mkdtemp),
    open: vi.fn(actual.open),
    realpath: vi.fn(actual.realpath),
  };
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let root: string;
let Capture: typeof AnonymousNetLogCapture;
const instances: AnonymousNetLogCapture[] = [];
beforeEach(async () => {
  vi.resetModules(); // Poisoning is process-lifetime in production; each test is a fresh module process.
  vi.mocked(fs.unlink).mockReset();
  vi.mocked(fs.rmdir).mockReset();
  vi.mocked(fs.mkdtemp).mockReset();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.realpath).mockReset();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.unlink).mockImplementation(actual.unlink);
  vi.mocked(fs.rmdir).mockImplementation(actual.rmdir);
  vi.mocked(fs.mkdtemp).mockImplementation(actual.mkdtemp);
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.realpath).mockImplementation(actual.realpath);
  root = await fs.mkdtemp(path.join(tmpdir(), "clipdock-netlog-unit-"));
  Capture = (await import("./anonymous-netlog-capture")).AnonymousNetLogCapture;
});
afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((capture) => capture.dispose()));
  // Only this test's freshly-created absolute root. Fake loggers own no native exporter.
  const exact = path.resolve(root),
    base = path.resolve(tmpdir());
  if (
    path.dirname(exact).toLowerCase() !== base.toLowerCase() ||
    !path.basename(exact).startsWith("clipdock-netlog-unit-")
  )
    throw new Error("Unsafe test cleanup");
  await fs.rm(exact, { recursive: true, force: true });
});
function fixture() {
  let quiet = true,
    logging = false,
    filename = "";
  const contents = JSON.stringify({ constants: {}, events: [{ synthetic: true }] });
  const logger = {
    get currentlyLogging() {
      return logging;
    },
    startLogging: vi.fn(async (file: string) => {
      filename = file;
      logging = true;
      await fs.writeFile(file, contents);
    }),
    stopLogging: vi.fn(async () => {
      logging = false;
    }),
  };
  const options = { isQuiescent: vi.fn(() => quiet), temporaryRoot: root },
    capture = new Capture(options),
    controller = new AbortController();
  instances.push(capture);
  return {
    capture,
    controller,
    logger,
    options,
    contents,
    netLog: logger as unknown as NetLog,
    filename: () => filename,
    quiet: (value: boolean) => {
      quiet = value;
    },
    logging: (value: boolean) => {
      logging = value;
    },
  };
}

describe("anonymous NetLog capture lifetime", () => {
  it("constructs without file I/O or an external window check", async () => {
    const before = vi.mocked(fs.mkdtemp).mock.calls.length,
      f = fixture();
    expect(vi.mocked(fs.mkdtemp).mock.calls.length).toBe(before);
    expect(f.options.isQuiescent).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    await f.capture.whenIdle();
  });

  it("returns only after the bounded original log and exact directory are removed", async () => {
    const f = fixture();
    await f.capture.start(f.netLog, f.controller.signal);
    expect(f.logger.startLogging).toHaveBeenCalledWith(f.filename(), {
      captureMode: "default",
      maxFileSize: 6 * 1024 * 1024,
    });
    expect(path.dirname(path.dirname(f.filename()))).toBe(await fs.realpath(root));
    expect(await f.capture.finish(f.controller.signal)).toBe(f.contents);
    expect(await fs.readdir(root)).toEqual([]);
    await f.capture.whenIdle();
    const dispose = f.capture.dispose();
    expect(f.capture.dispose()).toBe(dispose);
    await dispose;
    expect(f.logger.stopLogging).toHaveBeenCalledOnce();
    const next = fixture();
    await next.capture.start(next.netLog, next.controller.signal);
    await next.capture.dispose();
  });

  it.each(["not quiet", "already logging", "aborted"] as const)(
    "rejects %s before acquiring files or stopping another exporter",
    async (why) => {
      const f = fixture();
      if (why === "not quiet") f.quiet(false);
      if (why === "already logging") f.logging(true);
      if (why === "aborted") f.controller.abort();
      await expect(f.capture.start(f.netLog, f.controller.signal)).rejects.toThrow(
        "NETLOG_CAPTURE_UNAVAILABLE",
      );
      expect(f.logger.startLogging).not.toHaveBeenCalled();
      expect(f.logger.stopLogging).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it("does not accept a fabricated incomplete logger capability", async () => {
    const f = fixture();
    await expect(
      f.capture.start({ currentlyLogging: false } as NetLog, f.controller.signal),
    ).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("keeps the module slot across instances until stop and deletion are done", async () => {
    const f = fixture(),
      other = fixture(),
      stop = deferred<void>();
    await f.capture.start(f.netLog, f.controller.signal);
    f.logger.stopLogging.mockImplementation(async () => {
      await stop.promise;
      f.logging(false);
    });
    const finishing = f.capture.finish(f.controller.signal);
    await flush();
    await expect(other.capture.start(other.netLog, other.controller.signal)).rejects.toThrow();
    stop.resolve();
    await finishing;
    await other.capture.start(other.netLog, other.controller.signal);
  });

  it("does not run duplicate finish readers or restart the same capture", async () => {
    const f = fixture();
    await f.capture.start(f.netLog, f.controller.signal);
    const first = f.capture.finish(f.controller.signal);
    await expect(f.capture.finish(f.controller.signal)).rejects.toThrow();
    expect(await first).toBe(f.contents);
    await expect(f.capture.start(f.netLog, f.controller.signal)).rejects.toThrow();
    expect(f.logger.stopLogging).toHaveBeenCalledOnce();
  });

  it("cleans an early directory creation failure and allows a later independent capture", async () => {
    const f = fixture();
    vi.mocked(fs.mkdtemp).mockRejectedValueOnce(new Error("creation failed"));
    await expect(f.capture.start(f.netLog, f.controller.signal)).rejects.toThrow();
    await f.capture.whenIdle();
    expect(f.logger.stopLogging).not.toHaveBeenCalled();
    const next = fixture();
    await next.capture.start(next.netLog, next.controller.signal);
  });

  it("stops a native exporter even if its start rejected after opening the log", async () => {
    const f = fixture(),
      original = f.logger.startLogging.getMockImplementation()!;
    f.logger.startLogging.mockImplementation(async (file) => {
      await original(file);
      throw new Error("late start error");
    });
    await expect(f.capture.start(f.netLog, f.controller.signal)).rejects.toThrow();
    await f.capture.whenIdle();
    expect(f.logger.stopLogging).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("does not overwrite or stop an external exporter that starts while the temporary directory opens", async () => {
    const f = fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.mkdtemp).mockImplementationOnce(async (prefix, options) => {
      const directory = await actual.mkdtemp(prefix, options);
      f.logging(true);
      return directory;
    });
    await expect(f.capture.start(f.netLog, f.controller.signal)).rejects.toThrow();
    await f.capture.whenIdle();
    expect(f.logger.startLogging).not.toHaveBeenCalled();
    expect(f.logger.stopLogging).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("cleans its new directory if the actual quiet window is lost before native start", async () => {
    const f = fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.mkdtemp).mockImplementationOnce(async (prefix, options) => {
      const directory = await actual.mkdtemp(prefix, options);
      f.quiet(false);
      return directory;
    });
    await expect(f.capture.start(f.netLog, f.controller.signal)).rejects.toThrow();
    await f.capture.whenIdle();
    expect(f.logger.startLogging).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("waits for native start to finish before a competing dispose can stop or release", async () => {
    const f = fixture(),
      entered = deferred<void>(),
      start = deferred<void>(),
      original = f.logger.startLogging.getMockImplementation()!;
    f.logger.startLogging.mockImplementation(async (file) => {
      await original(file);
      entered.resolve();
      await start.promise;
    });
    const opening = f.capture.start(f.netLog, f.controller.signal);
    const failure = expect(opening).rejects.toThrow();
    await entered.promise;
    const dispose = f.capture.dispose();
    await flush();
    expect(f.logger.stopLogging).not.toHaveBeenCalled();
    const other = fixture();
    await expect(other.capture.start(other.netLog, other.controller.signal)).rejects.toThrow();
    start.resolve();
    await failure;
    await dispose;
    expect(f.logger.stopLogging).toHaveBeenCalledOnce();
    await other.capture.start(other.netLog, other.controller.signal);
  });

  it("automatically drains when the start signal is aborted during recording", async () => {
    const f = fixture();
    await f.capture.start(f.netLog, f.controller.signal);
    f.controller.abort();
    await f.capture.whenIdle();
    expect(f.logger.stopLogging).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
    await expect(f.capture.finish(new AbortController().signal)).rejects.toThrow();
  });

  it.each(["start signal", "finish signal", "dispose", "quiet window"] as const)(
    "cannot expose text when %s is revoked while native stop is pending",
    async (why) => {
      const f = fixture(),
        stop = deferred<void>(),
        finishController = new AbortController();
      await f.capture.start(f.netLog, f.controller.signal);
      f.logger.stopLogging.mockImplementation(async () => {
        await stop.promise;
        f.logging(false);
      });
      const finish = f.capture.finish(finishController.signal),
        rejected = expect(finish).rejects.toThrow();
      await flush();
      if (why === "start signal") f.controller.abort();
      if (why === "finish signal") finishController.abort();
      if (why === "dispose") void f.capture.dispose();
      if (why === "quiet window") f.quiet(false);
      stop.resolve();
      await rejected;
      await f.capture.whenIdle();
      expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it.each(["stop rejects", "still logging"] as const)(
    "poisons the process slot on %s without a retry or deleting an active log",
    async (why) => {
      const f = fixture();
      await f.capture.start(f.netLog, f.controller.signal);
      if (why === "stop rejects") f.logger.stopLogging.mockRejectedValue(new Error("stop failure"));
      else f.logger.stopLogging.mockResolvedValue();
      await expect(f.capture.finish(f.controller.signal)).rejects.toThrow();
      await expect(f.capture.whenIdle()).rejects.toThrow();
      await expect(f.capture.dispose()).rejects.toThrow();
      expect(f.logger.stopLogging).toHaveBeenCalledOnce();
      expect(await fs.readFile(f.filename(), "utf8")).toBe(f.contents);
      const other = fixture();
      await expect(other.capture.start(other.netLog, other.controller.signal)).rejects.toThrow();
    },
  );

  it("will not return a parsed string or release the slot before unlink actually finishes", async () => {
    const f = fixture(),
      unlink = deferred<void>(),
      entered = deferred<void>(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    await f.capture.start(f.netLog, f.controller.signal);
    vi.mocked(fs.unlink).mockImplementationOnce(async (file) => {
      entered.resolve();
      await unlink.promise;
      await actual.unlink(file);
    });
    let returned = false;
    const finish = f.capture.finish(f.controller.signal).then((text) => {
      returned = true;
      return text;
    });
    await entered.promise;
    expect(returned).toBe(false);
    const other = fixture();
    await expect(other.capture.start(other.netLog, other.controller.signal)).rejects.toThrow();
    unlink.resolve();
    expect(await finish).toBe(f.contents);
    await other.capture.start(other.netLog, other.controller.signal);
  });

  it.each(["unlink", "rmdir", "directory validation"] as const)(
    "poisons the slot after %s fails and never silently retries cleanup",
    async (why) => {
      const f = fixture();
      await f.capture.start(f.netLog, f.controller.signal);
      if (why === "unlink") vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("locked"));
      if (why === "rmdir") vi.mocked(fs.rmdir).mockRejectedValueOnce(new Error("locked"));
      if (why === "directory validation")
        vi.mocked(fs.realpath).mockResolvedValue(path.join(root, "wrong-directory"));
      await expect(f.capture.finish(f.controller.signal)).rejects.toThrow();
      await expect(f.capture.whenIdle()).rejects.toThrow();
      const calls = vi.mocked(fs.unlink).mock.calls.length;
      await expect(f.capture.dispose()).rejects.toThrow();
      expect(vi.mocked(fs.unlink).mock.calls.length).toBe(calls);
      const other = fixture();
      await expect(other.capture.start(other.netLog, other.controller.signal)).rejects.toThrow();
    },
  );

  it("does not recursively delete unexpected files in its directory", async () => {
    const f = fixture();
    await f.capture.start(f.netLog, f.controller.signal);
    const unexpected = path.join(path.dirname(f.filename()), "unexpected.txt");
    await fs.writeFile(unexpected, "retain");
    await expect(f.capture.finish(f.controller.signal)).rejects.toThrow();
    expect(await fs.readFile(unexpected, "utf8")).toBe("retain");
    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
  });

  it.each([0, 8 * 1024 * 1024 + 1])(
    "rejects a log of %s bytes and still deletes its original file",
    async (size) => {
      const f = fixture();
      await f.capture.start(f.netLog, f.controller.signal);
      await fs.writeFile(f.filename(), Buffer.alloc(size));
      await expect(f.capture.finish(f.controller.signal)).rejects.toThrow();
      await f.capture.whenIdle();
      expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it("keeps whenIdle pending while a native capture is still active", async () => {
    const f = fixture();
    await f.capture.start(f.netLog, f.controller.signal);
    let idle = false;
    void f.capture.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    await f.capture.dispose();
    expect(idle).toBe(true);
  });

  it("still checks the original start signal after cleanup detaches listeners but before finish returns", async () => {
    const f = fixture();
    await f.capture.start(f.netLog, f.controller.signal);
    void f.capture.whenIdle().then(() => f.controller.abort());
    await expect(f.capture.finish(new AbortController().signal)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("waits for a cancelled in-progress file read and actual handle close before deleting or reusing", async () => {
    const f = fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises"),
      read = deferred<void>(),
      entered = deferred<void>();
    let closed = false;
    await f.capture.start(f.netLog, f.controller.signal);
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "read")
            return async (...params: unknown[]) => {
              entered.resolve();
              await read.promise;
              return Reflect.apply(target.read, target, params);
            };
          if (key === "close")
            return async () => {
              await target.close();
              closed = true;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const finish = f.capture.finish(f.controller.signal),
      rejected = expect(finish).rejects.toThrow();
    await entered.promise;
    const dispose = f.capture.dispose();
    await flush();
    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    read.resolve();
    await rejected;
    await dispose;
    expect(closed).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("poisons the slot if the read handle cannot confirm closure", async () => {
    const f = fixture(),
      actual = await vi.importActual<typeof fs>("node:fs/promises");
    await f.capture.start(f.netLog, f.controller.signal);
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          // Close the real test handle, then report an ambiguous production-style failure.
          if (key === "close")
            return async () => {
              await target.close();
              throw new Error("close failed");
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    await expect(f.capture.finish(f.controller.signal)).rejects.toThrow();
    await expect(f.capture.whenIdle()).rejects.toThrow();
    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
    const other = fixture();
    await expect(other.capture.start(other.netLog, other.controller.signal)).rejects.toThrow();
  });
});
