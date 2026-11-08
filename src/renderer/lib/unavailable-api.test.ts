import { expect, it, vi } from "vitest";
import { BRIDGE_UNAVAILABLE_MESSAGE, createUnavailableApi } from "./unavailable-api";

it("rejects every read and write instead of fabricating account or business data", async () => {
  const api = createUnavailableApi();
  const subscriptions = new Set(["onChanged", "onState"]);
  for (const group of Object.values(api)) {
    if (typeof group === "function") continue;
    for (const [name, method] of Object.entries(group)) {
      if (subscriptions.has(name)) continue;
      if (typeof method !== "function") throw new Error(`Invalid unavailable API method: ${name}`);
      await expect(method()).rejects.toThrow(BRIDGE_UNAVAILABLE_MESSAGE);
    }
  }
});

it("exposes inert, safely disposable event subscriptions", () => {
  const api = createUnavailableApi();
  const listener = vi.fn();
  const dispose = [
    api.on("account-changed", listener),
    api.globalOAuth.onState(listener),
    api.globalJobs.onChanged(listener),
    api.globalUploads.onChanged(listener),
    api.globalWeb.onChanged(listener),
    api.globalWorkspace.onChanged(listener),
  ];
  for (const off of dispose) {
    off();
    off();
  }
  expect(listener).not.toHaveBeenCalled();
});
