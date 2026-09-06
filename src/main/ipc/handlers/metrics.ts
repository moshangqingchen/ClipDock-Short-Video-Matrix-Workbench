import { z } from "zod";
import { IPC, accountIdSchema, platformIdSchema } from "@shared/ipc";
import type { PlatformId } from "@shared/platforms";
import type { Store } from "@main/db";
import type { CollectScheduler } from "@main/data/scheduler";
import { ReadModel } from "@main/data/read-model";
import type { AccountService } from "@main/services/account-service";
import type { IpcRegistrar } from "../register";

export interface MetricsHandlerDeps {
  store: Store;
  scheduler: CollectScheduler;
  accounts: AccountService;
}

const daysSchema = z.number().int().min(1).max(365).optional();
const limitSchema = z.number().int().min(1).max(500).optional();

export function registerMetricsHandlers(ipc: IpcRegistrar, deps: MetricsHandlerDeps): void {
  const readModel = new ReadModel(deps.store);
  ipc.handle(IPC.metricsAccount, (_e, id: unknown, days: unknown) =>
    readModel.account(accountIdSchema.parse(id), daysSchema.parse(days) ?? 30),
  );
  ipc.handle(IPC.metricsPlatform, (_e, platformId: unknown, days: unknown) =>
    readModel.platform(platformIdSchema.parse(platformId) as PlatformId, daysSchema.parse(days) ?? 30),
  );
  ipc.handle(IPC.metricsOverview, (_e, days: unknown) => readModel.overview(daysSchema.parse(days) ?? 30));
  ipc.handle(IPC.metricsCollectNow, async (_e, id: unknown) => {
    if (id == null) return deps.scheduler.collectAll("manual");
    const run = await deps.scheduler.enqueue(accountIdSchema.parse(id), "manual");
    return run ? [run] : [];
  });
  ipc.handle(IPC.metricsRuns, (_e, id: unknown, limit: unknown) =>
    deps.store.metrics.listRuns(accountIdSchema.parse(id), limitSchema.parse(limit) ?? 20),
  );
  ipc.handle(IPC.worksList, (_e, id: unknown, limit: unknown) =>
    deps.store.metrics.listWorks(accountIdSchema.parse(id), limitSchema.parse(limit) ?? 50),
  );
}
