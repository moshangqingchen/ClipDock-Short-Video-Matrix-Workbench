import type { Session } from "electron";
import type { CnPlatformId } from "@shared/platforms";
import { isStrictBusinessNetwork, NetworkDormantError } from "./business-access";
import type { NetworkReason } from "@shared/network";

interface SessionNetworkPolicy {
  registerSession(session: Session, accountId: string, platformId: CnPlatformId): { ready: Promise<void> };
  checkSessionRequest(
    session: Session,
    url: string,
  ): { cancel: boolean; reason?: NetworkReason; generation?: number };
}
let policy: SessionNetworkPolicy | null = null;

export function installSessionNetworkPolicy(next: SessionNetworkPolicy): () => void {
  policy = next;
  return () => {
    if (policy === next) policy = null;
  };
}

export function initializeAccountSessionNetwork(
  session: Session,
  accountId: string,
  platformId: CnPlatformId,
): Promise<void> {
  const ready =
    policy?.registerSession(session, accountId, platformId).ready ??
    (isStrictBusinessNetwork() ? Promise.reject(new NetworkDormantError()) : Promise.resolve());
  void ready.catch(() => undefined);
  return ready;
}

type Observation = (platformId: CnPlatformId, host: string) => void;
let receive: Observation = () => undefined;
type BlockedRequest = {
  accountId: string;
  url: string;
  resourceType: string;
  reason: NetworkReason;
  generation: number;
};
let receiveBlocked: (request: BlockedRequest) => void = () => undefined;
export function setBlockedRequestSink(sink: (request: BlockedRequest) => void): void {
  receiveBlocked = sink;
}
const installed = new WeakMap<Session, { platformId: CnPlatformId; accountId: string }>();

export function setNetworkObservationSink(sink: Observation): void {
  receive = sink;
}

/** One listener for observation and enforcement; its lifetime is the Session, not a view. */
export function ensureSessionObservation(
  session: Session,
  platformId: CnPlatformId,
  accountId: string,
): void {
  const state = installed.get(session);
  if (state) {
    if (state.platformId !== platformId || state.accountId !== accountId)
      throw new Error("账号分区的身份不一致");
    return;
  }
  installed.set(session, { platformId, accountId });
  session.webRequest.onBeforeRequest((details, callback) => {
    let cancel = isStrictBusinessNetwork();
    try {
      const url = new URL(details.url);
      if (["https:", "http:", "wss:", "ws:"].includes(url.protocol)) receive(platformId, url.hostname);
      const decision = policy?.checkSessionRequest(session, details.url);
      cancel = decision?.cancel ?? cancel;
      if (cancel)
        receiveBlocked({
          accountId,
          url: details.url,
          resourceType: details.resourceType,
          reason: decision?.reason ?? "CHECKING",
          generation: decision?.generation ?? 0,
        });
    } catch {
      // Malformed URLs or a failed observation sink must not break the browser callback.
    } finally {
      // Observation explicitly allows; absent/broken strict policy always closes.
      callback({ cancel });
    }
  });
}
