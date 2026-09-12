import { CN_PLATFORM_IDS, getPlatform, type CnPlatformId } from "@shared/platforms";
import type { ObservedTarget } from "@shared/network";

export type CatalogTarget = Pick<ObservedTarget, "platformId" | "host" | "purpose">;

/** Seeds for stage-2 observation, NOT a frozen login allowlist or a permit. */
export function candidateTargets(): CatalogTarget[] {
  const result: CatalogTarget[] = [];
  for (const platformId of CN_PLATFORM_IDS) {
    const platform = getPlatform(platformId);
    const seen = new Set<string>();
    const add = (host: string, purpose: CatalogTarget["purpose"]) => {
      host = host.toLowerCase();
      if (!host || seen.has(host) || host.includes("*")) return;
      seen.add(host);
      result.push({ platformId, host, purpose });
    };
    add(new URL(platform.routes.login).hostname, "login");
    for (const url of [...Object.values(platform.routes), platform.login.probe.url]) {
      if (url) add(new URL(url).hostname, "business");
    }
    for (const host of platform.login.verificationHosts) add(host, "verification");
  }
  return result;
}

export function suggestedDirectRules(targets: readonly CatalogTarget[]): string {
  const hosts = [...new Set(targets.map((t) => t.host))].sort();
  return [
    "# 观察阶段候选规则：登录及资源清单尚未冻结，不代表兼容性已经验收。",
    "# 放在可能命中的其他规则之前；应用后重新验证真实内核，不自动修改你的配置。",
    ...hosts.map((host) => `DOMAIN,${host},DIRECT`),
  ].join("\n");
}

export function observationKey(platformId: CnPlatformId, host: string): string {
  return `${platformId}:${host}`;
}
