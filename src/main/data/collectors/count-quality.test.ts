import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "@main/db";
import { workMetric } from "@shared/metric-quality";
import { ReadModel } from "../read-model";
import { makeWork, profileToMetrics, toNumber, worksToMetrics } from "./shared";

const stores: Store[] = [];
const open = () => { const store = createStore(":memory:"); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("count observation quality", () => {
  it.each([
    [0, 0], [789, 789], ["0", 0], ["3,456", 3456], ["1.2万", 12000],
    ["12w", 120000], ["2W", 20000], ["1.5亿", 150000000], ["2.5K", 2500],
    ["3M", 3000000], [" 1.001 万 ", 10010], ["0.001k", 1], ["42.0", 42],
    ["9,007,199,254,740,991", Number.MAX_SAFE_INTEGER],
  ])("reads the complete supported count %j as %s", (input, expected) => {
    expect(toNumber(input)).toBe(expected);
  });

  it.each([
    null, undefined, false, true, {}, [], "", "--", "加载中", "12%", "12-20", "1万+",
    "12次", "1e3", "123invalid", "1,2,3", "3 456", "-1", -1, 1.5, "1.5",
    "0.0001k", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "9007199254740991.1",
    "9007199254740992", "900719925474.0992万", "1".repeat(129),
  ])("leaves ambiguous, malformed or unsafe counts unknown: %j", (input) => {
    expect(toNumber(input)).toBeNull();
  });

  it("does not overwrite saved observations or introduce zero when later values are invalid", () => {
    const store = open();
    const account = store.accounts.create({ platformId: "douyin" });
    const before = new Date(Date.now() - 1000).toISOString();
    const now = new Date().toISOString();
    const original = makeWork(account, "one", { plays: 100, likes: 9 }, before);
    store.metrics.upsertWorks([original]);
    store.metrics.saveSnapshots(profileToMetrics(account, { followers: 12 }, before));
    const invalid = makeWork(account, "one", {
      plays: -1, likes: 0, comments: toNumber("12%"), shares: Infinity, favorites: 1.5,
    }, now);
    expect(invalid.observations).toEqual({ likes: { capturedAt: now, origin: "official" } });
    expect(worksToMetrics([invalid], now).map(({ metric, value }) => [metric, value])).toEqual([["likes", 0]]);
    expect(profileToMetrics(account, { followers: -1, plays: Infinity, likes: 1.5 }, now)).toEqual([]);
    store.metrics.upsertWorks([invalid]);
    const saved = store.metrics.listWorks(account.id)[0];
    expect(workMetric(saved, "plays")).toBe(100);
    expect(workMetric(saved, "likes")).toBe(0);
    expect(workMetric(saved, "comments")).toBeNull();
    const view = new ReadModel(store).account(account.id);
    expect(view.metrics.followers?.current).toBe(12);
    expect(view.workTotals).toEqual({ plays: 100, likes: 0 });
  });
});
