import { z } from "zod";
import { GLOBAL_WORKSPACE_CHANNEL, globalPublishInputSchema } from "@shared/global-workspace";
import { globalAccountIdSchema } from "@shared/global-accounts";
import type { GlobalWorkspaceService } from "@main/services/global-workspace-service";
import type { IpcRegistrar } from "../register";

export function registerGlobalWorkspaceHandlers(ipc: IpcRegistrar, service: GlobalWorkspaceService): void {
  for (const method of [
    "openLoginWindow",
    "identity",
    "checkLogin",
    "resetEnvironment",
    "openDevTools",
    "openSystemBrowser",
    "works",
    "collect",
    "cancelJob",
    "publishDelete",
    "openUpload",
  ] as const) {
    ipc.handleValidated(GLOBAL_WORKSPACE_CHANNEL + method, globalAccountIdSchema, (_event, id) =>
      service[method](id),
    );
  }
  for (const method of ["jobs", "publishList"] as const)
    ipc.handleValidated(GLOBAL_WORKSPACE_CHANNEL + method, globalAccountIdSchema.optional(), (_event, id) =>
      service[method](id),
    );
  ipc.handleValidated(GLOBAL_WORKSPACE_CHANNEL + "publishSave", globalPublishInputSchema, (_event, input) =>
    service.publishSave(input),
  );
  ipc.handleValidated(
    GLOBAL_WORKSPACE_CHANNEL + "attachFiles",
    z.object({ id: globalAccountIdSchema, assetIds: z.array(z.uuid()).max(50) }).strict(),
    (_event, input) => service.attachFiles(input.id, input.assetIds),
  );
  ipc.handleValidated(
    GLOBAL_WORKSPACE_CHANNEL + "useBrowser",
    z.object({ id: globalAccountIdSchema, engine: z.enum(["chrome", "embedded"]) }).strict(),
    (_event, input) => service.useBrowser(input.id, input.engine),
  );
  ipc.handleValidated(
    GLOBAL_WORKSPACE_CHANNEL + "openWork",
    z.object({ id: globalAccountIdSchema, remoteId: z.string().min(1).max(256) }).strict(),
    (_event, input) => service.openWork(input.id, input.remoteId),
  );
}
