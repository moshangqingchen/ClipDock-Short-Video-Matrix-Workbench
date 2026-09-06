import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "@main/db";
import { applyBackup, buildBackup, readBackup, writeBackup } from "./backup";

describe("backup", () => {
  it("round-trips an encrypted backup without carrying login state", async () => {
    const source = createStore(":memory:");
    const account = source.accounts.create({ platformId: "douyin", displayName: "备份账号" });
    source.accounts.updateStatus(account.id, "online", "ok");
    source.metrics.saveSnapshots([
      {
        accountId: account.id,
        platformId: "douyin",
        metric: "followers",
        value: 42,
        capturedAt: new Date().toISOString(),
        source: "session",
      },
    ]);

    const payload = buildBackup(source, "test");
    expect(payload.accounts[0].status).toBe("unknown");
    expect(payload.accounts[0].lastOnlineAt).toBeNull();
    expect(JSON.stringify(payload)).not.toMatch(/cookie/i);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "svbak-")), "b.svbak");
    const meta = await writeBackup(file, payload, "correct horse battery");
    expect(meta.encrypted).toBe(true);

    await expect(readBackup(file, "wrong password")).rejects.toThrow(/解密|密码/);
    const restored = await readBackup(file, "correct horse battery");
    expect(restored.accounts[0].displayName).toBe("备份账号");

    const target = createStore(":memory:");
    expect(applyBackup(target, restored, "merge")).toBe(1);
    expect(target.accounts.list()[0].displayName).toBe("备份账号");
    expect(target.metrics.latest(account.id).get("followers")?.value).toBe(42);
    source.close();
    target.close();
  });

  it("rejects tampered payloads", async () => {
    const store = createStore(":memory:");
    store.accounts.create({ platformId: "bilibili" });
    const payload = buildBackup(store, "test");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "svbak-")), "plain.svbak");
    await writeBackup(file, payload);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.payload.accounts[0].displayName = "tampered";
    fs.writeFileSync(file, JSON.stringify(raw));
    await expect(readBackup(file)).rejects.toThrow(/校验/);
    store.close();
  });
});
