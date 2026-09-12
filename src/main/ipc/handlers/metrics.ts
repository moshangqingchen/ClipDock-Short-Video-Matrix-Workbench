import { z } from "zod";
import { IPC, accountIdSchema, platformIdSchema } from "@shared/ipc";
import type { PlatformId } from "@shared/platforms";
import type { Store } from "@main/db";
import type { CollectScheduler } from "@main/data/scheduler";
import { ReadModel } from "@main/data/read-model";
import type { AccountService } from "@main/services/account-service";
import type { IpcRegistrar } from "../register";
import { createMediaProjection, type MediaProjection } from "@main/services/media-projection";

export interface MetricsHandlerDeps {
  store: Store;
  scheduler: CollectScheduler;
  accounts: AccountService;
  media?: MediaProjection;
}

const daysSchema = z.number().int().min(1).max(365).optional();
const limitSchema = z.number().int().min(1).max(500).optional();

export function registerMetricsHandlers(ipc: IpcRegistrar, deps: MetricsHandlerDeps): void {
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
  ipc.handle(IPC.metricsRuns, (_e, id: unknown, limit: unknown) =>
    deps.store.metrics.listRuns(accountIdSchema.parse(id), limitSchema.parse(limit) ?? 20),
  );
  ipc.handle(IPC.worksList, (_e, id: unknown, limit: unknown) =>
    media.projectWorks(
      deps.store.metrics.listWorks(accountIdSchema.parse(id), limitSchema.parse(limit) ?? 50),
    ),
  );
}
