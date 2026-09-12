import { z } from "zod";
import type { CnPlatformId } from "./platforms";

/** Provisional defaults: stage-2 measurements freeze timing, not the proof model. */
export const NETWORK_TIMING = {
  renewMs: 10_000,
  proofTtlMs: 15_000,
  egressRefreshMs: 60_000,
  egressTtlMs: 120_000,
  warmupGapMs: 15_000,
  controllerTimeoutMs: 3_000,
} as const;

const controllerUrl = z
  .string()
  .trim()
  .max(200)
  .transform((value, ctx) => {
    try {
      if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/i.test(value)) throw new Error();
      const url = new URL(value);
      if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error();
      if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error();
      return url.origin;
    } catch {
      ctx.addIssue({ code: "custom", message: "控制器地址须为本机 IP 的 HTTP 地址，不含路径或凭据" });
      return z.NEVER;
    }
  });

// Public selection only. The main-process source reader checks canonical paths and supported clients.
const selectedClientResourcesPath = z
  .string()
  .max(4096)
  .refine(
    (value) => {
      const path = value.trim();
      return (
        /^[a-z]:[\\/]/i.test(path) &&
        !path.slice(2).includes(":") &&
        !/[<>"|?*]/.test(path) &&
        ![...value].some((character) => character.charCodeAt(0) < 32)
      );
    },
    { message: "配置来源须为本机 Windows 盘符绝对路径，不含非法字符" },
  )
  .transform((value) => value.trim());

export const networkSettingsSchema = z
  .object({
    controllerUrl: controllerUrl.default("http://127.0.0.1:9790"),
    diagnosticProxyPort: z.number().int().min(1).max(65535).default(10090),
    selectedClientResourcesPath: selectedClientResourcesPath.nullable().optional(),
  })
  .strict();
export type NetworkSettings = z.output<typeof networkSettingsSchema>;
export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = networkSettingsSchema.parse({});

export type NetworkReason =
  | "CHECKING"
  | "PROXY_ENABLED"
  | "PROXY_STATE_UNKNOWN"
  | "PROXY_DISABLED"
  | "GLOBAL_MODE"
  | "CONTROLLER_UNAVAILABLE"
  | "CREDENTIAL_UNAVAILABLE"
  | "RULE_UNVERIFIABLE"
  | "NOT_DIRECT"
  | "EGRESS_UNVERIFIED"
  | "EGRESS_OUTSIDE_CN"
  | "CONTEXT_UNVERIFIED"
  | "CATALOG_UNVERIFIED"
  | "UNKNOWN_TARGET"
  | "PROOF_EXPIRED"
  | "NETWORK_CHANGED"
  | "GATE_REVOKED"
  | "READY";

export const NETWORK_REASON_TEXT: Record<NetworkReason, string> = {
  CHECKING: "正在检测代理开关",
  PROXY_ENABLED: "代理已开启，国内平台休眠，国外平台启用",
  PROXY_STATE_UNKNOWN: "无法确认代理是否关闭，国内平台暂时休眠",
  PROXY_DISABLED: "代理已关闭，国际平台等待代理",
  GLOBAL_MODE: "当前为 global 模式，国内业务不符合严格模式条件",
  CONTROLLER_UNAVAILABLE: "控制器不可读，按不可验证处理",
  CREDENTIAL_UNAVAILABLE: "凭据不可用，请重新填写控制器或代理秘密",
  RULE_UNVERIFIABLE: "无法确定当前规则的真实命中结果",
  NOT_DIRECT: "当前目标不走 DIRECT",
  EGRESS_UNVERIFIED: "无法验证适用于业务通路的大陆出口",
  EGRESS_OUTSIDE_CN: "当前出口不符合中国大陆策略",
  CONTEXT_UNVERIFIED: "业务与诊断的进程及传输上下文尚未验收",
  CATALOG_UNVERIFIED: "登录与必要资源域名清单尚未验收",
  UNKNOWN_TARGET: "出现未审核目标，等待验证",
  PROOF_EXPIRED: "正在重新检测代理状态",
  NETWORK_CHANGED: "网络或规则已改变，旧许可已撤销",
  GATE_REVOKED: "任务的网络许可已撤销",
  READY: "代理已关闭，国内平台启用，国外平台休眠",
};

/** Current main-process mutual-exclusion decision. Never persist or accept from renderer. */
export interface ExclusiveAccessSnapshot {
  state: "checking" | "domestic" | "dual" | "overseas" | "unavailable";
  proxy: "on" | "off" | "unknown";
  reason: NetworkReason;
  generation: number;
  checkedAt: string | null;
  expiresAt: string | null;
}

/** Transient IPC projection only. Never persist, back up, or hydrate as permission. */
export interface AccountEgressLocation {
  state: "checking" | "ready" | "unavailable";
  route: "direct";
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  checkedAt: string | null;
}

/** Account route information is display-only and never grants network access. */
export interface AccountNetworkState {
  accountId: string;
  state: "checking" | "allowed" | "dormant";
  reason: NetworkReason;
  generation: number;
  checkedAt: string | null;
  proofExpiresAt: string | null;
  egressLocation?: AccountEgressLocation;
}

export interface ObservedTarget {
  platformId: CnPlatformId;
  host: string;
  purpose: "login" | "business" | "verification" | "observed";
  route: "direct" | "proxy" | "unknown";
  reason: NetworkReason;
  ruleType: string | null;
}

export interface PublicEgress {
  state: "checking" | "reachable" | "unavailable";
  country: string | null;
  asn: number | null;
  maskedIp: string | null;
  checkedAt: string | null;
  /** Reachability never certifies the actual proxy chain. */
  routeVerified: boolean;
}

export interface NetworkSnapshot {
  instanceId: string;
  sequence: number;
  enforcement: "observe" | "strict";
  state: "checking" | "dual" | "domestic" | "overseas" | "unavailable";
  checkedAt: string | null;
  controller: {
    readable: boolean;
    mode: string | null;
    tun: boolean | null;
    ruleCount: number;
    version: string | null;
  };
  rulesVersion: string | null;
  targets: ObservedTarget[];
  accounts: AccountNetworkState[];
  direct: PublicEgress;
  proxy: PublicEgress;
  validation: { context: boolean; loginCatalog: boolean; cancellation: boolean };
  reason: NetworkReason;
  /** Absent only in historical observation / controlled path-proof experiments. */
  policy?: "exclusive" | "rule-split";
  switching?: ExclusiveAccessSnapshot;
}

export function checkingNetworkSnapshot(): NetworkSnapshot {
  const egress: PublicEgress = {
    state: "checking",
    country: null,
    asn: null,
    maskedIp: null,
    checkedAt: null,
    routeVerified: false,
  };
  return {
    instanceId: "",
    sequence: 0,
    enforcement: "observe",
    state: "checking",
    checkedAt: null,
    controller: { readable: false, mode: null, tun: null, ruleCount: 0, version: null },
    rulesVersion: null,
    targets: [],
    accounts: [],
    direct: { ...egress },
    proxy: { ...egress },
    validation: { context: false, loginCatalog: false, cancellation: false },
    reason: "CHECKING",
  };
}

export interface NetworkApi {
  snapshot(): Promise<NetworkSnapshot>;
  settings(): Promise<NetworkSettings>;
  configure(input: NetworkSettings): Promise<NetworkSettings>;
  refresh(): Promise<NetworkSnapshot>;
  directRules(): Promise<string>;
}
