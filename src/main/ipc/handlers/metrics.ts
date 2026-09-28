import { z } from "zod";
import { IPC, accountIdSchema, platformIdSchema } from "@shared/ipc";
import type { PlatformId } from "@shared/platforms";
import type { Store } from "@main/db";
import type { CollectScheduler } from "@main/data/scheduler";
import { ReadModel } from "@main/data/read-model";
import type { AccountService } from "@main/services/account-service";
import type { IpcRegistrar } from "../register";
import { createMediaProjection, type MediaProjection } from "@main/services/media-projection";
import type { BusinessAnalyticsService } from "@main/data/business-analytics-service";

export interface MetricsHandlerDeps {
  analytics?: BusinessAnalyticsService;
  store: Store;
  scheduler: CollectScheduler;
  accounts: AccountService;
  media?: MediaProjection;
}

const daysSchema = z.number().int().min(1).max(365).optional();
const limitSchema = z.number().int().min(1).max(500).optional();

export function registerMetricsHandlers(ipc: IpcRegistrar, deps: MetricsHandlerDeps): void {
  ipc.handle(IPC.analyticsGet, (_e, id: unknown, days: unknown) => {
    if (!deps.analytics) throw new Error("经营分析不可用");
    return deps.analytics.repository.view(accountIdSchema.parse(id), z.union([z.literal(7), z.literal(30), z.literal(90)]).optional().parse(days) ?? 90);
  });
  ipc.handle(IPC.analyticsEnable, (_e, platform: unknown, enabled: unknown) => {
    if (!deps.analytics) throw new Error("经营分析不可用");
    deps.analytics.repository.setEnabled(platformIdSchema.parse(platform), z.boolean().parse(enabled));
  });
  ipc.handle(IPC.analyticsReadPage, (_e, id: unknown) => {
    if (!deps.analytics) throw new Error("经营分析不可用");
    const accountId = accountIdSchema.parse(id);
    deps.analytics.assertCurrentPage(accountId);
    const active = deps.scheduler.listJobs(accountId).find((job) => ["queued", "running", "waiting-network"].includes(job.state));
    if (active && active.progress?.scope !== "analytics") throw new Error("该账号已有采集任务，请待其完成或取消后读取经营页面");
    deps.scheduler.enqueue(accountId, "manual", "analytics");
    return deps.analytics.repository.view(accountId);
  });
  const readModel = new ReadModel(deps.store);
  const media = deps.media ?? createMediaProjection({ enforcement: "strict" });
  ipc.handle(IPC.metricsAccount, (_e, id: unknown, days: unknown) =>
    readModel.account(accountIdSchema.parse(id), daysSchema.parse(days) ?? 30),
  );
  ipc.handle(IPC.metricsPlatform, (_e, platformId: unknown, days: unknown) =>
    media.projectPlatformSummary(
      readModel.platform(platformIdSchema.parse(platformId) as PlatformId, daysSchema.parse(days) ?? 30),
    ),
  );
  ipc.handle(IPC.metricsOverview, (_e, days: unknown) =>
    media.projectOverview(readModel.overview(daysSchema.parse(days) ?? 30)),
  );
  deps.scheduler.onJobChange((job) => ipc.send(IPC.evCollectJob, job));
  ipc.handle(IPC.metricsCollectNow, (_e, id: unknown) => {
    if (id == null) return deps.scheduler.collectAll("manual");
    return [deps.scheduler.enqueue(accountIdSchema.parse(id), "manual")];
  });
  ipc.handle(IPC.metricsJobs, (_e, id: unknown) =>
    deps.scheduler.listJobs(id == null ? undefined : accountIdSchema.parse(id)),
  );
  ipc.handle(IPC.metricsCancelJob, (_e, id: unknown) => deps.scheduler.cancelJob(accountIdSchema.parse(id)));
  ipc.handle(IPC.metricsHistory, (_e, id: unknown) => deps.scheduler.enqueue(accountIdSchema.parse(id), "manual", "history"));
  ipc.handle(IPC.metricsPauseJob, (_e, id: unknown, paused: unknown) => deps.scheduler.pauseJob(accountIdSchema.parse(id), z.boolean().parse(paused)));
  ipc.handle(IPC.metricsRetryJob, (_e, id: unknown) => deps.scheduler.retryJob(accountIdSchema.parse(id)));
  ipc.handle(IPC.metricsRuns, (_e, id: unknown, limit: unknown) =>
    deps.store.metrics.listRuns(accountIdSchema.parse(id), limitSchema.parse(limit) ?? 20),
  );
  ipc.handle(IPC.worksList, (_e, id: unknown, limit: unknown, offset: unknown) =>
    media.projectWorks(
      deps.store.metrics.listWorks(accountIdSchema.parse(id), limitSchema.parse(limit) ?? 50, z.number().int().min(0).max(1_000_000).optional().parse(offset) ?? 0),
    ),
  );
}
