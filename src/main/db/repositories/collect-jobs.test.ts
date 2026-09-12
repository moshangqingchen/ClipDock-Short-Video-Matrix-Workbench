import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createStore, type Store } from "@main/db";

const stores: Store[] = [];
const open = () => {
  const store = createStore(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("CollectJobsRepository", () => {
  it("merges manual, scheduled, login and keepalive into one active account task", () => {
    const store = open(),
      account = store.accounts.create({ platformId: "douyin" });
    const job = store.collectJobs.enqueue(account.id, "keepalive", true);
    for (const trigger of ["scheduled", "login", "manual"] as const)
      expect(store.collectJobs.enqueue(account.id, trigger, true).id).toBe(job.id);
    expect(store.collectJobs.list(account.id, true)).toHaveLength(1);
    expect(store.collectJobs.get(job.id)).toMatchObject({ trigger: "manual", state: "waiting-network" });
    store.collectJobs.transition(job.id, ["waiting-network"], "running");
    expect(store.collectJobs.enqueue(account.id, "manual", false).id).toBe(job.id);
    expect(store.collectJobs.get(job.id)?.attempts).toBe(1);
  });
  it("never resurrects cancelled jobs and enforces one active row in SQLite", () => {
    const store = open(),
      account = store.accounts.create({ platformId: "douyin" });
    const first = store.collectJobs.enqueue(account.id, "manual", false);
    store.collectJobs.cancel(first.id);
    expect(store.collectJobs.transition(first.id, ["running"], "done")).toBeNull();
    const second = store.collectJobs.enqueue(account.id, "manual", false);
    expect(second.id).not.toBe(first.id);
    expect(() => store.collectJobs.transition(first.id, ["cancelled"], "queued")).toThrow();
    store.accounts.delete(account.id);
    expect(store.collectJobs.list()).toEqual([]);
  });
  it("recovers persisted in-flight tasks into waiting without persisting permits", () => {
    const directory = mkdtempSync(join(tmpdir(), "clipdock-jobs-"));
    const file = join(directory, "queue.sqlite");
    let store = createStore(file);
    try {
      const account = store.accounts.create({ platformId: "bilibili" });
      const job = store.collectJobs.enqueue(account.id, "manual", false);
      store.collectJobs.transition(job.id, ["queued"], "running");
      store.close();
      store = createStore(file);
      store.collectJobs.recoverInterrupted();
      expect(store.collectJobs.get(job.id)).toMatchObject({
        state: "waiting-network",
        attempts: 1,
        runId: null,
      });
      expect(store.collectJobs.enqueue(account.id, "scheduled", true).id).toBe(job.id);
      expect(store.metrics.listRuns(account.id)).toEqual([]);
    } finally {
      store.close();
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects non-domestic and missing accounts before creating jobs", () => {
    const store = open(),
      account = store.accounts.create({ platformId: "douyin" });
    store.db.run("UPDATE accounts SET platform_id = 'youtube' WHERE id = ?", [account.id]);
    expect(() => store.collectJobs.enqueue(account.id, "manual", false)).toThrow(/国内/);
    expect(() => store.collectJobs.enqueue("missing", "manual", false)).toThrow(/国内/);
    expect(store.collectJobs.list()).toEqual([]);
  });
});
