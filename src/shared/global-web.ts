import { z } from "zod";
import { globalAccountIdSchema } from "./global-accounts";
import type { ViewBounds } from "./types";
import type { GlobalWebCapability } from "./global-platforms";
import type { WebObservation } from "./global-web-observation";

export const GLOBAL_WEB_ERROR_CODES = [
  "GLOBAL_WEB_PROXY_UNVERIFIED",
  "GLOBAL_WEB_BROWSER_UNAVAILABLE",
  "GLOBAL_WEB_PROFILE_BUSY",
  "GLOBAL_WEB_BUSY",
  "GLOBAL_WEB_CLEANUP_FAILED",
  "GLOBAL_WEB_UNAVAILABLE",
  "GLOBAL_WEB_ROUTE_UNAVAILABLE",
] as const;
export type GlobalWebErrorCode = (typeof GLOBAL_WEB_ERROR_CODES)[number];
export const globalWebStateSchema = z
  .object({
    accountId: globalAccountIdSchema,
    phase: z.enum(["closed", "checking", "opening", "open", "closing", "dormant", "error"]),
    errorCode: z.enum(GLOBAL_WEB_ERROR_CODES).nullable(),
    embedded: z.boolean().optional(),
    displayUrl: z.string().max(2000).optional(),
    title: z.string().max(200).optional(),
    loading: z.boolean().optional(),
    canGoBack: z.boolean().optional(),
    canGoForward: z.boolean().optional(),
    engine: z.literal("chrome").optional(),
  })
  .strict();
export const globalWebCapabilitySchema = z.enum([
  "home",
  "manage",
  "upload",
  "analytics",
  "works",
  "comments",
  "publish",
]);
export const globalWebCommandSchema = z.enum(["back", "forward", "reload"]);
export type GlobalWebState = z.infer<typeof globalWebStateSchema>;
export interface GlobalWebApi {
  observation(id: string): Promise<WebObservation | null>;
  observationHistory(id: string): Promise<WebObservation[]>;
  readPage(id: string): Promise<WebObservation>;
  state(id: string): Promise<GlobalWebState>;
  open(id: string): Promise<GlobalWebState>;
  openChrome(id: string): Promise<GlobalWebState>;
  close(id: string): Promise<GlobalWebState>;
  openExternal(id: string): Promise<GlobalWebState>;
  show(id: string, bounds: ViewBounds): Promise<void>;
  hide(id: string): Promise<void>;
  go(id: string, capability: GlobalWebCapability): Promise<void>;
  command(id: string, command: "back" | "forward" | "reload"): Promise<void>;
  onChanged(listener: (state: GlobalWebState) => void): () => void;
}
export function globalWebErrorCode(error: unknown): GlobalWebErrorCode {
  if (error instanceof Error) {
    const match =
      /^(?:Error invoking remote method 'global-web:[a-z-]+': Error: )?(GLOBAL_WEB_[A-Z_]+)$/.exec(
        error.message,
      );
    if (match && GLOBAL_WEB_ERROR_CODES.includes(match[1] as GlobalWebErrorCode))
      return match[1] as GlobalWebErrorCode;
  }
  return "GLOBAL_WEB_UNAVAILABLE";
}
