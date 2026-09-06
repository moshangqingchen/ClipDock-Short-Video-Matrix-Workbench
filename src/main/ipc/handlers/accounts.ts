import { z } from "zod";
import { IPC, accountCreateSchema, accountIdSchema, accountUpdateSchema } from "@shared/ipc";
import type { IpcRegistrar } from "../register";
import type { AccountService } from "@main/services/account-service";

export function registerAccountHandlers(ipc: IpcRegistrar, accounts: AccountService): void {
  ipc.handle(IPC.accountList, () => accounts.list());
  ipc.handleValidated(IPC.accountCreate, accountCreateSchema, (_e, input) => accounts.create(input));
  ipc.handle(IPC.accountUpdate, (_e, id: unknown, patch: unknown) => {
    const accountId = accountIdSchema.parse(id);
    return accounts.update(accountId, accountUpdateSchema.parse(patch));
  });
  ipc.handleValidated(IPC.accountDelete, accountIdSchema, (_e, id) => accounts.delete(id));
  ipc.handleValidated(IPC.accountReorder, z.array(accountIdSchema).max(100), (_e, ids) =>
    accounts.reorder(ids),
  );
  ipc.handleValidated(IPC.accountResetEnvironment, accountIdSchema, (_e, id) =>
    accounts.resetEnvironment(id),
  );
  ipc.handleValidated(IPC.accountCheckStatus, accountIdSchema, (_e, id) => accounts.checkStatus(id));
  ipc.handleValidated(IPC.accountRefreshProfile, accountIdSchema, (_e, id) => accounts.refreshProfile(id));
}
