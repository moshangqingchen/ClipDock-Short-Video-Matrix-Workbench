export const CHROMIUM_TRANSPORT_PROFILE_ID = "clipdock-chromium-tcp-v1" as const;

export interface ChromiumTransportApp {
  isReady(): boolean;
  commandLine: {
    appendSwitch(name: string): void;
    hasSwitch(name: string): boolean;
  };
}

export interface ChromiumTransportState {
  readonly profileId: typeof CHROMIUM_TRANSPORT_PROFILE_ID;
  readonly configuredBeforeReady: boolean;
  readonly disableQuicSwitchPresent: boolean;
}

const configured = new WeakSet<ChromiumTransportApp>();

/** Chromium HTTPS transport constraint only: does not control DNS, address family, OS routing or TUN. */
export function configureChromiumTransport(app: ChromiumTransportApp): ChromiumTransportState {
  if (app.isReady()) throw new Error("CHROMIUM_TRANSPORT_STARTUP_TOO_LATE");
  app.commandLine.appendSwitch("disable-quic");
  if (!app.commandLine.hasSwitch("disable-quic")) throw new Error("CHROMIUM_TRANSPORT_SWITCH_MISSING");
  configured.add(app);
  return readChromiumTransportState(app);
}

/** Main-process memory only. Switch presence is a startup fact, not a route proof or engine attestation. */
export function readChromiumTransportState(app: ChromiumTransportApp): ChromiumTransportState {
  return Object.freeze({
    profileId: CHROMIUM_TRANSPORT_PROFILE_ID,
    configuredBeforeReady: configured.has(app),
    disableQuicSwitchPresent: app.commandLine.hasSwitch("disable-quic"),
  });
}
