import { useEffect, useState } from "react";
import type { GlobalPlatformId } from "@shared/platforms";
import { GLOBAL_PLATFORM_IDS } from "@shared/platforms";
import { useGlobalAccounts, useUi, useToasts } from "@renderer/store";
import { AddGlobalAccountModal } from "./AddGlobalAccountModal";

export function GlobalAccountModalHost() {
  const [platform, setPlatform] = useState<GlobalPlatformId | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      if (useUi.getState().overlayCount > 0) return;
      const id = (event as CustomEvent<GlobalPlatformId>).detail;
      setPlatform(GLOBAL_PLATFORM_IDS.includes(id) ? id : "youtube");
    };
    window.addEventListener("clipdock:focus-global-create", open);
    return () => window.removeEventListener("clipdock:focus-global-create", open);
  }, []);
  return platform ? (
    <AddGlobalAccountModal
      initialPlatform={platform}
      onClose={() => setPlatform(null)}
      onCreated={(account) => {
        useGlobalAccounts.getState().upsert(account);
        useUi.getState().selectGlobalAccount(account.id);
      }}
      onNotice={(message) => useToasts.getState().push({ kind: "info", title: message })}
    />
  ) : null;
}
