import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "@main/db/database";
import { GlobalAccountRepository } from "@main/api/global-account-repository";
/** The old release had no persisted engine choice. A valid owned Chrome marker is the migration evidence. */
export async function migrateGlobalBrowserPreferences(db: Database, dataDirectory: string): Promise<void> {
  const key = "global-browser-preferences-v14";
  if (db.get("SELECT key FROM settings WHERE key=?", [key])) return;
  const accounts = new GlobalAccountRepository(db),
    chrome: string[] = [];
  for (const account of accounts.list()) {
    const directory = path.join(dataDirectory, "global-browser-profiles", account.id),
      marker = path.join(directory, "clipdock-profile.json");
    try {
      const dir = await fs.lstat(directory),
        stat = await fs.lstat(marker);
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 1024
      )
        continue;
      const value = JSON.parse(await fs.readFile(marker, "utf8"));
      if (value.version === 1 && value.accountId === account.id && value.platformId === account.platformId)
        chrome.push(account.id);
    } catch {
      /* Missing or unowned directories cannot select a browser engine. */
    }
  }
  db.transaction(() => {
    for (const id of chrome) accounts.setBrowserEngine(id, "chrome");
    db.run("INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)", [
      key,
      "true",
      new Date().toISOString(),
    ]);
  });
}
