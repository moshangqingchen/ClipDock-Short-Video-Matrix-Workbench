import { describe, expect, it } from "vitest";
import { desktopShellUrl, resolveRendererRuntime } from "./renderer-runtime";

const browser = {
  hasBridge: false,
  development: true,
  url: "http://127.0.0.1:5173/",
  userAgent: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36",
};

describe("desktop transport and explicit browser preview", () => {
  it("uses a present preload bridge for both packaged and development shells", () => {
    for (const url of ["file:///D:/app/dist/index.html", browser.url])
      expect(resolveRendererRuntime({ ...browser, hasBridge: true, development: false, url })).toBe("desktop");
  });

  it.each(["http://localhost:5173/", "http://127.0.0.1:5173/", "http://[::1]:5173/"])(
    "permits demo data only in a local development browser: %s", (url) => {
      expect(resolveRendererRuntime({ ...browser, url })).toBe("preview");
      expect(resolveRendererRuntime({ ...browser, url, development: false })).toBe("unavailable");
    },
  );

  it.each([null, "not-a-url", "file:///D:/app/dist/index.html", "https://example.com/", "data:text/html,app"])(
    "never substitutes demo data for an unavailable runtime: %s", (url) => {
      expect(resolveRendererRuntime({ ...browser, url })).toBe("unavailable");
    },
  );

  it("recognizes the Electron dev shell even though its user agent was normalized to Chrome", () => {
    const url = desktopShellUrl("http://127.0.0.1:5173/?theme=light#overview");
    expect(new URL(url).searchParams.get("theme")).toBe("light");
    expect(new URL(url).hash).toBe("#overview");
    expect(resolveRendererRuntime({ ...browser, url })).toBe("unavailable");
  });

  it("rejects an unmarked Electron user agent as an additional fallback", () => {
    expect(resolveRendererRuntime({ ...browser, userAgent: `${browser.userAgent} Electron/43.3.0` }))
      .toBe("unavailable");
  });
});
