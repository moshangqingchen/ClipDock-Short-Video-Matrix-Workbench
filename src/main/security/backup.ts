import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import type { BackupMetadata, BackupPayload } from "@shared/types";
import { METRIC_NAMES } from "@shared/types";
import { CN_PLATFORM_IDS } from "@shared/platforms";
import type { Store } from "@main/db";
import { MAX_ACCOUNTS } from "@main/db/repositories/accounts";
import { partitionForAccount } from "@main/browser/partition";

import { globalAccountSchema } from "@shared/global-accounts";
import { globalWorkSchema, globalPublishRecordSchema } from "@shared/global-workspace";
import { webObservationSchema } from "@shared/global-web-observation";
import { GlobalAccountRepository, MAX_GLOBAL_ACCOUNTS } from "@main/api/global-account-repository";
import { GlobalWebObservationRepository } from "@main/data/global-web-observation-repository";
import { GlobalWorkspaceRepository } from "@main/data/global-workspace-repository";

const globalBackupSchema = z
  .object({
    accounts: z
      .array(
        z.object({
          id: globalAccountSchema.shape.id,
          platformId: globalAccountSchema.shape.platformId,
          displayName: globalAccountSchema.shape.displayName,
          note: globalAccountSchema.shape.note,
          browserEngine: globalAccountSchema.shape.browserEngine,
          createdAt: globalAccountSchema.shape.createdAt,
          updatedAt: globalAccountSchema.shape.updatedAt,
        }),
      )
      .max(30),
    observations: z.array(webObservationSchema).max(30030),
    works: z.array(globalWorkSchema).max(100000),
    publishRecords: z.array(globalPublishRecordSchema).max(100000),
  })
  .superRefine((data, ctx) => {
    const accounts = new Map(data.accounts.map((a) => [a.id, a.platformId]));
    if (accounts.size !== data.accounts.length) ctx.addIssue({ code: "custom", message: "国外账号重复" });
    for (const rows of [data.observations, data.works, data.publishRecords])
      for (const row of rows) {
        if (accounts.get(row.accountId) !== row.platformId)
          ctx.addIssue({ code: "custom", message: "国外记录的账号或平台不一致" });
      }
  });

const FORMAT = "sv-workbench-backup" as const;
const VERSION = 3;
const MAX_BYTES = 256 * 1024 * 1024;
const KDF = { N: 16_384, r: 8, p: 1 };

const versionSchema = z.union([z.literal(1), z.literal(2), z.literal(VERSION)]);
const dateSchema = z.string().datetime({ offset: true });
const optionalText = z.string().max(20_000).nullish();
const optionalDate = dateSchema.nullish();
const platformSchema = z.enum(CN_PLATFORM_IDS);
const uuidSchema = z.string().uuid();

// These schemas are the backup DTO allowlist. Zod strips unknown legacy fields;
// runtime routing permissions, active jobs and browser/OAuth state are absent.
const backupAccountSchema = z
  .object({
    id: uuidSchema,
    platformId: platformSchema,
    displayName: z.string().min(1).max(60),
    handle: optionalText,
    externalId: optionalText,
    sortOrder: z.number().int().min(0).max(10_000),
    note: z.string().max(500).nullish(),
    createdAt: dateSchema,
    updatedAt: dateSchema,
  })
  .transform((account) => ({
    id: account.id,
    platformId: account.platformId,
    displayName: account.displayName,
    handle: account.handle ?? null,
    // Remote signatures and cache IDs have no authority after restore; neither enters backups.
    avatarUrl: null,
    externalId: account.externalId ?? null,
    partition: partitionForAccount(account.id),
    status: "unknown" as const,
    statusMessage: null,
    lastOnlineAt: null,
    lastCheckedAt: null,
    sessionExpiresAt: null,
    sortOrder: account.sortOrder,
    note: account.note ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }));

const backupMetricSchema = z.object({
  id: z.number().int().positive().optional(),
  accountId: uuidSchema,
  platformId: platformSchema,
  metric: z.enum(METRIC_NAMES),
  value: z.number().finite(),
  capturedAt: dateSchema,
  source: z.enum(["session", "manual"]),
  workId: optionalText,
});

const backupWorkSchema = z
  .object({
    id: z.string().min(1).max(1000),
    accountId: uuidSchema,
    platformId: platformSchema,
    remoteId: z.string().min(1).max(1000),
    title: z.string().max(20_000),
    url: optionalText,
    publishedAt: optionalDate,
    status: optionalText,
    plays: z.number().finite(),
    likes: z.number().finite(),
    comments: z.number().finite(),
    shares: z.number().finite(),
    favorites: z.number().finite(),
    fetchedAt: dateSchema,
  })
  .transform((work) => ({ ...work, coverUrl: null }));

