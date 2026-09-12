import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nativeImage, type Session } from "electron";
import type { BusinessNetworkLease } from "@main/network/business-access";
import type { LocalMediaUrl } from "@shared/types";
import { normalizeExactOrigin, type ExactOrigin } from "@main/network/operation-catalog";
import { downloadAnonymousMedia, RemoteMediaUnavailableError } from "./remote-media-download";
import { inspectRemoteMedia } from "./remote-media-format";

export type RemoteMediaOrigin = ExactOrigin;
export type RemoteMediaSubject =
  { accountId: string; kind: "avatar" } | { accountId: string; kind: "cover"; workId: string };
export type { LocalMediaUrl } from "@shared/types";
export interface MediaPreview {
  url: LocalMediaUrl | null;
  state: "cached" | "pending" | "waiting-network" | "unreviewed" | "unavailable";
}
export type MediaAuthorization =
  | { state: "allowed"; session: Pick<Session, "fetch">; lease: BusinessNetworkLease }
  | { state: "waiting-network" | "unreviewed" | "unavailable" };
export interface RemoteMediaServiceOptions {
  cacheDir: string;
  /** Main-only: verified media purpose + exact current target/context + original account lease.
   * Unknown media targets return a refusal; do not widen scope or revoke the account to probe them. */
  authorize(subject: RemoteMediaSubject, origin: RemoteMediaOrigin): MediaAuthorization;
  onChanged?(subject: RemoteMediaSubject, preview: MediaPreview): void;
  maxConcurrent?: number;
  maxPerAccount?: number;
  maxEntries?: number;
  maxDownloadBytes?: number;
  maxPixels?: number;
  maxDimension?: number;
  thumbnailDimension?: number;
  maxOutputBytes?: number;
  maxCacheBytes?: number;
  timeoutMs?: number;
}
interface CacheRecord {
  id: string;
  subject: RemoteMediaSubject;
  revision: string;
  sha256: string;
  bytes: number;
  updatedAt: number;
}
interface Entry {
  subject: RemoteMediaSubject;
  version: number;
  state: MediaPreview["state"];
  source: { url: string; origin: RemoteMediaOrigin; revision: string } | null;
  cache: CacheRecord | null;
  touched: number;
}
interface Active {
  abort: AbortController;
  promise: Promise<void>;
  accountId: string;
}
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const UNAVAILABLE: MediaPreview = { url: null, state: "unavailable" };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function subjectKey(input: RemoteMediaSubject): string | null {
  const text = (value: unknown, limit: number) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    ![...value].some((character) => character.charCodeAt(0) < 32);
  if (!input || !text(input.accountId, 128)) return null;
  if (input.kind === "avatar") return JSON.stringify([input.accountId, "avatar"]);
  if (input.kind === "cover" && text(input.workId, 1024))
    return JSON.stringify([input.accountId, "cover", input.workId]);
  return null;
}
function copySubject(subject: RemoteMediaSubject): RemoteMediaSubject {
  return subject.kind === "avatar"
    ? { accountId: subject.accountId, kind: "avatar" }
    : { accountId: subject.accountId, kind: "cover", workId: subject.workId };
}
function positive(value: number | undefined, fallback: number, maximum: number): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number <= 0 || number > maximum)
    throw new Error("INVALID_REMOTE_MEDIA_LIMIT");
  return number;
}

/** Bounded main-process cache. No image URL, arbitrary request headers or Session cross renderer IPC. */
export class RemoteMediaService {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, CacheRecord>();
  private readonly queue = new Set<string>();
  private readonly active = new Map<string, Active>();
  private readonly suspended = new Set<string>();
  private readonly root: string;
  private readonly limits;
  private pumpScheduled = false;
  private disposed = false;
  private cacheHealthy = true;
  private disposal: Promise<void> | null = null;

