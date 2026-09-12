// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@renderer/lib/api";
import { useAccounts } from "./index";

beforeEach(() => useAccounts.setState({ accounts: [], loaded: false, loadError: null }));
afterEach(() => vi.restoreAllMocks());

it("recovers a transient list failure during startup", async () => {
  const accounts = await api.accounts.list();
  const list = vi.spyOn(api.accounts, "list").mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValueOnce(accounts);
  await useAccounts.getState().load();
  expect(list).toHaveBeenCalledTimes(2);
  expect(useAccounts.getState()).toMatchObject({ accounts, loaded: true, loadError: null });
});

it("preserves existing accounts and exposes a persistent read failure", async () => {
  const accounts = await api.accounts.list();
  useAccounts.setState({ accounts, loaded: true });
  vi.spyOn(api.accounts, "list").mockRejectedValue(new Error("read failed"));
  await expect(useAccounts.getState().load()).rejects.toThrow("read failed");
  expect(useAccounts.getState().accounts).toEqual(accounts);
  expect(useAccounts.getState().loadError).toContain("加载失败");
});

it("accepts a genuinely empty list and clears previous load errors", async () => {
  useAccounts.setState({ loadError: "previous failure" });
  vi.spyOn(api.accounts, "list").mockResolvedValue([]);
  await useAccounts.getState().load();
  expect(useAccounts.getState()).toMatchObject({ accounts: [], loaded: true, loadError: null });
});
