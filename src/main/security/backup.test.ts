import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createStore } from "@main/db";
import { partitionForAccount } from "@main/browser/partition";
import type { BackupPayload } from "@shared/types";
import { applyBackup, buildBackup, readBackup, writeBackup } from "./backup";

/** Reproduce historical checksums before unknown-field migration runs. */
function writeLegacyBackup(value: unknown, version = 2, withChecksum = true): string {
  const payload = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const metadata = payload.metadata as Record<string, unknown>;
  delete metadata.checksum;
  if (withChecksum) metadata.checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "svbak-schema-")), "legacy.svbak");
  fs.writeFileSync(
    file,
    JSON.stringify({ format: "sv-workbench-backup", version, encrypted: false, payload }),
  );
  return file;
}

describe("backup", () => {
  it.each([
    "https://images.example.test/path-capability/avatar.jpg?signature=private-media",
    "sv-asset://remote/86cd4ebf-007c-4b24-8b0a-6b84097f304a",
  ])("excludes remote media and cache references from every backup: %s", async (mediaUrl) => {
    const source = createStore(":memory:");
    try {
      const account = source.accounts.create({ platformId: "bilibili" });
      source.accounts.update(account.id, { avatarUrl: mediaUrl });
      source.metrics.upsertWorks([
        {
          id: `${account.id}:one`,
          accountId: account.id,
          platformId: account.platformId,
          remoteId: "one",
          title: "作品",
          coverUrl: mediaUrl,
          plays: 2,
          likes: 0,
          comments: 0,
          shares: 0,
          favorites: 0,
          fetchedAt: new Date().toISOString(),
        },
      ]);
      const payload = buildBackup(source, "test");
      expect(payload.accounts[0].avatarUrl).toBeNull();
      expect(payload.works[0].coverUrl).toBeNull();
      expect(JSON.stringify(payload)).not.toContain(mediaUrl);
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "svbak-media-")), "media.svbak");
      await writeBackup(file, payload);
      expect(fs.readFileSync(file, "utf8")).not.toContain(mediaUrl);
      // Exporting is a projection and does not mutate an observe-mode database.
      expect(source.accounts.get(account.id)?.avatarUrl).toBe(mediaUrl);
    } finally {
      source.close();
    }
  });

  it.each([1, 2])(
    "checks original v%i checksums before discarding old image URLs and cache IDs",
    async (version) => {
      const source = createStore(":memory:");
      const target = createStore(":memory:");
      try {
        const account = source.accounts.create({ platformId: "douyin" });
        const payload = buildBackup(source, "legacy");
        const remote = "https://images.example.test/capability/cover.png?signature=legacy-secret";
        const cache = "sv-asset://remote/86cd4ebf-007c-4b24-8b0a-6b84097f304a";
        const legacy = {
          ...payload,
          metadata: { ...payload.metadata, version },
          accounts: [{ ...account, avatarUrl: remote }],
          works: [
            {
              id: `${account.id}:one`,
              accountId: account.id,
              platformId: account.platformId,
              remoteId: "one",
              title: "作品",
              coverUrl: cache,
              plays: 2,
              likes: 0,
              comments: 0,
              shares: 0,
              favorites: 0,
              fetchedAt: account.createdAt,
            },
          ],
        };
        const file = writeLegacyBackup(legacy, version);
        const restored = await readBackup(file);
        expect(restored.accounts[0].avatarUrl).toBeNull();
        expect(restored.works[0].coverUrl).toBeNull();
        expect(JSON.stringify(restored)).not.toContain("legacy-secret");
        expect(JSON.stringify(restored)).not.toContain(cache);
        applyBackup(target, restored, "merge");
        expect(target.accounts.get(account.id)?.avatarUrl).toBeNull();
        expect(target.metrics.listWorks(account.id)[0].coverUrl).toBeNull();
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        raw.payload.accounts[0].avatarUrl = `${remote}&tampered=1`;
        fs.writeFileSync(file, JSON.stringify(raw));
        await expect(readBackup(file)).rejects.toThrow(/校验/);
      } finally {
        source.close();
        target.close();
      }
    },
  );

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

  it("round-trips the full metadata DTO without scheduling saved publishing plans", async () => {
    const source = createStore(":memory:");
    const account = source.accounts.create({ platformId: "weixin_channels" });
    const now = new Date().toISOString();
    const asset = source.assets.insert({
      id: randomUUID(),
      kind: "video",
      filePath: "D:\\videos\\example.mp4",
      fileName: "example.mp4",
      sizeBytes: 1234,
      createdAt: now,
    });
    source.metrics.upsertWorks([
      {
        id: `${account.id}:work-1`,
        accountId: account.id,
        platformId: account.platformId,
        remoteId: "work-1",
        title: "作品",
        plays: 2,
        likes: 1,
        comments: 0,
        shares: 0,
        favorites: 0,
        fetchedAt: now,
      },
    ]);
    const record = source.publish.save(
      {
        accountId: account.id,
        assetIds: [asset.id],
        title: "人工发布计划",
        status: "planned",
      },
      account.platformId,
    );
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "svbak-")), "full.svbak");
    await writeBackup(file, buildBackup(source, "test"));
    const payload = await readBackup(file);
    const target = createStore(":memory:");
    applyBackup(target, payload, "replace");
    expect(target.assets.get(asset.id)?.filePath).toBe(asset.filePath);
    expect(target.metrics.listWorks(account.id)[0].title).toBe("作品");
    expect(target.publish.get(record.id)?.status).toBe("planned");
    expect(target.metrics.listRuns(account.id)).toEqual([]);
    source.close();
    target.close();
  });

  it.each([1, 2])(
    "imports v%i while stripping obsolete fields and discarding route permissions",
    async (version) => {
      const source = createStore(":memory:");
      const account = source.accounts.create({ platformId: "baijiahao" });
      const payload = buildBackup(source, "old-version");
      const legacy = {
        ...payload,
        metadata: { ...payload.metadata, version, obsoleteVersionField: true },
        accounts: [{ ...account, status: "online", partition: "persist:foreign", routePermit: true }],
        settings: {
          theme: "dark",
          lastActiveAccountId: account.id,
          lastRoute: "/browser",
          forceOnline: true,
        },
        directProof: { allow: true },
        activeJobs: [{ kind: "upload", state: "running" }],
      };
      const restored = await readBackup(writeLegacyBackup(legacy, version));
      expect(restored.accounts[0].status).toBe("unknown");
      expect(restored.accounts[0].partition).toBe(partitionForAccount(account.id));
      expect(restored.settings).toEqual({ theme: "dark" });
      expect(JSON.stringify(restored)).not.toMatch(
        /routePermit|forceOnline|directProof|activeJobs|obsoleteVersionField/,
      );
      const target = createStore(":memory:");
      expect(applyBackup(target, restored, "merge")).toBe(1);
      expect(target.settings.get().theme).toBe("dark");
      expect(target.settings.get().lastRoute).toBeNull();
      source.close();
      target.close();
    },
  );

  it("supports legacy payloads without optional metadata collections or checksums", async () => {
    const source = createStore(":memory:");
    const account = source.accounts.create({ platformId: "bilibili" });
    const payload = buildBackup(source, "old-version");
    const restored = await readBackup(
      writeLegacyBackup(
        {
          metadata: { ...payload.metadata, version: 1 },
          accounts: [account],
        },
        1,
        false,
      ),
    );
    expect(restored.metrics).toEqual([]);
    expect(restored.works).toEqual([]);
    expect(restored.assets).toEqual([]);
    expect(restored.publishRecords).toEqual([]);
    expect(restored.settings).toEqual({});
    source.close();
  });

  it.each([
    "client_secret",
    "id_token",
    "proxyPassword",
    "ClashSecret",
    "Authorization",
    "credentials",
    "credential_ref",
  ])("rejects %s even inside an unknown legacy settings field", async (key) => {
    const source = createStore(":memory:");
    const payload = buildBackup(source, "test");
    const contaminated = { ...payload, settings: { legacyNetwork: { [key]: "sentinel-credential" } } };
    await expect(readBackup(writeLegacyBackup(contaminated))).rejects.toThrow(/敏感字段/);
    source.close();
  });

  it("rejects international accounts and mismatched account references before applying a replacement", async () => {
    const source = createStore(":memory:");
    const account = source.accounts.create({ platformId: "douyin" });
    const payload = buildBackup(source, "test");
    const international = { ...payload, accounts: [{ ...account, platformId: "youtube" }] };
    await expect(readBackup(writeLegacyBackup(international))).rejects.toThrow(/备份内容无效/);
    const orphan = {
      ...payload,
      metrics: [
        {
          accountId: account.id,
          platformId: "bilibili",
          metric: "followers",
          value: 1,
          capturedAt: new Date().toISOString(),
          source: "session",
        },
      ],
    };
    await expect(readBackup(writeLegacyBackup(orphan))).rejects.toThrow(/备份内容无效/);
    const target = createStore(":memory:");
    const existing = target.accounts.create({ platformId: "kuaishou" });
    const bypassRead = { ...international, metadata: { ...payload.metadata, checksum: undefined } };
    expect(() => applyBackup(target, bypassRead as unknown as BackupPayload, "replace")).toThrow(
      /备份内容无效/,
    );
    expect(target.accounts.get(existing.id)?.platformId).toBe("kuaishou");
    source.close();
    target.close();
  });

  it("validates writes instead of serializing extra caller-supplied credentials", async () => {
    const source = createStore(":memory:");
    const payload = buildBackup(source, "test");
    Object.assign(payload.settings, { proxyPassword: "sentinel-proxy-password" });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "svbak-")), "unsafe.svbak");
    await expect(writeBackup(file, payload, "correct horse battery")).rejects.toThrow(/敏感字段/);
    expect(fs.existsSync(file)).toBe(false);
    source.close();
  });

  it.each(["merge", "replace"] as const)(
    "rejects cross-platform UUID reuse before %s changes the database",
    (mode) => {
      const store = createStore(":memory:");
      const account = store.accounts.create({ platformId: "douyin" });
      const payload = buildBackup(store, "test");
      const replacement = {
        ...payload,
        metadata: { ...payload.metadata, checksum: undefined },
        accounts: [{ ...payload.accounts[0], platformId: "bilibili" }],
      } as BackupPayload;
      expect(() => applyBackup(store, replacement, mode)).toThrow(/UUID.*平台/);
      expect(store.accounts.get(account.id)?.platformId).toBe("douyin");
      expect(store.accounts.list()).toHaveLength(1);
      store.close();
    },
  );
});
