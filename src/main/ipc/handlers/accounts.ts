import { z } from "zod";
import { IPC, accountCreateSchema, accountIdSchema, accountUpdateSchema } from "@shared/ipc";
import type { IpcRegistrar } from "../register";
import type { AccountService } from "@main/services/account-service";
import { createMediaProjection, type MediaProjection } from "@main/services/media-projection";

export function registerAccountHandlers(
  ipc: IpcRegistrar,
  accounts: AccountService,
  media: MediaProjection = createMediaProjection({ enforcement: "strict" }),
): void {
  ipc.handle(IPC.accountList, () => {
    const list = accounts.list();
    const result = media.projectAccounts(list);
    return result;
  });
  ipc.handleValidated(IPC.accountCreate, accountCreateSchema, (_e, input) =>
    media.projectAccount(accounts.create(input)),
  );
  ipc.handle(IPC.accountUpdate, (_e, id: unknown, patch: unknown) => {
    const accountId = accountIdSchema.parse(id);
    return media.projectAccount(accounts.update(accountId, accountUpdateSchema.parse(patch)));
  });
  ipc.handleValidated(IPC.accountDelete, accountIdSchema, (_e, id) => accounts.delete(id));
  ipc.handleValidated(IPC.accountReorder, z.array(accountIdSchema).max(100), (_e, ids) =>
    accounts.reorder(ids),
  );
  ipc.handleValidated(IPC.accountResetEnvironment, accountIdSchema, (_e, id) =>
    accounts.resetEnvironment(id).then(media.projectAccount),
  );
  ipc.handleValidated(IPC.accountCheckStatus, accountIdSchema, (_e, id) =>
    accounts.checkStatus(id, { force: true, refreshPage: true }).then(media.projectAccount),
  );
  ipc.handleValidated(IPC.accountRefreshProfile, accountIdSchema, (_e, id) =>
    accounts.refreshProfile(id).then(media.projectAccount),
  );
}
