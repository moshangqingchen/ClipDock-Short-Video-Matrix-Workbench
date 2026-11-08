import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopShellUrl } from "@shared/renderer-runtime";

const preview = vi.hoisted(() => ({ create: vi.fn(() => ({ preview: true })) }));
vi.mock("./preview-api", () => ({ createPreviewApi: preview.create }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DEV", true);
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("initializes preview data only in an explicit local browser development session", async () => {
  vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
  const { api, hasBridge, runtimeMode } = await import("./api");
  expect(runtimeMode).toBe("preview");
  expect(hasBridge).toBe(false);
  expect(api).toEqual({ preview: true });
  expect(preview.create).toHaveBeenCalledOnce();
});

it.each([
  "file:///D:/workbench/dist/index.html",
  desktopShellUrl("http://localhost:5173/"),
])("rejects missing desktop transport without even initializing demo data: %s", async (href) => {
  vi.stubGlobal("window", { location: { href } });
  const { api, hasBridge, runtimeMode } = await import("./api");
  expect(runtimeMode).toBe("unavailable");
  expect(hasBridge).toBe(false);
  expect(preview.create).not.toHaveBeenCalled();
  await expect(api.accounts.list()).rejects.toThrow("桌面连接不可用");
});

it("never enables demo data in a production build even when served over localhost", async () => {
  vi.stubEnv("DEV", false);
  vi.stubGlobal("window", { location: { href: "http://localhost:5173/" } });
  const { runtimeMode } = await import("./api");
  expect(runtimeMode).toBe("unavailable");
  expect(preview.create).not.toHaveBeenCalled();
});

it("uses the preload bridge without creating preview data", async () => {
  const bridge = { accounts: { list: vi.fn() } };
  vi.stubGlobal("window", { workbench: bridge, location: { href: "file:///D:/workbench/dist/index.html" } });
  const { api, hasBridge, runtimeMode } = await import("./api");
  expect(runtimeMode).toBe("desktop");
  expect(hasBridge).toBe(true);
  expect(api).toBe(bridge);
  expect(preview.create).not.toHaveBeenCalled();
});
