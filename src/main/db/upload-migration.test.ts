import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { MIGRATIONS } from "./migrations";
import { openDatabase } from "./database";

function removeFixture(dir: string): void {
  const resolved = path.resolve(dir);
  if (
    !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith("clipdock-upload-migration-")
  )
    throw new Error("INVALID_TEST_PATH");
  fs.rmSync(resolved, { recursive: true, force: true });
}

it("upgrades version 10 upload rows without firing credential deletion and restores the constraints", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipdock-upload-migration-"));
  const file = path.join(dir, "v10.sqlite"),
    previous = new DatabaseSync(file);
  const accountId = "11111111-1111-4111-8111-111111111111",
    jobId = "22222222-2222-4222-8222-222222222222";
  try {
    previous.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((item) => item.version <= 10)) {
      previous.exec(migration.sql);
      previous
        .prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-09-08T00:00:00.000Z");
    }
    previous
      .prepare(
        "INSERT INTO global_accounts (id,platform_id,display_name,created_at,updated_at) VALUES (?,'tiktok','Migration account','created','updated')",
      )
      .run(accountId);
    const json = JSON.stringify({
      id: jobId,
      accountId,
      platformId: "tiktok",
      assetId: "33333333-3333-4333-8333-333333333333",
      fileName: "video.mp4",
      state: "uploading",
      sentBytes: 7,
      totalBytes: 100,
      revision: 3,
      errorCode: null,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    });
    previous
      .prepare("INSERT INTO global_upload_jobs VALUES (?,?,'uploading',3,?,?,?,1,0)")
      .run(jobId, accountId, json, "a".repeat(64), "b".repeat(64));
    previous
      .prepare("INSERT INTO credentials VALUES ('upload-secret','upload_session',?,?,1,'created','updated')")
      .run(jobId, randomBytes(48));
    const beforeRow = previous.prepare("SELECT * FROM global_upload_jobs").get();
    const beforeCredentials = previous.prepare("SELECT * FROM credentials").all();
    previous.close();
    const upgraded = openDatabase(file);
    try {
      expect(upgraded.get("SELECT * FROM global_upload_jobs")).toEqual({
        ...beforeRow,
        not_before_at: 0,
        attempts: 0,
      });
      expect(upgraded.all("SELECT * FROM credentials")).toEqual(beforeCredentials);
      expect(upgraded.get("SELECT name FROM schema_migrations WHERE version=11")?.name).toBe(
        "youtube-resumable-upload-jobs",
      );
      expect(() =>
        upgraded.run(
          "INSERT INTO global_upload_jobs (id,account_id,state,revision,job_json,binding_hash,asset_sha256) VALUES ('second',?,'waiting-retry',1,'{}',?,?)",
          [accountId, "a".repeat(64), "b".repeat(64)],
        ),
      ).toThrow();
      expect(upgraded.all("PRAGMA foreign_key_check")).toEqual([]);
      upgraded.run("DELETE FROM global_accounts WHERE id=?", [accountId]);
      expect(upgraded.all("SELECT * FROM global_upload_jobs")).toEqual([]);
      expect(upgraded.all("SELECT * FROM credentials")).toEqual([]);
    } finally {
      upgraded.close();
    }
  } finally {
    if (previous.isOpen) previous.close();
    removeFixture(dir);
  }
});

it("upgrades a real version 9 database without rewriting previous encrypted credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipdock-upload-migration-"));
  const file = path.join(dir, "v9.sqlite");
  const previous = new DatabaseSync(file);
  try {
    previous.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((item) => item.version < 10)) {
      previous.exec(migration.sql);
      previous
        .prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-09-08T00:00:00.000Z");
    }
    for (const kind of ["clash_secret", "proxy_password", "oauth_token", "oauth_client_secret"]) {
      previous
        .prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(kind + "-synthetic-id", kind, "synthetic-owner", randomBytes(48), 1, "2026-09-07", "2026-09-08");
    }
    const rows = previous.prepare("SELECT * FROM credentials ORDER BY id").all();
    previous.close();
    const upgraded = openDatabase(file);
    try {
      expect(upgraded.all("SELECT * FROM credentials ORDER BY id")).toEqual(rows);
      expect(upgraded.get("SELECT name FROM schema_migrations WHERE version = 10")?.name).toBe(
        "durable-tiktok-draft-uploads",
      );
      expect(upgraded.all("SELECT * FROM global_upload_jobs")).toEqual([]);
      expect(upgraded.all("PRAGMA foreign_key_check")).toEqual([]);
      upgraded.run(
        "INSERT INTO credentials VALUES ('synthetic-upload','upload_session','synthetic-job',?,1,'created','updated')",
        [randomBytes(48)],
      );
      expect(upgraded.get("SELECT kind FROM credentials WHERE id = 'synthetic-upload'")?.kind).toBe(
        "upload_session",
      );
    } finally {
      upgraded.close();
    }
  } finally {
    if (previous.isOpen) previous.close();
    removeFixture(dir);
  }
});
