import type { AccountService } from "@main/services/account-service";
import type { ViewPool } from "./view-pool";
import { messageEntry } from "@shared/messages";
import { isHomepageContext } from "./homepage-login";
import { beginBusinessOperation, isNetworkDormantError } from "@main/network/business-access";
import { evaluateWithLease } from "@main/network/page-evaluation";
import { buildDouyinMessageEntryScript } from "./message-entry";
import type { WebContents } from "electron";

const openedHeaders = new WeakMap<WebContents, { url: string; navigationId: number | undefined }>();

/** Foreground navigation only; content and replies remain entirely in the account's official page. */
export async function openOfficialMessages(id: string, pool: ViewPool, accounts: AccountService) {
  const account = accounts.get(id);
  const entry = messageEntry(account.platformId);
  const existing = pool.getState(id);
  if (!existing?.visible) throw new Error("请先打开这个账号，再进入消息页面");
  const currentContents = pool.getWebContents(id);
  const previousHeader = currentContents ? openedHeaders.get(currentContents) : undefined;
  if (existing.messageMode && !existing.lastError && (entry.kind !== "douyin-header" ||
      previousHeader?.url === existing.url && previousHeader.navigationId === existing.navigationId))
    return { opened: true, guidance: entry.guidance };
  const target = entry.kind === "douyin-header" && isHomepageContext(account.platformId, existing.url)
    ? existing.url : entry.url;
  accounts.prepareNetworkOperation(id, "view-navigate", target);
  pool.ensure({ id, platformId: account.platformId }, { navigate: false });
  const wc = pool.getWebContents(id);
  if (!wc) throw new Error("账号页面尚未就绪，请重新打开账号");
  if (!existing.messageMode) openedHeaders.delete(wc);
  pool.setMessageMode(id, true);
  const stillOwned = () => {
    const state = pool.getState(id);
    return Boolean(state?.messageMode && state.visible && pool.getWebContents(id) === wc && !wc.isDestroyed());
  };
  try {
    if (wc.getURL() !== target || existing.lastError) await pool.navigate(id, target);
    if (!stillOwned()) return { opened: false, guidance: "账号页面已切换，请在当前账号打开消息。" };
    if (entry.kind !== "douyin-header") return { opened: true, guidance: entry.guidance };
    if (wc.isLoading() || !isHomepageContext(account.platformId, wc.getURL()))
      return { opened: false, guidance: entry.guidance };
    const operation = beginBusinessOperation(id, wc.getURL());
    try {
      if (!stillOwned()) return { opened: false, guidance: entry.guidance };
      const documentUrl = wc.getURL();
      const documentNavigation = pool.getState(id)?.navigationId;
      const opened = await evaluateWithLease<unknown>(wc, buildDouyinMessageEntryScript(), operation, 3000);
      operation.assertCurrent();
      const current = stillOwned() && wc.getURL() === documentUrl && pool.getState(id)?.navigationId === documentNavigation;
      if (opened === true && current)
        openedHeaders.set(wc, { url: documentUrl, navigationId: documentNavigation });
      return { opened: opened === true && current, guidance: entry.guidance };
    } catch (error) {
      if (isNetworkDormantError(error)) throw error;
      // A layout change leaves the official entry available for the user's own click.
      return { opened: false, guidance: entry.guidance };
    } finally { operation.release(); }
  } catch (error) {
    // Do not expose page/native failures, URLs, or private causes through the bridge.
    throw new Error("消息页面暂未打开，请检查网络或在官方页面完成登录后重试", { cause: error });
  }
}
