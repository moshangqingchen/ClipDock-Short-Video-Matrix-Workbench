import { GlobalAccountsPage } from "@renderer/features/global/GlobalAccountsPage";
import { AccountWorkspace } from "@renderer/features/browser/AccountWorkspace";
import { useUi } from "@renderer/store";
import styles from "./creator.module.css";

/** Unified creator entry point. The two account domains keep their own sessions and data. */
export function CreatorPlatformPage() {
  const mode = useUi((state) => state.creatorMode);
  return (
    <div className={styles.page}>
      {mode === "domestic" ? <AccountWorkspace /> : <GlobalAccountsPage />}
    </div>
  );
}
