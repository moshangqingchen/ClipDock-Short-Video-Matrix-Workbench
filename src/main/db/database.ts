import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations";

export type SqlParam = SQLInputValue;

export interface Database {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlParam[]): { changes: number; lastInsertRowid: number };
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlParam[],
  ): T | undefined;
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlParam[],
  ): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly path: string;
}

class NodeSqliteDatabase implements Database {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") fs.mkdirSync(dirnameOf(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly SqlParam[] = []) {
    const result = this.db.prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get<T extends Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private depth = 0;

  /** Reentrant: nested calls become savepoints so repositories compose. */
  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `sp_${this.depth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const result = fn();
      this.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      } catch {
        // preserve original error
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // ignore
    }
    this.db.close();
  }
}

function dirnameOf(file: string): string {
  return path.dirname(file);
}

export function openDatabase(file: string): Database {
  const db = new NodeSqliteDatabase(file);
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => Number(r.version)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
  }
}
