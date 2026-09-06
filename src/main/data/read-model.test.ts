import { describe, expect, it } from "vitest";
import { createStore } from "@main/db";
import { ReadModel } from "./read-model";

function iso(daysAgo: number, hour = 12): string {
  const date = new Date(Date.UTC(2026, 8, 3, hour));
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString();
}

describe("ReadModel", () => {
  it("computes current values, deltas and per-platform totals from snapshots", () => {
    const store = createStore(":memory:");
    const a = store.accounts.create({ platformId: "douyin", displayName: "A" });
    const b = store.accounts.create({ platformId: "douyin", displayName: "B" });
    const c = store.accounts.create({ platformId: "bilibili", displayName: "C" });

    const snap = (
      accountId: string,
      platformId: "douyin" | "bilibili",
      metric: "followers" | "likes",
      value: number,
      capturedAt: string,
    ) => ({
      accountId,
      platformId,
      metric,
      value,
      capturedAt,
      source: "session" as const,
      workId: null,
    });
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
    const lastWeek = new Date(Date.now() - 8 * 86_400_000).toISOString();
    store.metrics.saveSnapshots([
      snap(a.id, "douyin", "followers", 1000, lastWeek),
      snap(a.id, "douyin", "followers", 1100, yesterday),
      snap(a.id, "douyin", "followers", 1150, now),
      snap(a.id, "douyin", "likes", 5000, now),
      snap(b.id, "douyin", "followers", 200, now),
      snap(c.id, "bilibili", "followers", 50, now),
    ]);

    const model = new ReadModel(store);
    const viewA = model.account(a.id, 30);
    expect(viewA.metrics.followers?.current).toBe(1150);
    expect(viewA.metrics.followers?.day).toBe(50);
    expect(viewA.metrics.followers?.week).toBe(150);
    expect(viewA.metrics.likes?.current).toBe(5000);

    const douyin = model.platform("douyin", 30);
    expect(douyin.accountCount).toBe(2);
    expect(douyin.totals.followers).toBe(1350);
    expect(douyin.totals.likes).toBe(5000);

    const overview = model.overview(30);
    expect(overview.accountCount).toBe(3);
    expect(overview.totals.followers).toBe(1400);
    expect(overview.platforms.map((p) => p.platformId).sort()).toEqual(["bilibili", "douyin"]);
    store.close();
    void iso;
  });

  it("lists attention accounts", () => {
    const store = createStore(":memory:");
    const a = store.accounts.create({ platformId: "kuaishou" });
    store.accounts.updateStatus(a.id, "offline", "掉线");
    const overview = new ReadModel(store).overview();
    expect(overview.attention).toHaveLength(1);
    expect(overview.attention[0].status).toBe("offline");
    store.close();
  });
});
