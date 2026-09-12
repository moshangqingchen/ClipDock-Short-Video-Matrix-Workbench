import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import type { Asset } from "@shared/types";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { buildBackup } from "@main/security/backup";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAuthorizationStore } from "./global-authorization-store";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";
import { GlobalUploadsRepository } from "./global-uploads-repository";
import { GlobalUploadQueue } from "./global-upload-queue";
import { GlobalUploadError, type TikTokDraftAdapter, type TikTokDraftStatus } from "./tiktok-draft-adapter";
import { prepareUploadFile } from "./global-upload-file";
import {
  YouTubeUploadRetryError,
  type YouTubeUploadAdapter,
  type YouTubeUploadSession,
} from "./youtube-upload-adapter";
import {
  YOUTUBE_UPLOAD_SCOPE,
  type YouTubeUploadMetadata,
  type YouTubeUploadReceipt,
} from "@shared/youtube-upload";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stores: Store[] = [],
  queues: GlobalUploadQueue[] = [],
  dirs: string[] = [],
  unblock: (() => void)[] = [];
afterEach(async () => {
  unblock.splice(0).forEach((done) => done());
  for (const queue of queues.splice(0)) await queue.dispose();
  stores.splice(0).forEach((store) => store.close());
  for (const dir of dirs.splice(0)) {
    const resolved = path.resolve(dir);
    if (
      !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith("clipdock-upload-")
    )
      throw new Error("INVALID_TEST_PATH");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function deferred<T>(value: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  unblock.push(() => resolve(value));
  return { promise, resolve: () => resolve(value) };
}
function fixture(bytes = 1024, fileDb = false, platformId: "tiktok" | "youtube" = "tiktok") {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(new Date("2026-09-08T10:00:00Z"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipdock-upload-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "test.sqlite"),
    store = createStore(fileDb ? dbPath : ":memory:");
  stores.push(store);
  const key = randomBytes(32);
  const encryption: CredentialEncryptionProvider = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (data) => {
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
    },
  };
  const account = new GlobalAccountRepository(store.db).create({ platformId });
  new GlobalAppRepository(store.db).put({
    platformId,
    clientId: "synthetic-app",
    redirectPort: 3455,
  });
  const tokens = new GlobalTokenStore(store.db, encryption),
    vault = new CredentialVault(store.db, encryption);
  const token: GlobalTokenEnvelope = {
    version: 1,
    accountId: account.id,
    platformId,
    remoteId: "synthetic-user",
    accessToken: "synthetic-access-secret",
    refreshToken: "synthetic-refresh-secret",
    tokenType: "Bearer",
    scopes:
      platformId === "tiktok"
        ? ["user.info.basic", "video.upload"]
        : ["https://www.googleapis.com/auth/youtube.readonly", YOUTUBE_UPLOAD_SCOPE],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  tokens.commitAuthorization(token, {
    accountId: account.id,
    platformId,
    assertCurrent: () => undefined,
  });
  const data = Buffer.alloc(bytes, 7),
    filePath = path.join(dir, "test-video.mp4");
  fs.writeFileSync(filePath, data);
  const asset: Asset = {
    id: randomUUID(),
    kind: "video",
    filePath,
    fileName: "test-video.mp4",
    mimeType: "video/mp4",
    sizeBytes: bytes,
    sha256: createHash("sha256").update(data).digest("hex"),
    createdAt: new Date().toISOString(),
  };
  store.assets.insert(asset);
  const session = {
    publishId: "v_inbox_file~v2.synthetic",
    uploadUrl:
      "https://open-upload.tiktokapis.com/video/?upload_id=synthetic&upload_token=synthetic-upload-secret",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const adapter = {
    initialize: vi.fn<TikTokDraftAdapter["initialize"]>(async () => ({ ...session })),
    upload: vi.fn<TikTokDraftAdapter["upload"]>(async () => undefined),
    status: vi.fn<TikTokDraftAdapter["status"]>(async () => ({ state: "inbox", uploadedBytes: bytes })),
  };
  const metadata: YouTubeUploadMetadata = {
    title: "Synthetic video",
    description: "Controlled test only",
    categoryId: "22",
    privacy: "private",
    madeForKids: false,
    containsSyntheticMedia: true,
    notifySubscribers: false,
  };
  const youtubeSession: YouTubeUploadSession = {
    uploadUrl:
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=synthetic-upload-secret&part=snippet%2Cstatus",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    videoId: null,
  };
  const receipt: YouTubeUploadReceipt = { videoId: "abcdefghijk", privacy: "private", state: "processing" };
  const youtube = {
    initialize: vi.fn<YouTubeUploadAdapter["initialize"]>(async () => ({ ...youtubeSession })),
    upload: vi.fn<YouTubeUploadAdapter["upload"]>(async (_ctx, _session, size, start, _mime, buffer) =>
      start + buffer.byteLength === size
        ? { kind: "complete", receipt }
        : { kind: "progress", receivedBytes: start + buffer.byteLength, retryAfterMs: 0 },
    ),
    query: vi.fn<YouTubeUploadAdapter["query"]>(async () => ({
      kind: "progress",
      receivedBytes: 0,
      retryAfterMs: 0,
    })),
    status: vi.fn<YouTubeUploadAdapter["status"]>(async () => ({ ...receipt, state: "ready" })),
  };
  let enabled = true;
  const acquireEligibility = vi.fn(async () => {
    const controller = new AbortController();
    return {
      generation: 1,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      release: vi.fn(() => controller.abort()),
    };
  });
  const refreshToken = vi.fn(async () => ({
    ...token,
    accessToken: "refreshed-secret",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }));
  const options = {
    db: store.db,
    encryption,
    adapter,
    youtube,
    acquireEligibility,
    refreshToken,
    canAttempt: () => enabled,
    whenTransportIdle: vi.fn(async () => undefined),
    onChanged: vi.fn(),
  };
  const queue = new GlobalUploadQueue(options);
  queues.push(queue);
  const repo = new GlobalUploadsRepository(store.db, encryption);
  return {
    store,
    dir,
    dbPath,
    tokens,
    vault,
    token,
    account,
    asset,
    data,
    session,
    adapter,
    youtube,
    youtubeSession,
    metadata,
    receipt,
    queue,
    repo,
    options,
    encryption,
    acquireEligibility,
    refreshToken,
    setEnabled(value: boolean) {
      enabled = value;
    },
    submit: () =>
      queue.submit({
        accountId: account.id,
        assetId: asset.id,
        ...(platformId === "youtube" ? { youtube: metadata } : {}),
      }),
    async step(ms = 30001) {
      await vi.advanceTimersByTimeAsync(ms);
      await queue.whenIdle();
    },
  };
}
describe("durable YouTube resumable upload queue", () => {
  it("merges identical consent and refuses a changed privacy while the original task waits offline", async () => {
    const f = fixture(1024, false, "youtube");
    f.setEnabled(false);
    const job = f.submit();
    expect(f.submit().id).toBe(job.id);
    expect(() =>
      f.queue.submit({
        accountId: f.account.id,
        assetId: f.asset.id,
        youtube: { ...f.metadata, privacy: "public" },
      }),
    ).toThrow("GLOBAL_UPLOAD_BUSY");
    f.queue.start();
    await f.step();
    expect(f.youtube.initialize).not.toHaveBeenCalled();
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
  it("requires upload scope and metadata before queuing any business request", () => {
    const f = fixture(1024, false, "youtube");
    expect(() => f.queue.submit({ accountId: f.account.id, assetId: f.asset.id })).toThrow(
      "GLOBAL_UPLOAD_INVALID",
    );
    f.tokens.commitAuthorization(
      { ...f.token, scopes: ["https://www.googleapis.com/auth/youtube.readonly"] },
      { accountId: f.account.id, platformId: "youtube", assertCurrent: () => undefined },
    );
    expect(() => f.submit()).toThrow("GLOBAL_UPLOAD_SCOPE_MISSING");
    expect(f.queue.list(f.account.id)).toEqual([]);
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
  it("records actual private processing and ready status without claiming the requested public visibility", async () => {
    const f = fixture(1024, false, "youtube");
    const job = f.queue.submit({
      accountId: f.account.id,
      assetId: f.asset.id,
      youtube: { ...f.metadata, privacy: "public" },
    });
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job).toMatchObject({
      state: "processing",
      sentBytes: 1024,
      receipt: f.receipt,
    });
    expect(f.adapter.initialize).not.toHaveBeenCalled();
    expect(f.acquireEligibility).toHaveBeenCalledWith("youtube", expect.any(AbortSignal));
    await f.step();
    expect(f.repo.get(job.id)?.job).toMatchObject({ state: "ready", receipt: { privacy: "private" } });
    f.youtube.status.mockResolvedValue({ ...f.receipt, state: "published", privacy: "public" });
    f.queue.check(job.id);
    await f.step();
    expect(f.repo.get(job.id)?.job).toMatchObject({ state: "published", receipt: { privacy: "public" } });
    expect(f.youtube.initialize).toHaveBeenCalledTimes(1);
    expect(f.youtube.upload).toHaveBeenCalledTimes(1);
  });
  it("encrypts the original URL and excludes it from public jobs, audit and backups", async () => {
    const f = fixture(1024, false, "youtube"),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.session(f.repo.get(job.id)!)).toEqual({ ...f.youtubeSession, videoId: f.receipt.videoId });
    const cipher = f.store.db.get(
      "SELECT ciphertext FROM credentials WHERE kind='upload_session' AND owner_id=?",
      [job.id],
    );
    expect(
      Buffer.from(cipher!.ciphertext as Uint8Array).includes(Buffer.from("synthetic-upload-secret")),
    ).toBe(false);
    const visible = JSON.stringify({
      jobs: f.queue.list(f.account.id),
      audit: f.store.db.all("SELECT * FROM audit_events"),
      backup: buildBackup(f.store),
      rows: f.store.db.all("SELECT * FROM global_upload_jobs"),
    });
    for (const secret of ["synthetic-upload-secret", "synthetic-access-secret", f.asset.filePath])
      expect(visible).not.toContain(secret);
  });
  it("reopens the database, queries the original session and resumes at the server's partial byte offset", async () => {
    const f = fixture(8 * 1024 ** 2 + 99, true, "youtube"),
      job = f.submit();
    f.youtube.upload.mockRejectedValueOnce(new Error("lost chunk reply"));
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job).toMatchObject({ state: "waiting-retry", sentBytes: 0 });
    await f.queue.dispose();
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = createStore(f.dbPath);
    stores.push(reopened);
    f.youtube.query.mockResolvedValue({ kind: "progress", receivedBytes: 7, retryAfterMs: 0 });
    f.youtube.upload.mockClear();
    const next = new GlobalUploadQueue({ ...f.options, db: reopened.db });
    queues.push(next);
    next.start();
    await vi.advanceTimersByTimeAsync(30001);
    await next.whenIdle();
    expect(f.youtube.initialize).toHaveBeenCalledTimes(1);
    expect(f.youtube.query.mock.calls[0][1]).toEqual(f.youtubeSession);
    expect(f.youtube.upload.mock.calls.map((call) => call[3])).toEqual([7, 7 + 8 * 1024 ** 2]);
    expect(Buffer.from(f.youtube.upload.mock.calls[0][5]).equals(f.data.subarray(7, 7 + 8 * 1024 ** 2))).toBe(
      true,
    );
    expect(next.list(f.account.id)[0]).toMatchObject({ state: "processing", sentBytes: f.asset.sizeBytes });
  });
  it.each(["range", "rate-limit"])("persists the server's %s wait across a database reopen", async (mode) => {
    const f = fixture(1024, true, "youtube"),
      job = f.submit();
    if (mode === "range")
      f.youtube.upload.mockResolvedValueOnce({ kind: "progress", receivedBytes: 7, retryAfterMs: 300_000 });
    else
      f.youtube.upload.mockRejectedValueOnce(
        new YouTubeUploadRetryError("GLOBAL_UPLOAD_RATE_LIMITED", 300_000),
      );
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.notBeforeAt).toBe(Date.now() + 300_000);
    await f.queue.dispose();
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = createStore(f.dbPath);
    stores.push(reopened);
    f.youtube.query.mockResolvedValue({ kind: "progress", receivedBytes: 7, retryAfterMs: 0 });
    f.youtube.upload.mockClear();
    const next = new GlobalUploadQueue({ ...f.options, db: reopened.db });
    queues.push(next);
    expect(next.list(f.account.id)[0].state).toBe("waiting-retry");
    next.start();
    await vi.advanceTimersByTimeAsync(299_000);
    await next.whenIdle();
    expect(f.youtube.query).not.toHaveBeenCalled();
    expect(f.youtube.upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    await next.whenIdle();
    expect(f.youtube.query).toHaveBeenCalledOnce();
    expect(next.list(f.account.id)[0].state).toBe("processing");
  });
  it.each(["GLOBAL_UPLOAD_RATE_LIMITED", "GLOBAL_UPLOAD_FORBIDDEN", "GLOBAL_UPLOAD_SCOPE_MISSING"] as const)(
    "does not repeat a definitively refused initialization: %s",
    async (code) => {
      const f = fixture(1024, false, "youtube"),
        job = f.submit();
      f.youtube.initialize.mockRejectedValue(new GlobalUploadError(code));
      f.queue.start();
      await f.queue.whenIdle();
      await f.step(300_001);
      expect(f.repo.get(job.id)?.job).toMatchObject({ state: "failed", errorCode: code });
      expect(f.youtube.initialize).toHaveBeenCalledOnce();
    },
  );
  it("never repeats initialization with an unknown outcome", async () => {
    const f = fixture(1024, false, "youtube"),
      job = f.submit();
    f.youtube.initialize.mockRejectedValue(new Error("lost init response"));
    f.queue.start();
    await f.queue.whenIdle();
    await f.queue.dispose();
    const next = new GlobalUploadQueue(f.options);
    queues.push(next);
    next.start();
    await next.whenIdle();
    expect(next.list(f.account.id)[0]).toMatchObject({ id: job.id, state: "uncertain" });
    expect(f.youtube.initialize).toHaveBeenCalledOnce();
  });
  it("a cancelled task's manual result check cannot resend missing bytes", async () => {
    const f = fixture(1024, false, "youtube"),
      job = f.submit();
    f.youtube.upload.mockRejectedValueOnce(new Error("interrupted"));
    f.queue.start();
    await f.queue.whenIdle();
    f.queue.cancel(job.id);
    f.queue.check(job.id);
    await f.step();
    expect(f.repo.get(job.id)?.job.state).toBe("uncertain");
    expect(f.youtube.query).toHaveBeenCalledOnce();
    expect(f.youtube.upload).toHaveBeenCalledOnce();
  });
  it("stops after bounded no-progress replies instead of hammering the upload URL", async () => {
    const f = fixture(1024, false, "youtube"),
      job = f.submit();
    f.youtube.upload.mockResolvedValue({ kind: "progress", receivedBytes: 0, retryAfterMs: 0 });
    f.queue.start();
    await f.queue.whenIdle();
    for (let i = 0; i < 8; i++) await f.step(300_001);
    expect(f.repo.get(job.id)?.job.state).toBe("uncertain");
    expect(f.youtube.upload).toHaveBeenCalledTimes(8);
    expect(f.youtube.initialize).toHaveBeenCalledOnce();
  });
  it("cannot revive a cancelled task from a delayed upload success", async () => {
    const f = fixture(1024, false, "youtube"),
      job = f.submit();
    const pending = deferred({ kind: "complete" as const, receipt: f.receipt });
    f.youtube.upload.mockReturnValue(pending.promise);
    f.queue.start();
    await vi.waitFor(() => expect(f.youtube.upload).toHaveBeenCalledOnce());
    f.queue.cancel(job.id);
    pending.resolve();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job).toMatchObject({ state: "cancelled", sentBytes: 0 });
    expect(f.repo.get(job.id)?.job.receipt).toBeUndefined();
  });
  it("does not cancel YouTube work when only TikTok app settings change", () => {
    const f = fixture(1024, false, "youtube"),
      job = f.submit();
    f.queue.invalidatePlatform("tiktok");
    expect(f.repo.get(job.id)?.job.state).toBe("waiting-proxy");
    f.queue.invalidatePlatform("youtube");
    expect(f.repo.get(job.id)?.job.state).toBe("cancelled");
  });
});
describe("durable TikTok draft upload queue", () => {
  it("returns a waiting ID immediately, merges repeated intent and sends nothing with proxy off", async () => {
    const f = fixture();
    f.setEnabled(false);
    const job = f.submit();
    expect(f.submit().id).toBe(job.id);
    expect(job.state).toBe("waiting-proxy");
    f.queue.start();
    await f.step();
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect(f.adapter.initialize).not.toHaveBeenCalled();
    expect(f.queue.list(f.account.id)[0].state).toBe("waiting-proxy");
  });
  it("transfers to processing, then waits for the explicit inbox response without claiming a publication", async () => {
    const f = fixture(),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job).toMatchObject({ state: "processing", sentBytes: f.asset.sizeBytes });
    expect(f.adapter.initialize).toHaveBeenCalledTimes(1);
    expect(f.adapter.upload).toHaveBeenCalledTimes(1);
    expect(f.adapter.status).not.toHaveBeenCalled();
    await f.step();
    expect(f.repo.get(job.id)?.job.state).toBe("inbox");
    await f.step();
    expect(f.adapter.status).toHaveBeenCalledTimes(1);
    expect(new GlobalAccountRepository(f.store.db).get(f.account.id)?.authStatus).toBe("authorized");
  });
  it("saves the signed upload address encrypted, outside public jobs, audit and business backup", async () => {
    const f = fixture(),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    const item = f.repo.get(job.id)!;
    expect(f.repo.session(item)).toEqual(f.session);
    const row = f.store.db.get(
      "SELECT ciphertext FROM credentials WHERE kind = 'upload_session' AND owner_id = ?",
      [job.id],
    );
    expect(Buffer.from(row!.ciphertext as Uint8Array).includes(Buffer.from("synthetic-upload-secret"))).toBe(
      false,
    );
    const visible = JSON.stringify({
      jobs: f.queue.list(f.account.id),
      audit: f.store.db.all("SELECT * FROM audit_events"),
      rows: f.store.db.all("SELECT * FROM global_upload_jobs"),
    });
    expect(visible).not.toContain("synthetic-upload-secret");
    expect(visible).not.toContain("synthetic-access-secret");
    expect(visible).not.toContain(f.asset.filePath);
    const backup = JSON.stringify(buildBackup(f.store));
    expect(backup).not.toContain("synthetic-upload-secret");
    expect(backup).not.toContain("global_upload_jobs");
  });
  it("rejects missing upload scope before creating intent or diagnostics", () => {
    const f = fixture();
    f.tokens.commitAuthorization(
      { ...f.token, scopes: ["user.info.basic"] },
      { accountId: f.account.id, platformId: "tiktok", assertCurrent: () => undefined },
    );
    expect(f.submit).toThrow("GLOBAL_UPLOAD_SCOPE_MISSING");
    expect(f.queue.list(f.account.id)).toEqual([]);
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
  it("unavailable encryption preserves existing data and creates no upload", () => {
    const f = fixture();
    f.encryption.isEncryptionAvailable = () => false;
    expect(f.submit).toThrow();
    expect(f.queue.list(f.account.id)).toEqual([]);
    expect(f.adapter.initialize).not.toHaveBeenCalled();
  });
  it("changed file content is refused before initializing the remote upload", async () => {
    const f = fixture(),
      job = f.submit();
    fs.writeFileSync(f.asset.filePath, Buffer.alloc(f.asset.sizeBytes, 9));
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job).toMatchObject({
      state: "failed",
      errorCode: "GLOBAL_UPLOAD_FILE_CHANGED",
    });
    expect(f.adapter.initialize).not.toHaveBeenCalled();
  });
  it("checks each pinned part against its preflight hash before use", async () => {
    const f = fixture();
    const file = await prepareUploadFile(f.asset, () => undefined);
    try {
      fs.writeFileSync(f.asset.filePath, Buffer.alloc(f.asset.sizeBytes, 9));
      await expect(file.read(0)).rejects.toMatchObject({ code: "GLOBAL_UPLOAD_FILE_CHANGED" });
    } finally {
      await file.close();
    }
  });
  it("reads an arbitrary resumed YouTube range across two verified chunks without skipping bytes", async () => {
    const f = fixture(8 * 1024 ** 2 + 25);
    const file = await prepareUploadFile(f.asset, () => undefined, "youtube");
    try {
      expect((await file.readRange(7, 8 * 1024 ** 2)).equals(f.data.subarray(7, 7 + 8 * 1024 ** 2))).toBe(
        true,
      );
      await expect(file.readRange(f.asset.sizeBytes - 1, 2)).rejects.toMatchObject({
        code: "GLOBAL_UPLOAD_INVALID",
      });
      fs.writeFileSync(f.asset.filePath, Buffer.alloc(f.asset.sizeBytes, 9));
      await expect(file.readRange(7, 30)).rejects.toMatchObject({ code: "GLOBAL_UPLOAD_FILE_CHANGED" });
    } finally {
      await file.close();
    }
  });
  it("does not repeat an uncertain init after restarting the queue", async () => {
    const f = fixture(),
      job = f.submit();
    f.adapter.initialize.mockRejectedValue(new Error("connection lost after sending init"));
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job.state).toBe("uncertain");
    await f.queue.dispose();
    const next = new GlobalUploadQueue(f.options);
    queues.push(next);
    next.start();
    await next.whenIdle();
    expect(f.adapter.initialize).toHaveBeenCalledTimes(1);
  });
  it("recovers an init-attempted row with no saved response to uncertain rather than retrying it", async () => {
    const f = fixture(),
      job = f.submit();
    f.repo.update(f.repo.get(job.id)!, "initializing", { initAttempted: true });
    const next = new GlobalUploadQueue(f.options);
    queues.push(next);
    next.start();
    await next.whenIdle();
    expect(f.repo.get(job.id)?.job.state).toBe("uncertain");
    expect(f.adapter.initialize).not.toHaveBeenCalled();
  });
  it.each([
    "GLOBAL_UPLOAD_SCOPE_MISSING",
    "GLOBAL_UPLOAD_REAUTHORIZE",
    "GLOBAL_UPLOAD_RATE_LIMITED",
    "GLOBAL_UPLOAD_FORBIDDEN",
  ] as const)("keeps a definitive init refusal %s explicit and does not retry", async (code) => {
    const f = fixture(),
      job = f.submit();
    f.adapter.initialize.mockRejectedValue(new GlobalUploadError(code));
    f.queue.start();
    await f.queue.whenIdle();
    await f.step();
    expect(f.repo.get(job.id)?.job).toMatchObject({ state: "failed", errorCode: code });
    expect(f.adapter.initialize).toHaveBeenCalledTimes(1);
  });
  it("resumes only the original publish ID and the next acknowledged chunk after the database reopens", async () => {
    const f = fixture(16 * 1024 ** 2 + 100, true),
      job = f.submit();
    f.adapter.upload
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("uncertain chunk reply"));
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job).toMatchObject({ state: "waiting-proxy", sentBytes: 8 * 1024 ** 2 });
    await f.queue.dispose();
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = createStore(f.dbPath);
    stores.push(reopened);
    f.adapter.status.mockResolvedValue({ state: "uploading", uploadedBytes: 8 * 1024 ** 2 });
    f.adapter.upload.mockClear();
    const next = new GlobalUploadQueue({ ...f.options, db: reopened.db });
    queues.push(next);
    next.start();
    await next.whenIdle();
    expect(f.adapter.initialize).toHaveBeenCalledTimes(1);
    expect(f.adapter.upload).toHaveBeenCalledTimes(1);
    expect(f.adapter.upload.mock.calls[0][3]).toBe(8 * 1024 ** 2);
    expect(f.adapter.status.mock.calls[0][1]).toBe(f.session.publishId);
    expect(next.list(f.account.id)[0].state).toBe("processing");
  });
  it.each([null, 3, -1])(
    "does not guess a resumable boundary from remote byte count %s",
    async (uploadedBytes) => {
      const f = fixture(),
        job = f.submit();
      f.adapter.upload.mockRejectedValueOnce(new Error("lost reply"));
      f.queue.start();
      await f.queue.whenIdle();
      f.adapter.status.mockResolvedValue({ state: "uploading", uploadedBytes } as TikTokDraftStatus);
      await f.step();
      expect(f.repo.get(job.id)?.job.state).toBe("uncertain");
      expect(f.adapter.upload).toHaveBeenCalledTimes(1);
    },
  );
  it("a delivered inbox status takes precedence over an expired upload URL or missing local file", async () => {
    const f = fixture(),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    fs.unlinkSync(f.asset.filePath);
    vi.setSystemTime(new Date(Date.now() + 3700000));
    await f.step();
    expect(f.repo.get(job.id)?.job.state).toBe("inbox");
    expect(f.adapter.upload).toHaveBeenCalledTimes(1);
  });
  it("an explicit result check can observe user publication and never resends the file", async () => {
    const f = fixture(),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    await f.step();
    f.adapter.status.mockResolvedValue({ state: "published", uploadedBytes: f.asset.sizeBytes });
    expect(f.queue.check(job.id).state).toBe("waiting-proxy");
    f.queue.sync();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job.state).toBe("published");
    expect(f.adapter.upload).toHaveBeenCalledTimes(1);
  });
  it("cancelled work retains the true drain and a late init cannot install an upload session", async () => {
    const f = fixture(),
      job = f.submit(),
      held = deferred(f.session),
      entered = deferred(undefined);
    f.adapter.initialize.mockImplementation(async () => {
      entered.resolve();
      return held.promise;
    });
    f.queue.start();
    await entered.promise;
    expect(f.queue.cancel(job.id)?.state).toBe("cancelled");
    let idle = false;
    const drain = f.queue.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    held.resolve();
    await drain;
    expect(f.repo.get(job.id)?.job.state).toBe("cancelled");
    expect(f.repo.hasSession(f.repo.get(job.id)!)).toBe(false);
    expect(f.adapter.upload).not.toHaveBeenCalled();
  });
  it("network revocation during init marks an unknown result and does not revive it on recovery", async () => {
    const f = fixture(),
      job = f.submit(),
      held = deferred(f.session),
      entered = deferred(undefined);
    f.adapter.initialize.mockImplementation(async () => {
      entered.resolve();
      return held.promise;
    });
    f.queue.start();
    await entered.promise;
    f.setEnabled(false);
    f.queue.invalidateNetwork();
    held.resolve();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job.state).toBe("uncertain");
    f.setEnabled(true);
    await f.step();
    expect(f.adapter.initialize).toHaveBeenCalledTimes(1);
  });
  it("new consent cancels the old intent even if the token and account identity have the same values", async () => {
    const f = fixture(),
      job = f.submit();
    f.tokens.commitAuthorization(f.token, {
      accountId: f.account.id,
      platformId: "tiktok",
      assertCurrent: () => undefined,
    });
    f.queue.start();
    await f.queue.whenIdle();
    expect(f.repo.get(job.id)?.job.state).toBe("cancelled");
    expect(f.adapter.initialize).not.toHaveBeenCalled();
  });
  it("deleting an account removes its encrypted upload session by the job cascade", async () => {
    const f = fixture(),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    await f.queue.dispose();
    f.store.db.run("DELETE FROM global_accounts WHERE id = ?", [f.account.id]);
    expect(f.store.db.get("SELECT id FROM global_upload_jobs WHERE id = ?", [job.id])).toBeUndefined();
    expect(f.vault.has({ kind: "upload_session", ownerId: job.id })).toBe(false);
  });
  it("explicit local disconnect removes unreadable upload secrets while keeping task history", async () => {
    const f = fixture(),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    f.queue.invalidateAccount(f.account.id);
    f.encryption.isEncryptionAvailable = () => false;
    new GlobalAuthorizationStore(f.store.db).disconnect(f.account.id);
    expect(f.vault.has({ kind: "upload_session", ownerId: job.id })).toBe(false);
    expect(f.vault.has({ kind: "oauth_token", ownerId: f.account.id })).toBe(false);
    expect(f.repo.get(job.id)?.job.state).toBe("cancelled");
    expect(() => f.queue.check(job.id)).toThrow("GLOBAL_UPLOAD_UNCERTAIN");
  });
  it("changing the developer app discards old upload secrets without creating another upload", async () => {
    const f = fixture(),
      job = f.submit();
    f.queue.start();
    await f.queue.whenIdle();
    f.queue.invalidatePlatform("tiktok");
    new GlobalAppRepository(f.store.db).put({
      platformId: "tiktok",
      clientId: "replacement-app",
      redirectPort: 3455,
    });
    expect(f.vault.has({ kind: "upload_session", ownerId: job.id })).toBe(false);
    expect(f.tokens.read(f.account.id)).toBeNull();
    await f.step();
    expect(f.adapter.initialize).toHaveBeenCalledTimes(1);
    expect(f.repo.get(job.id)?.job.state).toBe("cancelled");
  });
  it.each(["IGNORE", "ABORT, 'synthetic private failure'"])(
    "a failed upload-secret deletion (%s) rolls back local disconnect",
    async (failure) => {
      const f = fixture(),
        job = f.submit();
      f.queue.start();
      await f.queue.whenIdle();
      f.queue.invalidateAccount(f.account.id);
      const before = f.store.db.all("SELECT * FROM credentials ORDER BY id");
      f.store.db.exec(
        `CREATE TRIGGER refuse_upload_secret_delete BEFORE DELETE ON credentials WHEN OLD.kind = 'upload_session' BEGIN SELECT RAISE(${failure}); END;`,
      );
      expect(() => new GlobalAuthorizationStore(f.store.db).disconnect(f.account.id)).toThrow(
        "GLOBAL_AUTHORIZATION_DISCONNECT_FAILED",
      );
      expect(f.store.db.all("SELECT * FROM credentials ORDER BY id")).toEqual(before);
      expect(new GlobalAccountRepository(f.store.db).get(f.account.id)?.authStatus).toBe("authorized");
      expect(f.repo.get(job.id)?.job.state).toBe("cancelled");
    },
  );
});
