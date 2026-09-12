import { describe, expect, it } from "vitest";
import { CN_PLATFORM_IDS, GLOBAL_PLATFORM_IDS } from "./platforms";
import { accountCreateSchema } from "./ipc";
import { globalAccountCreateSchema, globalAccountSchema } from "./global-accounts";

describe("international account boundary", () => {
  it("keeps creation disjoint from all six domestic partition platforms", () => {
    for (const platformId of CN_PLATFORM_IDS) {
      expect(globalAccountCreateSchema.safeParse({ platformId }).success).toBe(false);
      expect(accountCreateSchema.safeParse({ platformId }).success).toBe(true);
    }
    for (const platformId of GLOBAL_PLATFORM_IDS) {
      expect(globalAccountCreateSchema.safeParse({ platformId }).success).toBe(true);
      expect(accountCreateSchema.safeParse({ platformId }).success).toBe(false);
    }
  });

  it.each(["partition", "authStatus", "remoteId", "token", "clientSecret", "egressState"])(
    "rejects renderer creation with authority field %s instead of silently accepting it",
    (key) => {
      expect(globalAccountCreateSchema.safeParse({ platformId: "youtube", [key]: "private" }).success).toBe(
        false,
      );
    },
  );

  it("trims a bounded name but rejects empty or oversized names", () => {
    expect(globalAccountCreateSchema.parse({ platformId: "x", displayName: "  工作账号  " })).toEqual({
      platformId: "x",
      displayName: "工作账号",
    });
    for (const displayName of ["   ", "a".repeat(61)])
      expect(globalAccountCreateSchema.safeParse({ platformId: "x", displayName }).success).toBe(false);
  });

  it("validates a public DTO without browser or secret fields and requires an authorized identity", () => {
    const account = {
      id: "19d484c0-2fd8-4314-92d4-2109fbfe3123",
      platformId: "tiktok",
      displayName: "TikTok",
      remoteId: null,
      authStatus: "unauthorized",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    };
    expect(globalAccountSchema.safeParse(account).success).toBe(true);
    expect(globalAccountSchema.safeParse({ ...account, authStatus: "authorized" }).success).toBe(false);
    expect(globalAccountSchema.safeParse({ ...account, partition: "persist:anything" }).success).toBe(false);
    expect(globalAccountSchema.safeParse({ ...account, accessToken: "private" }).success).toBe(false);
    expect(globalAccountSchema.safeParse({ ...account, networkState: "allowed" }).success).toBe(false);
  });
});
