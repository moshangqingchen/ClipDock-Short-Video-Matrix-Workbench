import type { Account } from "@shared/types";
import { STATUS_LABEL, StatusDot } from "./index";

const labels = {
  checking: "检测中",
  unconfirmed: "待核实",
  network_error: "网络异常",
  paused: "网络暂停",
  confirmed: "",
};
export function AccountLoginStatus({ account }: { account: Account }) {
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
  return (
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
  );
}
