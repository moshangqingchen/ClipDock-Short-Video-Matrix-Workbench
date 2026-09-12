import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { migrate } from "@main/db/database";
import { CredentialVault, type CredentialEncryptionProvider } from "@main/security/credential-vault";
import { buildBackup } from "@main/security/backup";
import { globalJobSchema } from "@shared/global-jobs";
import type { GlobalReadData } from "@shared/global-read";
import { GLOBAL_APP_PROFILES } from "@shared/global-apps";
import type { GlobalPlatformId } from "@shared/platforms";
import { GlobalJobQueue } from "./global-job-queue";
import { GlobalJobsRepository } from "./global-jobs-repository";
import { GlobalAccountRepository } from "./global-account-repository";
import { GlobalAppRepository } from "./global-app-repository";
import { GlobalTokenStore, type GlobalTokenEnvelope } from "./global-token-store";
import { GlobalReadService, type GlobalReadServiceOptions } from "./global-read-service";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
const stores: Store[] = [],
  queues: GlobalJobQueue[] = [],
  services: GlobalReadService[] = [];
const unblock: (() => void)[] = [],
  dirs: string[] = [];
afterEach(async () => {
  unblock.splice(0).forEach((done) => done());
  for (const queue of queues.splice(0)) await queue.dispose();
  for (const service of services.splice(0)) await service.dispose();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    const resolved = path.resolve(dir);
    if (
      !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith("clipdock-global-jobs-")
    )
      throw new Error("INVALID_TEST_PATH");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function defer<T>(value: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  unblock.push(() => resolve(value));
  return { promise, resolve: () => resolve(value) };
}
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
function fixture(file = ":memory:") {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-09-08T10:00:00Z"));
  const store = createStore(file);
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
    decryptString: (bytes) => {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const accounts = new GlobalAccountRepository(store.db),
    apps = new GlobalAppRepository(store.db);
  const tokens = new GlobalTokenStore(store.db, encryption),
    vault = new CredentialVault(store.db, encryption);
  const add = (platformId: GlobalPlatformId = "youtube") => {
    if (!apps.get(platformId))
      apps.put({
        platformId,
        clientId: "synthetic-client",
        redirectPort: platformId === "youtube" ? 0 : 13000,
      });
    const account = accounts.create({ platformId });
    const token: GlobalTokenEnvelope = {
      version: 1,
      accountId: account.id,
      platformId,
      remoteId: `remote-${account.id}`,
      accessToken: "synthetic-private-access",
      refreshToken: "synthetic-private-refresh",
      tokenType: "Bearer",
      scopes: [...GLOBAL_APP_PROFILES[platformId].scopes],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    tokens.commitAuthorization(token, { accountId: account.id, platformId, assertCurrent: () => undefined });
    return { account, token };
  };
  const { account, token } = add();
  const data: GlobalReadData = {
    remoteId: token.remoteId,
    profile: { displayName: "Synthetic channel", username: null },
    totals: { followers: "5", following: null, works: null, views: null, likes: null },
    works: [],
    hasMoreWorks: null,
    capabilities: { readProfile: "ready", readMetrics: "scope_required", listWorks: "scope_required" },
  };
  const acquireEligibility = vi.fn<GlobalReadServiceOptions["acquireEligibility"]>(async () => {
    const abort = new AbortController();
    return {
      generation: 1,
      signal: abort.signal,
      isCurrent: () => !abort.signal.aborted,
      release: () => abort.abort(),
    };
  });
  const read = vi.fn<GlobalReadServiceOptions["read"]>(async ({ token: current }) => ({
    ...data,
    remoteId: current.remoteId,
  }));
  const refreshToken = vi.fn<GlobalReadServiceOptions["refreshToken"]>(async (input) => ({
    ...input.token,
    accessToken: "synthetic-rotated-access",
    refreshToken: "synthetic-rotated-refresh",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  const reads = new GlobalReadService({ db: store.db, encryption, acquireEligibility, read, refreshToken });
  services.push(reads);
  let allowed = false;
  const canAttempt = vi.fn(() => allowed),
    changed = vi.fn();
  const queueOptions = {
    db: store.db,
    reads,
    canAttempt,
    onChanged: changed,
    retryMs: 100,
    maxRetryMs: 400,
    gapMs: 10,
    pollMs: 10,
  };
  const queue = new GlobalJobQueue(queueOptions);
  queues.push(queue);
  const repo = new GlobalJobsRepository(store.db);
  return {
    store,
    db: store.db,
    account,
    token,
    tokens,
    accounts,
    apps,
    vault,
    queue,
    queueOptions,
    repo,
    reads,
    read,
    refreshToken,
    data,
    add,
    acquireEligibility,
    canAttempt,
    changed,
    allow: (value = true) => {
      allowed = value;
      queue.sync();
    },
    job: () => queue.list(account.id)[0],
  };
}

describe("durable international read intents", () => {
  it("upgrades v8 without changing existing encrypted grants, public account fields or domestic data", () => {
    const f = fixture(),
      domestic = f.store.accounts.create({ platformId: "douyin" });
    const before = f.accounts.get(f.account.id),
      secrets = f.db.all("SELECT * FROM credentials");
    f.db.exec(
      "DROP TABLE global_jobs; ALTER TABLE global_accounts DROP COLUMN grant_revision; DELETE FROM schema_migrations WHERE version=9;",
    );
    migrate(f.db);
    migrate(f.db);
    expect(f.accounts.get(f.account.id)).toEqual(before);
    expect(f.store.accounts.get(domestic.id)).toEqual(domestic);
    expect(f.db.all("SELECT * FROM credentials")).toEqual(secrets);
    expect(f.tokens.read(f.account.id)).toEqual(f.token);
    expect(f.repo.binding(f.account.id).hash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.db.all("SELECT version FROM schema_migrations WHERE version=9")).toHaveLength(1);
  });
  it("returns an ID immediately, coalesces the account, and does zero credential/proof work while proxy is off", async () => {
    const f = fixture();
    f.queue.start();
    const job = f.queue.submit(f.account.id);
    expect(job).toMatchObject({ state: "waiting-proxy", attempts: 0, kind: "read" });
    for (let i = 0; i < 30; i++) expect(f.queue.submit(f.account.id).id).toBe(job.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.refreshToken).not.toHaveBeenCalled();
    expect(f.job().attempts).toBe(0);
    expect(JSON.stringify(f.queue.list(f.account.id))).not.toMatch(
      /private|binding|grant|token|secret|generation|proxyPort/,
    );
    expect(JSON.stringify(buildBackup(f.store))).not.toContain(job.id);
  });
  it("starts only after the proxy prerequisite, obtains a lease, saves a real snapshot and stops after the requested read", async () => {
    const f = fixture();
    f.queue.start();
    f.queue.submit(f.account.id);
    f.allow();
    await flush();
    expect(f.job()).toMatchObject({ state: "done", attempts: 1 });
    expect(f.reads.get(f.account.id)?.totals.followers).toBe("5");
    expect(f.acquireEligibility).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("uses bounded exponential backoff when a proxy is enabled but cannot be proved, even under repeated sync calls", async () => {
    const f = fixture();
    f.acquireEligibility.mockResolvedValue(null);
    f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.job().state).toBe("waiting-proxy");
    for (let i = 0; i < 30; i++) f.queue.sync();
    await vi.advanceTimersByTimeAsync(90);
    expect(f.acquireEligibility).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.acquireEligibility).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(190);
    expect(f.acquireEligibility).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.acquireEligibility).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(800);
    expect(f.acquireEligibility).toHaveBeenCalledTimes(5);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.refreshToken).not.toHaveBeenCalled();
  });
  it("runs accounts in FIFO order with one worker and a gap after real completion", async () => {
    const f = fixture(),
      second = f.add("x"),
      stalled = defer(f.data);
    f.read.mockReturnValueOnce(stalled.promise);
    f.queue.submit(f.account.id);
    f.queue.submit(second.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read).toHaveBeenCalledTimes(1);
    stalled.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(9);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.read.mock.calls.map(([input]) => input.token.accountId)).toEqual([
      f.account.id,
      second.account.id,
    ]);
    expect(f.queue.list(second.account.id)[0].state).toBe("done");
  });
  it("an unprovable target backs off without starving another platform's eligible task", async () => {
    const f = fixture(),
      second = f.add("x"),
      real = f.acquireEligibility.getMockImplementation()!;
    f.acquireEligibility.mockImplementation((platform, signal) =>
      platform === "youtube" ? Promise.resolve(null) : real(platform, signal),
    );
    f.queue.submit(f.account.id);
    f.queue.submit(second.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.job().state).toBe("waiting-proxy");
    await vi.advanceTimersByTimeAsync(10);
    expect(f.queue.list(second.account.id)[0].state).toBe("done");
    expect(f.read.mock.calls.map(([input]) => input.token.accountId)).toEqual([second.account.id]);
    await vi.advanceTimersByTimeAsync(90);
    expect(f.acquireEligibility.mock.calls.map(([platform]) => platform)).toEqual([
      "youtube",
      "x",
      "youtube",
    ]);
  });
  it("cancels a stalled read immediately but retains the worker until actual HTTP work drains", async () => {
    const f = fixture(),
      stalled = defer(f.data);
    f.read.mockReturnValueOnce(stalled.promise);
    const original = f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.queue.cancel(original.id)?.state).toBe("cancelled");
    const newer = f.queue.submit(f.account.id);
    expect(newer.id).not.toBe(original.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read).toHaveBeenCalledTimes(1);
    let idle = false;
    void f.queue.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    stalled.resolve();
    await flush();
    expect(f.reads.get(f.account.id)).toBeNull();
    expect(f.repo.get(original.id)?.job.state).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(10);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.repo.get(newer.id)?.job.state).toBe("done");
  });
  it("network loss preserves intent without a login error or a late snapshot and resumes only after draining", async () => {
    const f = fixture(),
      stalled = defer(f.data),
      before = f.accounts.get(f.account.id);
    f.read.mockReturnValueOnce(stalled.promise);
    f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    f.allow(false);
    expect(f.job().state).toBe("waiting-proxy");
    f.allow();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read).toHaveBeenCalledTimes(1);
    stalled.resolve();
    await flush();
    expect(f.reads.get(f.account.id)).toBeNull();
    expect(f.accounts.get(f.account.id)).toEqual(before);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.job().state).toBe("done");
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("does not let cancellation of an old completed job abort the account's new job", async () => {
    const f = fixture();
    const old = f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    f.queue.submit(f.account.id);
    const stalled = defer(f.data);
    f.read.mockReturnValueOnce(stalled.promise);
    await vi.advanceTimersByTimeAsync(10);
    f.queue.cancel(old.id);
    expect(f.job().state).toBe("running");
    stalled.resolve();
    await flush();
    expect(f.job().state).toBe("done");
  });
  it.each(["unauthorized", "reauthorization_required"])(
    "does not queue an account whose grant is %s",
    (status) => {
      const f = fixture();
      f.db.run("UPDATE global_accounts SET auth_status=? WHERE id=?", [status, f.account.id]);
      expect(() => f.queue.submit(f.account.id)).toThrow(/^GLOBAL_READ_UNAUTHORIZED$/);
      expect(f.repo.active()).toEqual([]);
      expect(f.acquireEligibility).not.toHaveBeenCalled();
    },
  );
  it("refuses missing credentials before starting any anonymous or business request", () => {
    const f = fixture();
    f.db.run("DELETE FROM credentials WHERE kind='oauth_token'");
    expect(() => f.queue.submit(f.account.id)).toThrow(/^GLOBAL_READ_REAUTHORIZE$/);
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
  it("binds a job to the consent revision, even when reauthorization returns the same identity and exact token", async () => {
    const f = fixture();
    f.queue.submit(f.account.id);
    f.tokens.commitAuthorization(f.token, {
      accountId: f.account.id,
      platformId: "youtube",
      assertCurrent: () => undefined,
    });
    f.allow();
    f.queue.start();
    await flush();
    expect(f.job()).toMatchObject({ state: "cancelled", errorCode: "GLOBAL_READ_REAUTHORIZE" });
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
  it("keeps the consent binding across token refresh and lets the same task finish", async () => {
    const f = fixture();
    f.vault.set({
      kind: "oauth_token",
      ownerId: f.account.id,
      secret: JSON.stringify({ ...f.token, expiresAt: new Date(Date.now() + 1000).toISOString() }),
    });
    const before = f.repo.binding(f.account.id).hash;
    f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.job().state).toBe("done");
    expect(f.refreshToken).toHaveBeenCalledTimes(1);
    expect(f.repo.binding(f.account.id).hash).toBe(before);
  });
  it("cancels pending tasks before an account or platform mutation and never auto-runs them afterward", async () => {
    const f = fixture(),
      second = f.add("x");
    f.queue.submit(f.account.id);
    f.queue.submit(second.account.id);
    f.queue.invalidatePlatform("youtube");
    expect(f.job().state).toBe("cancelled");
    f.queue.invalidateAccount(second.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.acquireEligibility).not.toHaveBeenCalled();
  });
  it("does not accept a late result after deletion and cascades the persisted jobs", async () => {
    const f = fixture(),
      stalled = defer(f.data);
    f.read.mockReturnValue(stalled.promise);
    f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    f.queue.invalidateAccount(f.account.id);
    f.accounts.delete(f.account.id);
    stalled.resolve();
    await flush();
    expect(f.queue.list(f.account.id)).toEqual([]);
    expect(f.reads.get(f.account.id)).toBeNull();
  });
  it.each([
    "GLOBAL_READ_RATE_LIMITED",
    "GLOBAL_READ_FORBIDDEN",
    "GLOBAL_READ_REAUTHORIZE",
    "GLOBAL_READ_RESPONSE_INVALID",
  ])("a business error %s is terminal and never creates an automatic platform retry", async (code) => {
    const f = fixture(),
      before = f.accounts.get(f.account.id);
    f.read.mockRejectedValue(new Error(code));
    f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.job()).toMatchObject({ state: "failed", errorCode: code });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.accounts.get(f.account.id)).toEqual(before);
  });
  it("suspension retains an unfinished intent, and restart begins with no permission", async () => {
    const f = fixture();
    const queued = f.queue.submit(f.account.id);
    f.repo.transition(f.repo.get(queued.id)!, "running");
    const next = new GlobalJobQueue(f.queueOptions);
    queues.push(next);
    expect(next.list(f.account.id)[0]).toMatchObject({ state: "waiting-proxy", attempts: 1 });
    next.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    next.stop();
    f.allow();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read).not.toHaveBeenCalled();
    next.start();
    await flush();
    expect(next.list(f.account.id)[0].state).toBe("done");
  });
  it("persists only intent across a real SQLite close/reopen, with unfinished work recovered to waiting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipdock-global-jobs-"));
    dirs.push(dir);
    const f = fixture(path.join(dir, "jobs.db")),
      job = f.queue.submit(f.account.id);
    await f.queue.dispose();
    queues.splice(queues.indexOf(f.queue), 1);
    await f.reads.dispose();
    services.splice(services.indexOf(f.reads), 1);
    f.repo.transition(f.repo.get(job.id)!, "running");
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = createStore(path.join(dir, "jobs.db"));
    stores.push(reopened);
    const repo = new GlobalJobsRepository(reopened.db);
    repo.recover();
    expect(repo.get(job.id)?.job).toMatchObject({ state: "waiting-proxy", attempts: 1 });
    expect(repo.get(job.id)?.bindingHash).toBe(repo.binding(f.account.id).hash);
  });
  it("ignores a stale worker CAS after cancellation, and validates UUIDs and public data", () => {
    const f = fixture(),
      job = f.queue.submit(f.account.id),
      old = f.repo.transition(f.repo.get(job.id)!, "running")!;
    f.queue.cancel(job.id);
    expect(f.repo.transition(old, "done")).toBeNull();
    expect(() => f.queue.submit("youtube")).toThrow(/^GLOBAL_READ_INPUT_INVALID$/);
    expect(() => f.queue.cancel("Cookie private")).toThrow(/^GLOBAL_READ_INPUT_INVALID$/);
    expect(globalJobSchema.safeParse({ ...job, bindingHash: "secret" }).success).toBe(false);
    expect(globalJobSchema.safeParse({ ...job, state: "done", finishedAt: null }).success).toBe(false);
  });
  it("bounds history while retaining an active task and keeps job details out of the backup", () => {
    const f = fixture();
    for (let i = 0; i < 26; i++) {
      const job = f.queue.submit(f.account.id);
      f.repo.transition(f.repo.get(job.id)!, "done");
    }
    const active = f.queue.submit(f.account.id);
    expect(f.queue.list(f.account.id)).toHaveLength(20);
    expect(f.queue.list(f.account.id)[0].id).toBe(active.id);
    expect(f.db.get("SELECT COUNT(*) AS n FROM global_jobs")?.n).toBe(21);
    const audit = JSON.stringify(f.db.all("SELECT * FROM audit_events WHERE action='GlobalJob'"));
    expect(audit).not.toMatch(/private|binding_hash|grant_revision|accessToken|remote-/);
  });
  it.each(["INSERT", "UPDATE"])(
    "a SQLite %s ignored write cannot produce a successful task transition",
    async (operation) => {
      const f = fixture();
      if (operation === "UPDATE") f.queue.submit(f.account.id);
      f.db.exec(
        `CREATE TRIGGER ignored_job BEFORE ${operation} ON global_jobs BEGIN SELECT RAISE(IGNORE); END;`,
      );
      if (operation === "INSERT")
        expect(() => f.queue.submit(f.account.id)).toThrow(/^GLOBAL_READ_SAVE_FAILED$/);
      else {
        f.allow();
        f.queue.start();
        await flush();
        expect(f.job().state).toBe("waiting-proxy");
      }
      expect(f.acquireEligibility).not.toHaveBeenCalled();
    },
  );
  it("rolls back the task if its audit cannot be committed", () => {
    const f = fixture();
    f.db.exec(
      "CREATE TRIGGER ignore_job_audit BEFORE INSERT ON audit_events WHEN NEW.action='GlobalJob' BEGIN SELECT RAISE(IGNORE); END;",
    );
    expect(() => f.queue.submit(f.account.id)).toThrow(/^GLOBAL_READ_SAVE_FAILED$/);
    expect(f.repo.active()).toEqual([]);
  });
  it("failed durable cancellation aborts work and prevents replay in this process", async () => {
    const f = fixture(),
      stalled = defer(f.data);
    f.read.mockReturnValue(stalled.promise);
    const job = f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    f.db.exec(
      "CREATE TRIGGER ignore_cancel BEFORE UPDATE ON global_jobs WHEN NEW.state='cancelled' BEGIN SELECT RAISE(IGNORE); END;",
    );
    expect(() => f.queue.cancel(job.id)).toThrow(/^GLOBAL_READ_SAVE_FAILED$/);
    stalled.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.reads.get(f.account.id)).toBeNull();
    expect(() => f.queue.submit(f.account.id)).toThrow(/^GLOBAL_READ_UNAVAILABLE$/);
  });
  it("a private platform error and a throwing UI subscriber cannot leak data or change the persisted result", async () => {
    const f = fixture();
    f.read.mockRejectedValue(new Error("Bearer private-secret?code=private"));
    f.changed.mockImplementation(() => {
      throw new Error("ui failed");
    });
    f.queue.submit(f.account.id);
    f.allow();
    f.queue.start();
    await flush();
    expect(f.job()).toMatchObject({ state: "failed", errorCode: "GLOBAL_READ_UNAVAILABLE" });
    expect(JSON.stringify(f.job())).not.toContain("private-secret");
  });
  it("an unknown proxy observation fails closed without touching account status", async () => {
    const f = fixture(),
      before = f.accounts.get(f.account.id);
    f.canAttempt.mockImplementation(() => {
      throw new Error("unknown");
    });
    f.queue.submit(f.account.id);
    f.queue.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.acquireEligibility).not.toHaveBeenCalled();
    expect(f.accounts.get(f.account.id)).toEqual(before);
  });
  it("does not validate an unrelated job UUID as an account request", () => {
    const f = fixture();
    expect(f.queue.cancel(randomUUID())).toBeNull();
    expect(() => f.queue.submit(randomUUID())).toThrow(/^GLOBAL_READ_UNAUTHORIZED$/);
  });
});
