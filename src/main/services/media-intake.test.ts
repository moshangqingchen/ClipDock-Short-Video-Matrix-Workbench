import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@main/db";
import { installBusinessNetwork } from "@main/network/business-access";
import type { Work } from "@shared/types";
import { clearLegacyMediaReferences, createMediaIntake, persistableMediaReference } from "./media-intake";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.useRealTimers();
});
function mode(enforcement: "observe" | "strict") {
  cleanups.push(
    installBusinessNetwork({
      enforcement,
      check: () => ({ allowed: false, reason: "CHECKING" }),
      acquire: () => null,
    }),
  );
}
function work(accountId: string, id = "work-1"): Work {
  return {
    id,
    accountId,
    platformId: "douyin",
    remoteId: id,
    title: "title",
    coverUrl: "https://media.example.test/private-capability?signature=synthetic",
    plays: 1,
    likes: 2,
    comments: 3,
    shares: 4,
    favorites: 5,
    fetchedAt: "2026-09-08T00:00:00Z",
  };
}
function storeFixture() {
  const store = createStore(":memory:");
  cleanups.push(() => store.close());
  const account = store.accounts.create({ platformId: "douyin" });
  store.accounts.update(account.id, { avatarUrl: work(account.id).coverUrl });
  store.metrics.upsertWorks([work(account.id)]);
  return { store, account };
}

describe("media intake and persisted source boundary", () => {
  it("keeps observation display behavior without starting the new downloader", () => {
    mode("observe");
    const sink = { offer: vi.fn() },
      intake = createMediaIntake(sink);
    intake.avatar("account", "https://media.example.test/private");
    intake.covers("account", [work("account")]);
    expect(sink.offer).not.toHaveBeenCalled();
    expect(persistableMediaReference("https://media.example.test/private")).toContain("https:");
    const { store, account } = storeFixture();
    clearLegacyMediaReferences(store);
    expect(store.accounts.get(account.id)?.avatarUrl).toContain("signature");
  });

  it("never stores a strict signed reference and only offers main-process results owned by this account", () => {
    mode("strict");
    const sink = { offer: vi.fn() },
      intake = createMediaIntake(sink);
    const own = work("account");
    intake.avatar("account", own.coverUrl!);
    intake.covers("account", [own, work("another-account"), { ...own, id: "no-image", coverUrl: null }]);
    expect(sink.offer).toHaveBeenCalledTimes(2);
    expect(sink.offer.mock.calls[1][0]).toEqual({ kind: "cover", accountId: "account", workId: own.id });
    expect(sink.offer.mock.calls[1][1]).toMatchObject({
      sourceUrl: own.coverUrl,
      sourceRevision: expect.any(String),
    });
    expect(persistableMediaReference(own.coverUrl)).toBeNull();
    expect(persistableMediaReference(null)).toBeNull();
  });

  it("treats previews as optional and continues after a single offer fails", () => {
    mode("strict");
    const sink = {
      offer: vi.fn().mockImplementationOnce(() => {
        throw new Error("signed-url");
      }),
    };
    const intake = createMediaIntake(sink);
    expect(() => intake.covers("account", [work("account", "a"), work("account", "b")])).not.toThrow();
    expect(sink.offer).toHaveBeenCalledTimes(2);
  });

  it("keeps a stable revision for repeated homepage avatars and covers in the same five-minute window", () => {
    mode("strict");
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-12T10:00:01.000Z");
    const sink = { offer: vi.fn() }, intake = createMediaIntake(sink);
    const own = work("account");
    intake.avatar("account", own.coverUrl!);
    intake.covers("account", [own]);
    vi.setSystemTime("2026-09-12T10:04:59.000Z");
    intake.avatar("account", own.coverUrl!);
    intake.covers("account", [own]);
    const offered = sink.offer.mock.calls.map(([, input]) => input);
    expect(offered[2]).toEqual(offered[0]);
    expect(offered[3]).toEqual(offered[1]);
    expect(offered[0].sourceRevision).not.toContain("signature");
    // Changed URLs still reach the service immediately; it includes the URL in its digest.
    intake.avatar("account", "https://media.example.test/new-avatar");
    expect(sink.offer.mock.calls[4][1]).toEqual({
      sourceUrl: "https://media.example.test/new-avatar", sourceRevision: offered[0].sourceRevision,
    });
  });

  it("refreshes unchanged sources in the next window without retaining a subject suppression map", () => {
    mode("strict");
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-12T10:04:59.000Z");
    const sink = { offer: vi.fn() }, intake = createMediaIntake(sink);
    const own = work("account");
    intake.avatar("account", own.coverUrl!);
    const first = sink.offer.mock.calls[0][1];
    // After a reset/forget, the same URL is offered again even within this window.
    intake.avatar("account", own.coverUrl!);
    expect(sink.offer.mock.calls[1][1]).toEqual(first);
    vi.setSystemTime("2026-09-12T10:05:00.000Z");
    intake.avatar("account", own.coverUrl!);
    expect(sink.offer.mock.calls[2][1]).toMatchObject({ sourceUrl: own.coverUrl });
    expect(sink.offer.mock.calls[2][1].sourceRevision).not.toBe(first.sourceRevision);
    expect(persistableMediaReference(own.coverUrl)).toBeNull();
  });

  it("clears legacy media references at strict startup without changing login conclusions or creating downloads", () => {
    const { store, account } = storeFixture();
    const before = store.accounts.get(account.id)!;
    clearLegacyMediaReferences(store); // Missing policy defaults closed.
    expect(store.accounts.get(account.id)).toEqual({ ...before, avatarUrl: null });
    expect(store.metrics.listWorks(account.id)[0].coverUrl).toBeNull();
    expect(store.metrics.listWorks(account.id)[0].plays).toBe(1);
  });

  it("clears both tables in one transaction so failure cannot silently leave half a migration", () => {
    const { store, account } = storeFixture();
    const realRun = store.db.run.bind(store.db);
    vi.spyOn(store.db, "run").mockImplementation((sql, ...args) => {
      if (sql.startsWith("UPDATE works")) throw new Error("fixture write failure");
      return realRun(sql, ...args);
    });
    expect(() => clearLegacyMediaReferences(store as Pick<Store, "db">)).toThrow();
    expect(store.accounts.get(account.id)?.avatarUrl).toContain("signature");
  });
});
