import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import type { ClashReadResult } from "./clash-reader";
import type { KnownSelectedLoaderContract } from "./configuration-association";
import { EffectiveConfigSource, type EffectiveConfigSourceSnapshot } from "./effective-config-source";
import { SELECTED_CLIENT_PROFILE, selectedClientDecoder } from "./selected-client-protocol";
import { createSelectedKernelCompatibility, KERNEL_COMPATIBILITY_PROFILE } from "./kernel-compatibility";

export interface SelectedClientConfigOptions {
  /** Explicit main-process selection. No search, environment discovery, renderer input or fallback. */
  resourcesPath: string;
  readController(signal: AbortSignal): Promise<ClashReadResult>;
  onChange?: (snapshot: EffectiveConfigSourceSnapshot) => void;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fail = (): never => {
  throw new Error("SELECTED_CLIENT_UNAVAILABLE");
};
function localPath(value: string): string {
  if (value.length > 4096 || !/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(":")) return fail();
  if ([...value].some((c) => c.charCodeAt(0) < 32) || /[<>"|?*]/.test(value)) return fail();
  const normalized = win32.normalize(value);
  if (normalized.split("\\").some((part) => /[. ]$/.test(part))) return fail();
  return normalized;
}
async function canonical(value: string, directory: boolean): Promise<string> {
  const requested = localPath(value),
    resolved = localPath(await realpath(requested));
  if (requested.toLowerCase() !== resolved.toLowerCase()) return fail();
  const info = await lstat(requested);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) return fail();
  return resolved;
}
async function boundedFile(value: string, max: number, check: () => void): Promise<Buffer> {
  check();
  const file = await open(value, "r");
  let data: Buffer | null = null;
  try {
    const before = await file.stat();
    check();
    if (!before.isFile() || before.size < 1 || before.size > max) return fail();
    data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const value = await file.read(data, offset, data.length - offset, offset);
      check();
      if (!value.bytesRead) return fail();
      offset += value.bytesRead;
    }
    const after = await file.stat();
    check();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      return fail();
    return data;
  } catch {
    data?.fill(0);
    return fail();
  } finally {
    await file.close();
  }
}

/**
 * Version-specific, read-only selected source. Uses Electron's native ASAR filesystem support.
 * Selection retains the known-loader assumption; main.node internals and kernel loaded payload are
 * not attested. This factory issues neither path qualifications nor Gate permits.
 */
export class SelectedClientConfig {
  private snapshot: EffectiveConfigSourceSnapshot = Object.freeze({ state: "checking", generation: 0 });
  private generation = 0;
  private loader: KnownSelectedLoaderContract | null = null;
  private source: EffectiveConfigSource | null = null;
  private decoder: ReturnType<typeof selectedClientDecoder> | null = null;
  private identity: string | null = null;
  private controllerObservation: Pick<
    ClashReadResult,
    "version" | "fingerprint" | "startedAtMono" | "completedAtMono"
  > | null = null;
  private pending: Promise<unknown> | null = null;
  private readonly draining = new Set<Promise<void>>();
  private cancelPending: (() => void) | null = null;
  private disposed = false;
  private notifying = false;
  constructor(private readonly options: SelectedClientConfigOptions) {}

