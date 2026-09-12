import { IPC, accountIdSchema, boundsSchema, viewGoSchema } from "@shared/ipc";
import { decideTopLevelNavigation } from "@main/browser/navigation-policy";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import type { IpcRegistrar } from "../register";

export function registerViewHandlers(ipc: IpcRegistrar, pool: ViewPool, accounts: AccountService): void {
  ipc.handle(IPC.viewShow, (_e, id: unknown, bounds: unknown, enterHomepage: unknown = false) => {
    if (typeof enterHomepage !== "boolean") throw new Error("主页入口参数无效");
    return accounts.showView(accountIdSchema.parse(id), boundsSchema.parse(bounds), enterHomepage);
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
    accounts.prepareNetworkOperation(accountId, "view-navigate", decision.url);
    accounts.ensureView(accountId);
    await pool.navigate(accountId, decision.url);
  });
  ipc.handle(IPC.viewGo, (_e, id: unknown, route: unknown) =>
    accounts.go(accountIdSchema.parse(id), viewGoSchema.parse(route)),
  );
  ipc.handleValidated(IPC.viewReload, accountIdSchema, (_e, id) => pool.reload(id));
  const moveHistory = (id: string, direction: "back" | "forward") => {
    const account = accounts.get(id);
    const target = pool.historyTarget(id, direction);
    if (!target) return;
    const decision = decideTopLevelNavigation(account.platformId, target);
    if (decision.action !== "allow") throw new Error("该历史地址不属于此平台，已拒绝打开");
    accounts.prepareNetworkOperation(id, "view-navigate", decision.url);
    if (direction === "back") pool.back(id);
    else pool.forward(id);
  };
  ipc.handleValidated(IPC.viewBack, accountIdSchema, (_e, id) => moveHistory(id, "back"));
  ipc.handleValidated(IPC.viewForward, accountIdSchema, (_e, id) => moveHistory(id, "forward"));
  ipc.handleValidated(IPC.viewStop, accountIdSchema, (_e, id) => pool.stop(id));
  ipc.handleValidated(IPC.viewState, accountIdSchema, (_e, id) => pool.getState(id));
  ipc.handle(IPC.viewStates, () => pool.listStates());
  ipc.handleValidated(IPC.viewOpenDevTools, accountIdSchema, (_e, id) => pool.openDevTools(id));
}
