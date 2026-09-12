import type { Database } from "@main/db/database";
import type { GlobalPlatformId } from "@shared/platforms";
import { isActiveGlobalJob, type GlobalJob } from "@shared/global-jobs";
import { globalReadErrorCode, type GlobalReadErrorCode } from "@shared/global-read";
import type { GlobalReadService } from "./global-read-service";
import { GlobalJobsRepository, type StoredGlobalJob } from "./global-jobs-repository";

interface Options {
  db: Database;
  reads: Pick<GlobalReadService, "refresh" | "cancel" | "invalidate" | "whenIdle">;
  /** Only a prerequisite. GlobalReadService must still acquire a fresh, target-bound proxy lease. */
  canAttempt(): boolean;
  onChanged?(job: GlobalJob): void;
  now?(): number;
  retryMs?: number;
  maxRetryMs?: number;
  gapMs?: number;
  pollMs?: number;
}

/** One FIFO worker for explicit read intents; no automatic publishing or periodic platform reads. */
export class GlobalJobQueue {
  private readonly repo: GlobalJobsRepository;
  private readonly now: () => number;
  private readonly timing;
  private running = false;
  private disposed = false;
  private faulted = false;
  private ready = false;
  private readonly retries = new Map<string, { failures: number; nextAt: number }>();
  private nextAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flight: Promise<void> | null = null;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now());
    this.timing = {
      retry: options.retryMs ?? 30_000,
      maxRetry: options.maxRetryMs ?? 300_000,
      gap: options.gapMs ?? 1000,
      poll: options.pollMs ?? 1000,
    };
    if (
      Object.values(this.timing).some((n) => !Number.isSafeInteger(n) || n < 1) ||
      this.timing.maxRetry < this.timing.retry
    )
      throw new Error("GLOBAL_READ_INPUT_INVALID");
    this.repo = new GlobalJobsRepository(options.db);
    this.repo.recover();
  }
  submit(accountId: string): GlobalJob {
    if (this.disposed || this.faulted) throw new Error("GLOBAL_READ_UNAVAILABLE");
    const job = this.repo.submit(accountId);
    this.emit(job);
    // IPC returns persisted intent before any diagnostic or credential work starts.
    return job;
  }
  list(accountId: string): GlobalJob[] {
    return this.repo.list(accountId);
  }
  cancel(jobId: string): GlobalJob | null {
    try {
      const current = this.repo.get(jobId);
      if (!current || !isActiveGlobalJob(current.job)) return current?.job ?? null;
      this.options.reads.cancel(current.job.accountId);
      const cancelled = this.repo.transition(current, "cancelled", "GLOBAL_READ_CANCELLED");
      this.retries.delete(jobId);
      if (cancelled) this.emit(cancelled.job);
      return cancelled?.job ?? this.repo.get(jobId)?.job ?? null;
    } catch (error) {
      // A failed durable cancellation must not permit an automatic replay in this process.
      if (globalReadErrorCode(error) !== "GLOBAL_READ_INPUT_INVALID") this.halt();
      throw error;
    }
  }
  invalidateAccount(accountId: string): void {
    for (const item of this.repo.active()) if (item.job.accountId === accountId) this.cancel(item.job.id);
    this.options.reads.cancel(accountId);
  }
  invalidatePlatform(platformId: GlobalPlatformId): void {
    for (const item of this.repo.active()) if (item.job.platformId === platformId) this.cancel(item.job.id);
  }
  start(): void {
    if (this.running || this.disposed || this.faulted) return;
    this.running = true;
    this.timer = setInterval(() => this.sync(), this.timing.poll);
    this.timer.unref?.();
    this.sync();
  }
  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.invalidateNetwork();
  }
  invalidateNetwork(): void {
    this.ready = false;
    // Revoke underlying work before changing its persisted intent.
    this.options.reads.invalidate();
    try {
      for (const item of this.repo.active())
        if (item.job.state !== "waiting-proxy") {
          const next = this.repo.transition(item, "waiting-proxy", "GLOBAL_READ_WAITING_PROXY");
          if (next) this.emit(next.job);
        }
    } catch {
      this.halt();
    }
  }
  sync(): void {
    if (!this.running || this.disposed || this.faulted) return;
    try {
      let allowed = false;
      try {
        allowed = this.options.canAttempt() === true;
      } catch {
        /* Unknown is closed. */
      }
      if (!allowed) {
        if (this.ready || this.flight) this.invalidateNetwork();
        return;
      }
      if (!this.ready) {
        this.ready = true;
        this.retries.clear();
        this.nextAt = Math.min(this.nextAt, this.now());
      }
      if (this.flight || this.now() < this.nextAt) return;
      const item = this.repo.active().find((candidate) => {
        let matches = false;
        try {
          matches = this.repo.binding(candidate.job.accountId).hash === candidate.bindingHash;
        } catch {
          /* Obsolete authorization. */
        }
        if (!matches) {
          const cancelled = this.repo.transition(candidate, "cancelled", "GLOBAL_READ_REAUTHORIZE");
          if (cancelled) this.emit(cancelled.job);
        }
        return matches && (this.retries.get(candidate.job.id)?.nextAt ?? 0) <= this.now();
      });
      if (!item) return;
      const started = this.repo.transition(item, "running");
      if (!started) return;
      const pending = Promise.resolve()
        .then(() => this.execute(started))
        .catch(() => this.halt())
        .finally(() => {
          if (this.flight === pending) this.flight = null;
        });
      this.flight = pending;
      this.emit(started.job);
    } catch {
      this.halt();
    }
  }
  async whenIdle(): Promise<void> {
    while (this.flight) await this.flight;
    await this.options.reads.whenIdle();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stop();
    await this.whenIdle();
  }
  private async execute(item: StoredGlobalJob): Promise<void> {
    let errorCode: GlobalReadErrorCode | null = null;
    try {
      await this.options.reads.refresh(item.job.accountId, () => {
        if (!this.running || this.disposed || !this.ready || this.options.canAttempt() !== true)
          throw new Error("GLOBAL_READ_WAITING_PROXY");
        this.repo.assertCurrent(item);
      });
    } catch (error) {
      errorCode = globalReadErrorCode(error);
    }
    // Public cancellation can win a race while the real HTTP/Windows reader is still draining.
    await this.options.reads.whenIdle();
    const waiting = errorCode === "GLOBAL_READ_WAITING_PROXY" || errorCode === "GLOBAL_READ_BUSY";
    if (waiting) {
      const failures = Math.min((this.retries.get(item.job.id)?.failures ?? 0) + 1, 16);
      this.retries.set(item.job.id, {
        failures,
        nextAt: this.now() + Math.min(this.timing.maxRetry, this.timing.retry * 2 ** (failures - 1)),
      });
    } else this.retries.delete(item.job.id);
    this.nextAt = this.now() + this.timing.gap;
    const next = this.repo.transition(
      item,
      waiting ? "waiting-proxy" : errorCode ? "failed" : "done",
      errorCode,
    );
    if (!next) {
      const current = this.repo.get(item.job.id);
      if (!current || !isActiveGlobalJob(current.job)) this.retries.delete(item.job.id);
    }
    if (next) this.emit(next.job);
  }
  private emit(job: GlobalJob): void {
    try {
      this.options.onChanged?.(structuredClone(job));
    } catch {
      /* A UI subscriber cannot change persisted intent. */
    }
  }
  private halt(): void {
    this.faulted = true;
    this.running = false;
    this.ready = false;
    clearInterval(this.timer);
    this.options.reads.invalidate();
  }
}
