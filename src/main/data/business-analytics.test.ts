import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { CN_PLATFORM_IDS, getPlatform } from "@shared/platforms";
import { analyticsRecordSchema, type AnalyticsRecord } from "@shared/business-analytics";
import { analyticsPageAllowed, parseAnalyticsPage, parseDuration, parseRate, type AnalyticsPageSample } from "./business-analytics-page";
import { BusinessAnalyticsRepository } from "./business-analytics-repository";
import { makeWork } from "./collectors/shared";
import { applyBackup, buildBackup } from "@main/security/backup";

const stores: Store[] = [];
const open = () => { const store = createStore(":memory:"); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });
const sample: AnalyticsPageSample = {
  dates: ["2026-09-01", "2026-09-07"], permissionRequired: false,
  cards: [
    { label: "完播率", text: "25%", dates: [] },
    { label: "平均观看时长", text: "1.5 分钟", dates: [] },
    { label: "预估收益", text: "1,200.50 元", dates: [] },
    { label: "已结算收益", text: "￥1000", dates: [] },
  ],
  groups: [
    { dimension: "粉丝性别", dates: [], entries: [{ label: "男", text: "40%" }, { label: "女", text: "60%" }] },
    { dimension: "流量来源", dates: [], entries: [{ label: "推荐", text: "90%" }, { label: "搜索", text: "10%" }] },
  ],
};
describe("business analytics evidence and units", () => {
  it.each(CN_PLATFORM_IDS)("%s retains the official range and separates estimates from settlement", (platformId) => {
    const account = open().accounts.create({ platformId });
    const parsed = parseAnalyticsPage(account, sample);
    expect(parsed.records).toHaveLength(6);
    expect(parsed.states.every((state) => state.state === "available")).toBe(true);
    expect(parsed.records.every((record) => record.startDate === "2026-09-01" && record.endDate === "2026-09-07" && record.granularity === "range")).toBe(true);
    expect(parsed.records.find((r) => r.metric === "completionRate")?.data).toEqual({ kind: "rate", value: 0.25, unit: "ratio" });
    expect(parsed.records.find((r) => r.metric === "averageWatchTime")?.data).toEqual({ kind: "duration", value: 90, unit: "seconds" });
    expect(parsed.records.filter((r) => r.metric === "contentRevenue").map((r) => r.data)).toEqual([
      { kind: "money", value: 1200.5, currency: "CNY", settlement: "estimated" },
      { kind: "money", value: 1000, currency: "CNY", settlement: "settled" },
    ]);
    expect(analyticsPageAllowed(platformId, getPlatform(platformId).routes.analytics)).toBe(true);
    expect(analyticsPageAllowed(platformId, "https://untrusted.example/analysis")).toBe(false);
  });
  it("accepts true zero and refuses missing/ambiguous units, dates and revenue state", () => {
    const account = open().accounts.create({ platformId: "douyin" });
    expect(parseRate("0%")).toBe(0);
    expect(parseRate("25")).toBeNull(); expect(parseRate("101%")).toBeNull();
    expect(parseDuration("00:30")).toBe(30); expect(parseDuration("30")).toBeNull();
    const uncertain = { ...sample, groups: [], cards: [{ label: "内容收益", text: "100元", dates: [] }] };
    expect(parseAnalyticsPage(account, uncertain).records).toEqual([]);
    for (const dates of [[], ["2026-09-01", "2026-09-07", "2026-09-08"], ["2026-02-30"], ["2026-09-07", "2026-09-01"]])
      expect(parseAnalyticsPage(account, { ...sample, dates }).records).toEqual([]);
    expect(parseAnalyticsPage(account, { ...sample, permissionRequired: true })).toMatchObject({ records: [], states: Array.from({ length: 5 }, () => expect.objectContaining({ state: "permission-required" })) });
  });
  it("rejects impossible distributions, units and daily ranges", () => {
    const account = open().accounts.create({ platformId: "douyin" });
    const record = parseAnalyticsPage(account, sample).records[0];
    expect(analyticsRecordSchema.safeParse({ ...record, granularity: "day" }).success).toBe(false);
    expect(analyticsRecordSchema.safeParse({ ...record, data: { kind: "duration", unit: "seconds", value: 1 } }).success).toBe(false);
    expect(analyticsRecordSchema.safeParse({ ...record, metric: "audience", data: { kind: "distribution", dimension: "性别", unit: "ratio", entries: [{ label: "a", value: 0.4 }, { label: "a", value: 0.6 }] } }).success).toBe(false);
  });
  it("isolates platforms, accounts and works and never lets older revisions overwrite new ones", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    const store = open(), account = store.accounts.create({ platformId: "douyin" });
    const other = store.accounts.create({ platformId: "douyin" });
    const repo = new BusinessAnalyticsRepository(store.db), record = parseAnalyticsPage(account, sample, "2026-09-21T00:00:00Z").records[0];
    expect(repo.enabled("douyin")).toBe(false); repo.setEnabled("douyin", true);
    expect(repo.enabled("kuaishou")).toBe(false);
    repo.save([record]); repo.save([{ ...record, capturedAt: "2026-09-20T00:00:00Z", data: { kind: "rate", unit: "ratio", value: 0 } }]);
    expect(repo.view(account.id).records[0].data).toEqual(record.data);
    const revised: AnalyticsRecord = { ...record, capturedAt: "2026-09-22T00:00:00Z", data: { kind: "rate", unit: "ratio", value: 0 } };
    repo.save([revised]); expect(repo.view(account.id).records).toEqual([revised]);
    expect(repo.view(other.id).records).toEqual([]);
    expect(() => repo.save([{ ...record, platformId: "bilibili" }])).toThrow(/不匹配/);
    const work = makeWork(other, "other-video", {}, new Date().toISOString()); store.metrics.upsertWorks([work]);
    expect(() => repo.save([{ ...record, workId: work.id }])).toThrow(/不属于/);
    repo.status(account.id, [{ metric: "completionRate", state: "failed", reason: "fixture", checkedAt: new Date().toISOString() }]);
    expect(repo.view(account.id).records).toEqual([revised]);
  });
  it("backs up business records and repeated restore does not duplicate intervals or settlement states", () => {
    const source = open(), target = open(), account = source.accounts.create({ platformId: "bilibili" });
    const repo = new BusinessAnalyticsRepository(source.db);
    repo.save(parseAnalyticsPage(account, sample).records);
    const backup = buildBackup(source, "test");
    applyBackup(target, backup, "merge"); applyBackup(target, backup, "merge");
    const restored = new BusinessAnalyticsRepository(target.db);
    expect(restored.all()).toEqual(repo.all());
    expect(restored.all()).toHaveLength(6);
    expect(restored.enabled("bilibili")).toBe(false);
  });
});
