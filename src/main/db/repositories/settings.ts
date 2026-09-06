import { DEFAULT_SETTINGS, type AppSettings, type AuditEvent } from "@shared/types";
import type { Database } from "../database";

const SETTINGS_KEY = "app";

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get(): AppSettings {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", [
      SETTINGS_KEY,
    ]);
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(row.value_json) as Partial<AppSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...stripUndefined(patch) };
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [SETTINGS_KEY, JSON.stringify(next), new Date().toISOString()],
    );
    return next;
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

interface AuditRow extends Record<string, unknown> {
  id: number;
  action: string;
  account_id: string | null;
  details_json: string | null;
  created_at: string;
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  append(event: Omit<AuditEvent, "id" | "createdAt"> & { createdAt?: string }): void {
    this.db.run(
      "INSERT INTO audit_events (action, account_id, details_json, created_at) VALUES (?, ?, ?, ?)",
      [
        event.action,
        event.accountId ?? null,
        event.details ? JSON.stringify(event.details) : null,
        event.createdAt ?? new Date().toISOString(),
      ],
    );
  }

  list(limit = 200): AuditEvent[] {
    return this.db
      .all<AuditRow>("SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?", [limit])
      .map((row) => ({
        id: Number(row.id),
        action: row.action,
        accountId: row.account_id,
        details: row.details_json ? safeParse(row.details_json) : null,
        createdAt: row.created_at,
      }));
  }

  prune(keep = 5000): void {
    this.db.run(
      "DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT ?)",
      [keep],
    );
  }
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
