import { z } from "zod";
import { GLOBAL_PLATFORM_IDS } from "./platforms";

export const globalPlatformIdSchema = z.enum(GLOBAL_PLATFORM_IDS);
export const globalAccountIdSchema = z.string().uuid();
export const globalAccountUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type GlobalAccountUpdate = z.infer<typeof globalAccountUpdateSchema>;
export const globalAuthStatusSchema = z.enum(["unauthorized", "authorized", "reauthorization_required"]);

/** Creating metadata neither authorizes an API nor creates a Chromium partition. */
export const globalAccountCreateSchema = z
  .object({
    platformId: globalPlatformIdSchema,
    displayName: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

/** Public metadata only. Runtime network eligibility is projected separately, never stored. */
export const globalAccountSchema = z
  .object({
    id: globalAccountIdSchema,
    platformId: globalPlatformIdSchema,
    displayName: z.string().min(1).max(60),
    remoteId: z.string().min(1).max(256).nullable(),
    note: z.string().max(500).nullable().optional(),
    browserEngine: z.enum(["chrome", "embedded"]).optional(),
    authStatus: globalAuthStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((account) => account.authStatus !== "authorized" || account.remoteId !== null);

export type GlobalAccount = z.infer<typeof globalAccountSchema>;
export type GlobalAccountCreateInput = z.input<typeof globalAccountCreateSchema>;
export type GlobalAuthStatus = z.infer<typeof globalAuthStatusSchema>;

/** No renderer patch can set authorization, remote identity, tokens or network state. */
export interface GlobalAccountApi {
  list(): Promise<GlobalAccount[]>;
  update(id: string, input: GlobalAccountUpdate): Promise<GlobalAccount>;
  create(input: GlobalAccountCreateInput): Promise<GlobalAccount>;
  delete(id: string): Promise<void>;
  /** Deletes the local grant only; this does not revoke consent at the provider. */
  disconnect(id: string): Promise<GlobalAccount>;
}
