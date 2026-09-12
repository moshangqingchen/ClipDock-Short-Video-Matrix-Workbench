import { it, expect } from "vitest";
import { createStore } from "@main/db";
import { GlobalAccountRepository } from "@main/api/global-account-repository";
import { GlobalWorkspaceRepository } from "@main/data/global-workspace-repository";
import { GlobalWebObservationRepository } from "@main/data/global-web-observation-repository";
import { parseWebObservation } from "@main/data/global-web-observation";
import { buildBackup, applyBackup, writeBackup, readBackup } from "./backup";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
it("roundtrips global metadata, observations, zero-valued works and plans through encrypted backup without auth", async () => {
  const source = createStore(":memory:"),
    target = createStore(":memory:");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "global-backup-test-"));
  try {
    const accounts = new GlobalAccountRepository(source.db),
      a = accounts.create({ platformId: "x", displayName: "Account" }),
      repo = new GlobalWorkspaceRepository(source.db);
    accounts.update(a.id, { displayName: "Account", note: "Note" });
    repo.saveIdentity(a.id, {
      status: "online",
      subjectId: "owner",
      displayName: "Owner",
      checkedAt: new Date().toISOString(),
    });
    repo.saveWorks([
      {
        accountId: a.id,
        platformId: "x",
        subjectId: "owner",
        remoteId: "123",
        title: "Post",
        url: "https://x.com/owner/status/123",
        publishedAt: null,
        metrics: { likes: "0" },
        capturedAt: new Date().toISOString(),
      },
    ]);
    const plan = repo.publishSave({ accountId: a.id, assetIds: [], title: "Draft" }, "x");
    new GlobalWebObservationRepository(source.db).save({
      ...parseWebObservation(a.id, "x", "chrome", {
        url: "https://x.com/i/account_analytics",
        text: "Last 7 days\nImpressions\n20",
      }),
      subjectId: "owner",
    });
    const payload = buildBackup(source, "test"),
      file = path.join(dir, "backup.svbak");
    await writeBackup(file, payload, "test-password-123");
    expect(await fs.readFile(file, "utf8")).not.toContain("Draft");
    const restored = await readBackup(file, "test-password-123");
    applyBackup(target, restored, "replace");
    expect(new GlobalAccountRepository(target.db).get(a.id)).toMatchObject({
      note: "Note",
      authStatus: "unauthorized",
      browserEngine: "chrome",
    });
    const out = new GlobalWorkspaceRepository(target.db);
    expect(out.identity(a.id)).toBeNull();
    expect(out.works(a.id, "owner")[0].metrics.likes).toBe("0");
    expect(out.publishList()[0]).toEqual(plan);
    expect(new GlobalWebObservationRepository(target.db).history(a.id)).toHaveLength(1);
  } finally {
    source.close();
    target.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it("legacy domestic replacement preserves global records", () => {
  const source = createStore(":memory:"),
    target = createStore(":memory:");
  try {
    const account = new GlobalAccountRepository(target.db).create({ platformId: "youtube" });
    const repo = new GlobalWorkspaceRepository(target.db);
    repo.publishSave({ accountId: account.id, assetIds: [], title: "Keep" }, "youtube");
    const payload = buildBackup(source, "test");
    delete payload.global;
    delete payload.metadata.checksum;
    payload.metadata.version = 2;
    applyBackup(target, payload, "replace");
    expect(new GlobalAccountRepository(target.db).get(account.id)).toBeDefined();
    expect(repo.publishList()[0].title).toBe("Keep");
  } finally {
    source.close();
    target.close();
  }
});
