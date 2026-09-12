import {
  CREDENTIAL_IPC,
  credentialDeleteSchema,
  credentialRefSchema,
  credentialWriteSchema,
} from "@shared/credentials";
import type { CredentialVault } from "@main/security/credential-vault";
import type { IpcRegistrar } from "../register";

export function registerCredentialHandlers(
  ipc: IpcRegistrar,
  vault: CredentialVault,
  onChanged?: () => void,
): void {
  ipc.handleValidated(CREDENTIAL_IPC.credentialMeta, credentialRefSchema, (_e, ref) => vault.meta(ref));
  ipc.handleValidated(CREDENTIAL_IPC.credentialSet, credentialWriteSchema, (_e, input) => {
    const result = vault.set(input);
    onChanged?.();
    return result;
  });
  ipc.handleValidated(CREDENTIAL_IPC.credentialDelete, credentialDeleteSchema, (_e, ref) => {
    const result = vault.delete(ref);
    onChanged?.();
    return result;
  });
}