  constructor(private readonly options: RemoteMediaServiceOptions) {
    this.limits = {
      concurrent: positive(options.maxConcurrent, 2, 4),
      perAccount: positive(options.maxPerAccount, 1, 2),
      entries: positive(options.maxEntries, 256, 1024),
      download: positive(options.maxDownloadBytes, 4 * 1024 * 1024, 8 * 1024 * 1024),
      pixels: positive(options.maxPixels, 4_000_000, 16_000_000),
      dimension: positive(options.maxDimension, 4096, 8192),
      thumbnail: positive(options.thumbnailDimension, 480, 1024),
      output: positive(options.maxOutputBytes, 1024 * 1024, 4 * 1024 * 1024),
      cache: positive(options.maxCacheBytes, 32 * 1024 * 1024, 128 * 1024 * 1024),
      timeout: positive(options.timeoutMs, 10_000, 30_000),
    };
    try {
      if (!path.isAbsolute(options.cacheDir) || /^[\\/]{2}/.test(options.cacheDir)) throw new Error();
      const requested = path.resolve(options.cacheDir);
      // Windows native realpath expands 8.3 aliases; the JS sync implementation may preserve them.
      // Reject reparse directories explicitly instead of mistaking a short-name alias for escape.
      for (let cursor = requested; ; cursor = path.dirname(cursor)) {
        try {
          const stat = fs.lstatSync(cursor);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (path.dirname(cursor) === cursor) break;
      }
      fs.mkdirSync(requested, { recursive: true });
      const actual = fs.realpathSync.native(requested);
      if (/^[\\/]{2}/.test(actual)) throw new Error();
      this.root = actual;
      this.loadCache();
    } catch {
      throw new Error("REMOTE_MEDIA_CACHE_UNAVAILABLE");
    }
  }

  offer(subject: RemoteMediaSubject, input: { sourceUrl: string; sourceRevision: string }): void {
    if (this.disposed) return;
    const key = subjectKey(subject);
    if (!key) return;
    let source: Entry["source"] = null;
    try {
      if (
        typeof input.sourceUrl !== "string" ||
        input.sourceUrl.length > 8192 ||
        typeof input.sourceRevision !== "string" ||
        !input.sourceRevision.length ||
        input.sourceRevision.length > 2048
      )
        throw new Error();
      if (
        [...input.sourceUrl].some(
          (character) =>
            character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
        )
      )
        throw new Error();
      const url = new URL(input.sourceUrl);
      const origin = normalizeExactOrigin({
        protocol: url.protocol as ExactOrigin["protocol"],
        host: url.hostname,
        port: Number(url.port || 443),
      });
      if (!origin || origin.protocol !== "https:" || url.username || url.password) throw new Error();
      url.hash = "";
      source = { url: url.href, origin, revision: digest(JSON.stringify([input.sourceRevision, url.href])) };
    } catch {
      /* Invalid media never becomes a network action. */
    }
    let entry = this.entries.get(key);
    if (
      entry &&
      source &&
      (entry.source?.revision === source.revision || entry.cache?.revision === source.revision)
    )
      return;
    if (!entry) {
      if (this.entries.size >= this.limits.entries) this.evictOldest();
      if (this.entries.size >= this.limits.entries) return;
      entry = {
        subject: copySubject(subject),
        version: 0,
        state: "unavailable",
        source: null,
        cache: null,
        touched: Date.now(),
      };
      this.entries.set(key, entry);
    }
    entry.version++;
    entry.source = source;
    entry.touched = Date.now();
    entry.state = source
      ? this.suspended.has(subject.accountId)
        ? "waiting-network"
        : "pending"
      : "unavailable";
    this.active.get(key)?.abort.abort();
    this.queue.delete(key);
    if (source && !this.suspended.has(subject.accountId)) this.queue.add(key);
    this.changed(entry);
    this.schedulePump();
  }

  preview(subject: RemoteMediaSubject): MediaPreview {
    if (this.disposed) return { ...UNAVAILABLE };
    const key = subjectKey(subject);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry) return { ...UNAVAILABLE };
    return entry.cache
      ? { url: `sv-asset://remote/${entry.cache.id}`, state: "cached" }
      : { url: null, state: entry.state };
  }

  /** Explicit Gate/review-change wake-up. No timer and no download on cache-miss protocol requests. */
  resumeAccount(accountId?: string): void {
    if (this.disposed) return;
    if (accountId === undefined) this.suspended.clear();
    else this.suspended.delete(accountId);
    for (const [key, entry] of this.entries) {
      if ((accountId !== undefined && entry.subject.accountId !== accountId) || !entry.source) continue;
      if (["waiting-network", "unreviewed"].includes(entry.state)) {
        entry.state = "pending";
        this.queue.add(key);
        this.changed(entry);
      }
    }
    this.schedulePump();
  }

