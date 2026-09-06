import { IPC, accountIdSchema, boundsSchema, viewGoSchema } from "@shared/ipc";
import { decideTopLevelNavigation } from "@main/browser/navigation-policy";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import type { IpcRegistrar } from "../register";

export function registerViewHandlers(ipc: IpcRegistrar, pool: ViewPool, accounts: AccountService): void {
  ipc.handle(IPC.viewShow, (_e, id: unknown, bounds: unknown) => {
    return accounts.showView(accountIdSchema.parse(id), boundsSchema.parse(bounds));
  });
  ipc.handleValidated(IPC.viewHide, accountIdSchema, (_e, id) => pool.hide(id));
  ipc.handle(IPC.viewHideAll, () => pool.hideAll());
  ipc.handle(IPC.viewSetBounds, (_e, id: unknown, bounds: unknown) => {
    pool.setBounds(accountIdSchema.parse(id), boundsSchema.parse(bounds));
  });
  ipc.handle(IPC.viewNavigate, async (_e, id: unknown, url: unknown) => {
    const accountId = accountIdSchema.parse(id);
    if (typeof url !== "string" || url.length > 4000) throw new Error("URL 无效");
    const account = accounts.get(accountId);
    const decision = decideTopLevelNavigation(
      account.platformId,
      url.startsWith("http") ? url : `https://${url}`,
    );
    if (decision.action !== "allow") throw new Error("该地址不属于此平台,已拒绝在账号环境内打开");
    accounts.ensureView(accountId);
    await pool.navigate(accountId, decision.url);
  });
  ipc.handle(IPC.viewGo, (_e, id: unknown, route: unknown) =>
    accounts.go(accountIdSchema.parse(id), viewGoSchema.parse(route)),
  );
  ipc.handleValidated(IPC.viewReload, accountIdSchema, (_e, id) => pool.reload(id));
  ipc.handleValidated(IPC.viewBack, accountIdSchema, (_e, id) => pool.back(id));
  ipc.handleValidated(IPC.viewForward, accountIdSchema, (_e, id) => pool.forward(id));
  ipc.handleValidated(IPC.viewStop, accountIdSchema, (_e, id) => pool.stop(id));
  ipc.handleValidated(IPC.viewState, accountIdSchema, (_e, id) => pool.getState(id));
  ipc.handle(IPC.viewStates, () => pool.listStates());
  ipc.handleValidated(IPC.viewOpenDevTools, accountIdSchema, (_e, id) => pool.openDevTools(id));
}
