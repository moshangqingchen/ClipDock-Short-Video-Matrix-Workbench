import { getPlatform, isCnPlatformId, type CnPlatformId } from "@shared/platforms";

// Resource families observed on the public Kuaishou homepage. These are only
// CONNECT candidates: they still need the current DIRECT route proof, and do
// not become account navigation or login origins.
const RESOURCE_ROOTS: Partial<Record<string, readonly string[]>> = {
  kuaishou: ["wskwai.com", "wsbkwai.com", "ndcimgs.com", "oskwai.com"],
};

// Exact resources referenced by Douyin's official creator HTML and its security
// SDK dependency chain. Keep these separate from navigation hosts and suffix
// families: admitting one CDN host must not admit its parent or other subdomains.
// Source links and the bounded audit are in docs/douyin-login-resource-scope.md.
const RESOURCE_HOSTS: Partial<Record<CnPlatformId, readonly string[]>> = {
  douyin: [
    "unpkg.byted-static.com",
    "lf3-short.ibytedapm.com",
    "lf-ucenter-web.yhgfb-cn-static.com",
    "lf-headquarters-speed.yhgfb-cn-static.com",
    "lf-rc1.yhgfb-cn-static.com",
    "lf-rc2.yhgfb-cn-static.com",
    "lf-cdn-tos.bytescm.com",
    "lf3-config.bytetcc.com",
  ],
};

/** Main-owned platform families. A match only permits a CONNECT attempt, never a route. */
export function isDomesticWebHost(platform: string, host: string): boolean {
  if (!isCnPlatformId(platform) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))
    return false;
  const definition = getPlatform(platform);
  const roots = [
    ...definition.login.topLevelHosts,
    ...definition.login.verificationHosts,
    ...(RESOURCE_ROOTS[platform] ?? []),
  ];
  return roots.some((root) => host === root || host.endsWith(`.${root}`)) ||
    (RESOURCE_HOSTS[platform]?.includes(host) ?? false);
}
