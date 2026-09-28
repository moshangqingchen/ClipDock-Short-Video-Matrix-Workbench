import { describe, expect, it } from "vitest";
import { chromeMajorVersion, toChromeUserAgent } from "./user-agent";

describe("toChromeUserAgent", () => {
  it("strips the Electron token and an ASCII product token", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) short-video-matrix-workbench/1.0.0 Chrome/150.0.7871.212 Electron/43.3.0 Safari/537.36";
    expect(toChromeUserAgent(ua)).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.212 Safari/537.36",
    );
  });

  it("strips a non-ASCII product token (app.setName with Chinese)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 短视频矩阵工作台/1.0.0 Chrome/150.0.7871.212 Electron/43.3.0 Safari/537.36";
    const result = toChromeUserAgent(ua);
    expect(result).not.toMatch(/Electron/);
    expect(result).not.toMatch(/短视频/);
    expect(result).toMatch(/Chrome\/150\.0\.7871\.212 Safari\/537\.36$/);
  });

  it("is idempotent on an already clean Chrome UA", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
    expect(toChromeUserAgent(ua)).toBe(ua);
  });

  it.each([
    "短视频矩阵工作台/1.0.6-rc.3",
    "short-video-matrix-workbench/1.0.6-rc.4",
    "short-video-matrix-workbench/1.0.6-beta.2+build.123",
  ])("removes the installed prerelease product token %s", (product) => {
    const prefix = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
    const ua = `${prefix} ${product} Chrome/150.0.7871.212 Electron/43.3.0 Safari/537.36`;
    const clean = `${prefix} Chrome/150.0.7871.212 Safari/537.36`;
    expect(toChromeUserAgent(ua)).toBe(clean);
    expect(toChromeUserAgent(toChromeUserAgent(ua))).toBe(clean);
  });

  it("removes an Electron prerelease token without leaving its suffix", () => {
    const ua = "Mozilla/5.0 Chrome/150.0.7871.212 Electron/43.0.0-beta.1 Safari/537.36";
    expect(toChromeUserAgent(ua)).toBe("Mozilla/5.0 Chrome/150.0.7871.212 Safari/537.36");
  });

  it("preserves a standard Edge UA including its browser suffix", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";
    expect(toChromeUserAgent(ua)).toBe(ua);
  });

  it("extracts the Chrome major version", () => {
    expect(chromeMajorVersion("... Chrome/150.0.7871.212 Safari/537.36")).toBe("150");
  });
});
