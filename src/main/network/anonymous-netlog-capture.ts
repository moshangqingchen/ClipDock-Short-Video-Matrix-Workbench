import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NetLog } from "electron";

const MAX_BYTES = 8 * 1024 * 1024;
const PREFIX = "clipdock-proof-netlog-";
let activeCapture: object | null = null;
const unavailable = () => new Error("NETLOG_CAPTURE_UNAVAILABLE");
const cleanupUnavailable = () => new Error("NETLOG_CLEANUP_UNAVAILABLE");
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The caller must hold a real application-wide quiet window and abort when it is revoked.
 * NetLog is process-wide: this does not infer privacy from a Session or a caller boolean.
 * Only the actual private factory's NetLog capability may be supplied; no logger is created here.
 * One capture owns the module-wide slot until native stop AND deletion succeed. Failed cleanup
 * poisons that slot until process exit; constructing another instance does not recover it.
 */
export class AnonymousNetLogCapture {
  private readonly ownership = Object.freeze({});
  private root: string | null = null;
  private directory: string | null = null;
  private directoryIdentity: { dev: number; ino: number } | null = null;
  private filename: string | null = null;
  private logger: NetLog | null = null;
  private opening: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private reading: Promise<string> | null = null;
  private finishing: Promise<string> | null = null;
  private cleanup: Promise<void> | null = null;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;
  private rejectIdle: ((error: unknown) => void) | null = null;
  private startAttempted = false;
  private readCloseFailed = false;
  private revoked = false;
  private closed = false;
  private readonly signals = new Map<AbortSignal, () => void>();

  constructor(private readonly options: { isQuiescent(): boolean; temporaryRoot?: string }) {}

  start(logger: NetLog, signal: AbortSignal): Promise<void> {
    try {
      if (
        this.opening ||
        this.closed ||
        activeCapture ||
        !logger ||
        typeof logger.startLogging !== "function" ||
        typeof logger.stopLogging !== "function" ||
        logger.currentlyLogging !== false
      )
        throw unavailable();
      this.guard(signal);
      // The external window check can call application code; recheck before taking ownership.
      if (this.closed || activeCapture) throw unavailable();
    } catch {
      return Promise.reject(unavailable());
    }
    activeCapture = this.ownership;
    this.logger = logger;
    this.idle = new Promise<void>((resolve, reject) => {
      this.resolveIdle = resolve;
      this.rejectIdle = reject;
    });
    void this.idle.catch(() => undefined);
    this.watch(signal);
    this.opening = Promise.resolve()
      .then(() => this.openCapture(logger, signal))
      .catch(() => {
        this.revoked = true;
        void this.clean().catch(() => undefined);
        throw unavailable();
      });
    return this.opening;
  }

  private async openCapture(logger: NetLog, signal: AbortSignal): Promise<void> {
    this.guard(signal);
    this.root = await realpath(path.resolve(this.options.temporaryRoot ?? tmpdir()));
    this.guard(signal);
    this.directory = await mkdtemp(path.join(this.root, PREFIX));
    const exact = path.resolve(this.directory);
    if (!samePath(path.dirname(exact), this.root) || !path.basename(exact).startsWith(PREFIX))
      throw unavailable();
    const info = await lstat(exact);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    this.directoryIdentity = { dev: info.dev, ino: info.ino };
    await this.verifyDirectory();
    this.guard(signal);
    if (logger.currentlyLogging !== false) throw unavailable();
    this.filename = path.join(exact, "anonymous.json");
    // A rejected start can still have opened the native exporter: always attempt its one stop.
    this.startAttempted = true;
    await logger.startLogging(this.filename, { captureMode: "default", maxFileSize: 6 * 1024 * 1024 });
    this.guard(signal);
  }

  finish(signal: AbortSignal): Promise<string> {
    if (!this.opening || this.closed || this.finishing) return Promise.reject(unavailable());
    this.watch(signal);
    this.finishing = Promise.resolve().then(async () => {
      let text: string;
      try {
        await this.opening;
        this.guard(signal);
        await this.stop();
        this.guard(signal);
        this.reading = Promise.resolve().then(() => this.readLog(signal));
        text = await this.reading;
      } finally {
        // Do not expose raw contents until the original file has actually been deleted.
        await this.clean();
      }
      this.guard(signal);
      return text;
    });
    return this.finishing;
  }

