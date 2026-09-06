import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import type { BackupMetadata, BackupPayload } from "@shared/types";
import type { Store } from "@main/db";

const FORMAT = "sv-workbench-backup" as const;
const VERSION = 2;
const MAX_BYTES = 256 * 1024 * 1024;
const KDF = { N: 16_384, r: 8, p: 1 };

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
  /^(cookie|cookies|password|passwd|token|access_token|refresh_token|secret|sessionid|bduss|sessdata)$/i;

function checksum(payload: BackupPayload): string {
  const copy = { ...payload, metadata: { ...payload.metadata, checksum: undefined } };
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function assertSafe(value: unknown, trail: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafe(item, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`备份包含敏感字段: ${[...trail, key].join(".")}`);
    assertSafe(child, [...trail, key]);
  }
}

/**
 * Backups carry account metadata, metrics, works, asset references, publish
 * records and settings. They never contain browser profiles or cookies: a
 * restored account must be logged in again, by design.
 */
export function buildBackup(store: Store, appVersion: string): BackupPayload {
  const accounts = store.accounts.list().map((a) => ({
    ...a,
    status: "unknown" as const,
    statusMessage: null,
    lastOnlineAt: null,
    lastCheckedAt: null,
    sessionExpiresAt: null,
  }));
  const payload: BackupPayload = {
    metadata: {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      appVersion,
      accountCount: accounts.length,
      encrypted: false,
    },
    accounts,
    metrics: store.metrics.listSnapshots(undefined, 500_000),
    works: store.metrics.allWorks(),
    assets: store.assets.list(),
    publishRecords: store.publish.list(),
    settings: store.settings.get(),
  };
  payload.metadata.checksum = checksum(payload);
  assertSafe(payload);
  return payload;
}

export async function writeBackup(
  file: string,
  payload: BackupPayload,
  password?: string,
): Promise<BackupMetadata> {
  let envelope: EncryptedEnvelope | PlainEnvelope;
  if (password) {
    if (password.length < 8) throw new Error("备份密码至少 8 位");
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(password, salt, 32, KDF);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    envelope = {
      format: FORMAT,
      version: VERSION,
      encrypted: true,
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      metadata: { ...payload.metadata, encrypted: true },
    };
  } else {
    envelope = { format: FORMAT, version: VERSION, encrypted: false, payload };
  }
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("备份文件过大");
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, serialized, "utf8");
  await fs.promises.rename(tmp, file);
  return { ...payload.metadata, encrypted: Boolean(password) };
}

export async function readBackup(file: string, password?: string): Promise<BackupPayload> {
  const stats = await fs.promises.stat(file);
  if (stats.size > MAX_BYTES) throw new Error("备份文件过大");
  const raw = await fs.promises.readFile(file, "utf8");
  let envelope: EncryptedEnvelope | PlainEnvelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  if (envelope.format !== FORMAT || (envelope.version !== VERSION && envelope.version !== 1))
    throw new Error("不支持的备份格式或版本");
  let payload: BackupPayload;
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
  if (!payload?.metadata || !Array.isArray(payload.accounts)) throw new Error("备份内容损坏");
  if (payload.metadata.checksum && payload.metadata.checksum !== checksum(payload))
    throw new Error("备份校验失败,文件可能已损坏");
  if (payload.accounts.length > 30) throw new Error("备份账号数量超出上限");
  assertSafe(payload);
  return payload;
}

export function applyBackup(store: Store, payload: BackupPayload, mode: "merge" | "replace"): number {
  return store.db.transaction(() => {
    if (mode === "replace") {
      store.db.exec(
        "DELETE FROM publish_records; DELETE FROM works; DELETE FROM metric_snapshots; DELETE FROM collect_runs; DELETE FROM accounts; DELETE FROM assets;",
      );
    }
    for (const account of payload.accounts) store.accounts.upsertRaw(account);
    for (const asset of payload.assets ?? []) store.assets.insert(asset);
    store.metrics.upsertWorks(payload.works ?? []);
    store.metrics.saveSnapshots((payload.metrics ?? []).map((m) => ({ ...m, id: undefined })));
    for (const record of payload.publishRecords ?? []) store.publish.upsertRaw(record);
    if (payload.settings) {
      const { lastActiveAccountId: _a, lastRoute: _r, ...rest } = payload.settings;
      store.settings.patch(rest);
    }
    return payload.accounts.length;
  });
}