  getSnapshot(): EffectiveConfigSourceSnapshot {
    this.source?.getSnapshot(); // Its expiry callback synchronously withdraws the selection.
    return this.snapshot;
  }
  getSelectedLoader(): KnownSelectedLoaderContract | null {
    this.getSnapshot();
    return this.loader;
  }
  /** Must precede the actual observation round. A read never silently chooses a replacement. */
  select(): Promise<KnownSelectedLoaderContract | null> {
    if (this.disposed || this.pending || this.notifying) return Promise.resolve(null);
    if (this.getSelectedLoader()) return Promise.resolve(this.loader);
    const generation = this.generation;
    const check = () => {
      if (this.disposed || this.generation !== generation) return fail();
    };
    const work = this.artifact(check)
      .then(({ main, path, identity }) => {
        try {
          check();
          this.decoder = selectedClientDecoder(main);
          this.identity = identity;
          const selectedAtMono = performance.now();
          this.loader = Object.freeze({
            source: "main-process-selected-loader-contract",
            selectionId: randomUUID(),
            loaderProfileId: SELECTED_CLIENT_PROFILE.id,
            sourcePathIdentity: hash(path.toLowerCase()),
            decoderIdentity: SELECTED_CLIENT_PROFILE.decoderIdentity,
            qualificationEvidenceIds: Object.freeze([
              hash(
                JSON.stringify({
                  identity,
                  selectedAtMono,
                  profile: SELECTED_CLIENT_PROFILE.id,
                  assumption: "KNOWN_SELECTED_LOADER_USES_SELECTED_SOURCE",
                }),
              ),
            ]),
            selectedAtMono,
          });
          const decoder = this.decoder;
          const source = new EffectiveConfigSource({
            path,
            format: "decoded-yaml",
            decoderIdentity: SELECTED_CLIENT_PROFILE.decoderIdentity,
            decode: decoder.decode,
            readController: async (signal) => {
              const result = await this.options.readController(signal);
              check();
              this.controllerObservation = Object.freeze({
                version: result.version,
                fingerprint: result.fingerprint,
                startedAtMono: result.startedAtMono,
                completedAtMono: result.completedAtMono,
              });
              // The current controller is authoritative for the short version. Do not
              // retain the previous attachment when that live version has changed.
              if (
                this.loader?.kernelCompatibility &&
                result.version !== KERNEL_COMPATIBILITY_PROFILE.controllerVersion
              ) {
                const { kernelCompatibility: _old, ...loader } = this.loader;
                this.loader = Object.freeze(loader);
              }
              return result;
            },
            onChange: (value) => {
              if (this.source !== source || this.generation !== generation || this.disposed) return;
              // A candidate is published only after the outer artifact post-check.
              if (value.state === "unavailable") this.invalidate(value.reason);
            },
          });
          this.source = source;
          this.publish(Object.freeze({ state: "checking", generation }));
          return this.loader;
        } finally {
          main.fill(0);
        }
      })
      .catch(() => {
        if (!this.disposed && generation === this.generation) this.invalidate();
        return null;
      });
    return this.bounded(work, () => null);
  }
  read(): Promise<EffectiveConfigSourceSnapshot> {
    if (this.notifying) return Promise.resolve(this.snapshot);
    if (this.pending) return this.pending.then(() => this.getSnapshot());
    const source = this.source;
    if (this.disposed || !source || !this.loader)
      return Promise.resolve(this.getSnapshot().state === "unavailable" ? this.snapshot : this.closed());
    const generation = this.generation;
    const check = () => {
      if (this.disposed || generation !== this.generation || source !== this.source) return fail();
    };
    const verify = async () => {
      const artifact = await this.artifact(check);
      try {
        check();
        if (artifact.identity !== this.identity) return fail();
        return { identity: artifact.identity, binary: artifact.binary };
      } finally {
        artifact.main.fill(0);
      }
    };
    const work = (async () => {
      await verify();
      check();
      this.controllerObservation = null;
      const value = await source.read();
      check();
      if (value.state !== "candidate") return fail();
      const artifact = await verify();
      check();
      if (value.candidate.expiresAtMono <= performance.now()) return fail();
      const loader = this.loader!;
      const compatibility = createSelectedKernelCompatibility({
        loader,
        candidate: value.candidate,
        binary: artifact.binary,
        artifactIdentity: artifact.identity,
        controller: this.controllerObservation,
        checkedAtMono: performance.now(),
      });
      if (compatibility) this.loader = Object.freeze({ ...loader, kernelCompatibility: compatibility });
      else if (loader.kernelCompatibility) {
        const { kernelCompatibility: _old, ...withoutCompatibility } = loader;
        this.loader = Object.freeze(withoutCompatibility);
      }
      this.publish(Object.freeze({ ...value, generation }));
      return this.snapshot;
    })().catch(() => {
      if (!this.disposed && generation === this.generation) this.invalidate();
      return this.getSnapshot();
    });
    return this.bounded(work, () => this.snapshot, source);
  }
  invalidate(
    reason: Extract<EffectiveConfigSourceSnapshot, { state: "unavailable" }>["reason"] = "SOURCE_UNAVAILABLE",
  ): void {
    const source = this.source,
      decoder = this.decoder,
      cancelPending = this.cancelPending;
    this.generation++;
    this.source = null;
    this.decoder = null;
    this.loader = null;
    this.identity = null;
    this.controllerObservation = null;
    source?.dispose();
    decoder?.dispose();
    this.publish(
      Object.freeze({
        state: "unavailable",
        generation: this.generation,
        reason: this.disposed ? "DISPOSED" : reason,
      }),
    );
    cancelPending?.();
  }
  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.invalidate("DISPOSED");
    }
  }
  /** Waits for actual artifact and nested source I/O, including a source withdrawn by invalidate. */
  whenIdle(): Promise<void> {
    return Promise.allSettled([...this.draining]).then(() => undefined);
  }
  private closed(): EffectiveConfigSourceSnapshot {
    this.invalidate();
    return this.snapshot;
  }
  private bounded<T>(work: Promise<T>, closed: () => T, source?: EffectiveConfigSource): Promise<T> {
    let finished = false;
    const tracked = work.finally(async () => {
      // Capture the original source: invalidate/dispose clears this.source before its I/O unwinds.
      await source?.whenIdle();
      finished = true;
    });
    const cancellation = new Promise<T>((resolve) => {
      this.cancelPending = () => resolve(closed());
    });
    const result = Promise.race([tracked, cancellation]);
    const timer = setTimeout(() => this.invalidate("READ_TIMEOUT"), 10_000);
    timer.unref?.();
    this.pending = result;
    const release = () => {
      if (this.pending === result) {
        this.pending = null;
        this.cancelPending = null;
      }
    };
    void result.finally(() => {
      clearTimeout(timer);
      if (finished) release();
    });
    // Cancellation settles the public call immediately, but a slow filesystem operation retains its
    // single slot until it actually unwinds; repeated select/read cannot create unbounded I/O work.
    const draining = Promise.allSettled([tracked, result]).then(release);
    this.draining.add(draining);
    void draining.then(() => this.draining.delete(draining));
    return result;
  }
  private publish(value: EffectiveConfigSourceSnapshot): void {
    this.snapshot = value;
    const previous = this.notifying;
    this.notifying = true;
    try {
      this.options.onChange?.(value);
    } catch {
      /* A diagnostic subscriber cannot reopen the source. */
    } finally {
      this.notifying = previous;
    }
  }
  private async artifact(check: () => void): Promise<{
    main: Buffer;
    path: string;
    identity: string;
    binary: Readonly<{ sha256: string; pathIdentity: string }> | null;
  }> {
    check();
    const resources = await canonical(this.options.resourcesPath, true);
    check();
    // Electron presents an ASAR as a directory even to lstat. Its fixed internal package and main
    // bytes below, rather than ordinary-fs file classification, bind the supported artifact.
    const archive = await canonical(win32.join(resources, "app.asar"), true);
    check();
    const extra = await canonical(win32.join(resources, "extra"), true);
    check();
    const config = await canonical(win32.join(extra, "config.yaml"), false);
    check();
    // The exact package binds version/name/native entry; no client code is imported or executed.
    const pkg = await boundedFile(win32.join(archive, "package.json"), 4096, check);
    try {
      if (hash(pkg) !== SELECTED_CLIENT_PROFILE.packageSha256) return fail();
    } finally {
      pkg.fill(0);
    }
    const main = await boundedFile(
      win32.join(archive, "src", "main", "main.js"),
      SELECTED_CLIENT_PROFILE.mainBytes,
      check,
    );
    try {
      if (
        main.length !== SELECTED_CLIENT_PROFILE.mainBytes ||
        hash(main) !== SELECTED_CLIENT_PROFILE.mainSha256
      )
        return fail();
      check();
      let binary: Readonly<{ sha256: string; pathIdentity: string }> | null = null;
      try {
        const binaryPath = await canonical(win32.join(extra, KERNEL_COMPATIBILITY_PROFILE.binaryName), false);
        const bytes = await boundedFile(binaryPath, 64 * 1024 * 1024, check);
        try {
          binary = Object.freeze({ sha256: hash(bytes), pathIdentity: hash(binaryPath.toLowerCase()) });
        } finally {
          bytes.fill(0);
        }
      } catch {
        // Optional compatibility may be unknown while the already supported source
        // remains readable. Cancellation still withdraws the whole observation below.
      }
      check();
      return {
        main,
        path: config,
        binary,
        identity: hash(
          JSON.stringify({
            resources: resources.toLowerCase(),
            archive: archive.toLowerCase(),
            config: config.toLowerCase(),
            profile: SELECTED_CLIENT_PROFILE,
            binary,
          }),
        ),
      };
    } catch {
      main.fill(0);
      return fail();
    }
  }
}
