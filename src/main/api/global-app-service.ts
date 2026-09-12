import type { Database } from "@main/db/database";
import {
  CredentialVault,
  CredentialVaultError,
  type CredentialEncryptionProvider,
} from "@main/security/credential-vault";
import { GLOBAL_PLATFORM_IDS, type GlobalPlatformId } from "@shared/platforms";
import { globalPlatformIdSchema } from "@shared/global-accounts";
import {
  globalAppConfigureSchema,
  type GlobalAppConfigureInput,
  type GlobalAppConfiguration,
  type GlobalAppMetadata,
} from "@shared/global-apps";
import { GlobalAppRepository } from "./global-app-repository";

type GlobalAppServiceErrorCode =
  | "GLOBAL_APP_INPUT_INVALID"
  | "GLOBAL_APP_READ_FAILED"
  | "GLOBAL_APP_SAVE_FAILED"
  | "GLOBAL_APP_NOT_CONFIGURED"
  | "GLOBAL_APP_SECRET_REQUIRED"
  | "GLOBAL_APP_SECRET_UNAVAILABLE"
  | "GLOBAL_APP_SECRET_UNSUPPORTED";
export class GlobalAppServiceError extends Error {
  constructor(readonly code: GlobalAppServiceErrorCode) {
    super(code);
    this.name = "GlobalAppServiceError";
  }
}

/** Local application configuration only. No OAuth, browser, Session or transport is invoked here.
 * Secret input is write-only; returned DTOs contain only CredentialVault metadata.
 */
export class GlobalAppService {
  private readonly apps: GlobalAppRepository;
  private readonly vault: CredentialVault;
  constructor(
    private readonly db: Database,
    encryption?: CredentialEncryptionProvider,
  ) {
    this.apps = new GlobalAppRepository(db);
    this.vault = new CredentialVault(db, encryption);
  }

  list(): GlobalAppMetadata[] {
    return this.fixed("GLOBAL_APP_READ_FAILED", () =>
      GLOBAL_PLATFORM_IDS.map((platformId) => this.get(platformId)),
    );
  }

  get(platformId: GlobalPlatformId): GlobalAppMetadata {
    const id = this.parsePlatform(platformId);
    return this.fixed("GLOBAL_APP_READ_FAILED", () => this.project(id, this.apps.get(id)));
  }

  configure(input: GlobalAppConfigureInput): GlobalAppMetadata {
    const parsed = globalAppConfigureSchema.safeParse(input);
    if (!parsed.success) throw new GlobalAppServiceError("GLOBAL_APP_INPUT_INVALID");
    const { platformId, clientId, redirectPort, clientSecret } = parsed.data;
    return this.fixed("GLOBAL_APP_SAVE_FAILED", () =>
      this.db.transaction(() => {
        const previous = this.apps.get(platformId);
        // Repository, vault and token invalidation share this transaction/savepoint chain.
        const configured = this.apps.put({ platformId, clientId, redirectPort });
        const ref = { kind: "oauth_client_secret" as const, ownerId: configured.id };
        let secretChanged = false;
        if (clientSecret !== undefined) {
          const saved = this.vault.set({ ...ref, secret: clientSecret });
          if (!saved.available || this.vault.get(ref) !== clientSecret)
            throw new GlobalAppServiceError("GLOBAL_APP_SECRET_UNAVAILABLE");
          secretChanged = true;
        } else if (previous && previous.clientId !== clientId) {
          // Omission preserves a secret only for the same application, never a different client ID.
          secretChanged = this.vault.has(ref);
          if (secretChanged && this.vault.delete(ref).hasCredential)
            throw new GlobalAppServiceError("GLOBAL_APP_SAVE_FAILED");
        }
        const result = this.project(platformId, configured);
        if (platformId === "tiktok" && !result.clientSecret?.available) {
          throw new GlobalAppServiceError(
            result.clientSecret?.hasCredential
              ? "GLOBAL_APP_SECRET_UNAVAILABLE"
              : "GLOBAL_APP_SECRET_REQUIRED",
          );
        }
        if (secretChanged) this.apps.invalidatePlatformAuthorization(platformId);
        return result;
      }),
    );
  }

  clearSecret(platformId: GlobalPlatformId): GlobalAppMetadata {
    const id = this.parsePlatform(platformId);
    if (id === "x") throw new GlobalAppServiceError("GLOBAL_APP_SECRET_UNSUPPORTED");
    return this.fixed("GLOBAL_APP_SAVE_FAILED", () =>
      this.db.transaction(() => {
        const configured = this.apps.get(id);
        if (!configured) throw new GlobalAppServiceError("GLOBAL_APP_NOT_CONFIGURED");
        const ref = { kind: "oauth_client_secret" as const, ownerId: configured.id };
        if (this.vault.has(ref)) {
          if (this.vault.delete(ref).hasCredential) throw new GlobalAppServiceError("GLOBAL_APP_SAVE_FAILED");
          this.apps.invalidatePlatformAuthorization(id);
        }
        // Public configuration remains present; TikTok must receive a replacement before future OAuth.
        return this.project(id, configured);
      }),
    );
  }

  private project(platformId: GlobalPlatformId, config: GlobalAppConfiguration | null): GlobalAppMetadata {
    if (!config)
      return {
        id: null,
        platformId,
        clientId: null,
        redirectPort: null,
        createdAt: null,
        updatedAt: null,
        configured: false,
        clientSecret: null,
      };
    return {
      ...config,
      configured: true,
      clientSecret:
        platformId === "x" ? null : this.vault.meta({ kind: "oauth_client_secret", ownerId: config.id }),
    };
  }
  private parsePlatform(value: unknown): GlobalPlatformId {
    const parsed = globalPlatformIdSchema.safeParse(value);
    if (!parsed.success) throw new GlobalAppServiceError("GLOBAL_APP_INPUT_INVALID");
    return parsed.data;
  }
  private fixed<T>(code: GlobalAppServiceErrorCode, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof GlobalAppServiceError || error instanceof CredentialVaultError) throw error;
      throw new GlobalAppServiceError(code);
    }
  }
}
