import type { Account } from "@shared/types";
import { STATUS_LABEL, StatusDot } from "./index";
import { getPlatform } from "@shared/platforms";
import styles from "./ui.module.css";

const labels = {
  checking: "检测中",
  unconfirmed: "待核实",
  network_error: "网络异常",
  paused: "网络暂停",
  confirmed: "",
};
export function AccountLoginStatus({ account, detailed = false, compact = false }: { account: Account; detailed?: boolean; compact?: boolean }) {
  const info = account.checkInfo;
  const attempted = info ? new Date(info.attemptedAt).toLocaleString() : "尚未检查";
  const confirmed = account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString() : "尚未确认";
  // A check without a new login conclusion must not replace the stored account status.
  const showCheckState = account.status === "unknown" && info && info.state !== "confirmed";
  const label =
    showCheckState
      ? labels[info.state]
      : account.status === "unknown"
        ? "待检测"
        : STATUS_LABEL[account.status];
  const creator = account.checkInfo?.creatorConfirmation;
  const separateCreator = Boolean(getPlatform(account.platformId).routes.site);
  const checkLabel = info && info.state !== "confirmed" && !showCheckState ? labels[info.state] : null;
  return <span className={styles.loginStatus} data-detailed={detailed || undefined}>
    {detailed && separateCreator ? <span>主页：</span> : null}
    <span
      title={`${info?.reason ?? account.statusMessage ?? label}\n最近检查：${attempted}\n上次确认：${STATUS_LABEL[account.status]} · ${confirmed}`}
    >
      <StatusDot
        status={
          showCheckState
            ? info.state === "network_error"
              ? "network_error"
              : "unknown"
            : account.status
        }
      />
      {label}
    </span>
    {!compact && checkLabel && checkLabel !== label ? <span className={styles.loginCheck}>{checkLabel}</span> : null}
    {detailed ? <>
      {separateCreator ? <span title={creator ? `最近确认：${new Date(creator.observedAt).toLocaleString()}` : "请打开管理页，由平台网页确认后台登录"}>
        管理后台：{creator?.kind === "online" ? "已确认登录" : creator?.kind === "offline" ? "需要登录" : "待确认"}
        {creator ? <small>（{new Date(creator.observedAt).toLocaleString()}）</small> : null}
      </span> : null}
      <small>{separateCreator ? "主页" : "登录"}最近确认：{confirmed}</small>
    </> : null}
  </span>;
}
