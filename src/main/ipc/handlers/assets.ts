import { z } from "zod";
import type { BaseWindow } from "electron";
import { IPC } from "@shared/ipc";
import type { AssetService } from "@main/services/asset-service";
import type { IpcRegistrar } from "../register";

const idSchema = z.string().uuid();

export function registerAssetHandlers(ipc: IpcRegistrar, assets: AssetService, window: BaseWindow): void {
  ipc.handle(IPC.assetList, () => assets.list());
  ipc.handle(IPC.assetImport, () => assets.importFromDialog(window));
  ipc.handleValidated(IPC.assetRemove, idSchema, (_e, id) => assets.remove(id));
  ipc.handleValidated(IPC.assetReveal, idSchema, (_e, id) => assets.reveal(id));
  ipc.handleValidated(IPC.assetThumbnail, idSchema, (_e, id) => assets.thumbnailUrl(id));
}
