import fs from "node:fs";
import type { WebContents } from "electron";
import type { PublishRecord, PublishRecordInput } from "@shared/types";
import type { Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import type { AssetService } from "./asset-service";

export interface PublishServiceOptions {
  store: Store;
  pool: ViewPool;
  accounts: AccountService;
  assets: AssetService;
}

/**
 * The publish assistant never uploads on the operator's behalf. It opens the
 * platform's own upload page inside the account view, hands local files to
 * that page's `<input type=file>` through the DevTools protocol (the same
 * thing a drag-and-drop would do) and records what was planned/published.
 */
export class PublishService {
  constructor(private readonly options: PublishServiceOptions) {}

  list(accountId?: string): PublishRecord[] {
    return this.options.store.publish.list(accountId);
  }

  save(input: PublishRecordInput): PublishRecord {
    const account = this.options.accounts.get(input.accountId);
    const record = this.options.store.publish.save(input, account.platformId);
    this.options.store.audit.append({
      action: "publish.save",
      accountId: input.accountId,
      details: { id: record.id, status: record.status },
    });
    return record;
  }

  delete(id: string): void {
    this.options.store.publish.delete(id);
  }

  async openUpload(accountId: string): Promise<void> {
    await this.options.accounts.go(accountId, "upload");
  }

  async attachFiles(accountId: string, assetIds: string[]): Promise<{ attached: number; message?: string }> {
    const account = this.options.accounts.get(accountId);
    const files = assetIds
      .map((id) => this.options.assets.get(id))
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
      .map((asset) => asset.filePath)
      .filter((file) => fs.existsSync(file));
    if (files.length === 0) return { attached: 0, message: "没有可用的素材文件" };

    const wc = this.options.pool.getWebContents(accountId);
    if (!wc) return { attached: 0, message: "请先打开该账号的上传页面" };
    void account;
    return attachThroughDevtools(wc, files);
  }
}

async function attachThroughDevtools(
  wc: WebContents,
  files: string[],
): Promise<{ attached: number; message?: string }> {
  const dbg = wc.debugger;
  const attachedHere = !dbg.isAttached();
  try {
    if (attachedHere) dbg.attach("1.3");
    const { root } = (await dbg.sendCommand("DOM.getDocument", { depth: -1, pierce: true })) as {
      root: { nodeId: number };
    };
    const { nodeIds } = (await dbg.sendCommand("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "input[type=file]",
    })) as {
      nodeIds: number[];
    };
    if (!nodeIds || nodeIds.length === 0) {
      return { attached: 0, message: "当前页面没有文件上传控件,请先进入上传页" };
    }
    // Prefer an input that accepts video when several exist.
    let target = nodeIds[0];
    for (const nodeId of nodeIds) {
      const { attributes } = (await dbg.sendCommand("DOM.getAttributes", { nodeId })) as {
        attributes: string[];
      };
      const accept = attributeValue(attributes, "accept") ?? "";
      if (/video|mp4|\*/.test(accept) && files.some((f) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f))) {
        target = nodeId;
        break;
      }
    }
    await dbg.sendCommand("DOM.setFileInputFiles", { nodeId: target, files });
    return { attached: files.length };
  } catch (error) {
    return { attached: 0, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (attachedHere) {
      try {
        dbg.detach();
      } catch {
        // ignore
      }
    }
  }
}

function attributeValue(attributes: string[], name: string): string | undefined {
  for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === name) return attributes[i + 1];
  return undefined;
}
