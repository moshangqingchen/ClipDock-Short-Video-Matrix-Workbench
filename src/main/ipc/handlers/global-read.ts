import { IPC } from "@shared/ipc-channels";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { globalReadErrorCode, globalReadSnapshotSchema } from "@shared/global-read";
import type { GlobalReadService } from "@main/api/global-read-service";
import type { IpcRegistrar } from "../register";

export function registerGlobalReadHandlers(ipc: IpcRegistrar, service: Pick<GlobalReadService, "get">): void {
  // Network work is submitted through the durable queue, never through local get().
  ipc.handle(IPC.globalReadGet, async (_event, raw: unknown) => {
    const parsed = globalAccountIdSchema.safeParse(raw);
    if (!parsed.success) throw new Error("GLOBAL_READ_INPUT_INVALID");
    try {
      const value = service.get(parsed.data);
      if (value === null) return null;
      const snapshot = globalReadSnapshotSchema.safeParse(value);
      if (!snapshot.success || snapshot.data.accountId !== parsed.data)
        throw new Error("GLOBAL_READ_UNAVAILABLE");
      return snapshot.data;
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Provider and database errors must not enter IPC.
      throw new Error(globalReadErrorCode(error));
    }
  });
}
