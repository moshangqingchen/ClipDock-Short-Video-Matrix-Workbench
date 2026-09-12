import { describe, expect, it } from "vitest";
import type { AccountEgressLocation, AccountNetworkState, ExclusiveAccessSnapshot } from "@shared/network";
import { projectAccountEgressLocation } from "./account-egress-projection";

const account: AccountNetworkState = { accountId: "account-a", state: "allowed", reason: "READY", generation: 8, checkedAt: null, proofExpiresAt: null };
const switching: ExclusiveAccessSnapshot = { state: "dual", proxy: "on", reason: "READY", generation: 8, checkedAt: null, expiresAt: null };
const location: AccountEgressLocation = { state: "ready", route: "direct", ip: "203.0.113.8", country: "中国", region: "广东", city: "深圳", checkedAt: "2026-09-12T00:00:00.000Z" };

describe("account egress display association", () => {
  it("requires a successfully verified account path in rule mode", () => {
    expect(projectAccountEgressLocation(account, switching, location, false).egressLocation).toMatchObject({ state: "unavailable", ip: null, city: null });
    expect(projectAccountEgressLocation(account, switching, location, true).egressLocation).toEqual(location);
  });
  it("accepts a currently allowed proxy-off account without a proxy proof", () => {
    expect(projectAccountEgressLocation(account, { ...switching, state: "domestic", proxy: "off" }, location, false).egressLocation).toEqual(location);
  });
  it("rejects an allowed account from a different network generation", () => {
    expect(projectAccountEgressLocation({ ...account, generation: 7 }, switching, location, true).egressLocation?.ip).toBeNull();
  });
  it.each(["dormant", "checking"] as const)("clears the address from %s accounts", (state) => {
    const result = projectAccountEgressLocation({ ...account, state, reason: "NETWORK_CHANGED" }, switching, location, true);
    expect(result.egressLocation?.ip).toBeNull();
    expect(result.egressLocation?.city).toBeNull();
    expect(result.state).toBe(state);
    expect(result.reason).toBe("NETWORK_CHANGED");
  });
  it.each(["checking", "overseas", "unavailable"] as const)("never shows an old address in %s mode", (state) => {
    expect(projectAccountEgressLocation(account, { ...switching, state }, location, true).egressLocation?.ip).toBeNull();
  });
  it("copies display data without changing access generation or permissions", () => {
    const result = projectAccountEgressLocation(account, switching, location, true);
    expect(result.egressLocation).not.toBe(location);
    const { egressLocation: _display, ...permission } = result;
    expect(permission).toEqual(account);
  });
});
