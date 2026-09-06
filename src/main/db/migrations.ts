export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core-schema",
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        handle TEXT,
        avatar_url TEXT,
        external_id TEXT,
        partition TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'unknown',
        status_message TEXT,
        last_online_at TEXT,
        last_checked_at TEXT,
        session_expires_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform_id, sort_order);

      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        captured_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'session',
        work_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_account_metric_time ON metric_snapshots(account_id, metric, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_platform_time ON metric_snapshots(platform_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_work ON metric_snapshots(work_id, metric, captured_at DESC);

      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        cover_url TEXT,
        url TEXT,
        published_at TEXT,
        status TEXT,
        plays INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        favorites INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL,
        UNIQUE(account_id, remote_id)
      );
      CREATE INDEX IF NOT EXISTS idx_works_account_published ON works(account_id, published_at DESC);

      CREATE TABLE IF NOT EXISTS collect_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        message TEXT,
        metrics_written INTEGER NOT NULL DEFAULT 0,
        works_written INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_account_time ON collect_runs(account_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        duration_ms INTEGER,
        width INTEGER,
        height INTEGER,
        thumbnail_path TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);

      CREATE TABLE IF NOT EXISTS publish_records (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL,
        asset_ids_json TEXT NOT NULL DEFAULT '[]',
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        scheduled_at TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        published_at TEXT,
        work_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_publish_account ON publish_records(account_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        account_id TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(created_at DESC);
    `,
  },
];
