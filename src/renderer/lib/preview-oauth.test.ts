// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPreviewApi } from "./preview-api";

describe("preview OAuth is unavailable", () => {
  it("never turns a preview record into a real grant or persists transaction state", async () => {
    const api = createPreviewApi();
    const account = await api.globalAccounts.create({ platformId: "youtube" });
    expect(await api.globalOAuth.state(account.id)).toMatchObject({ phase: "idle", transactionId: null });
    await expect(api.globalOAuth.start(account.id)).rejects.toThrow("GLOBAL_OAUTH_UNAVAILABLE");
    await expect(api.globalOAuth.cancel(account.id)).rejects.toThrow("GLOBAL_OAUTH_UNAVAILABLE");
    expect(await api.globalAccounts.list()).toEqual([account]);
    expect(account.authStatus).toBe("unauthorized");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
