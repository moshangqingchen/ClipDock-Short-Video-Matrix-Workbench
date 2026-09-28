import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { makeWork, worksToMetrics } from "./collectors/shared";
import { ReadModel } from "./read-model";
import { workMetric } from "@shared/metric-quality";
import { applyBackup, buildBackup } from "@main/security/backup";
const stores: Store[] = [];
const open = () => { const store = createStore(":memory:"); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });
describe("collection quality", () => {
  it("preserves missing fields and original metadata while accepting real zeros and decreases", () => {
    const store = open(), account = store.accounts.create({ platformId: "douyin" });
    const first = makeWork(account, "one", { title: "original", plays: 100, likes: 9 }, "2026-09-01T00:00:00Z");
    store.metrics.upsertWorks([first]);
    const next = makeWork(account, "one", { likes: 0, comments: 2 }, "2026-09-02T00:00:00Z");
    store.metrics.upsertWorks([next]);
    expect(worksToMetrics([next], next.fetchedAt).map((row) => row.metric)).toEqual(["likes", "comments"]);
    const saved = store.metrics.listWorks(account.id)[0];
    expect(saved).toMatchObject({ title: "original", plays: 100, likes: 0, comments: 2 });
    expect(saved.observations?.plays?.capturedAt).toBe(first.fetchedAt);
    expect(workMetric(saved, "shares")).toBeNull();
    store.metrics.upsertWorks([makeWork(account, "one", { plays: 20 }, "2026-09-03T00:00:00Z")]);
    expect(store.metrics.listWorks(account.id)[0].plays).toBe(20);
  });
  it("does not replace newer field observations with an older backup", () => {
    const store = open(), account = store.accounts.create({ platformId: "bilibili" });
    store.metrics.upsertWorks([makeWork(account, "one", { plays: 123 }, "2026-09-20T00:00:00Z")]);
    store.metrics.upsertWorks([makeWork(account, "one", { plays: 1 }, "2026-09-10T00:00:00Z")]);
    expect(store.metrics.listWorks(account.id)[0].plays).toBe(123);
  });
  it("uses Beijing midnight and retains field timestamps instead of the keepalive time", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-22T00:30:00Z"));
    const store = open(), account = store.accounts.create({ platformId: "douyin" });
    store.accounts.create({ platformId: "douyin" });
    store.metrics.saveSnapshots([
      { accountId: account.id, platformId: account.platformId, metric: "followers", value: 10, capturedAt: "2026-09-21T15:59:00Z", source: "session", origin: "official" },
      { accountId: account.id, platformId: account.platformId, metric: "followers", value: 15, capturedAt: "2026-09-21T16:01:00Z", source: "session", origin: "official" },
    ]);
    const id = store.metrics.startRun({ accountId: account.id, platformId: account.platformId, status: "success", trigger: "keepalive", startedAt: new Date().toISOString() });
    store.metrics.finishRun(id, { status: "success", metricsWritten: 0, worksWritten: 0 });
    const model = new ReadModel(store), view = model.account(account.id);
    expect(view.metrics.followers).toMatchObject({ current: 15, day: 5, capturedAt: "2026-09-21T16:01:00Z" });
    expect(view.trend.map((row) => row.date)).toEqual(["2026-09-21", "2026-09-22"]);
    expect(view.capturedAt).not.toBe(view.lastRun?.startedAt);
    expect(model.platform("douyin").coverage?.followers).toBe(1);
  });
  it("round-trips observation metadata and imports snapshots idempotently", () => {
    const source = open(), target = open(), account = source.accounts.create({ platformId: "douyin" });
    const work = makeWork(account, "one", { plays: 0 }, new Date().toISOString());
    source.metrics.upsertWorks([work]); source.metrics.saveSnapshots(worksToMetrics([work], work.fetchedAt));
    const backup = buildBackup(source, "test");
    applyBackup(target, backup, "merge"); applyBackup(target, backup, "merge");
    expect(target.metrics.listSnapshots()).toHaveLength(1);
    expect(target.metrics.listWorks(account.id)[0].observations).toEqual(work.observations);
    expect(workMetric(target.metrics.listWorks(account.id)[0], "likes")).toBeNull();
  });
});
