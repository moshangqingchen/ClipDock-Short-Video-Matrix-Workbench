import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "@main/db/database";
import { DEFAULT_NETWORK_SETTINGS } from "@shared/network";
import { NetworkSettingsRepository } from "./settings";

describe("public network settings persistence", () => {
  let db: Database | undefined;
  afterEach(() => db?.close());

  it("persists only the source selection and explicit removal across repository reads", () => {
    db = openDatabase(":memory:");
    const repository = new NetworkSettingsRepository(db);
    expect(repository.get()).toEqual(DEFAULT_NETWORK_SETTINGS);
    repository.set({
      ...DEFAULT_NETWORK_SETTINGS,
      selectedClientResourcesPath: "C:\\Apps\\猫猫云\\resources",
    });
    const reloaded = new NetworkSettingsRepository(db).get();
    expect(reloaded.selectedClientResourcesPath).toBe("C:\\Apps\\猫猫云\\resources");
    const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", [
      "network-public",
    ]);
    expect(JSON.parse(row!.value_json)).toEqual(reloaded);
    repository.set({ ...reloaded, selectedClientResourcesPath: null });
    expect(new NetworkSettingsRepository(db).get()).toEqual({
      ...DEFAULT_NETWORK_SETTINGS,
      selectedClientResourcesPath: null,
    });
  });

  it("reads an existing two-field record and refuses invalid paths without overwriting it", () => {
    db = openDatabase(":memory:");
    const repository = new NetworkSettingsRepository(db);
    repository.set(DEFAULT_NETWORK_SETTINGS);
    expect(new NetworkSettingsRepository(db).get()).toEqual(DEFAULT_NETWORK_SETTINGS);
    expect(() => repository.set({
      ...DEFAULT_NETWORK_SETTINGS,
      selectedClientResourcesPath: "\\\\server\\share\\resources",
    })).toThrow();
    expect(repository.get()).toEqual(DEFAULT_NETWORK_SETTINGS);
  });
});
