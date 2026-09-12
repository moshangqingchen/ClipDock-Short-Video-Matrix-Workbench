import { z } from "zod";
import { IPC } from "@shared/ipc-channels";
import {
  globalAccountCreateSchema,
  globalAccountIdSchema,
  globalAccountUpdateSchema,
} from "@shared/global-accounts";
import type { GlobalAccountRepository } from "@main/api/global-account-repository";
import type { GlobalAuthorizationStore } from "@main/api/global-authorization-store";
import type { IpcRegistrar } from "../register";

/** Uses the same trusted-shell registrar, with a separate repository and no Session access. */
export function registerGlobalAccountHandlers(
  ipc: IpcRegistrar,
  accounts: GlobalAccountRepository,
  authorization: Pick<GlobalAuthorizationStore, "disconnect">,
  beforeMutation: (accountId: string) => void = () => undefined,
  beforeDelete?: (accountId: string) => Promise<void>,
): void {
  ipc.handleValidated(
    IPC.globalAccountUpdate,
    z.object({ id: globalAccountIdSchema, input: globalAccountUpdateSchema }).strict(),
    (_event, value) => accounts.update(value.id, value.input),
  );
  ipc.handle(IPC.globalAccountList, () => accounts.list());
  ipc.handleValidated(IPC.globalAccountCreate, globalAccountCreateSchema, (_event, input) =>
    accounts.create(input),
  );
  ipc.handleValidated(IPC.globalAccountDelete, globalAccountIdSchema, async (_event, id) => {
    await beforeDelete?.(id);
    beforeMutation(id);
    accounts.delete(id);
  });
  ipc.handleValidated(IPC.globalAccountDisconnect, globalAccountIdSchema, (_event, id) => {
    beforeMutation(id);
    return authorization.disconnect(id);
  });
}