const backupAssetSchema = z.object({
  id: uuidSchema,
  kind: z.enum(["video", "image", "audio", "other"]),
  filePath: z.string().min(1).max(32_768),
  fileName: z.string().min(1).max(1000),
  mimeType: optionalText,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullish(),
  durationMs: z.number().finite().nonnegative().nullish(),
  width: z.number().int().nonnegative().nullish(),
  height: z.number().int().nonnegative().nullish(),
  // Cache paths belong to this installation, never to a restored backup.
  // Keep accepting legacy paths for checksum validation, then discard them.
  thumbnailPath: z
    .string()
    .max(32_768)
    .nullish()
    .transform(() => null),
  createdAt: dateSchema,
});

const backupPublishSchema = z.object({
  id: uuidSchema,
  accountId: uuidSchema,
  platformId: platformSchema,
  assetIds: z.array(uuidSchema).max(50),
  title: z.string().max(200),
  description: z.string().max(5000),
  tags: z.array(z.string().min(1).max(40)).max(30),
  scheduledAt: optionalDate,
  status: z.enum(["planned", "published", "cancelled"]),
  publishedAt: optionalDate,
  workId: optionalText,
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

// Navigation restoration and the separate network configuration are intentionally
// excluded. Restoring a backup must not restore a route or a permission to send.
const backupSettingsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  maxLiveViews: z.number().int().min(2).max(12).optional(),
  collectIntervalHours: z.number().int().min(1).max(48).optional(),
  keepaliveIntervalHours: z.number().int().min(2).max(72).optional(),
  collectEnabled: z.boolean().optional(),
  keepaliveEnabled: z.boolean().optional(),
  notifyOnOffline: z.boolean().optional(),
  notifyOnExpiring: z.boolean().optional(),
  sidebarCollapsed: z.boolean().optional(),
});

const metadataSchema = z.object({
  globalAccountCount: z.number().int().min(0).max(30).optional(),
  format: z.literal(FORMAT),
  version: versionSchema,
  createdAt: dateSchema,
  appVersion: z.string().max(200).optional(),
  accountCount: z.number().int().min(0).max(MAX_ACCOUNTS),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  encrypted: z.boolean(),
});

const backupPayloadSchema = z
  .object({
    metadata: metadataSchema,
    accounts: z.array(backupAccountSchema).max(MAX_ACCOUNTS),
    metrics: z.array(backupMetricSchema).max(500_000).default([]),
    works: z.array(backupWorkSchema).max(500_000).default([]),
    assets: z.array(backupAssetSchema).max(100_000).default([]),
    publishRecords: z.array(backupPublishSchema).max(100_000).default([]),
    settings: backupSettingsSchema.default({}),
    global: globalBackupSchema.optional(),
  })
  .superRefine((payload, context) => {
    const fail = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    if (
      payload.global &&
      payload.metadata.globalAccountCount !== undefined &&
      payload.metadata.globalAccountCount !== payload.global.accounts.length
    )
      fail(["metadata", "globalAccountCount"], "国外账号数量不一致");
    if (payload.metadata.accountCount !== payload.accounts.length)
      fail(["metadata", "accountCount"], "账号数量不一致");
    for (const key of ["accounts", "works", "assets", "publishRecords"] as const) {
      const ids = new Set<string>();
      payload[key].forEach((row, index) => {
        if (ids.has(row.id)) fail([key, index, "id"], "记录 ID 重复");
        ids.add(row.id);
      });
    }
    const accounts = new Map(payload.accounts.map((account) => [account.id, account.platformId]));
    for (const key of ["metrics", "works", "publishRecords"] as const) {
      payload[key].forEach((row, index) => {
        if (accounts.get(row.accountId) !== row.platformId)
          fail([key, index, "accountId"], "账号不存在或平台不一致");
      });
    }
    // Asset and work references may outlive a deleted local asset/work. They
    // remain metadata references, never commands to reattach or upload files.
  });

