import { expect, it } from "vitest";
import type { WebObservation } from "./global-web-observation";
import { observationNumber, observationTrend } from "./global-web-trend";
const base: WebObservation = {
  accountId: "8e65b156-a2ee-48ac-957e-2f990141c207",
  platformId: "youtube",
  source: "webpage",
  engine: "chrome",
  capturedAt: "2026-09-10T08:00:00.000Z",
  page: "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  period: "Last 28 days",
  metrics: [{ key: "views", label: "Views", value: "1.2K" }],
};
it("compares only matching account, source and period; retains the last daily sample and never creates zero days", () => {
  const history: WebObservation[] = [
    {
      ...base,
      capturedAt: "2026-09-08T01:00:00.000Z",
      metrics: [{ key: "views", label: "Views", value: "900" }],
    },
    {
      ...base,
      capturedAt: "2026-09-08T02:00:00.000Z",
      metrics: [{ key: "views", label: "Views", value: "0" }],
    },
    { ...base, capturedAt: "2026-09-09T01:00:00.000Z", period: "Last 7 days" },
    { ...base, capturedAt: "2026-09-09T02:00:00.000Z", accountId: "77777777-7777-4777-8777-777777777777" },
  ];
  expect(
    observationTrend(history, base, "views", 7, new Date("2026-09-10T09:00:00.000Z")).map(
      (item) => item.value,
    ),
  ).toEqual([0, 1200]);
  expect(observationTrend(history, { ...base, period: null }, "views", 90)).toEqual([]);
});
it("keeps original display units and excludes percentages, signed changes and ambiguous decimal commas", () => {
  expect(observationNumber("1.2万")).toBe(12000);
  expect(observationNumber("1,234")).toBe(1234);
  expect(observationNumber("0.0")).toBe(0);
  for (const text of ["1,2", "+12", "12%", "—", "NaN"]) expect(observationNumber(text)).toBeNull();
});
