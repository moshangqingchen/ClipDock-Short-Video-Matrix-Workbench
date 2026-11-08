import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/types";

const transport = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@renderer/lib/api", () => ({ api: { settings: transport } }));
import { useSettings, useUi } from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: false });
  useUi.setState({ theme: "system", railCollapsed: false });
});

it("applies a settings edit after an older startup read has completed", async () => {
  const initial = deferred<typeof DEFAULT_SETTINGS>();
  transport.get.mockReturnValue(initial.promise);
  transport.set.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark" });
  const load = useSettings.getState().load();
  const save = useSettings.getState().patch({ theme: "dark" });
  await Promise.resolve();
  expect(transport.set).not.toHaveBeenCalled();
  initial.resolve({ ...DEFAULT_SETTINGS, theme: "light" });
  await Promise.all([load, save]);
  expect(useSettings.getState().settings.theme).toBe("dark");
  expect(useUi.getState().theme).toBe("dark");
});

it("saves consecutive edits in order and synchronizes the saved sidebar preference", async () => {
  const first = deferred<typeof DEFAULT_SETTINGS>();
  transport.set.mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, theme: "light", sidebarCollapsed: true });
  const dark = useSettings.getState().patch({ theme: "dark" });
  const light = useSettings.getState().patch({ theme: "light", sidebarCollapsed: true });
  await Promise.resolve();
  expect(transport.set).toHaveBeenCalledTimes(1);
  first.resolve({ ...DEFAULT_SETTINGS, theme: "dark" });
  await Promise.all([dark, light]);
  expect(transport.set).toHaveBeenLastCalledWith({ theme: "light", sidebarCollapsed: true });
  expect(useUi.getState()).toMatchObject({ theme: "light", railCollapsed: true });
});

it("allows another save after a failed write without applying the failed value", async () => {
  transport.set.mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ ...DEFAULT_SETTINGS, theme: "light" });
  const failed = useSettings.getState().patch({ theme: "dark" });
  const recovery = useSettings.getState().patch({ theme: "light" });
  await expect(failed).rejects.toThrow("unavailable");
  await recovery;
  expect(useSettings.getState().settings.theme).toBe("light");
  expect(useUi.getState().theme).toBe("light");
});
