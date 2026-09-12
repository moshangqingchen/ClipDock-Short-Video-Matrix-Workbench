import { MapPin } from "lucide-react";
import type { AccountEgressLocation } from "@shared/network";
import styles from "./account-egress-badge.module.css";

const text = (value: string | null | undefined) => typeof value === "string" ? value.trim() : "";

export function AccountEgressBadge({ location }: { location?: AccountEgressLocation }) {
  const ready = location?.state === "ready";
  const places = ready
    ? [...new Set([text(location.country), text(location.region), text(location.city)].filter(Boolean))]
    : [];
  const label = location?.state === "checking"
    ? "检测中"
    : ready
      ? text(location.city) || text(location.region) || text(location.country) || "位置未知"
      : "位置未知";
  const timestamp = location?.checkedAt ? Date.parse(location.checkedAt) : NaN;
  const checkedAt = Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false })
    : "尚未检测";
  const title = [
    `直连出口 IP：${ready ? text(location.ip) || "未知" : "未知"}`,
    `归属地：${places.length ? places.join(" · ") : label}`,
    `检测时间：${checkedAt}`,
    "IP归属地估测，可能与平台显示不同",
  ].join("\n");

  return (
    <span className={styles.badge} title={title} aria-label={`直连出口位置：${label}`}>
      <MapPin size={10} aria-hidden="true" />
      <span className={styles.text}>{label}</span>
    </span>
  );
}
