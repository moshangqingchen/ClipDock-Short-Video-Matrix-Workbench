import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createRecoveryPoint, openDatabase } from "./database";
import { MIGRATIONS } from "./migrations";
import { createStore } from "./index";
import { initialProgress } from "@shared/collect-jobs";

function clean(directory: string) {
  const absolute = path.resolve(directory);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith("sv-recovery-test-")) throw new Error("Invalid fixture path");
  fs.rmSync(absolute, { recursive: true, force: true });
}
it("makes a verified pre-migration SQLite snapshot including WAL changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sv-recovery-test-"));
  const file = path.join(directory, "old.sqlite");
  const old = new DatabaseSync(file);
  try {
    old.exec("PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)");
    for (const migration of MIGRATIONS.filter((row) => row.version <= 15)) {
      old.exec(migration.sql); old.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(migration.version, migration.name, "2026-09-01");
    }
    old.exec("CREATE TABLE synthetic_recovery_marker(value TEXT); INSERT INTO synthetic_recovery_marker VALUES('saved-before-upgrade')");
    const upgraded = openDatabase(file);
    try {
      expect(upgraded.get("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(17);
      const files = fs.readdirSync(path.join(directory, "recovery-points")); expect(files).toHaveLength(1);
      const snapshot = new DatabaseSync(path.join(directory, "recovery-points", files[0]), { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(15);
        expect(snapshot.prepare("SELECT value FROM synthetic_recovery_marker").get()?.value).toBe("saved-before-upgrade");
        expect(snapshot.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      } finally { snapshot.close(); }
      expect(createRecoveryPoint(upgraded, "restore")).toContain("restore-");
    } finally { upgraded.close(); }
  } finally { old.close(); clean(directory); }
});
it("restores paused progress, unique works and backoff after a database restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sv-recovery-test-"));
  const file = path.join(directory, "progress.sqlite");
  let store = createStore(file);
  try {
    const account = store.accounts.create({ platformId: "douyin" });
    const job = store.collectJobs.enqueue(account.id, "manual", false, "history");
    store.collectJobs.transition(job.id, ["queued"], "running");
    const progress = { ...initialProgress("history"), page: 4, cursor: "saved-cursor", pagesDone: 3, worksSeen: 75 };
    store.collectJobs.checkpoint(job.id, progress);
    store.db.run("INSERT INTO collection_seen VALUES(?,?)", [job.id, "synthetic-work"]);
    const until = Date.now() + 600_000;
    store.collectJobs.defer(job.id, until, "rate limited"); store.collectJobs.pause(job.id, true);
    store.close(); store = createStore(file); store.collectJobs.recoverInterrupted();
    expect(store.collectJobs.get(job.id)).toMatchObject({ progress, notBefore: until, paused: true, state: "waiting-network" });
    expect(store.db.get("SELECT COUNT(*) AS n FROM collection_seen WHERE job_id=?", [job.id])?.n).toBe(1);
  } finally { store.close(); clean(directory); }
});
