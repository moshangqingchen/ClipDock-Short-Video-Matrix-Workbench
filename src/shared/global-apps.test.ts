import { describe, expect, it } from "vitest";
import {
  GLOBAL_APP_PROFILES,
  globalAppConfigSchema,
  globalAppConfigureSchema,
  unconfiguredGlobalApp,
} from "./global-apps";

describe("public international app configuration", () => {
  it("accepts canonical official client IDs after trim without accepting URLs or whitespace injection", () => {
    expect(
      globalAppConfigSchema.parse({
        platformId: "youtube",
        clientId: " 12345-example.apps.googleusercontent.com ",
        redirectPort: 0,
      }).clientId,
    ).toBe("12345-example.apps.googleusercontent.com");
    for (const clientId of [
      "",
      "  ",
      "has space",
      "line\r\nbreak",
      "https://arbitrary.example",
      "x".repeat(513),
    ])
      expect(globalAppConfigSchema.safeParse({ platformId: "x", clientId, redirectPort: 3456 }).success).toBe(
        false,
      );
  });

  it("only allows YouTube's dynamic port and otherwise requires a bounded unprivileged port", () => {
    for (const platformId of ["youtube", "tiktok", "x"] as const) {
      for (const redirectPort of [1024, 65535])
        expect(
          globalAppConfigSchema.safeParse({ platformId, clientId: "valid-client", redirectPort }).success,
        ).toBe(true);
      for (const redirectPort of [-1, 1, 1023, 65536, 3456.5])
        expect(
          globalAppConfigSchema.safeParse({ platformId, clientId: "valid-client", redirectPort }).success,
        ).toBe(false);
      expect(
        globalAppConfigSchema.safeParse({ platformId, clientId: "valid-client", redirectPort: 0 }).success,
      ).toBe(platformId === "youtube");
    }
  });

  it("separates the public row input from the secret write and rejects destination or scope overrides", () => {
    const base = { platformId: "tiktok", clientId: "valid-client", redirectPort: 3455 };
    for (const key of [
      "id",
      "clientSecret",
      "token",
      "scopes",
      "authorizeUrl",
      "redirectPath",
      "networkState",
    ])
      expect(globalAppConfigSchema.safeParse({ ...base, [key]: "untrusted" }).success).toBe(false);
    expect(globalAppConfigureSchema.safeParse({ ...base, clientSecret: "write-only" }).success).toBe(true);
    expect(globalAppConfigureSchema.safeParse({ ...base, clientSecret: " " }).success).toBe(false);
    expect(
      globalAppConfigureSchema.safeParse({ ...base, platformId: "x", clientSecret: "unused" }).success,
    ).toBe(false);
    expect(globalAppConfigureSchema.safeParse({ ...base, scopes: ["video.publish"] }).success).toBe(false);
  });

  it("keeps default profiles immutable, limited to first read scopes, and does not imply authorization", () => {
    expect(GLOBAL_APP_PROFILES.youtube.scopes).toEqual(["https://www.googleapis.com/auth/youtube.readonly"]);
    expect(GLOBAL_APP_PROFILES.tiktok.scopes).toEqual(["user.info.basic"]);
    expect(GLOBAL_APP_PROFILES.x.scopes).toEqual(["users.read", "tweet.read", "offline.access"]);
    for (const platformId of ["youtube", "tiktok", "x"] as const) {
      const profile = GLOBAL_APP_PROFILES[platformId];
      expect(profile.redirectPath).toBe("/oauth/callback");
      expect(() => (profile.scopes as string[]).push("publish-anything")).toThrow();
      expect(unconfiguredGlobalApp(platformId)).toEqual({
        platformId,
        configured: false,
        id: null,
        clientId: null,
        redirectPort: null,
        createdAt: null,
        updatedAt: null,
        clientSecret: null,
      });
    }
  });
});
