import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "@main/db";
import { GlobalAccountRepository } from "@main/api/global-account-repository";
import { migrateGlobalBrowserPreferences } from "./global-browser-preferences";
it("migrates owned old Chrome profiles once and retains subsequent explicit engine choice", async () => {
  const store = createStore(":memory:"),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "engine-migration-"));
  try {
    const repo = new GlobalAccountRepository(store.db),
      a = repo.create({ platformId: "x" }),
      b = repo.create({ platformId: "youtube" });
    repo.setBrowserEngine(a.id, "embedded");
    repo.setBrowserEngine(b.id, "embedded");
    const profile = path.join(dir, "global-browser-profiles", a.id);
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(
      path.join(profile, "clipdock-profile.json"),
      JSON.stringify({ version: 1, accountId: a.id, platformId: "x" }),
    );
    await migrateGlobalBrowserPreferences(store.db, dir);
    expect(repo.get(a.id)?.browserEngine).toBe("chrome");
    expect(repo.get(b.id)?.browserEngine).toBe("embedded");
    repo.setBrowserEngine(a.id, "embedded");
    await migrateGlobalBrowserPreferences(store.db, dir);
    expect(repo.get(a.id)?.browserEngine).toBe("embedded");
    expect(await fs.stat(profile)).toBeTruthy();
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
