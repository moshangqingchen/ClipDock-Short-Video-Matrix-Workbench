import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { accountUpdateSchema } from "@shared/ipc";
import type { Account, LocalMediaUrl, OverviewView, PlatformSummaryView, Work } from "@shared/types";
import { createMediaProjection, isLocalMediaUrl } from "./media-projection";

const cacheUrl = "sv-asset://remote/86cd4ebf-007c-4b24-8b0a-6b84097f304a" as const;
const remote = "https://img.example.test/private-capability/avatar.jpg?signature=not-for-renderer";
const account: Account = {
  id: "owner",
  platformId: "bilibili",
  displayName: "账号",
  avatarUrl: remote,
  partition: "persist:controlled-test",
  status: "online",
  sortOrder: 0,
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};
const work: Work = {
  id: "owner:work",
  accountId: "owner",
  platformId: "bilibili",
  remoteId: "work",
  title: "作品",
  coverUrl: remote,
  url: "https://www.bilibili.com/video/public-id",
  plays: 5,
  likes: 1,
  comments: 0,
  shares: 0,
  favorites: 0,
  fetchedAt: account.createdAt,
};
const platform: PlatformSummaryView = {
  platformId: "bilibili",
  accountCount: 1,
  onlineCount: 1,
  totals: { plays: 5 },
  dayDelta: {},
  accounts: [
    {
      accountId: account.id,
      displayName: account.displayName,
      avatarUrl: remote,
      status: "online",
      capturedAt: account.createdAt,
      metrics: {},
      spark: [1, 2],
    },
  ],
};
const overview: OverviewView = {
  accountCount: 1,
  onlineCount: 1,
  attentionCount: 0,
  totals: { plays: 5 },
  dayDelta: {},
  platforms: [platform],
  trend: [],
  attention: [],
};

describe("renderer media DTO projection", () => {
  it("keeps safe check feedback on IPC responses without exporting unknown observation fields", () => {
    const checkInfo = {state: "paused" as const, reason: "国内网络暂停", attemptedAt: "2026-09-12T00:00:00Z", token: "must-not-export"};
    const projected = createMediaProjection({enforcement: "strict"}).projectAccount({...account, checkInfo});
    expect(projected.checkInfo).toEqual({state: "paused", reason: "国内网络暂停", attemptedAt: checkInfo.attemptedAt});
    expect(JSON.stringify(projected)).not.toContain("must-not-export");
  });
  it("strict mode defaults to null and does not trust either a remote URL or an old DB cache reference", () => {
    const projection = createMediaProjection({ enforcement: "strict" });
    expect(projection.projectAccount(account).avatarUrl).toBeNull();
    expect(projection.projectAccount({ ...account, avatarUrl: cacheUrl }).avatarUrl).toBeNull();
    expect(projection.projectWork(work).coverUrl).toBeNull();
    expect(projection.projectWork({ ...work, coverUrl: cacheUrl }).coverUrl).toBeNull();
    expectTypeOf(projection.projectAccount(account).avatarUrl).toEqualTypeOf<LocalMediaUrl | null>();
    expectTypeOf(projection.projectWork(work).coverUrl).toEqualTypeOf<LocalMediaUrl | null>();
  });

  it("looks up only owned subject identities and projects an opaque local reference", () => {
    const preview = vi.fn().mockReturnValue({ url: cacheUrl });
    const projection = createMediaProjection({ enforcement: "strict", preview });
    expect(projection.projectAccounts([account])[0].avatarUrl).toBe(cacheUrl);
    expect(projection.projectWorks([work])[0].coverUrl).toBe(cacheUrl);
    expect(preview.mock.calls).toEqual([
      [{ accountId: "owner", kind: "avatar" }],
      [{ accountId: "owner", kind: "cover", workId: "owner:work" }],
    ]);
    expect(JSON.stringify(preview.mock.calls)).not.toContain(remote);
    expect(account.avatarUrl).toBe(remote);
    expect(work.coverUrl).toBe(remote);
  });

  it.each([
    remote,
    `${cacheUrl}?token=secret`,
    `${cacheUrl}#secret`,
    `${cacheUrl}/other`,
    `${cacheUrl}\n`,
    `${cacheUrl}\r`,
    cacheUrl.replace("remote/", "remote:443/"),
    cacheUrl.replace("remote/", "user@remote/"),
    cacheUrl.replace("remote/", "file/"),
    cacheUrl.replace("remote/", "REMOTE/"),
    cacheUrl.replace("86cd", "%38%36cd"),
    "sv-asset://remote/../secret",
    "data:image/png;base64,AAAA",
    "file:///C:/secret.png",
    "https://remote/86cd4ebf-007c-4b24-8b0a-6b84097f304a",
  ])("refuses malformed or non-cache preview references: %s", (url) => {
    expect(isLocalMediaUrl(url)).toBe(false);
    const projection = createMediaProjection({ enforcement: "strict", preview: () => ({ url }) });
    expect(projection.projectAccount(account).avatarUrl).toBeNull();
    expect(projection.projectWork(work).coverUrl).toBeNull();
  });

  it("projects every nested account and excludes incidental internal fields", () => {
    const projection = createMediaProjection({ enforcement: "strict", preview: () => ({ url: cacheUrl }) });
    const decorated = { ...account, sourceUrl: remote, privateDownload: { url: remote } };
    expect(JSON.stringify(projection.projectAccount(decorated))).not.toContain("sourceUrl");
    const output = projection.projectOverview(overview);
    expect(output.platforms[0].accounts[0].avatarUrl).toBe(cacheUrl);
    expect(JSON.stringify(output)).not.toContain(remote);
    output.platforms[0].accounts[0].spark.push(99);
    expect(platform.accounts[0].spark).toEqual([1, 2]);
    expect(projection.projectPlatformSummary(platform).accounts[0].avatarUrl).toBe(cacheUrl);
  });

  it("uses a placeholder on preview lookup failure without leaking its exception", () => {
    const projection = createMediaProjection({
      enforcement: "strict",
      preview: () => {
        throw new Error(remote);
      },
    });
    expect(projection.projectAccount(account).avatarUrl).toBeNull();
    expect(JSON.stringify(projection.projectOverview(overview))).not.toContain(remote);
  });

  it("observe mode retains its existing display strategy and never calls the cache preview", () => {
    const preview = vi.fn();
    const projection = createMediaProjection({ enforcement: "observe", preview });
    expect(projection.projectAccount(account).avatarUrl).toBe(remote);
    expect(projection.projectWork(work).coverUrl).toBe(remote);
    expect(projection.projectOverview(overview).platforms[0].accounts[0].avatarUrl).toBe(remote);
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([remote, cacheUrl, null])("public account updates cannot nominate media: %s", (avatarUrl) => {
    expect(accountUpdateSchema.safeParse({ displayName: "更新", avatarUrl }).success).toBe(false);
    expect(accountUpdateSchema.parse({ displayName: "更新" })).toEqual({ displayName: "更新" });
  });
});
