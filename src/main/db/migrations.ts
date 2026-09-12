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
  {
    version: 2,
    name: "credential-vault",
    sql: `
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('clash_secret', 'proxy_password', 'oauth_token')),
        owner_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) > 0),
        encryption_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(kind, owner_id)
      );
    `,
  },
  {
    version: 3,
    name: "durable-domestic-collect-jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS cn_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','scheduled','login','keepalive')),
        state TEXT NOT NULL CHECK (state IN ('queued','waiting-network','running','done','failed','cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        message TEXT,
        run_id INTEGER REFERENCES collect_runs(id) ON DELETE SET NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cn_jobs_active_account ON cn_jobs(account_id)
        WHERE state IN ('queued','waiting-network','running');
      CREATE INDEX IF NOT EXISTS idx_cn_jobs_state_time ON cn_jobs(state,created_at);
    `,
  },
  {
    version: 4,
    name: "independent-global-accounts",
    sql: `
      CREATE TABLE IF NOT EXISTS global_accounts (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL CHECK (platform_id IN ('youtube','tiktok','x')),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
        remote_id TEXT CHECK (remote_id IS NULL OR length(remote_id) BETWEEN 1 AND 256),
        auth_status TEXT NOT NULL DEFAULT 'unauthorized'
          CHECK (auth_status IN ('unauthorized','authorized','reauthorization_required')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (auth_status != 'authorized' OR remote_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_global_accounts_platform ON global_accounts(platform_id,created_at);
    `,
  },
  {
    version: 5,
    name: "exclusive-account-id-namespace",
    sql: `
      -- Existing collisions abort the migration transaction. Never repair by deleting identities.
      CREATE TABLE account_namespace_migration_guard (
        collision_count INTEGER NOT NULL CHECK (collision_count = 0)
      );
      INSERT INTO account_namespace_migration_guard (collision_count)
        SELECT COUNT(*) FROM accounts AS domestic
        INNER JOIN global_accounts AS international ON domestic.id = international.id COLLATE NOCASE;
      DROP TABLE account_namespace_migration_guard;

      -- UUID case aliases share the same browser partition spelling, so compare without case.
      CREATE TRIGGER accounts_global_id_insert BEFORE INSERT ON accounts
        WHEN EXISTS (SELECT 1 FROM global_accounts WHERE id = NEW.id COLLATE NOCASE)
        BEGIN SELECT RAISE(ABORT, 'ACCOUNT_ID_NAMESPACE_CONFLICT'); END;
      CREATE TRIGGER accounts_global_id_update BEFORE UPDATE OF id ON accounts
        WHEN EXISTS (SELECT 1 FROM global_accounts WHERE id = NEW.id COLLATE NOCASE)
        BEGIN SELECT RAISE(ABORT, 'ACCOUNT_ID_NAMESPACE_CONFLICT'); END;
      CREATE TRIGGER global_accounts_domestic_id_insert BEFORE INSERT ON global_accounts
        WHEN EXISTS (SELECT 1 FROM accounts WHERE id = NEW.id COLLATE NOCASE)
        BEGIN SELECT RAISE(ABORT, 'ACCOUNT_ID_NAMESPACE_CONFLICT'); END;
      CREATE TRIGGER global_accounts_domestic_id_update BEFORE UPDATE OF id ON global_accounts
        WHEN EXISTS (SELECT 1 FROM accounts WHERE id = NEW.id COLLATE NOCASE)
        BEGIN SELECT RAISE(ABORT, 'ACCOUNT_ID_NAMESPACE_CONFLICT'); END;
    `,
  },
  {
    version: 6,
    name: "public-global-app-configuration",
    sql: `
      CREATE TABLE IF NOT EXISTS global_apps (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL UNIQUE CHECK (platform_id IN ('youtube','tiktok','x')),
        client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
        redirect_port INTEGER NOT NULL CHECK (
          typeof(redirect_port) = 'integer' AND
          ((redirect_port BETWEEN 1024 AND 65535) OR (platform_id = 'youtube' AND redirect_port = 0))
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    name: "oauth-application-secret-vault",
    sql: `
      -- SQLite cannot widen a CHECK constraint in place. Copy ciphertext unchanged in one transaction.
      CREATE TABLE credentials_next (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('clash_secret', 'proxy_password', 'oauth_token', 'oauth_client_secret')),
        owner_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) > 0),
        encryption_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(kind, owner_id)
      );
      INSERT INTO credentials_next (id, kind, owner_id, ciphertext, encryption_version, created_at, updated_at)
        SELECT id, kind, owner_id, ciphertext, encryption_version, created_at, updated_at FROM credentials;
      DROP TABLE credentials;
      ALTER TABLE credentials_next RENAME TO credentials;
    `,
  },
  {
    version: 8,
    name: "local-global-read-snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS global_read_snapshots (
        account_id TEXT PRIMARY KEY REFERENCES global_accounts(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL CHECK (platform_id IN ('youtube','tiktok','x')),
        remote_id TEXT NOT NULL CHECK (length(remote_id) BETWEEN 1 AND 256),
        fetched_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) BETWEEN 1 AND 262144)
      );
    `,
  },
  {
    version: 9,
    name: "durable-global-read-jobs",
    sql: `
      -- Main-only consent identity: normal token refresh must not change this revision.
      ALTER TABLE global_accounts ADD COLUMN grant_revision TEXT NOT NULL DEFAULT '';
      UPDATE global_accounts SET grant_revision = lower(hex(randomblob(16)))
        WHERE auth_status = 'authorized';
      CREATE TABLE global_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL CHECK (platform_id IN ('youtube','tiktok','x')),
        kind TEXT NOT NULL CHECK (kind = 'read'),
        binding_hash TEXT NOT NULL CHECK (length(binding_hash) = 64),
        state TEXT NOT NULL CHECK (state IN ('queued','waiting-proxy','running','done','failed','cancelled')),
        error_code TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE UNIQUE INDEX global_jobs_one_active_account ON global_jobs(account_id)
        WHERE state IN ('queued','waiting-proxy','running');
      CREATE INDEX global_jobs_account_history ON global_jobs(account_id, created_at);
    `,
  },
  {
    version: 10,
    name: "durable-tiktok-draft-uploads",
    sql: `
      CREATE TABLE credentials_upload_next (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('clash_secret','proxy_password','oauth_token','oauth_client_secret','upload_session')),
        owner_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) > 0),
        encryption_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(kind, owner_id)
      );
      INSERT INTO credentials_upload_next SELECT id,kind,owner_id,ciphertext,encryption_version,created_at,updated_at FROM credentials;
      DROP TABLE credentials;
      ALTER TABLE credentials_upload_next RENAME TO credentials;
      CREATE TABLE global_upload_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('waiting-proxy','preparing','initializing','uploading','checking','processing','inbox','published','failed','cancelled','uncertain')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        job_json TEXT NOT NULL CHECK (length(job_json) BETWEEN 1 AND 8192),
        binding_hash TEXT NOT NULL CHECK (length(binding_hash) = 64),
        asset_sha256 TEXT NOT NULL CHECK (length(asset_sha256) = 64),
        init_attempted INTEGER NOT NULL DEFAULT 0 CHECK (init_attempted IN (0,1)),
        check_only INTEGER NOT NULL DEFAULT 0 CHECK (check_only IN (0,1))
      );
      CREATE UNIQUE INDEX global_upload_one_active_account ON global_upload_jobs(account_id)
        WHERE state IN ('waiting-proxy','preparing','initializing','uploading','checking','processing');
      CREATE TRIGGER global_upload_credentials_delete AFTER DELETE ON global_upload_jobs
        BEGIN DELETE FROM credentials WHERE kind = 'upload_session' AND owner_id = OLD.id; END;
    `,
  },
  {
    version: 11,
    name: "youtube-resumable-upload-jobs",
    sql: `
      DROP TRIGGER global_upload_credentials_delete;
      CREATE TABLE global_upload_jobs_next (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('waiting-proxy','waiting-retry','preparing','initializing','uploading','checking','processing','inbox','ready','published','failed','cancelled','uncertain')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        job_json TEXT NOT NULL CHECK (length(job_json) BETWEEN 1 AND 32768),
        binding_hash TEXT NOT NULL CHECK (length(binding_hash) = 64),
        asset_sha256 TEXT NOT NULL CHECK (length(asset_sha256) = 64),
        init_attempted INTEGER NOT NULL DEFAULT 0 CHECK (init_attempted IN (0,1)),
        check_only INTEGER NOT NULL DEFAULT 0 CHECK (check_only IN (0,1)),
        not_before_at INTEGER NOT NULL DEFAULT 0 CHECK (not_before_at >= 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
      );
      INSERT INTO global_upload_jobs_next (id,account_id,state,revision,job_json,binding_hash,asset_sha256,init_attempted,check_only)
        SELECT id,account_id,state,revision,job_json,binding_hash,asset_sha256,init_attempted,check_only FROM global_upload_jobs;
      DROP TABLE global_upload_jobs;
      ALTER TABLE global_upload_jobs_next RENAME TO global_upload_jobs;
      CREATE UNIQUE INDEX global_upload_one_active_account ON global_upload_jobs(account_id)
        WHERE state IN ('waiting-proxy','waiting-retry','preparing','initializing','uploading','checking','processing');
      CREATE TRIGGER global_upload_credentials_delete AFTER DELETE ON global_upload_jobs
        BEGIN DELETE FROM credentials WHERE kind = 'upload_session' AND owner_id = OLD.id; END;
    `,
  },
  {
    version: 12,
    name: "global-webpage-observations",
    sql: `CREATE TABLE global_web_observations (
      account_id TEXT PRIMARY KEY REFERENCES global_accounts(id) ON DELETE CASCADE,
      snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) BETWEEN 1 AND 8192)
    );`,
  },
  {
    version: 13,
    name: "global-webpage-observation-history",
    sql: `CREATE TABLE global_web_observation_history (
      account_id TEXT NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
      captured_day TEXT NOT NULL,
      scope TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) BETWEEN 1 AND 8192),
      PRIMARY KEY(account_id, captured_day, scope)
    );
    CREATE INDEX global_web_history_time ON global_web_observation_history(account_id, captured_at);
    INSERT INTO global_web_observation_history
      SELECT account_id, substr(json_extract(snapshot_json,'$.capturedAt'),1,10),
        json_extract(snapshot_json,'$.page') || '|' || coalesce(json_extract(snapshot_json,'$.period'),''),
        json_extract(snapshot_json,'$.capturedAt'), snapshot_json
      FROM global_web_observations WHERE json_valid(snapshot_json);`,
  },
  {
    version: 14,
    name: "unified-global-workspace",
    sql: `
      ALTER TABLE global_accounts ADD COLUMN note TEXT;
      ALTER TABLE global_accounts ADD COLUMN browser_engine TEXT NOT NULL DEFAULT 'embedded' CHECK(browser_engine IN ('chrome','embedded'));
      CREATE TABLE global_web_identity (
        account_id TEXT PRIMARY KEY REFERENCES global_accounts(id) ON DELETE CASCADE,
        identity_json TEXT NOT NULL CHECK(length(identity_json) < 4096)
      );
      CREATE TABLE global_web_works (
        account_id TEXT NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL, remote_id TEXT NOT NULL,
        work_json TEXT NOT NULL CHECK(length(work_json) < 16384),
        PRIMARY KEY(account_id,subject_id,remote_id)
      );
      CREATE TABLE global_publish_records (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
        record_json TEXT NOT NULL CHECK(length(record_json) < 65536), updated_at TEXT NOT NULL
      );
      CREATE TABLE global_web_collect_jobs (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES global_accounts(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('queued','waiting-network','waiting-login','running','done','failed','cancelled')),
        job_json TEXT NOT NULL CHECK(length(job_json)<8192), updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX global_web_collect_active ON global_web_collect_jobs(account_id)
        WHERE state IN ('queued','waiting-network','waiting-login','running');
    `,
  },
  {
    version: 15,
    name: "account-check-observations",
    sql: "ALTER TABLE accounts ADD COLUMN check_info_json TEXT;",
  },
];
