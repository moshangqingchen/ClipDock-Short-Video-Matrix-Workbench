import { describe, expect, it } from "vitest";
import { globalBrowserArguments } from "./global-browser-launcher";

const fixture = () => ({
  platformId: "youtube" as const,
  profile: {
    directory: "C:\\owned\\123",
    assertCurrent: async () => undefined,
    release: async () => undefined,
  },
  endpoint: { host: "127.0.0.1" as const, port: 12345 },
  signal: new AbortController().signal,
  assertCurrent() {},
});
describe("production website browser arguments", () => {
  it("refuses system transport in the external browser launcher", () => {
    const { profile: _profile, endpoint: _endpoint, ...context } = fixture();
    expect(() =>
      globalBrowserArguments({
        ...context,
        transport: "system",
        accountId: "8e65b156-a2ee-48ac-957e-2f990141c207",
      }),
    ).toThrow("GLOBAL_WEB_BROWSER_UNAVAILABLE");
  });
  it("uses a fixed official entry, own profile and one proxy without certificate/debugging exceptions", () => {
    const args = globalBrowserArguments(fixture());
    expect(args.at(-1)).toBe("https://studio.youtube.com/");
    expect(args).toContain("--proxy-server=http://127.0.0.1:12345");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--disable-quic");
    expect(args.join(" ")).not.toMatch(
      /\bDIRECT\b|remote-debugging|headless|ignore-certificate|fake-device|no-sandbox/i,
    );
  });
  it.each([0, -1, 65536, 1.5])("refuses invalid proxy ports (%s)", (port) => {
    const input = fixture();
    input.endpoint.port = port;
    expect(() => globalBrowserArguments(input)).toThrow("GLOBAL_WEB_BROWSER_UNAVAILABLE");
  });
});
