import { openDatabase, type Database } from "./database";
import { AccountsRepository } from "./repositories/accounts";
import { AssetsRepository } from "./repositories/assets";
import { MetricsRepository } from "./repositories/metrics";
import { PublishRepository } from "./repositories/publish";
import { AuditRepository, SettingsRepository } from "./repositories/settings";

export interface Store {
  db: Database;
  accounts: AccountsRepository;
  metrics: MetricsRepository;
  assets: AssetsRepository;
  publish: PublishRepository;
  settings: SettingsRepository;
  audit: AuditRepository;
  close(): void;
}

export function createStore(file: string): Store {
  const db = openDatabase(file);
  return {
    db,
    accounts: new AccountsRepository(db),
    metrics: new MetricsRepository(db),
    assets: new AssetsRepository(db),
    publish: new PublishRepository(db),
    settings: new SettingsRepository(db),
    audit: new AuditRepository(db),
    close: () => db.close(),
  };
}
