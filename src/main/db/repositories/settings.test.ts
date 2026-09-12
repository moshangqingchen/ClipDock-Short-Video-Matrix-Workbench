import { describe, expect, it } from "vitest";
import { createStore } from "@main/db";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/types";
import { NetworkSettingsRepository } from "@main/network/settings";

describe("public settings boundary", () => {
  it("does not return legacy arbitrary fields or network credentials to the shell", () => {
    const store = createStore(":memory:");
    store.db.run("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)", [
      "app",
      JSON.stringify({
        theme: "dark",
        client_secret: "legacy-private",
        accountNetworkState: { state: "allowed" },
      }),
      new Date().toISOString(),
    ]);
    expect(store.settings.get()).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
    const next = store.settings.patch({ clashSecret: "private", theme: "light" } as Partial<AppSettings>);
    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(
      store.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'app'")?.value_json,
    ).not.toContain("private");
    store.close();
  });

  it("validates separate public network configuration before persisting", () => {
    const store = createStore(":memory:");
    const network = new NetworkSettingsRepository(store.db);
    const valid = network.get();
    expect(() => network.set({ ...valid, controllerUrl: "http://127.0.0.1:0" })).toThrow();
    expect(network.get()).toEqual(valid);
    network.set({ ...valid, diagnosticProxyPort: 7890 });
    expect(JSON.stringify(store.settings.get())).not.toContain("controllerUrl");
    store.close();
  });
});
