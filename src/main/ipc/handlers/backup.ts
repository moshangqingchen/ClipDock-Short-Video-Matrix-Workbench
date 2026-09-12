import { app, dialog, type BaseWindow } from "electron";
import path from "node:path";
import { IPC, backupExportSchema, backupImportSchema, type BackupImportResult } from "@shared/ipc";
import type { Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import {
  applyBackup,
  assertBackupAccountIdentities,
  buildBackup,
  readBackup,
  writeBackup,
} from "@main/security/backup";
import type { IpcRegistrar } from "../register";
import type { CnPlatformId } from "@shared/platforms";

export interface BackupHandlerDeps {
  store: Store;
  accounts: AccountService;
  pool: ViewPool;
  window: BaseWindow;
  beforeGlobalRestore?(): Promise<void>;
  afterGlobalRestore?(): void;
  validateAccountIdentities?: (rows: readonly { id: string; platformId: CnPlatformId }[]) => void;
}

export function registerBackupHandlers(ipc: IpcRegistrar, deps: BackupHandlerDeps): void {
  ipc.handleValidated(IPC.backupExport, backupExportSchema, async (_e, options) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const result = await dialog.showSaveDialog(deps.window, {
      title: "导出备份",
      defaultPath: path.join(app.getPath("documents"), `矩阵工作台备份-${stamp}.svbak`),
      filters: [{ name: "工作台备份", extensions: ["svbak", "json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const payload = buildBackup(deps.store, app.getVersion());
    const metadata = await writeBackup(result.filePath, payload, options.password);
    deps.store.audit.append({
      action: "backup.export",
      details: { accounts: metadata.accountCount, encrypted: metadata.encrypted },
    });
    return metadata;
  });

  ipc.handleValidated(
    IPC.backupImport,
    backupImportSchema,
    async (_e, options): Promise<BackupImportResult | null> => {
      const result = await dialog.showOpenDialog(deps.window, {
        title: "导入备份",
        properties: ["openFile"],
        filters: [{ name: "工作台备份", extensions: ["svbak", "json"] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const payload = await readBackup(result.filePaths[0], options.password);
      assertBackupAccountIdentities(deps.store, payload);
      deps.validateAccountIdentities?.(payload.accounts);
      if (options.mode === "replace") {
        // Views of accounts about to disappear must be torn down first; their
        // partitions are left untouched so re-adding the same id logs back in.
        for (const account of deps.accounts.list()) {
          await deps.accounts.prepareSessionChange(account.id, "restore");
          deps.pool.remove(account.id);
        }
      }
      if (payload.global) await deps.beforeGlobalRestore?.();
      let accountsImported: number;
      try {
        accountsImported = applyBackup(deps.store, payload, options.mode);
      } finally {
        if (payload.global) deps.afterGlobalRestore?.();
      }
      deps.store.audit.append({
        action: "backup.import",
        details: { accounts: accountsImported, mode: options.mode },
      });
      deps.accounts.emit("accounts-reloaded");
      return { metadata: payload.metadata, accountsImported };
    },
  );
}
