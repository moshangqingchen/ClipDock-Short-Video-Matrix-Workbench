import { z } from "zod";
import type { CredentialMetadata } from "./credentials";
import type { GlobalPlatformId } from "./platforms";
import { globalPlatformIdSchema } from "./global-accounts";

/** Reviewed constants; neither scopes nor OAuth destinations come from editable settings. */
export const GLOBAL_APP_PROFILES = Object.freeze({
  youtube: Object.freeze({
    profile: "google-desktop-s256" as const,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scopes: Object.freeze(["https://www.googleapis.com/auth/youtube.readonly"]),
    redirectPath: "/oauth/callback" as const,
    defaultRedirectPort: 0,
    secretPolicy: "optional" as const,
  }),
  tiktok: Object.freeze({
    profile: "tiktok-desktop-hex-s256" as const,
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    scopes: Object.freeze(["user.info.basic"]),
    redirectPath: "/oauth/callback" as const,
    defaultRedirectPort: 3455,
    secretPolicy: "required" as const,
  }),
  x: Object.freeze({
    profile: "x-s256" as const,
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    scopes: Object.freeze(["users.read", "tweet.read", "offline.access"]),
    redirectPath: "/oauth/callback" as const,
    defaultRedirectPort: 3456,
    secretPolicy: "not-used" as const,
  }),
});

const clientIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._~-]{1,512}$/);
function validPort(input: { platformId: GlobalPlatformId; redirectPort: number }): boolean {
  return input.redirectPort >= 1024 || (input.platformId === "youtube" && input.redirectPort === 0);
}

/** Public persistence boundary. A secret is deliberately not a column or a valid input here. */
export const globalAppConfigSchema = z
  .object({
    platformId: globalPlatformIdSchema,
    clientId: clientIdSchema,
    redirectPort: z.number().int().min(0).max(65_535),
  })
  .strict()
  .refine(validPort);

/** UI write only; services separate this value into CredentialVault before returning metadata. */
export const globalAppConfigureSchema = globalAppConfigSchema
  .safeExtend({
    clientSecret: z
      .string()
      .min(1)
      .max(65_536)
      .refine((value) => value.trim().length > 0)
      .optional(),
  })
  .refine((input) => input.platformId !== "x" || input.clientSecret === undefined);

export const globalAppConfigurationSchema = globalAppConfigSchema.safeExtend({
  id: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type GlobalAppConfigInput = z.input<typeof globalAppConfigSchema>;
export type GlobalAppConfigureInput = z.input<typeof globalAppConfigureSchema>;
export type GlobalAppConfiguration = z.infer<typeof globalAppConfigurationSchema>;

/** Configured means only that public app settings exist, never authorization or network permission. */
export type GlobalAppMetadata = (
  | (GlobalAppConfiguration & { configured: true })
  | {
      platformId: GlobalPlatformId;
      id: null;
      configured: false;
      clientId: null;
      redirectPort: null;
      createdAt: null;
      updatedAt: null;
    }
) & { clientSecret: CredentialMetadata | null };

export function unconfiguredGlobalApp(platformId: GlobalPlatformId): GlobalAppMetadata {
  return {
    platformId: globalPlatformIdSchema.parse(platformId),
    id: null,
    configured: false,
    clientId: null,
    redirectPort: null,
    createdAt: null,
    updatedAt: null,
    clientSecret: null,
  };
}

export interface GlobalAppsApi {
  list(): Promise<GlobalAppMetadata[]>;
  configure(input: GlobalAppConfigureInput): Promise<GlobalAppMetadata>;
  clearSecret(platformId: GlobalPlatformId): Promise<GlobalAppMetadata>;
}
export type GlobalAppApi = GlobalAppsApi;
