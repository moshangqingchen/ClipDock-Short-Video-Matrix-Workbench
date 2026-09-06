import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stable persistent partition for an account. UUIDs stay readable on disk;
 * anything else is digested so user-controlled text never becomes a path.
 */
export function partitionForAccount(accountId: string): string {
  const value = String(accountId ?? "").trim();
  if (!value) throw new Error("accountId is required");
  const suffix = UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
  return `persist:sv-account-${suffix}`;
}
