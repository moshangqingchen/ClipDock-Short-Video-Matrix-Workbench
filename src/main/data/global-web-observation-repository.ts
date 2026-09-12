import type { Database } from "@main/db/database";
import { globalAccountIdSchema } from "@shared/global-accounts";
import { webObservationSchema, type WebObservation } from "@shared/global-web-observation";
import { observationDay } from "@shared/global-web-trend";

/** Latest snapshot plus bounded daily history, independent of API authorization. */
export class GlobalWebObservationRepository {
  constructor(private readonly db: Database) {}
  history(id: string): WebObservation[] {
    const key = globalAccountIdSchema.parse(id);
    return this.db
      .all(
        `SELECT w.snapshot_json, a.platform_id FROM global_web_observation_history w
       JOIN global_accounts a ON a.id = w.account_id WHERE a.id = ?
       ORDER BY w.captured_at DESC LIMIT 1000`,
        [key],
      )
      .flatMap((row) => {
        try {
          if (typeof row.snapshot_json !== "string" || row.snapshot_json.length > 8192) return [];
          const value = webObservationSchema.parse(JSON.parse(row.snapshot_json));
          return value.accountId === key && value.platformId === row.platform_id ? [value] : [];
        } catch {
          return [];
        }
      })
      .reverse();
  }
  get(id: string): WebObservation | null {
    const key = globalAccountIdSchema.parse(id);
    const row = this.db.get(
      `SELECT w.snapshot_json, a.platform_id FROM global_web_observations w
      JOIN global_accounts a ON a.id = w.account_id WHERE a.id = ?`,
      [key],
    );
    if (!row || typeof row.snapshot_json !== "string" || row.snapshot_json.length > 8192) return null;
    const result = webObservationSchema.safeParse(JSON.parse(row.snapshot_json));
    return result.success && result.data.accountId === key && result.data.platformId === row.platform_id
      ? result.data
      : null;
  }
  save(value: WebObservation): void {
    const snapshot = webObservationSchema.parse(value);
    if (!snapshot.metrics.length) return;
    const account = this.db.get("SELECT platform_id FROM global_accounts WHERE id = ?", [snapshot.accountId]);
    if (account?.platform_id !== snapshot.platformId) throw new Error("WEB_OBSERVE_CANCELLED");
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO global_web_observations (account_id, snapshot_json) VALUES (?, ?)
      ON CONFLICT(account_id) DO UPDATE SET snapshot_json=excluded.snapshot_json`,
        [snapshot.accountId, JSON.stringify(snapshot)],
      );
      this.db.run(
        `INSERT INTO global_web_observation_history(account_id,captured_day,scope,captured_at,snapshot_json)
         VALUES (?,?,?,?,?) ON CONFLICT(account_id,captured_day,scope) DO UPDATE SET
         captured_at=excluded.captured_at, snapshot_json=excluded.snapshot_json
         WHERE excluded.captured_at >= captured_at`,
        [
          snapshot.accountId,
          observationDay(snapshot.capturedAt),
          snapshot.page + "|" + (snapshot.period ?? "") + "|" + (snapshot.subjectId ?? ""),
          snapshot.capturedAt,
          JSON.stringify(snapshot),
        ],
      );
      this.db.run(
        `DELETE FROM global_web_observation_history WHERE account_id=? AND rowid NOT IN
         (SELECT rowid FROM global_web_observation_history WHERE account_id=? ORDER BY captured_at DESC LIMIT 1000)`,
        [snapshot.accountId, snapshot.accountId],
      );
    });
  }
}