  /** Close this account's result authority immediately, preserving its latest source and cache. */
  suspendAccount(accountId: string): void {
    if (this.disposed) return;
    this.suspended.add(accountId);
    for (const [key, entry] of this.entries) {
      if (entry.subject.accountId !== accountId) continue;
      entry.version++;
      this.queue.delete(key);
      this.active.get(key)?.abort.abort();
      if (entry.source) entry.state = "waiting-network";
      this.changed(entry);
    }
  }

  /** Retire source/result authority synchronously; returned promise waits for active jobs to settle. */
  forgetAccount(accountId: string): Promise<void> {
    this.suspended.delete(accountId);
    const waiting: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.subject.accountId !== accountId) continue;
      entry.version++;
      entry.source = null;
      this.entries.delete(key);
      this.queue.delete(key);
      const active = this.active.get(key);
      if (active) {
        active.abort.abort();
        waiting.push(active.promise);
      }
      this.removeCached(entry);
      this.changed(entry);
    }
    let failed = false;
    try {
      this.saveManifest();
    } catch {
      failed = true;
    }
    return Promise.allSettled(waiting).then(() => {
      if (failed) throw new Error("REMOTE_MEDIA_CACHE_UNAVAILABLE");
    });
  }

  async responseFor(cacheId: string): Promise<Response> {
    const record = !this.disposed && ID.test(cacheId) ? this.cache.get(cacheId) : undefined;
    if (!record) return new Response(null, { status: 404 });
    try {
      const file = this.safeFile(`${cacheId}.png`);
      const actual = await fs.promises.realpath(file);
      if (actual.toLowerCase() !== file.toLowerCase()) throw new Error();
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size !== record.bytes || stat.size > this.limits.output) throw new Error();
      const bytes = await fs.promises.readFile(file);
      if (this.disposed || this.cache.get(cacheId) !== record || bytes.length !== record.bytes)
        throw new Error();
      const image = inspectRemoteMedia(bytes, this.limits.thumbnail ** 2, this.limits.thumbnail);
      if (!image || image.mime !== "image/png" || digest(bytes) !== record.sha256) throw new Error();
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "image/png",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.queue.clear();
    for (const entry of this.entries.values()) {
      entry.version++;
      entry.source = null;
    }
    for (const task of this.active.values()) task.abort.abort();
    this.disposal = Promise.allSettled([...this.active.values()].map((task) => task.promise)).then(
      () => undefined,
    );
    return this.disposal;
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.disposed) return;
    for (const key of this.queue) {
      if (this.active.size >= this.limits.concurrent) break;
      const entry = this.entries.get(key);
      if (!entry?.source) {
        this.queue.delete(key);
        continue;
      }
      if (this.suspended.has(entry.subject.accountId)) {
        this.queue.delete(key);
        continue;
      }
      if (
        this.active.has(key) ||
        [...this.active.values()].filter((task) => task.accountId === entry.subject.accountId).length >=
          this.limits.perAccount
      )
        continue;
      this.queue.delete(key);
      const abort = new AbortController();
      // Commit ownership before authorize/onChanged can call back into this service.
      const active: Active = { abort, promise: Promise.resolve(), accountId: entry.subject.accountId };
      this.active.set(key, active);
      const version = entry.version;
      active.promise = Promise.resolve()
        .then(() => this.run(key, entry, version, abort))
        .finally(() => {
          if (this.active.get(key) === active) this.active.delete(key);
          this.schedulePump();
        });
      void active.promise.catch(() => undefined);
    }
  }

  private async run(key: string, entry: Entry, version: number, abort: AbortController): Promise<void> {
    const source = entry.source;
    let grant: Extract<MediaAuthorization, { state: "allowed" }> | null = null;
    let temporary: string | null = null;
    let final: string | null = null;
    const timer = setTimeout(() => abort.abort(), this.limits.timeout);
    const current = () =>
      !this.disposed && !abort.signal.aborted && this.entries.get(key) === entry && entry.version === version;
    try {
      if (!source || !current() || !this.cacheHealthy) throw new RemoteMediaUnavailableError();
      const authorization = this.options.authorize(copySubject(entry.subject), { ...source.origin });
      if (authorization.state !== "allowed") {
        if (current()) {
          entry.state = ["waiting-network", "unreviewed", "unavailable"].includes(authorization.state)
            ? authorization.state
            : "unavailable";
          this.changed(entry);
        }
        return;
      }
      grant = authorization;
      const signal = AbortSignal.any([abort.signal, grant.lease.signal]);
      const assertCurrent = () => {
        if (!current() || signal.aborted || !grant!.lease.isCurrent())
          throw new RemoteMediaUnavailableError();
      };
      assertCurrent();
      const downloaded = await downloadAnonymousMedia({
        session: grant.session,
        sourceUrl: source.url,
        signal,
        maxBytes: this.limits.download,
        assertCurrent,
      });
      assertCurrent();
      const dimensions = inspectRemoteMedia(downloaded.bytes, this.limits.pixels, this.limits.dimension);
      if (!dimensions || dimensions.mime !== downloaded.mime) throw new RemoteMediaUnavailableError();
      const decoded = nativeImage.createFromBuffer(downloaded.bytes);
      if (decoded.isEmpty()) throw new RemoteMediaUnavailableError();
      const actual = decoded.getSize();
      if (actual.width !== dimensions.width || actual.height !== dimensions.height)
        throw new RemoteMediaUnavailableError();
      const ratio = Math.min(1, this.limits.thumbnail / Math.max(actual.width, actual.height));
      const png = decoded
        .resize({
          width: Math.max(1, Math.round(actual.width * ratio)),
          height: Math.max(1, Math.round(actual.height * ratio)),
          quality: "good",
        })
        .toPNG();
      const converted = inspectRemoteMedia(png, this.limits.thumbnail ** 2, this.limits.thumbnail);
      if (!png.length || png.length > this.limits.output || !converted || converted.mime !== "image/png")
        throw new RemoteMediaUnavailableError();
      assertCurrent();
      if (png.length > this.limits.cache) throw new RemoteMediaUnavailableError();
      const id = randomUUID();
      temporary = this.safeFile(`${id}.tmp`);
      await fs.promises.writeFile(temporary, png, { flag: "wx", mode: 0o600 });
      assertCurrent();
      final = this.safeFile(`${id}.png`);
      await fs.promises.rename(temporary, final);
      temporary = null;
      assertCurrent();
      this.makeCacheRoom(png.length, key);
      assertCurrent();
      const oldCache = entry.cache;
      const record: CacheRecord = {
        id,
        subject: copySubject(entry.subject),
        revision: source.revision,
        sha256: digest(png),
        bytes: png.length,
        updatedAt: Date.now(),
      };
      entry.cache = record;
      this.cache.set(id, record);
      if (oldCache) this.cache.delete(oldCache.id);
      try {
        this.saveManifest();
      } catch {
        entry.cache = oldCache;
        this.cache.delete(id);
        if (oldCache) this.cache.set(oldCache.id, oldCache);
        throw new RemoteMediaUnavailableError();
      }
      final = null;
      if (oldCache) this.unlink(`${oldCache.id}.png`);
      entry.state = "cached";
      entry.source = null;
      this.changed(entry);
    } catch {
      if (this.entries.get(key) === entry && entry.version === version && !this.disposed) {
        entry.state = grant && !this.leaseCurrent(grant.lease) ? "waiting-network" : "unavailable";
        this.changed(entry);
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
      try {
        grant?.lease.release();
      } catch {
        /* Never change another job's completion. */
      }
      if (temporary) this.unlink(path.basename(temporary));
      if (final) this.unlink(path.basename(final));
    }
  }

  private leaseCurrent(lease: BusinessNetworkLease): boolean {
    try {
      return !lease.signal.aborted && lease.isCurrent();
    } catch {
      return false;
    }
  }
  private changed(entry: Entry): void {
    if (this.disposed) return;
    try {
      this.options.onChanged?.(copySubject(entry.subject), this.preview(entry.subject));
    } catch {
      /* UI observers cannot affect download/lease authority. */
    }
  }
  private safeFile(name: string): string {
    if (
      path.basename(name) !== name ||
      name === "." ||
      name === ".." ||
      fs.realpathSync.native(this.root).toLowerCase() !== this.root.toLowerCase()
    )
      throw new Error("REMOTE_MEDIA_CACHE_UNAVAILABLE");
    return path.join(this.root, name);
  }
  private unlink(name: string): void {
    try {
      fs.unlinkSync(this.safeFile(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.cacheHealthy = false;
    }
  }
  private removeCached(entry: Entry): void {
    if (!entry.cache) return;
    this.cache.delete(entry.cache.id);
    this.unlink(`${entry.cache.id}.png`);
    entry.cache = null;
  }
  private evictOldest(): void {
    const oldest = [...this.entries.entries()]
      .filter(([key]) => !this.active.has(key))
      .sort(([, a], [, b]) => a.touched - b.touched)[0];
    if (!oldest) return;
    this.entries.delete(oldest[0]);
    this.queue.delete(oldest[0]);
    this.removeCached(oldest[1]);
    try {
      this.saveManifest();
    } catch {
      /* Any later reload validates each existing file again. */
    }
    this.changed(oldest[1]);
  }
  private makeCacheRoom(bytes: number, except: string): void {
    const total = () => [...this.cache.values()].reduce((sum, record) => sum + record.bytes, 0);
    for (const [, entry] of [...this.entries.entries()]
      .filter(([key, entry]) => key !== except && entry.cache)
      .sort(([, a], [, b]) => a.touched - b.touched)) {
      if (total() + bytes <= this.limits.cache) break;
      this.removeCached(entry);
      this.changed(entry);
    }
    const own = this.entries.get(except);
    if (total() + bytes > this.limits.cache && own) this.removeCached(own);
    if (total() + bytes > this.limits.cache) throw new RemoteMediaUnavailableError();
  }
  private saveManifest(): void {
    if (!this.cacheHealthy) throw new Error("REMOTE_MEDIA_CACHE_UNAVAILABLE");
    const data = JSON.stringify({ version: 1, records: [...this.cache.values()] });
    const temporary = `${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(this.safeFile(temporary), data, { mode: 0o600, flag: "wx" });
      fs.renameSync(this.safeFile(temporary), this.safeFile("manifest.json"));
    } catch {
      this.cacheHealthy = false;
      this.unlink(temporary);
      throw new Error("REMOTE_MEDIA_CACHE_UNAVAILABLE");
    }
  }
  private loadCache(): void {
    const manifest = this.safeFile("manifest.json");
    try {
      if (
        fs.statSync(manifest).size > 2 * 1024 * 1024 ||
        fs.realpathSync.native(manifest).toLowerCase() !== manifest.toLowerCase()
      )
        throw new Error();
      const stored: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const records =
        (stored as { version?: unknown; records?: unknown }).version === 1
          ? (stored as { records?: unknown }).records
          : null;
      if (!Array.isArray(records)) throw new Error();
      let total = 0;
      for (const raw of records.slice(0, this.limits.entries)) {
        const record = raw as CacheRecord;
        const key = subjectKey(record.subject);
        if (
          !key ||
          !ID.test(record.id) ||
          !HASH.test(record.revision) ||
          !HASH.test(record.sha256) ||
          !Number.isInteger(record.bytes) ||
          record.bytes <= 0 ||
          record.bytes > this.limits.output ||
          !Number.isFinite(record.updatedAt) ||
          this.entries.has(key) ||
          this.cache.has(record.id)
        )
          continue;
        const file = this.safeFile(`${record.id}.png`);
        const stat = fs.statSync(file);
        if (
          !stat.isFile() ||
          stat.size !== record.bytes ||
          fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase() ||
          total + record.bytes > this.limits.cache
        )
          continue;
        const bytes = fs.readFileSync(file);
        const image = inspectRemoteMedia(bytes, this.limits.thumbnail ** 2, this.limits.thumbnail);
        if (!image || image.mime !== "image/png" || digest(bytes) !== record.sha256) continue;
        total += record.bytes;
        const safe: CacheRecord = {
          id: record.id,
          subject: copySubject(record.subject),
          revision: record.revision,
          sha256: record.sha256,
          bytes: record.bytes,
          updatedAt: record.updatedAt,
        };
        this.cache.set(safe.id, safe);
        this.entries.set(key, {
          subject: safe.subject,
          version: 0,
          state: "cached",
          source: null,
          cache: safe,
          touched: safe.updatedAt,
        });
      }
    } catch {
      /* Missing/corrupt/stale manifests do not provide authority or trigger a fetch. */
    }
    for (const file of fs.readdirSync(this.root)) {
      if (
        (ID.test(file.slice(0, -4)) &&
          (file.endsWith(".tmp") || (file.endsWith(".png") && !this.cache.has(file.slice(0, -4))))) ||
        file === "manifest.tmp"
      )
        this.unlink(file);
    }
    this.saveManifest();
  }
}
