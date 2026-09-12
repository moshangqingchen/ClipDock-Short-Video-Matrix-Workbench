import { describe, expect, it, vi } from "vitest";
import { configureChromiumTransport, readChromiumTransportState } from "./chromium-transport";

function fixture(ready = false) {
  const switches = new Set<string>();
  return {
    switches,
    isReady: vi.fn(() => ready),
    commandLine: {
      appendSwitch: vi.fn((name: string) => {
        switches.add(name);
      }),
      hasSwitch: (name: string) => switches.has(name),
    },
  };
}

describe("Chromium startup transport constraint", () => {
  it("adds only disable-quic before readiness and exposes an immutable memory snapshot", () => {
    const app = fixture();
    expect(readChromiumTransportState(app).configuredBeforeReady).toBe(false);
    const state = configureChromiumTransport(app);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith("disable-quic");
    expect(state).toEqual({
      profileId: "clipdock-chromium-tcp-v1",
      configuredBeforeReady: true,
      disableQuicSwitchPresent: true,
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("rejects late configuration without pretending a runtime switch constrained existing connections", () => {
    const app = fixture(true);
    expect(() => configureChromiumTransport(app)).toThrow("CHROMIUM_TRANSPORT_STARTUP_TOO_LATE");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(readChromiumTransportState(app).configuredBeforeReady).toBe(false);
  });

  it("does not accept a preexisting command line flag as this module's startup record", () => {
    const app = fixture();
    app.switches.add("disable-quic");
    expect(readChromiumTransportState(app)).toMatchObject({
      configuredBeforeReady: false,
      disableQuicSwitchPresent: true,
    });
  });

  it("reports a later removed switch and keeps separate app identities separate", () => {
    const app = fixture();
    configureChromiumTransport(app);
    app.switches.delete("disable-quic");
    expect(readChromiumTransportState(app)).toMatchObject({
      configuredBeforeReady: true,
      disableQuicSwitchPresent: false,
    });
    expect(readChromiumTransportState(fixture()).configuredBeforeReady).toBe(false);
  });

  it("does not record success when append throws or the switch is absent", () => {
    const app = fixture();
    app.commandLine.appendSwitch.mockImplementation(() => {
      throw Error("append failed");
    });
    expect(() => configureChromiumTransport(app)).toThrow("append failed");
    expect(readChromiumTransportState(app).configuredBeforeReady).toBe(false);
    app.commandLine.appendSwitch.mockImplementation(() => undefined);
    expect(() => configureChromiumTransport(app)).toThrow("CHROMIUM_TRANSPORT_SWITCH_MISSING");
    expect(readChromiumTransportState(app).configuredBeforeReady).toBe(false);
  });
});
