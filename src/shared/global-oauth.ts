import type { GlobalPlatformId } from "./platforms";

export const GLOBAL_OAUTH_ERROR_CODES = [
  "GLOBAL_OAUTH_INVALID_ACCOUNT",
  "GLOBAL_OAUTH_NOT_CONFIGURED",
  "GLOBAL_OAUTH_ENCRYPTION_UNAVAILABLE",
  "GLOBAL_OAUTH_SECRET_UNAVAILABLE",
  "GLOBAL_OAUTH_PROXY_UNVERIFIED",
  "GLOBAL_OAUTH_BUSY",
  "GLOBAL_OAUTH_REVOKED",
  "GLOBAL_OAUTH_CANCELLED",
  "GLOBAL_OAUTH_EXPIRED",
  "GLOBAL_OAUTH_FAILED",
  "GLOBAL_OAUTH_UNAVAILABLE",
] as const;
export type GlobalOAuthErrorCode = (typeof GLOBAL_OAUTH_ERROR_CODES)[number];
const PHASES = [
  "idle",
  "starting",
  "awaiting_user",
  "exchanging",
  "authorized",
  "cancelled",
  "expired",
  "failed",
] as const;

/** Safe projection only: no provider state, authorization URL, code, verifier or token. */
export interface GlobalOAuthState {
  readonly accountId: string;
  readonly platformId: GlobalPlatformId;
  readonly transactionId: string | null;
  readonly phase: (typeof PHASES)[number];
  readonly errorCode: GlobalOAuthErrorCode | null;
}
export interface GlobalOAuthApi {
  state(accountId: string): Promise<GlobalOAuthState>;
  start(accountId: string): Promise<GlobalOAuthState>;
  startDraft(accountId: string): Promise<GlobalOAuthState>;
  startUpload(accountId: string): Promise<GlobalOAuthState>;
  cancel(accountId: string): Promise<GlobalOAuthState>;
  onState(handler: (state: GlobalOAuthState) => void): () => void;
}

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
/** Dependency-free so the sandbox preload can enforce its output boundary too. */
export function projectGlobalOAuthState(raw: unknown): GlobalOAuthState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.accountId !== "string" ||
    !UUID.test(value.accountId) ||
    !["youtube", "tiktok", "x"].includes(value.platformId as string) ||
    !(
      value.transactionId === null ||
      (typeof value.transactionId === "string" && UUID.test(value.transactionId))
    ) ||
    !PHASES.includes(value.phase as GlobalOAuthState["phase"]) ||
    !(value.errorCode === null || GLOBAL_OAUTH_ERROR_CODES.includes(value.errorCode as GlobalOAuthErrorCode))
  )
    return null;
  return {
    accountId: value.accountId,
    platformId: value.platformId as GlobalPlatformId,
    transactionId: value.transactionId,
    phase: value.phase as GlobalOAuthState["phase"],
    errorCode: value.errorCode as GlobalOAuthErrorCode | null,
  };
}

/** Electron wraps invoke errors in a fixed prefix. Never render any source message. */
export function globalOAuthErrorCode(error: unknown): GlobalOAuthErrorCode {
  if (!error || typeof error !== "object") return "GLOBAL_OAUTH_UNAVAILABLE";
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (GLOBAL_OAUTH_ERROR_CODES.includes(code as GlobalOAuthErrorCode)) return code as GlobalOAuthErrorCode;
  if (typeof message === "string") {
    const match =
      /^(?:Error invoking remote method 'global-oauth:(?:state|start|start-draft|start-upload|cancel)': Error: )?(GLOBAL_OAUTH_[A-Z_]+)$/.exec(
        message,
      );
    if (match && GLOBAL_OAUTH_ERROR_CODES.includes(match[1] as GlobalOAuthErrorCode))
      return match[1] as GlobalOAuthErrorCode;
  }
  return "GLOBAL_OAUTH_UNAVAILABLE";
}
