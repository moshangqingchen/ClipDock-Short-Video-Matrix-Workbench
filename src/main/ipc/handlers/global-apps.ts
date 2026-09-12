import { IPC } from "@shared/ipc-channels";
import { globalPlatformIdSchema } from "@shared/global-accounts";
import { globalAppConfigureSchema } from "@shared/global-apps";
import type { GlobalAppService } from "@main/api/global-app-service";
import type { GlobalPlatformId } from "@shared/platforms";
import type { IpcRegistrar } from "../register";

/** Trusted-shell registrar plus strict input schemas; no raw-secret getter is registered. */
export function registerGlobalAppHandlers(
  ipc: IpcRegistrar,
  apps: GlobalAppService,
  beforeMutation: (platformId: GlobalPlatformId) => void = () => undefined,
): void {
  ipc.handle(IPC.globalAppsList, () => apps.list());
  ipc.handleValidated(IPC.globalAppsConfigure, globalAppConfigureSchema, (_event, input) => {
    beforeMutation(input.platformId);
    return apps.configure(input);
  });
  ipc.handleValidated(IPC.globalAppsClearSecret, globalPlatformIdSchema, (_event, platformId) => {
    beforeMutation(platformId);
    return apps.clearSecret(platformId);
  });
}