const encodedBytes = (size?: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine(
      (value) => value.length > 0 && (size === undefined || Buffer.from(value, "base64").length === size),
      "加密数据格式无效",
    );
const envelopeSchema = z.discriminatedUnion("encrypted", [
  z.object({
    format: z.literal(FORMAT),
    version: versionSchema,
    encrypted: z.literal(false),
    payload: z.unknown(),
  }),
  z.object({
    format: z.literal(FORMAT),
    version: versionSchema,
    encrypted: z.literal(true),
    kdf: z.literal("scrypt"),
    salt: encodedBytes(16),
    iv: encodedBytes(12),
    authTag: encodedBytes(16),
    ciphertext: encodedBytes(),
    metadata: metadataSchema,
  }),
]);

interface EncryptedEnvelope {
  format: typeof FORMAT;
  version: number;
  encrypted: true;
  kdf: "scrypt";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  metadata: BackupMetadata;
}

interface PlainEnvelope {
  format: typeof FORMAT;
  version: number;
  encrypted: false;
  payload: BackupPayload;
}

/** Field names that must never appear in a backup (defence in depth). */
const FORBIDDEN_KEYS =
  /^(cookie|cookies|password|passwd|token|accesstoken|refreshtoken|idtoken|clientsecret|secret|clashsecret|clashapisecret|proxypassword|proxysecret|apikey|authorization|sessionid|bduss|sessdata|credential|credentials|credentialref|credentialrefs|credentialvault|encryptedcredentials|ciphertext)$/i;

function checksum(payload: BackupPayload): string {
  const copy = { ...payload, metadata: { ...payload.metadata, checksum: undefined } };
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function assertSafe(value: unknown, trail: string[] = []): void {
  if (trail.length > 64) throw new Error("备份内容嵌套过深");
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafe(item, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key.replace(/[^a-z0-9]/gi, "")))
      throw new Error("备份包含敏感字段,不能导出或导入凭据");
    assertSafe(child, [...trail, key]);
  }
}

function normalizePayload(value: unknown, verifyChecksum = true): BackupPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("备份内容损坏");
  const raw = value as Record<string, unknown>;
  if (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata))
    throw new Error("备份内容损坏");
  assertSafe(value);
  const rawMetadata = raw.metadata as Record<string, unknown>;
  // Check the original v1/v2 bytes before projecting away obsolete fields.
  if (verifyChecksum && rawMetadata.checksum && rawMetadata.checksum !== checksum(value as BackupPayload))
    throw new Error("备份校验失败,文件可能已损坏");
  const result = backupPayloadSchema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`备份内容无效: ${fields}`);
  }
  const payload: BackupPayload = result.data;
  payload.metadata.checksum = checksum(payload);
  return payload;
}

/**
 * Backups carry account metadata, metrics, works, asset references, publish
 * records and settings. They never contain browser profiles or cookies: a
 * restored account must be logged in again, by design.
 */
export function buildBackup(store: Store, appVersion: string): BackupPayload {
  const accounts = store.accounts.list();
  const settings = store.settings.get();
  assertSafe(settings);
  // Only these repositories participate. Each row and public setting is then
  // projected through the explicit DTO above; the store is never serialized.
  return normalizePayload(
    {
      metadata: {
        format: FORMAT,
        version: VERSION,
        createdAt: new Date().toISOString(),
        appVersion,
        accountCount: accounts.length,
        globalAccountCount: new GlobalAccountRepository(store.db).list().length,
        encrypted: false,
      },
      accounts,
      metrics: store.metrics.listSnapshots(undefined, 500_000),
      works: store.metrics.allWorks(),
      assets: store.assets.list(),
      publishRecords: store.publish.list(),
      settings: backupSettingsSchema.parse(settings),
      global: {
        accounts: new GlobalAccountRepository(store.db).list().map((account) => ({
          id: account.id,
          platformId: account.platformId,
          displayName: account.displayName,
          note: account.note,
          browserEngine: account.browserEngine,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        })),
        observations: new GlobalAccountRepository(store.db)
          .list()
          .flatMap((account) => new GlobalWebObservationRepository(store.db).history(account.id)),
        works: store.db
          .all("SELECT work_json FROM global_web_works")
          .map((row) => globalWorkSchema.parse(JSON.parse(String(row.work_json)))),
        publishRecords: new GlobalWorkspaceRepository(store.db).publishList(),
      },
    },
    false,
  );
}

export async function writeBackup(
  file: string,
  payload: BackupPayload,
  password?: string,
): Promise<BackupMetadata> {
  const safePayload = normalizePayload(payload);
  let envelope: EncryptedEnvelope | PlainEnvelope;
  if (password) {
    if (password.length < 8) throw new Error("备份密码至少 8 位");
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(password, salt, 32, KDF);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(safePayload), "utf8"), cipher.final()]);
    envelope = {
      format: FORMAT,
      version: VERSION,
      encrypted: true,
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      metadata: { ...safePayload.metadata, encrypted: true },
    };
  } else {
    envelope = { format: FORMAT, version: VERSION, encrypted: false, payload: safePayload };
  }
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("备份文件过大");
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, serialized, "utf8");
  await fs.promises.rename(tmp, file);
  return { ...safePayload.metadata, encrypted: Boolean(password) };
}

