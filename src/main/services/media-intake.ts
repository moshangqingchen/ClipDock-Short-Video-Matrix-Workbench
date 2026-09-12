import type { Work } from "@shared/types";
import type { Store } from "@main/db";
import { isStrictBusinessNetwork } from "@main/network/business-access";

/** Collector results enter here in the main process; no IPC accepts a source URL. */
export interface MediaIntake {
  avatar(accountId: string, sourceUrl: string): void;
  covers(accountId: string, works: readonly Work[]): void;
}

export interface MediaOfferSink {
  offer(
    subject: { accountId: string; kind: "avatar" } | { accountId: string; kind: "cover"; workId: string },
    input: { sourceUrl: string; sourceRevision: string },
  ): void;
}

const MEDIA_REFRESH_INTERVAL_MS = 5 * 60_000;
// RemoteMediaService hashes this generation together with the exact source URL.
// Repeated homepage checks reuse in-flight/cached images; changed URLs still
// refresh immediately, and unchanged URLs may refresh in the next generation.
const mediaRevision = () => `media:${Math.floor(Date.now() / MEDIA_REFRESH_INTERVAL_MS)}`;

export function createMediaIntake(sink: MediaOfferSink): MediaIntake {
  return {
    avatar(accountId, sourceUrl) {
      if (!isStrictBusinessNetwork()) return;
      try {
        sink.offer({ accountId, kind: "avatar" }, { sourceUrl, sourceRevision: mediaRevision() });
      } catch {
        // Optional media never changes auth/collection status or exposes the URL/error.
      }
    },
    covers(accountId, works) {
      if (!isStrictBusinessNetwork()) return;
      const sourceRevision = mediaRevision();
      for (const work of works) {
        if (work.accountId !== accountId || !work.coverUrl) continue;
        try {
          sink.offer(
            { accountId, kind: "cover", workId: work.id },
            { sourceUrl: work.coverUrl, sourceRevision },
          );
        } catch {
          // A failed preview must not skip subsequent collection results.
        }
      }
    },
  };
}

/** Signed references are transient input, never new strict-mode database contents. */
export function persistableMediaReference(source: string | null | undefined): string | null {
  return isStrictBusinessNetwork() ? null : (source ?? null);
}

/** Run before loading any strict shell. Old references are not trusted download tasks. */
export function clearLegacyMediaReferences(store: Pick<Store, "db">): void {
  if (!isStrictBusinessNetwork()) return;
  store.db.transaction(() => {
    store.db.run("UPDATE accounts SET avatar_url = NULL WHERE avatar_url IS NOT NULL");
    store.db.run("UPDATE works SET cover_url = NULL WHERE cover_url IS NOT NULL");
  });
}
