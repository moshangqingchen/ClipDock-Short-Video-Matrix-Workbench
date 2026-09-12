import { getPlatform, isCnPlatformId } from "@shared/platforms";

// Resource families observed on the public Kuaishou homepage. These are only
// CONNECT candidates: they still need the current DIRECT route proof, and do
// not become account navigation or login origins.
const RESOURCE_ROOTS: Partial<Record<string, readonly string[]>> = {
  kuaishou: ["wskwai.com", "wsbkwai.com", "ndcimgs.com", "oskwai.com"],
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
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}
