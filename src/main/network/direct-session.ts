export interface DirectSessionLike {
  setProxy(config: { mode: "direct" | "system" }): Promise<void>;
  closeAllConnections(): Promise<void>;
  clearHostResolverCache(): Promise<void>;
}

interface Initialization {
  mode: "direct" | "system";
  ready: boolean;
  pending: Promise<void>;
}

const sessions = new WeakMap<DirectSessionLike, Initialization>();

/**
 * Configure Chromium's explicit direct mode before reusing the session. This
 * cannot bypass an OS/TUN route and is never a substitute for a route proof.
 */
export function ensureDirectSession(session: DirectSessionLike): Promise<void> {
  return ensureSessionProxy(session, "direct");
}

/** Let the operating system/Mihomo rule engine select DIRECT or proxy per target. */
export function ensureSystemSession(session: DirectSessionLike): Promise<void> {
  return ensureSessionProxy(session, "system");
}

function ensureSessionProxy(session: DirectSessionLike, mode: "direct" | "system"): Promise<void> {
  const existing = sessions.get(session);
  if (existing)
    return existing.mode === mode
      ? existing.pending
      : existing.pending.then(() => {
          if (sessions.get(session) === existing) sessions.delete(session);
          return ensureSessionProxy(session, mode);
        });

  const state: Initialization = { mode, ready: false, pending: Promise.resolve() };
  sessions.set(session, state);
  state.pending = Promise.resolve()
    .then(async () => {
      await session.setProxy({ mode });
      await session.closeAllConnections();
      // Closing sockets leaves Chromium's DNS cache intact. Do not carry cached
      // destinations from an earlier network configuration into a new permit.
      await session.clearHostResolverCache();
      state.ready = true;
    })
    .catch(() => {
      // Failed initialization grants no readiness. A later caller can retry both
      // steps; no system/proxy mode is installed as a recovery path.
      if (sessions.get(session) === state) sessions.delete(session);
      throw new Error("DIRECT_SESSION_INITIALIZATION_FAILED");
    });
  return state.pending;
}

export function isDirectSessionReady(session: DirectSessionLike): boolean {
  return sessions.get(session)?.ready === true;
}
