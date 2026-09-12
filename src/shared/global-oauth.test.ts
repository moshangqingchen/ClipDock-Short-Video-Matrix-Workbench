import { describe, expect, it } from "vitest";
import { globalOAuthErrorCode, projectGlobalOAuthState, type GlobalOAuthState } from "./global-oauth";

const state: GlobalOAuthState = {
  accountId: "8e65b156-a2ee-48ac-957e-2f990141c207",
  platformId: "youtube",
  transactionId: "7036177a-2411-427a-a9b2-bbe2c51e3e4f",
  phase: "awaiting_user",
  errorCode: null,
};
describe("global OAuth public projection", () => {
  it("copies only its six public fields", () => {
    const raw = {
      ...state,
      state: "private-state",
      code: "private-code",
      token: "private-token",
      authorizationUrl: "https://private.example/",
    };
    const result = projectGlobalOAuthState(raw);
    expect(result).toEqual(state);
    expect(result).not.toBe(raw);
    expect(JSON.stringify(result)).not.toMatch(/private|https:/);
  });
  it.each([
    { accountId: "youtube" },
    { transactionId: "private-provider-state" },
    { platformId: "douyin" },
    { phase: "private-code" },
    { errorCode: "Bearer private-token" },
  ])("rejects a malformed public field %j", (patch) =>
    expect(projectGlobalOAuthState({ ...state, ...patch })).toBeNull(),
  );
  it("recognizes only fixed invoke error shapes and never copies provider text", () => {
    expect(
      globalOAuthErrorCode(
        new Error("Error invoking remote method 'global-oauth:start': Error: GLOBAL_OAUTH_NOT_CONFIGURED"),
      ),
    ).toBe("GLOBAL_OAUTH_NOT_CONFIGURED");
    expect(globalOAuthErrorCode({ code: "GLOBAL_OAUTH_REVOKED", message: "private-token" })).toBe(
      "GLOBAL_OAUTH_REVOKED",
    );
    expect(globalOAuthErrorCode(new Error("GLOBAL_OAUTH_NOT_CONFIGURED private-secret"))).toBe(
      "GLOBAL_OAUTH_UNAVAILABLE",
    );
    expect(globalOAuthErrorCode(new Error("private-secret https://oauth.example/?code=x"))).toBe(
      "GLOBAL_OAUTH_UNAVAILABLE",
    );
  });
});
