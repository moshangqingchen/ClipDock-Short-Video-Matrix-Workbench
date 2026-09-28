import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { migrate } from "@main/db/database";
import { METRIC_NAMES, WORK_METRICS, type Account, type MetricName } from "@shared/types";
import { makeWork } from "./collectors/shared";
import { ReadModel } from "./read-model";

const NOW = "2026-09-28T04:00:00.000Z";
const TODAY = "2026-09-28T02:00:00.000Z";
const YESTERDAY = "2026-09-27T02:00:00.000Z";
const THREE_DAYS_AGO = "2026-09-25T02:00:00.000Z";
let store: Store;
let model: ReadModel;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  store = createStore(":memory:"); model = new ReadModel(store);
});
afterEach(() => { store.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function snapshot(account: Account, metric: MetricName, value: number, capturedAt: string, workId?: string) {
  store.metrics.saveSnapshots([{ accountId: account.id, platformId: account.platformId,
    metric, value, capturedAt, source: "session", origin: "official", workId }]);
}

describe("read model quality and bounded queries", () => {
  it("keeps first observations and stale periods unknown instead of inventing zero changes", () => {
    const account = store.accounts.create({ platformId: "douyin" });
    snapshot(account, "followers", 25, TODAY);
    snapshot(account, "likes", 10, YESTERDAY);
    snapshot(account, "plays", 20, "2026-08-01T02:00:00.000Z");
    const view = model.account(account.id);
    expect(view.metrics.followers).toMatchObject({ current: 25, day: null, week: null, month: null });
    expect(view.metrics.likes?.day).toBeNull();
    expect(view.metrics.plays).toMatchObject({ current: 20, day: null, week: null, month: null });
    expect(model.overview().dayDelta).toEqual({});
    expect(model.overview().dayCoverage).toEqual({});
  });

  it("keeps actual zero and decreases, while reporting the account coverage of each sum", () => {
    const a = store.accounts.create({ platformId: "douyin" });
    const b = store.accounts.create({ platformId: "douyin" });
    store.accounts.create({ platformId: "bilibili" });
    snapshot(a, "followers", 5, YESTERDAY); snapshot(a, "followers", 0, TODAY);
    snapshot(b, "followers", 7, TODAY);
    snapshot(a, "following", 4, YESTERDAY); snapshot(a, "following", 4, TODAY);
    const summary = model.platform("douyin");
    expect(summary.totals).toEqual({ followers: 7, following: 4 });
    expect(summary.coverage).toEqual({ followers: 2, following: 1 });
    expect(summary.dayDelta).toEqual({ followers: -5, following: 0 });
    expect(summary.dayCoverage).toEqual({ followers: 1, following: 1 });
    expect(model.overview()).toMatchObject({ accountCount: 3, totals: summary.totals,
      coverage: summary.coverage, dayDelta: summary.dayDelta, dayCoverage: summary.dayCoverage });
  });

  it("exposes all eight trend fields with explicit gaps and no forward filling", () => {
    const account = store.accounts.create({ platformId: "xiaohongshu" });
    METRIC_NAMES.forEach((metric, index) => snapshot(account, metric, index, THREE_DAYS_AGO));
    snapshot(account, "likes", 0, YESTERDAY);
    const view = model.account(account.id);
    expect(view.trend.map((point) => point.date)).toEqual(["2026-09-25", "2026-09-26", "2026-09-27"]);
    METRIC_NAMES.forEach((metric, index) => expect(view.trend[0][metric]).toBe(index));
    METRIC_NAMES.forEach((metric) => expect(view.trend[1][metric]).toBeNull());
    expect(view.trend[2]).toMatchObject({ followers: null, likes: 0, plays: null, following: null, coverage: { likes: 1 } });
    expect(model.platform("xiaohongshu").accounts[0].spark).toEqual([0, null, null]);
    const global = model.overview().trend;
    expect(global[1].followers).toBeNull();
    expect(global[1].coverage).toEqual({});
    expect(global[2].likes).toBe(0);
    expect(global[2].followers).toBeNull();
  });

  it("sums only observed accounts on each date and records changing daily coverage", () => {
    const a = store.accounts.create({ platformId: "douyin" });
    const b = store.accounts.create({ platformId: "bilibili" });
    snapshot(a, "followers", 3, YESTERDAY);
    snapshot(b, "followers", 7, YESTERDAY);
    snapshot(a, "followers", 4, TODAY);
    const trend = model.overview().trend;
    expect(trend[0]).toMatchObject({ followers: 10, coverage: { followers: 2 }, likes: null });
    expect(trend[1]).toMatchObject({ followers: 4, coverage: { followers: 1 }, likes: null });
  });

  it("uses the requested range, excludes future and work snapshots, and resolves equal timestamps deterministically", () => {
    const account = store.accounts.create({ platformId: "douyin" });
    snapshot(account, "followers", 5, THREE_DAYS_AGO);
    snapshot(account, "followers", 10, TODAY);
    snapshot(account, "followers", 12, TODAY);
    snapshot(account, "followers", 999, "2026-09-29T02:00:00.000Z");
    const work = makeWork(account, "one", { plays: 55 }, TODAY);
    store.metrics.upsertWorks([work]);
    snapshot(account, "plays", 55, TODAY, work.id);
    const view = model.account(account.id, 1);
    expect(view.metrics.followers?.current).toBe(12);
    expect(view.metrics.plays).toBeUndefined();
    expect(view.trend).toHaveLength(1);
    expect(view.trend[0]).toMatchObject({ date: "2026-09-28", followers: 12, plays: null });
    expect(model.overview(1).trend).toEqual(view.trend);
    expect(model.account(account.id, 365).trend[0].date).toBe("2026-09-25");
  });

  it("compares instants correctly across ISO precision and offset formats accepted by backups", () => {
    const account = store.accounts.create({ platformId: "douyin" });
    snapshot(account, "followers", 10, "2026-09-27T15:59:59Z");
    snapshot(account, "followers", 20, "2026-09-28T11:00:00+08:00");
    snapshot(account, "followers", 30, "2026-09-28T04:00:00Z"); // Exactly now, without milliseconds.
    snapshot(account, "likes", 1, "2026-09-28T01:00:00+08:00"); // Beijing today, despite UTC yesterday.
    const view = model.account(account.id, 1);
    expect(view.metrics.followers).toMatchObject({ current: 30, day: 20 });
    expect(view.trend).toHaveLength(1);
    expect(view.trend[0]).toMatchObject({ date: "2026-09-28", followers: 30, likes: 1 });
  });

  it("uses a baseline strictly before Beijing midnight and includes an observation exactly at now", () => {
    const account = store.accounts.create({ platformId: "douyin" });
    snapshot(account, "followers", 10, "2026-09-27T15:59:59.999Z");
    snapshot(account, "followers", 12, "2026-09-28T00:00:00+08:00");
    snapshot(account, "followers", 15, NOW);
    snapshot(account, "likes", 3, "2026-09-27T16:00:00.000Z"); // No earlier baseline.
    snapshot(account, "likes", 4, NOW);
    const view = model.account(account.id, 1);
    expect(view.metrics.followers).toMatchObject({ current: 15, day: 5 });
    expect(view.metrics.likes).toMatchObject({ current: 4, day: null });
    expect(view.trend[0]).toMatchObject({ date: "2026-09-28", followers: 15, likes: 4 });
  });

  it("upgrades the instant index without rewriting existing observations or backup timestamps", () => {
    store.db.exec("DROP INDEX idx_account_metric_instant");
    store.db.run("DELETE FROM schema_migrations WHERE version = ?", [18]);
    const account = store.accounts.create({ platformId: "douyin" });
    snapshot(account, "followers", 20, "2026-09-28T11:00:00+08:00");
    const before = store.metrics.listSnapshots(account.id);
    migrate(store.db);
    expect(store.metrics.listSnapshots(account.id)).toEqual(before);
    expect(model.account(account.id).metrics.followers?.current).toBe(20);
    expect(store.db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_account_metric_instant'")).toBeDefined();
  });

  it("counts all collected works separately from account totals and reports per-field legacy coverage", () => {
    const account = store.accounts.create({ platformId: "weixin_channels" });
    store.metrics.upsertWorks(Array.from({ length: 60 }, (_, i) => makeWork(account, String(i), { plays: i }, YESTERDAY)));
    store.metrics.upsertWorks([makeWork(account, "0", { likes: 0 }, TODAY)]);
    const legacy = makeWork(account, "legacy", { plays: 10 }, TODAY);
    delete legacy.observations;
    store.metrics.upsertWorks([legacy]);
    snapshot(account, "works", 100, TODAY);
    const view = model.account(account.id);
    expect(store.metrics.listWorks(account.id)).toHaveLength(50);
    expect(view.collectedWorkCount).toBe(61);
    expect(view.workTotals?.plays).toBe(1780);
    expect(view.metrics.works?.current).toBe(100);
    expect(view.metrics.plays).toBeUndefined();
    expect(view.workCoverage?.plays).toEqual({ observed: 61, legacy: 1, capturedAt: TODAY });
    expect(view.workCoverage?.likes).toEqual({ observed: 2, legacy: 1, capturedAt: TODAY });
    expect(view.workCoverage?.shares).toEqual({ observed: 1, legacy: 1, capturedAt: TODAY });
    expect(model.overview().totals).toEqual({ works: 100 });
  });

  it("keeps completely missing collected-work fields absent instead of summing stored placeholders", () => {
    const account = store.accounts.create({ platformId: "baijiahao" });
    store.metrics.upsertWorks([makeWork(account, "one", { plays: 0 }, TODAY)]);
    const view = model.account(account.id);
    expect(view.workTotals).toEqual({ plays: 0 });
    WORK_METRICS.filter((metric) => metric !== "plays").forEach((metric) => {
      expect(view.workCoverage?.[metric]).toEqual({ observed: 0, legacy: 0, capturedAt: null });
    });
  });

  it("preserves the chronologically newest work observations even when backup timestamps use offsets", () => {
    const account = store.accounts.create({ platformId: "bilibili" });
    store.metrics.upsertWorks([makeWork(account, "one", { plays: 100, title: "newer" }, TODAY)]);
    store.metrics.upsertWorks([makeWork(account, "one", { plays: 50, title: "older" }, "2026-09-28T09:00:00+08:00")]);
    const work = store.metrics.listWorks(account.id)[0];
    expect(work).toMatchObject({ plays: 100, title: "newer", fetchedAt: TODAY });
    expect(model.account(account.id).workCoverage?.plays?.capturedAt).toBe(TODAY);
  });

  it("preserves the last attempted collection while ignoring later skipped and keepalive runs", () => {
    const account = store.accounts.create({ platformId: "kuaishou" });
    const first = store.metrics.startRun({ accountId: account.id, platformId: account.platformId,
      status: "failed", trigger: "manual", startedAt: YESTERDAY, message: "采集未完成" });
    store.metrics.startRun({ accountId: account.id, platformId: account.platformId,
      status: "skipped", trigger: "scheduled", startedAt: TODAY });
    store.metrics.startRun({ accountId: account.id, platformId: account.platformId,
      status: "success", trigger: "keepalive", startedAt: NOW });
    expect(model.platform("kuaishou").accounts[0].lastRun?.id).toBe(first);
    expect(model.account(account.id).lastRun?.id).toBe(first);
  });

  it("uses six database reads for an overview regardless of the number of accounts", () => {
    for (let i = 0; i < 24; i++) {
      const account = store.accounts.create({ platformId: "douyin" });
      METRIC_NAMES.forEach((metric) => snapshot(account, metric, i, TODAY));
    }
    const all = vi.spyOn(store.db, "all"), get = vi.spyOn(store.db, "get");
    const result = model.overview(365);
    expect(result.accountCount).toBe(24);
    expect(result.coverage?.followers).toBe(24);
    expect(all).toHaveBeenCalledTimes(5);
    expect(get).toHaveBeenCalledTimes(1); // Account-list integrity count, not a per-account lookup.
    expect(get).toHaveBeenCalledWith("SELECT COUNT(*) AS n FROM accounts");
  });

  it.each([0, -1, 366, 1.5, NaN, Infinity])("rejects invalid time windows (%s) at every read-model entry", (days) => {
    const account = store.accounts.create({ platformId: "douyin" });
    expect(() => model.account(account.id, days)).toThrow("时间范围");
    expect(() => model.platform("douyin", days)).toThrow("时间范围");
    expect(() => model.overview(days)).toThrow("时间范围");
  });
});
