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

  it("extracts the Chrome major version", () => {
    expect(chromeMajorVersion("... Chrome/150.0.7871.212 Safari/537.36")).toBe("150");
  });
});