  private async readLog(signal: AbortSignal): Promise<string> {
    await this.verifyDirectory();
    this.guard(signal);
    if (!this.filename) throw unavailable();
    const before = await lstat(this.filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_BYTES)
      throw unavailable();
    this.guard(signal);
    const handle = await open(this.filename, "r");
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      )
        throw unavailable();
      // Bounded even if an unexpected writer grows the file after native stop.
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        this.guard(signal);
        const read = await handle.read(buffer, length, buffer.length - length, null);
        this.guard(signal);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      this.guard(signal);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw unavailable();
      return buffer.subarray(0, length).toString("utf8");
    } finally {
      try {
        await handle.close();
      } catch {
        this.readCloseFailed = true;
      }
    }
  }

  private watch(signal: AbortSignal): void {
    if (this.signals.has(signal)) return;
    const abort = () => {
      void this.dispose().catch(() => undefined);
    };
    this.signals.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  private guard(signal: AbortSignal): void {
    if (this.revoked || signal.aborted || !this.options.isQuiescent() || this.revoked || signal.aborted)
      throw unavailable();
    for (const watched of this.signals.keys()) if (watched.aborted) throw unavailable();
  }
  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(async () => {
      if (!this.startAttempted || !this.logger) return;
      try {
        await this.logger.stopLogging();
        if (this.logger.currentlyLogging !== false) throw unavailable();
      } catch {
        throw unavailable();
      }
    });
    return this.stopping;
  }
  private async verifyDirectory(): Promise<void> {
    if (!this.root || !this.directory || !this.directoryIdentity) throw cleanupUnavailable();
    const exact = path.resolve(this.directory);
    if (!samePath(path.dirname(exact), this.root) || !path.basename(exact).startsWith(PREFIX))
      throw cleanupUnavailable();
    const resolved = await realpath(exact),
      info = await lstat(exact);
    if (
      !samePath(resolved, exact) ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== this.directoryIdentity.dev ||
      info.ino !== this.directoryIdentity.ino
    )
      throw cleanupUnavailable();
  }
  private clean(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.cleanup = Promise.resolve().then(async () => {
      try {
        await this.opening?.catch(() => undefined);
        await this.stop();
        await this.reading?.catch(() => undefined); // File handles must close before Windows deletion.
        if (this.readCloseFailed) throw cleanupUnavailable();
        if (this.directory) {
          await this.verifyDirectory();
          const names = await readdir(this.directory);
          if (names.some((name) => name !== "anonymous.json")) throw cleanupUnavailable();
          if (names.includes("anonymous.json")) {
            const exactFile = path.join(this.directory, "anonymous.json"),
              info = await lstat(exactFile);
            if (!info.isFile() || info.isSymbolicLink()) throw cleanupUnavailable();
            await unlink(exactFile);
          }
          // Only the exact newly-created empty directory. Never recursively traverse unknown files.
          await this.verifyDirectory();
          await rmdir(this.directory);
        }
        if (activeCapture === this.ownership) activeCapture = null;
        this.resolveIdle?.();
      } catch {
        const error = cleanupUnavailable();
        this.rejectIdle?.(error);
        throw error;
      } finally {
        for (const [signal, listener] of this.signals) signal.removeEventListener("abort", listener);
        // Retain the small signal set for finish's final output guard. A whenIdle callback can
        // revoke the original start signal after listener teardown and before finish returns.
      }
    });
    return this.cleanup;
  }

  /** Cancels output immediately but drains native start/stop and any open file before resolving. */
  dispose(): Promise<void> {
    this.revoked = true;
    return this.clean();
  }
  /** Includes the entire active capture; settles only after cleanup, and reports a poisoned slot. */
  whenIdle(): Promise<void> {
    return this.idle;
  }
}
