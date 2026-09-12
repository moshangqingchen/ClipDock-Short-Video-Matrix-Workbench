import { IPC } from "@shared/ipc-channels";
import { globalAccountIdSchema } from "@shared/global-accounts";
import {
  globalWebCapabilitySchema,
  globalWebCommandSchema,
  globalWebErrorCode,
  globalWebStateSchema,
} from "@shared/global-web";
import { boundsSchema } from "@shared/ipc";
import type { GlobalWebService } from "@main/services/global-web-service";
import type { IpcRegistrar } from "../register";
import {
  webObservationSchema,
  webObservationHistorySchema,
  webObserveErrorCode,
} from "@shared/global-web-observation";

export function registerGlobalWebHandlers(
  ipc: IpcRegistrar,
  service: Pick<
    GlobalWebService,
    | "state"
    | "open"
    | "openChrome"
    | "openExternal"
    | "close"
    | "show"
    | "hide"
    | "go"
    | "command"
    | "observation"
    | "observationHistory"
    | "readPage"
  > &
    Partial<Pick<GlobalWebService, "ensureOpen">>,
  beforeClose?: (id: string) => void,
): void {
  ipc.handleValidated(IPC.globalWebObservationHistory, globalAccountIdSchema, async (_event, id) => {
    try {
      const values = webObservationHistorySchema.parse(service.observationHistory(id));
      if (values.some((value) => value.accountId !== id)) throw new Error("WEB_OBSERVE_UNAVAILABLE");
      return values;
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Only fixed errors cross the bridge.
      throw new Error(webObserveErrorCode(error));
    }
  });
  for (const [channel, method] of [
    [IPC.globalWebObservation, "observation"],
    [IPC.globalWebReadPage, "readPage"],
  ] as const) {
    ipc.handleValidated(channel, globalAccountIdSchema, async (_event, id) => {
      try {
        const raw = await service[method](id);
        if (raw === null && method === "observation") return null;
        const value = webObservationSchema.parse(raw);
        if (value.accountId !== id) throw new Error("WEB_OBSERVE_UNAVAILABLE");
        return value;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Do not expose raw page text or native paths.
        throw new Error(webObserveErrorCode(error));
      }
    });
  }
  for (const [channel, method] of [
    [IPC.globalWebState, "state"],
    [IPC.globalWebOpen, "open"],
    [IPC.globalWebOpenChrome, "openChrome"],
    [IPC.globalWebClose, "close"],
  ] as const) {
    ipc.handleValidated(channel, globalAccountIdSchema, async (_event, id) => {
      try {
        if (method === "close" || method === "openChrome") beforeClose?.(id);
        const state = globalWebStateSchema.parse(
          await (method === "open" && service.ensureOpen ? service.ensureOpen(id) : service[method](id)),
        );
        if (state.accountId !== id) throw new Error("GLOBAL_WEB_UNAVAILABLE");
        return state;
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- Browser paths and native errors must stay in main.
        throw new Error(globalWebErrorCode(error));
      }
    });
  }
  ipc.handleValidated(IPC.globalWebOpenExternal, globalAccountIdSchema, async (_event, id) => {
    try {
      return globalWebStateSchema.parse(await service.openExternal(id));
    } catch (error) {
      throw new Error(globalWebErrorCode(error), { cause: error });
    }
  });
  if (typeof ipc.handle === "function") {
    ipc.handle(IPC.globalWebShow, (_event, id: unknown, bounds: unknown) =>
      service.show(globalAccountIdSchema.parse(id), boundsSchema.parse(bounds)),
    );
    ipc.handleValidated(IPC.globalWebHide, globalAccountIdSchema, (_event, id) => service.hide(id));
    ipc.handle(IPC.globalWebGo, (_event, id: unknown, capability: unknown) =>
      service.go(globalAccountIdSchema.parse(id), globalWebCapabilitySchema.parse(capability)),
    );
    ipc.handle(IPC.globalWebCommand, (_event, id: unknown, command: unknown) =>
      service.command(globalAccountIdSchema.parse(id), globalWebCommandSchema.parse(command)),
    );
  }
}
