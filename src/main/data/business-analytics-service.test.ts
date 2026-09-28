import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import type { ViewPool } from "@main/browser/view-pool";
import type { AccountService } from "@main/services/account-service";
import { bindAccountWebContents, installBusinessNetwork } from "@main/network/business-access";
import { getPlatform } from "@shared/platforms";
import { BusinessAnalyticsService } from "./business-analytics-service";
import { makeWork } from "./collectors/shared";

const cleanup: Array<() => void> = [], stores: Store[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((fn) => fn()); stores.splice(0).forEach((store) => store.close()); vi.useRealTimers(); });
function setup() {
  const store = createStore(":memory:"); stores.push(store);
  const raw = store.accounts.create({ platformId: "douyin" }); store.accounts.updateStatus(raw.id, "online", "fixture");
  store.accounts.updateCheckInfo(raw.id, { state: "confirmed", reason: "fixture", attemptedAt: new Date().toISOString() });
  let subject = "self", navigationId = 1;
  const sample = { dates: ["2026-09-01"], permissionRequired: false, cards: [{ label: "完播率", text: "0%", dates: [] }], groups: [] };
  const executeJavaScript = vi.fn(async () => sample);
  const wc = Object.assign(new EventEmitter(), { getURL: () => getPlatform("douyin").routes.analytics, isDestroyed: () => false, isLoading: () => false, executeJavaScript }) as unknown as WebContents;
  cleanup.push(installBusinessNetwork({ enforcement: "strict", check: () => ({ allowed: true, reason: "READY" }), acquire: () => ({ signal: new AbortController().signal, isCurrent: () => true, release: () => undefined }) }));
  cleanup.push(bindAccountWebContents(wc, raw.id));
  const pool = { getWebContents: () => wc, getState: () => ({ instanceId: 1, navigationId }), getIdentitySubject: () => subject, getIdentityEvidence: () => null } as unknown as ViewPool;
  const accounts = { get: () => store.accounts.get(raw.id)!, checkStatus: async () => store.accounts.get(raw.id)! } as unknown as AccountService;
  const changed = vi.fn(), service = new BusinessAnalyticsService(store, pool, accounts, changed);
  service.repository.setEnabled("douyin", true);
  return { service, store, wc, id: raw.id, sample, executeJavaScript, changed, changeSubject: () => { subject = "other"; }, navigate: () => { navigationId++; } };
}
describe("business analytics account isolation", () => {
  it("stores explicit zero only after identity confirmation", async () => {
    const s = setup(); expect(await s.service.collect(s.id, s.wc, () => undefined)).toBe(1);
    expect(s.service.repository.all()[0].data).toEqual({ kind: "rate", value: 0, unit: "ratio" });
    expect(s.changed).toHaveBeenCalledOnce();
  });
  it("does not treat the previous online status as a new identity confirmation", async () => {
    const s = setup(); s.store.accounts.updateCheckInfo(s.id, { state: "unconfirmed", reason: "fixture", attemptedAt: new Date().toISOString() });
    await expect(s.service.collect(s.id, s.wc, () => undefined)).rejects.toThrow(/登录/);
    expect(s.executeJavaScript).not.toHaveBeenCalled(); expect(s.service.repository.all()).toEqual([]);
  });
  it("associates a single-work observation only with an existing work owned by the account", async () => {
    const s = setup(), account = s.store.accounts.get(s.id)!;
    const work = makeWork(account, "synthetic-work", {}, new Date().toISOString()); s.store.metrics.upsertWorks([work]);
    s.wc.getURL = () => getPlatform("douyin").routes.analytics + "/detail?aweme_id=synthetic-work";
    expect(await s.service.collect(s.id, s.wc, () => undefined)).toBe(1);
    expect(s.service.repository.all()[0].workId).toBe(work.id);
  });
  it("never stores unidentified single-work values as account aggregates", async () => {
    const s = setup(); s.executeJavaScript.mockResolvedValue({ ...s.sample, workDetail: true } as typeof s.sample);
    await expect(s.service.collect(s.id, s.wc, () => undefined)).rejects.toThrow(/单作品归属/);
    expect(s.service.repository.all()).toEqual([]);
  });
  it.each(["subject", "navigation", "disabled"])("does not save a late response after %s changes", async (change) => {
    const s = setup();
    s.executeJavaScript.mockImplementation(async () => {
      if (change === "subject") s.changeSubject(); else if (change === "navigation") s.navigate(); else s.service.repository.setEnabled("douyin", false);
      return s.sample;
    });
    await expect(s.service.collect(s.id, s.wc, () => undefined)).rejects.toThrow();
    expect(s.service.repository.all()).toEqual([]);
  });
});
