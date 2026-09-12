import { IPC } from "@shared/ipc-channels";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { globalOAuthErrorCode, projectGlobalOAuthState, type GlobalOAuthState } from "@shared/global-oauth";
import type { GlobalOAuthService } from "@main/api/global-oauth-service";
import type { IpcRegistrar } from "../register";

/** Only the existing trusted-shell registrar may bind these explicit user actions. */
export function registerGlobalOAuthHandlers(
  ipc: IpcRegistrar,
  oauth: Pick<GlobalOAuthService, "state" | "start" | "cancel"> &
    Partial<Pick<GlobalOAuthService, "startDraft" | "startUpload">>,
): void {
  for (const [channel, operation] of [
    [IPC.globalOAuthState, "state"],
    [IPC.globalOAuthStart, "start"],
    [IPC.globalOAuthStartDraft, "startDraft"],
    [IPC.globalOAuthStartUpload, "startUpload"],
    [IPC.globalOAuthCancel, "cancel"],
  ] as const)
    ipc.handle(channel, async (_event, raw: unknown) => {
      const parsed = globalAccountIdSchema.safeParse(raw);
      if (!parsed.success) throw new Error("GLOBAL_OAUTH_INVALID_ACCOUNT");
      const accountId = parsed.data;
      try {
        const method: ((id: string) => GlobalOAuthState | Promise<GlobalOAuthState>) | undefined =
          oauth[operation];
        if (!method) throw new Error("GLOBAL_OAUTH_UNAVAILABLE");
        const state = projectGlobalOAuthState(await method.call(oauth, accountId));
        if (!state || state.accountId !== accountId) throw new Error("GLOBAL_OAUTH_UNAVAILABLE");
        return state;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Never copy a private provider/database cause to IPC errors.
        throw new Error(globalOAuthErrorCode(error));
      }
    });
}
