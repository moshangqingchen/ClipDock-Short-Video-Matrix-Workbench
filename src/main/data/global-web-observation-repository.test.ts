import { expect, it } from "vitest";
import { createStore } from "@main/db";
import { GlobalAccountRepository } from "@main/api/global-account-repository";
import { GlobalWebObservationRepository } from "./global-web-observation-repository";
import { parseWebObservation } from "./global-web-observation";
it("persists isolated snapshots without API auth, preserves successful data on empty reads, and cascades account deletion", () => {
  const store = createStore(":memory:");
  try {
    const accounts = new GlobalAccountRepository(store.db),
      repo = new GlobalWebObservationRepository(store.db);
    const a = accounts.create({ platformId: "youtube", displayName: "A" }),
      b = accounts.create({ platformId: "youtube", displayName: "B" });
    const value = parseWebObservation(a.id, "youtube", "chrome", {
      url: "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv/analytics",
      text: "Views\n10",
    });
    repo.save(value);
    expect(repo.get(a.id)).toEqual(value);
    expect(repo.get(b.id)).toBeNull();
    expect(repo.history(a.id)).toEqual([value]);
    expect(repo.history(b.id)).toEqual([]);
    repo.save({ ...value, metrics: [] });
    expect(repo.get(a.id)).toEqual(value);
    expect(accounts.get(a.id)?.authStatus).toBe("unauthorized");
    expect(store.db.get("SELECT COUNT(*) AS n FROM credentials")?.n).toBe(0);
    store.db.run("DELETE FROM global_accounts WHERE id=?", [a.id]);
    expect(repo.get(a.id)).toBeNull();
    expect(store.db.get("SELECT COUNT(*) AS n FROM global_web_observations")?.n).toBe(0);
    expect(store.db.get("SELECT COUNT(*) AS n FROM global_web_observation_history")?.n).toBe(0);
  } finally {
    store.close();
  }
});
it("retains different days and periods independently and replaces only a newer sample in the same day and scope", () => {
  const store = createStore(":memory:");
  try {
    const account = new GlobalAccountRepository(store.db).create({
      platformId: "youtube",
      displayName: "History",
    });
    const repo = new GlobalWebObservationRepository(store.db);
    const value = parseWebObservation(
      account.id,
      "youtube",
      "chrome",
      {
        url: "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv",
        text: "Last 28 days\nViews\n10",
      },
      "2026-09-08T01:00:00.000Z",
    );
    repo.save(value);
    repo.save({ ...value, capturedAt: "2026-09-08T02:00:00.000Z" });
    repo.save({ ...value, capturedAt: "2026-09-09T01:00:00.000Z" });
    repo.save({ ...value, period: "Last 7 days" });
    repo.save({ ...value, metrics: [] });
    expect(repo.history(account.id).map((item) => [item.capturedAt, item.period])).toEqual([
      ["2026-09-08T01:00:00.000Z", "Last 7 days"],
      ["2026-09-08T02:00:00.000Z", "Last 28 days"],
      ["2026-09-09T01:00:00.000Z", "Last 28 days"],
    ]);
  } finally {
    store.close();
  }
});
