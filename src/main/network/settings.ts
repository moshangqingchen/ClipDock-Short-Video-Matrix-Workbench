import { DEFAULT_NETWORK_SETTINGS, networkSettingsSchema, type NetworkSettings } from "@shared/network";
import type { Database } from "@main/db/database";

/** Separate public key: credentials, live state and permits never enter app settings. */
export class NetworkSettingsRepository {
  constructor(private readonly db: Database) {}
  get(): NetworkSettings {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", [
      "network-public",
    ]);
    try {
      return row ? networkSettingsSchema.parse(JSON.parse(row.value_json)) : { ...DEFAULT_NETWORK_SETTINGS };
    } catch {
      return { ...DEFAULT_NETWORK_SETTINGS };
    }
  }
  set(input: NetworkSettings): NetworkSettings {
    const value = networkSettingsSchema.parse(input);
    this.db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      ["network-public", JSON.stringify(value), new Date().toISOString()],
    );
    return value;
  }
}
