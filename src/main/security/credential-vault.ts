import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import type { Database } from "@main/db/database";
import {
  credentialRefSchema,
  credentialSetSchema,
  type CredentialMetadata,
  type CredentialRef,
  type CredentialSetInput,
} from "@shared/credentials";

export interface CredentialEncryptionProvider {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

const ENCRYPTION_VERSION = 1;

const systemEncryption: CredentialEncryptionProvider = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plainText) => safeStorage.encryptString(plainText),
  decryptString: (ciphertext) => safeStorage.decryptString(ciphertext),
};

type CredentialErrorCode =
  | "CREDENTIAL_INPUT_INVALID"
  | "CREDENTIAL_ENCRYPTION_UNAVAILABLE"
  | "CREDENTIAL_ENCRYPTION_FAILED"
  | "CREDENTIAL_DECRYPTION_FAILED"
  | "CREDENTIAL_VERSION_UNSUPPORTED"
  | "CREDENTIAL_SAVE_FAILED"
  | "CREDENTIAL_READ_FAILED"
  | "CREDENTIAL_DELETE_FAILED";

/** Fixed errors intentionally omit provider messages, secret values and ciphertext. */
export class CredentialVaultError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code);
    this.name = "CredentialVaultError";
  }
}

interface CredentialRow extends Record<string, unknown> {
  ciphertext: Uint8Array;
  encryption_version: number;
  created_at: string;
  updated_at: string;
}

/** Main-process-only storage. No caller should expose get() through an IPC handler. */
export class CredentialVault {
  constructor(
    private readonly db: Database,
    private readonly encryption: CredentialEncryptionProvider = systemEncryption,
  ) {}

  set(input: CredentialSetInput): CredentialMetadata {
    const parsed = credentialSetSchema.safeParse(input);
    if (!parsed.success) throw new CredentialVaultError("CREDENTIAL_INPUT_INVALID");
    const { kind, ownerId, secret } = parsed.data;
    if (!this.encryptionAvailable()) throw new CredentialVaultError("CREDENTIAL_ENCRYPTION_UNAVAILABLE");

    // Encrypt before replacing a row: unavailable storage and encryption failures
    // must preserve any previous ciphertext (including after a portable move).
    let ciphertext: Buffer;
    try {
      ciphertext = this.encryption.encryptString(secret);
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw new Error();
    } catch {
      throw new CredentialVaultError("CREDENTIAL_ENCRYPTION_FAILED");
    }

    const now = new Date().toISOString();
    try {
      this.db.run(
        `INSERT INTO credentials (id, kind, owner_id, ciphertext, encryption_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, owner_id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           encryption_version = excluded.encryption_version,
           updated_at = excluded.updated_at`,
        [randomUUID(), kind, ownerId, ciphertext, ENCRYPTION_VERSION, now, now],
      );
    } catch {
      throw new CredentialVaultError("CREDENTIAL_SAVE_FAILED");
    }
    return this.meta({ kind, ownerId });
  }

  /** Resolve a secret for an authorized main-process consumer; missing is explicit. */
  get(ref: CredentialRef): string | null {
    const key = this.parseRef(ref);
    const row = this.readRow(key);
    if (!row) return null;
    if (!this.encryptionAvailable()) throw new CredentialVaultError("CREDENTIAL_ENCRYPTION_UNAVAILABLE");
    if (row.encryption_version !== ENCRYPTION_VERSION)
      throw new CredentialVaultError("CREDENTIAL_VERSION_UNSUPPORTED");
    return this.decrypt(row);
  }

  /** Presence alone is not permission to use a credential; check meta().available. */
  has(ref: CredentialRef): boolean {
    return Boolean(this.readRow(this.parseRef(ref)));
  }

  meta(ref: CredentialRef): CredentialMetadata {
    const key = this.parseRef(ref);
    const row = this.readRow(key);
    const encryptionAvailable = this.encryptionAvailable();
    const metadata: CredentialMetadata = {
      ...key,
      hasCredential: Boolean(row),
      available: false,
      encryptionAvailable,
      state: "missing",
      createdAt: row?.created_at ?? null,
      updatedAt: row?.updated_at ?? null,
    };
    if (!row) return metadata;
    if (!encryptionAvailable) return { ...metadata, state: "encryption_unavailable" };
    if (row.encryption_version !== ENCRYPTION_VERSION) return { ...metadata, state: "unsupported_version" };
    try {
      this.decrypt(row);
      return { ...metadata, available: true, state: "available" };
    } catch {
      // Do not remove unreadable ciphertext: another Windows user/machine may
      // still be able to decrypt it, and re-entry must be an explicit action.
      return { ...metadata, state: "decryption_failed" };
    }
  }

  delete(ref: CredentialRef): CredentialMetadata {
    const key = this.parseRef(ref);
    try {
      this.db.run("DELETE FROM credentials WHERE kind = ? AND owner_id = ?", [key.kind, key.ownerId]);
    } catch {
      throw new CredentialVaultError("CREDENTIAL_DELETE_FAILED");
    }
    return this.meta(key);
  }

  private parseRef(ref: CredentialRef): CredentialRef {
    const parsed = credentialRefSchema.safeParse(ref);
    if (!parsed.success) throw new CredentialVaultError("CREDENTIAL_INPUT_INVALID");
    return parsed.data;
  }

  private readRow(ref: CredentialRef): CredentialRow | undefined {
    try {
      return this.db.get<CredentialRow>(
        "SELECT ciphertext, encryption_version, created_at, updated_at FROM credentials WHERE kind = ? AND owner_id = ?",
        [ref.kind, ref.ownerId],
      );
    } catch {
      throw new CredentialVaultError("CREDENTIAL_READ_FAILED");
    }
  }

  private encryptionAvailable(): boolean {
    try {
      return this.encryption.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private decrypt(row: CredentialRow): string {
    try {
      const secret = this.encryption.decryptString(Buffer.from(row.ciphertext));
      if (typeof secret !== "string" || secret.length === 0) throw new Error();
      return secret;
    } catch {
      throw new CredentialVaultError("CREDENTIAL_DECRYPTION_FAILED");
    }
  }
}
