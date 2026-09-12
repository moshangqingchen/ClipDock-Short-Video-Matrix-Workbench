import type { AccountEgressLocation, AccountNetworkState, ExclusiveAccessSnapshot } from "@shared/network";

/** Informational projection only; never changes the account's permission or login state. */
export function projectAccountEgressLocation(
  account: AccountNetworkState,
  switching: ExclusiveAccessSnapshot,
  location: AccountEgressLocation,
  verifiedRulePath: boolean,
): AccountNetworkState {
  const associated = account.state === "allowed" && account.generation === switching.generation && (
    (switching.proxy === "off" && switching.state === "domestic") ||
    (switching.proxy === "on" && switching.state === "dual" && verifiedRulePath)
  );
  return {
    ...account,
    egressLocation: associated ? { ...location } : {
      state: account.state === "checking" ? "checking" : "unavailable",
      route: "direct",
      ip: null, country: null, region: null, city: null, checkedAt: null,
    },
  };
}