export async function readBackup(file: string, password?: string): Promise<BackupPayload> {
  const stats = await fs.promises.stat(file);
  if (stats.size > MAX_BYTES) throw new Error("备份文件过大");
  const raw = await fs.promises.readFile(file, "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  const parsedEnvelope = envelopeSchema.safeParse(decoded);
  if (!parsedEnvelope.success) throw new Error("不支持的备份格式、版本或加密参数");
  const envelope = parsedEnvelope.data;
  let payload: unknown;
  if (envelope.encrypted) {
    if (!password) throw new Error("该备份已加密,请输入备份密码");
    try {
      const key = scryptSync(password, Buffer.from(envelope.salt, "base64"), 32, KDF);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      payload = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw new Error("无法解密备份,请检查密码或文件完整性");
    }
  } else {
    payload = envelope.payload;
  }
  return normalizePayload(payload);
}

/** Check before closing views and again before deleting rows: UUID owns one domestic platform. */
export function assertBackupAccountIdentities(store: Store, payload: BackupPayload): void {
  for (const account of payload.global?.accounts ?? []) {
    if (store.accounts.get(account.id)) throw new Error("ACCOUNT_ID_NAMESPACE_CONFLICT");
    const existing = new GlobalAccountRepository(store.db).get(account.id);
    if (existing && existing.platformId !== account.platformId)
      throw new Error("备份国外账号 UUID 与现有平台不一致");
  }
  for (const account of payload.accounts) {
    if (new GlobalAccountRepository(store.db).get(account.id))
      throw new Error("ACCOUNT_ID_NAMESPACE_CONFLICT");
    const existing = store.accounts.get(account.id);
    if (existing && existing.platformId !== account.platformId)
      throw new Error("备份账号 UUID 与现有平台不一致");
  }
}

/** Validate the final distinct account count before pausing views and inside the write transaction. */
export function assertBackupAccountCapacity(
  store: Store,
  payload: BackupPayload,
  mode: "merge" | "replace",
): void {
  const domesticIds = new Set(mode === "merge" ? store.accounts.list().map((row) => row.id) : []);
  for (const account of payload.accounts) domesticIds.add(account.id);
  if (domesticIds.size > MAX_ACCOUNTS) throw new Error(`合并后国内账号超过 ${MAX_ACCOUNTS} 个，未导入备份`);
  if (payload.global) {
    const globalIds = new Set(
      mode === "merge" ? store.db.all("SELECT id FROM global_accounts").map((row) => String(row.id)) : [],
    );
    for (const account of payload.global.accounts) globalIds.add(account.id);
    if (globalIds.size > MAX_GLOBAL_ACCOUNTS)
      throw new Error(`合并后国外账号超过 ${MAX_GLOBAL_ACCOUNTS} 个，未导入备份`);
  }
}

export function applyBackup(store: Store, payload: BackupPayload, mode: "merge" | "replace"): number {
  const safePayload = normalizePayload(payload);
  return store.db.transaction(() => {
    assertBackupAccountIdentities(store, safePayload);
    assertBackupAccountCapacity(store, safePayload, mode);
    if (mode === "replace") {
      store.db.exec(
        "DELETE FROM publish_records; DELETE FROM works; DELETE FROM metric_snapshots; DELETE FROM collect_runs; DELETE FROM accounts;",
      );
    }
    if (
      mode === "replace" &&
      (safePayload.global || !Number(store.db.get("SELECT count(*) AS n FROM global_accounts")?.n))
    )
      store.db.exec("DELETE FROM assets");
    if (safePayload.global) {
      if (mode === "replace") store.db.exec("DELETE FROM global_accounts");
      for (const account of safePayload.global.accounts)
        store.db.run(
          "INSERT INTO global_accounts(id,platform_id,display_name,remote_id,auth_status,created_at,updated_at,note,browser_engine) VALUES(?,?,?,NULL,'unauthorized',?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,note=excluded.note,updated_at=excluded.updated_at",
          [
            account.id,
            account.platformId,
            account.displayName,
            account.createdAt,
            account.updatedAt,
            account.note ?? null,
            account.browserEngine ?? "embedded",
          ],
        );
      const observations = new GlobalWebObservationRepository(store.db);
      for (const row of [...safePayload.global.observations].sort((a, b) =>
        a.capturedAt.localeCompare(b.capturedAt),
      ))
        observations.save(row);
      new GlobalWorkspaceRepository(store.db).saveWorks(safePayload.global.works);
      for (const row of safePayload.global.publishRecords)
        store.db.run(
          "INSERT INTO global_publish_records(id,account_id,record_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at WHERE account_id=excluded.account_id",
          [row.id, row.accountId, JSON.stringify(row), row.updatedAt],
        );
    }
    for (const account of safePayload.accounts) store.accounts.upsertRaw(account);
    for (const asset of safePayload.assets) store.assets.insert(asset);
    store.metrics.upsertWorks(safePayload.works);
    store.metrics.saveSnapshots(safePayload.metrics);
    for (const record of safePayload.publishRecords) store.publish.upsertRaw(record);
    store.settings.patch(safePayload.settings);
    return safePayload.accounts.length + (safePayload.global?.accounts.length ?? 0);
  });
}
