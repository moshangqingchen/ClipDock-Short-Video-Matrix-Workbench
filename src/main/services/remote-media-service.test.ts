import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import type { BusinessNetworkLease } from "@main/network/business-access";
import {
  RemoteMediaService,
  type MediaAuthorization,
  type RemoteMediaServiceOptions,
  type RemoteMediaSubject,
} from "./remote-media-service";
import { inspectRemoteMedia } from "./remote-media-format";

const imageMock = vi.hoisted(() => ({ createFromBuffer: vi.fn() }));
vi.mock("electron", () => ({
  nativeImage: imageMock,
  get session() {
    throw new Error("default Session must not be used");
  },
}));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const AVATAR = { accountId: "account-a", kind: "avatar" } as const;
const IMAGE_URL = "https://media.example.test:8443/private/image.png?signature=synthetic-secret";
const pngResponse = (bytes = PNG) =>
  new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function tick() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

describe("RemoteMediaService controlled cache", () => {
  let directory: string;
  const services: RemoteMediaService[] = [];
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "clipdock-remote-media-test-"));
    imageMock.createFromBuffer.mockReset().mockImplementation((bytes: Buffer) => {
      const shape = inspectRemoteMedia(bytes, 16_000_000, 8192)!;
      return {
        isEmpty: () => false,
        getSize: () => ({ width: shape.width, height: shape.height }),
        resize: vi.fn(() => ({ toPNG: () => Buffer.from(PNG) })),
      };
    });
  });
  afterEach(async () => {
    for (const service of services.splice(0)) await service.dispose();
    const resolved = path.resolve(directory);
    expect(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(resolved).startsWith("clipdock-remote-media-test-")).toBe(true);
    fs.rmSync(resolved, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function fixture(options: Partial<RemoteMediaServiceOptions> = {}) {
    const fetch = vi.fn<Session["fetch"]>().mockImplementation(async () => pngResponse());
    const grants: Array<{ controller: AbortController; lease: BusinessNetworkLease }> = [];
    const authorize = vi.fn((_subject: RemoteMediaSubject): MediaAuthorization => {
      const controller = new AbortController();
      let released = false;
      const lease = {
        signal: controller.signal,
        isCurrent: () => !released && !controller.signal.aborted,
        release: vi.fn(() => {
          released = true;
        }),
      };
      grants.push({ controller, lease });
      return { state: "allowed", session: { fetch }, lease };
    });
    const changed = vi.fn();
    const service = new RemoteMediaService({
      cacheDir: path.join(directory, "cache"),
      authorize,
      onChanged: changed,
      ...options,
    });
    services.push(service);
    return { service, fetch, grants, authorize, changed };
  }
  const offer = (
    service: RemoteMediaService,
    subject: RemoteMediaSubject = AVATAR,
    revision = "revision-one",
    sourceUrl = IMAGE_URL,
  ) => service.offer(subject, { sourceUrl, sourceRevision: revision });
  const cached = (service: RemoteMediaService, subject: RemoteMediaSubject = AVATAR) =>
    vi.waitFor(() => expect(service.preview(subject).state).toBe("cached"));

  it("fetches in the granted original Session with fixed anonymous options and returns only local media", async () => {
    const f = fixture();
    offer(f.service);
    await cached(f.service);
    expect(f.authorize).toHaveBeenCalledExactlyOnceWith(AVATAR, {
      protocol: "https:",
      host: "media.example.test",
      port: 8443,
    });
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0];
    expect(url).toBe(IMAGE_URL);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "image/png,image/jpeg,image/webp" },
    });
    expect(Object.keys(init!)).toEqual([
      "method",
      "credentials",
      "cache",
      "redirect",
      "referrerPolicy",
      "headers",
      "signal",
    ]);
    expect(f.grants[0].lease.release).toHaveBeenCalledOnce();
    const preview = f.service.preview(AVATAR);
    expect(preview.url).toMatch(/^sv-asset:\/\/remote\/[a-f0-9-]{36}$/);
    const id = preview.url!.split("/").at(-1)!;
    const testFile = path.join(fs.realpathSync.native(path.join(directory, "cache")), id + ".png");
    expect((await fs.promises.realpath(testFile)).toLowerCase()).toBe(testFile.toLowerCase());
    expect(inspectRemoteMedia(fs.readFileSync(testFile), 480 ** 2, 480)?.mime).toBe("image/png");
    const response = await f.service.responseFor(id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    const persisted = fs.readFileSync(path.join(directory, "cache", "manifest.json"), "utf8");
    for (const text of [persisted, JSON.stringify(f.changed.mock.calls), JSON.stringify(preview)]) {
      expect(text).not.toContain("signature");
      expect(text).not.toContain("synthetic-secret");
      expect(text).not.toContain("media.example.test");
    }
    expect(JSON.parse(persisted).records[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["unreviewed", "waiting-network", "unavailable"] as const)(
    "keeps %s media as a placeholder without touching transport or account authority",
    async (state) => {
      const authorize = vi.fn(() => ({ state }));
      const f = fixture({ authorize });
      offer(f.service);
      await vi.waitFor(() => expect(f.service.preview(AVATAR)).toEqual({ url: null, state }));
      expect(authorize).toHaveBeenCalledOnce();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(imageMock.createFromBuffer).not.toHaveBeenCalled();
      expect((await f.service.responseFor(randomUUID())).status).toBe(404);
      expect(authorize).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "http://media.example.test/image",
    "https://user:password@media.example.test/image",
    "https://127.0.0.1/image",
    "https://2130706433/image",
    "https://0x7f000001/image",
    "https://%31%32%37.0.0.1/image",
    "https://[::1]/image",
    "https://media.example.test\\@outside.example/image",
    "https://media.example.test/\nsecret",
    " https://media.example.test/image",
    "data:image/png;base64,abc",
    "file:///C:/private.png",
    "sv-asset://file/private",
    "https://media.example.test:0/image",
  ])("does not offer malformed or unsupported URL %s to the authorization seam", async (sourceUrl) => {
    const f = fixture();
    offer(f.service, AVATAR, "revision", sourceUrl);
    await tick();
    expect(f.service.preview(AVATAR)).toEqual({ url: null, state: "unavailable" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("requires a nonempty source revision and never learns target authority from account-update shaped extras", async () => {
    const f = fixture();
    f.service.offer({ ...AVATAR, reviewed: true } as never, { sourceUrl: IMAGE_URL, sourceRevision: "" });
    await tick();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.service.preview(AVATAR).url).toBeNull();
  });

  it("deduplicates equal offers and reuses a verified local cache after restart without storing or fetching its source", async () => {
    const f = fixture();
    offer(f.service);
    offer(f.service);
    await cached(f.service);
    offer(f.service);
    expect(f.fetch).toHaveBeenCalledOnce();
    const before = f.service.preview(AVATAR);
    await f.service.dispose();
    const restored = fixture();
    expect(restored.service.preview(AVATAR)).toEqual(before);
    offer(restored.service);
    await tick();
    expect(restored.fetch).not.toHaveBeenCalled();
    const id = before.url!.split("/").at(-1)!;
    expect((await restored.service.responseFor(id)).status).toBe(200);
  });

  it("aborts an obsolete source and prevents its late success from overwriting the latest image", async () => {
    const f = fixture();
    const old = deferred<Response>();
    f.fetch.mockReturnValueOnce(old.promise);
    offer(f.service);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    const signal = f.fetch.mock.calls[0][1]!.signal!;
    offer(f.service, AVATAR, "revision-two", "https://media.example.test/new?signature=new-secret");
    expect(signal.aborted).toBe(true);
    await cached(f.service);
    const newest = f.service.preview(AVATAR);
    old.resolve(pngResponse());
    await tick();
    expect(f.service.preview(AVATAR)).toEqual(newest);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.grants.every((grant) => vi.mocked(grant.lease.release).mock.calls.length === 1)).toBe(true);
    expect(
      fs.readdirSync(path.join(directory, "cache")).filter((name) => name.endsWith(".png")),
    ).toHaveLength(1);
  });

  it("limits global and per-account work while letting another account proceed", async () => {
    const f = fixture({ maxConcurrent: 2, maxPerAccount: 1 });
    const pending: ReturnType<typeof deferred<Response>>[] = [];
    f.fetch.mockImplementation(() => {
      const next = deferred<Response>();
      pending.push(next);
      return next.promise;
    });
    offer(f.service, AVATAR);
    offer(f.service, { ...AVATAR, kind: "cover", workId: "work-one" });
    offer(f.service, { accountId: "account-b", kind: "avatar" });
    offer(f.service, { accountId: "account-c", kind: "avatar" });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(f.authorize.mock.calls.map(([subject]) => subject.accountId)).toEqual(["account-a", "account-b"]);
    pending[0].resolve(pngResponse());
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    expect(f.authorize.mock.calls[2][0]).toMatchObject({ accountId: "account-a", kind: "cover" });
    expect(f.fetch).toHaveBeenCalledTimes(3); // b + cover are still active, c is queued.
    pending[1].resolve(pngResponse());
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(4));
    pending[2].resolve(pngResponse());
    pending[3].resolve(pngResponse());
    await cached(f.service, { accountId: "account-c", kind: "avatar" });
  });

  it("suspends and resumes in the same tick without losing the latest queued source", async () => {
    const f = fixture();
    f.fetch.mockReturnValueOnce(new Promise(() => undefined));
    offer(f.service);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    f.service.suspendAccount(AVATAR.accountId);
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(f.service.preview(AVATAR).state).toBe("waiting-network");
    offer(f.service, AVATAR, "revision-two");
    f.service.resumeAccount(AVATAR.accountId);
    await cached(f.service);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("retains only cached images during suspension and does not send pending offers until explicit resume", async () => {
    const f = fixture();
    offer(f.service);
    await cached(f.service);
    const before = f.service.preview(AVATAR);
    f.service.suspendAccount(AVATAR.accountId);
    offer(f.service, AVATAR, "revision-two");
    await tick();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.service.preview(AVATAR)).toEqual(before);
    f.service.resumeAccount(AVATAR.accountId);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.service.preview(AVATAR).url).not.toBe(before.url));
  });

  it("aborts a body read when the Gate lease is revoked and never commits partial content", async () => {
    const f = fixture();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PNG.subarray(0, 16)));
      },
      cancel: cancelled,
    });
    f.fetch.mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "image/png" } }));
    offer(f.service);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    f.grants[0].controller.abort();
    await vi.waitFor(() => expect(f.service.preview(AVATAR).state).toBe("waiting-network"));
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(imageMock.createFromBuffer).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(directory, "cache"))).toEqual(["manifest.json"]);
  });

  it("revokes publication before forgetAccount/dispose resolve even when fetch never settles", async () => {
    const f = fixture();
    f.fetch.mockReturnValue(new Promise(() => undefined));
    offer(f.service);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    const forgotten = f.service.forgetAccount(AVATAR.accountId);
    expect(f.service.preview(AVATAR)).toEqual({ url: null, state: "unavailable" });
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    await forgotten;
    offer(f.service, AVATAR, "new-revision");
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    const disposal = f.service.dispose();
    expect(f.fetch.mock.calls[1][1]!.signal!.aborted).toBe(true);
    offer(f.service, AVATAR, "after-dispose");
    await disposal;
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds the deadline even if transport ignores abort and emits no body", async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 50 });
    f.fetch.mockReturnValue(new Promise(() => undefined));
    offer(f.service);
    await tick();
    expect(f.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(51);
    expect(f.service.preview(AVATAR).state).toBe("unavailable");
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(f.grants[0].lease.release).toHaveBeenCalledOnce();
  });

  it.each([401, 302])(
    "cancels %s responses without decoding, following, or retrying with credentials",
    async (status) => {
      const f = fixture();
      const cancelled = vi.fn();
      f.fetch.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: cancelled }), {
          status,
          headers: { "content-type": "image/png", Location: "https://second.example/private?token=secret" },
        }),
      );
      offer(f.service);
      await vi.waitFor(() => expect(f.service.preview(AVATAR).state).toBe("unavailable"));
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(cancelled).toHaveBeenCalledOnce();
      expect(imageMock.createFromBuffer).not.toHaveBeenCalled();
      expect(JSON.stringify(f.changed.mock.calls)).not.toContain("token=");
    },
  );

  it("limits actual streamed bytes even without Content-Length and cancels the reader", async () => {
    const f = fixture({ maxDownloadBytes: 32 });
    const cancelled = vi.fn();
    f.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(20));
            controller.enqueue(new Uint8Array(20));
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "image/png" } },
      ),
    );
    offer(f.service);
    await vi.waitFor(() => expect(f.service.preview(AVATAR).state).toBe("unavailable"));
    expect(cancelled).toHaveBeenCalledOnce();
    expect(imageMock.createFromBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ["image/svg+xml", Buffer.from("<svg><script>secret</script></svg>")],
    ["text/html", Buffer.from("<html>login required</html>")],
    ["image/png", Buffer.from("<svg><script>secret</script></svg>")],
    ["image/webp", PNG],
  ])("rejects active or mismatched %s content before native decoding", async (mime, bytes) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(new Uint8Array(bytes), { headers: { "content-type": mime } }));
    offer(f.service);
    await vi.waitFor(() => expect(f.service.preview(AVATAR).state).toBe("unavailable"));
    expect(imageMock.createFromBuffer).not.toHaveBeenCalled();
  });

  it("checks header pixels before native decode and output bytes before writing a thumbnail", async () => {
    const f = fixture({ maxPixels: 100, maxOutputBytes: PNG.length - 1 });
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(4000, 16);
    huge.writeUInt32BE(4000, 20);
    f.fetch.mockResolvedValueOnce(pngResponse(huge));
    offer(f.service);
    await vi.waitFor(() => expect(f.service.preview(AVATAR).state).toBe("unavailable"));
    expect(imageMock.createFromBuffer).not.toHaveBeenCalled();
    offer(f.service, AVATAR, "output-too-big");
    await vi.waitFor(() => expect(imageMock.createFromBuffer).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.service.preview(AVATAR).state).toBe("unavailable"));
    expect(fs.readdirSync(path.join(directory, "cache"))).toEqual(["manifest.json"]);
  });

  it("bounds cache bytes and entry count across eviction and restart, and does not expose evicted IDs", async () => {
    const f = fixture({ maxCacheBytes: PNG.length, maxEntries: 2 });
    offer(f.service);
    await cached(f.service);
    const firstId = f.service.preview(AVATAR).url!.split("/").at(-1)!;
    const other = { accountId: "account-b", kind: "avatar" } as const;
    offer(f.service, other);
    await cached(f.service, other);
    expect((await f.service.responseFor(firstId)).status).toBe(404);
    expect(
      fs.readdirSync(path.join(directory, "cache")).filter((name) => name.endsWith(".png")),
    ).toHaveLength(1);
    await f.service.dispose();
    const orphan = randomUUID() + ".png";
    fs.writeFileSync(path.join(directory, "cache", orphan), Buffer.alloc(4096));
    const restored = fixture({ maxCacheBytes: PNG.length, maxEntries: 2 });
    expect(fs.existsSync(path.join(directory, "cache", orphan))).toBe(false);
    expect(restored.service.preview(other).state).toBe("cached");
    expect(restored.fetch).not.toHaveBeenCalled();
  });

  it("fails local reads for same-size corruption and rejects malformed IDs without requests", async () => {
    const f = fixture();
    offer(f.service);
    await cached(f.service);
    const id = f.service.preview(AVATAR).url!.split("/").at(-1)!;
    const altered = Buffer.from(PNG);
    altered[altered.length - 1] ^= 1;
    fs.writeFileSync(path.join(directory, "cache", id + ".png"), altered);
    for (const candidate of [
      id,
      "../manifest.json",
      id + "?signature=secret",
      id.toUpperCase(),
      "file:///private",
    ])
      expect((await f.service.responseFor(candidate)).status).toBe(404);
    expect(f.fetch).toHaveBeenCalledOnce();
    await f.service.dispose();
    const restored = fixture();
    expect(restored.service.preview(AVATAR).url).toBeNull();
    expect(restored.fetch).not.toHaveBeenCalled();
  });

  it("does not let a throwing UI listener stop authorization cleanup or the next queued image", async () => {
    const f = fixture({
      onChanged: () => {
        throw new Error("private-ui-detail");
      },
      maxConcurrent: 1,
    });
    offer(f.service);
    const other = { accountId: "account-b", kind: "avatar" } as const;
    offer(f.service, other);
    await cached(f.service, other);
    expect(f.service.preview(AVATAR).state).toBe("cached");
    expect(f.grants.every((grant) => vi.mocked(grant.lease.release).mock.calls.length === 1)).toBe(true);
  });

  it("closes new writes after Windows refuses cache deletion, so repeated offers cannot evade disk limits", async () => {
    const f = fixture({ maxCacheBytes: PNG.length });
    offer(f.service);
    await cached(f.service);
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).endsWith(".png"))
        throw Object.assign(new Error("synthetic file in use"), { code: "EACCES" });
      return unlink(file);
    });
    offer(f.service, AVATAR, "revision-two");
    await vi.waitFor(() => expect(f.service.preview(AVATAR).state).toBe("unavailable"));
    const files = fs.readdirSync(path.join(directory, "cache")).filter((name) => name.endsWith(".png"));
    expect(files).toHaveLength(2); // Old cache + the single bounded failed commit; no more writes follow.
    expect(f.fetch).toHaveBeenCalledTimes(2);
    for (let index = 3; index < 9; index++) {
      offer(f.service, AVATAR, "revision-" + index);
      await tick();
    }
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.join(directory, "cache")).filter((name) => name.endsWith(".png"))).toEqual(
      files,
    );
  });

  it("refuses startup after a managed orphan cannot be removed instead of resetting its budget", () => {
    const cacheDir = path.join(directory, "cache");
    fs.mkdirSync(cacheDir);
    const orphan = path.join(cacheDir, randomUUID() + ".png");
    fs.writeFileSync(orphan, Buffer.alloc(4096));
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).endsWith(".png"))
        throw Object.assign(new Error("synthetic in use"), { code: "EACCES" });
      return unlink(file);
    });
    expect(() => fixture({ maxCacheBytes: PNG.length })).toThrow("REMOTE_MEDIA_CACHE_UNAVAILABLE");
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it("rejects a reparse ancestor before creating a cache directory outside its requested tree", () => {
    const other = path.join(directory, "other");
    const link = path.join(directory, "link");
    fs.mkdirSync(other);
    fs.symlinkSync(other, link, "junction");
    expect(() => fixture({ cacheDir: path.join(link, "new-cache") })).toThrow(
      "REMOTE_MEDIA_CACHE_UNAVAILABLE",
    );
    expect(fs.existsSync(path.join(other, "new-cache"))).toBe(false);
  });

  it("writes manifests via unpredictable exclusive temporary files and leaves an unrelated fixed name alone", async () => {
    const f = fixture();
    const sentinel = path.join(directory, "cache", "manifest.tmp");
    fs.writeFileSync(sentinel, "synthetic-do-not-overwrite");
    const writes = vi.spyOn(fs, "writeFileSync");
    offer(f.service);
    await cached(f.service);
    const metadataWrites = writes.mock.calls.filter(([file]) => String(file).endsWith(".tmp"));
    expect(metadataWrites.length).toBeGreaterThan(0);
    for (const [file, , options] of metadataWrites) {
      expect(path.basename(String(file))).toMatch(/^[a-f0-9-]{36}\.tmp$/);
      expect(options).toMatchObject({ flag: "wx", mode: 0o600 });
    }
    expect(fs.readFileSync(sentinel, "utf8")).toBe("synthetic-do-not-overwrite");
  });
});
