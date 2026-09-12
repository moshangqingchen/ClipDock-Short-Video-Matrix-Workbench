import { Radio } from "lucide-react";
import type { NetworkSnapshot } from "@shared/network";
import { useNetwork } from "@renderer/store/network";
import { cx } from "@renderer/components/ui";
import styles from "./network.module.css";

const STATE_LABEL = {
  checking: "检查中",
  domestic: "国内模式",
  dual: "规则模式",
  overseas: "代理模式",
  unavailable: "网络不可用",
};

export function networkDisplay(snapshot: NetworkSnapshot, startupPending = false) {
  // Read the main process's current decision, not the historical path summary.
  const switching = snapshot.policy === "exclusive" || snapshot.policy === "rule-split"
    ? snapshot.switching : undefined;
  const state =
    snapshot.enforcement === "strict" && switching
      ? switching.state
      : "checking";
  // Keep the actual state checking: platform badges and request guards must not
  // interpret the default domestic label as a successful proxy observation.
  if (
    startupPending &&
    state === "checking" &&
    ((snapshot.instanceId === "" && snapshot.policy === undefined) ||
      (snapshot.enforcement === "strict" && switching?.state === "checking")) &&
    ["CHECKING", "NETWORK_CHANGED"].includes(switching?.reason ?? snapshot.reason)
  ) {
    return {
      state,
      label: "国内模式",
      reason: "后台检测网络状态，确认后自动启用平台",
    };
  }
  const reason =
    state === "dual"
      ? "国内平台直连，国外平台代理，国内外可同时使用"
      : state === "domestic"
      ? "代理已关闭，国内平台启用，国外平台休眠"
      : state === "overseas"
        ? "代理已开启，国内平台休眠，国外平台启用"
        : state === "unavailable"
          ? "网络暂不可用，请检查网络连接"
          : switching?.reason === "PROOF_EXPIRED"
            ? "正在更新代理状态，请稍候"
            : switching?.proxy === "off"
              ? "代理已关闭，正在恢复国内平台"
              : "正在检测代理状态，请稍候";
  return { state, label: STATE_LABEL[state], reason };
}

export function NetworkStatus() {
  const snapshot = useNetwork((state) => state.snapshot);
  const startupPending = useNetwork((state) => state.startupPending);
  const display = networkDisplay(snapshot, startupPending);
  return (
    <div
      className={cx(styles.status, styles[display.state])}
      role="status"
      aria-label="网络状态"
      title={display.reason}
    >
      <Radio size={14} aria-hidden />
      <strong>{display.label}</strong>
      <span className={styles.statusReason}>{display.reason}</span>
    </div>
  );
}
