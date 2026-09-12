import type { ReactNode } from "react";
import { isPlatformHost } from "@shared/platforms";
import type { Account, Work } from "@shared/types";
import { cx } from "@renderer/components/ui";
import { useUi } from "@renderer/store";
import styles from "./work-link.module.css";

export function workLinkUrl(work: Work, account: Pick<Account, "id" | "platformId">): string | null {
  if (work.accountId !== account.id || work.platformId !== account.platformId ||
    !work.url || work.url.length > 4000 ||
    [...work.url].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f" || char === "\\")) return null;
  try {
    const url = new URL(work.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      !isPlatformHost(account.platformId, url.hostname)) return null;
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

/** The whole card is one keyboard-operable target in its owning account's session. */
export function WorkLink({ work, account, className, children }: {
  work: Work;
  account: Pick<Account, "id" | "platformId">;
  className?: string;
  children: ReactNode;
}) {
  const url = workLinkUrl(work, account);
  const title = work.title || "(无标题)";
  return (
    <button
      type="button"
      className={cx(styles.action, className)}
      disabled={!url}
      aria-label={`打开作品：${title}`}
      title={url ? `在此账号中打开：${title}` : "暂无可用作品链接"}
      onClick={() => { if (url) useUi.getState().openWork(account.id, url); }}
    >
      {children}
    </button>
  );
}
