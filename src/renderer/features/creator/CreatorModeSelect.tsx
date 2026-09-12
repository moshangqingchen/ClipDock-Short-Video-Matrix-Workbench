import { ChevronDown } from "lucide-react";
import { useUi } from "@renderer/store";
import styles from "./creator-mode-select.module.css";

/** Account scope is a navigation choice; it never changes the system proxy. */
export function CreatorModeSelect({ mode }: { mode: "domestic" | "global" }) {
  const setMode = useUi((state) => state.setCreatorMode);
  return (
    <div className={styles.control}>
      <select
        aria-label="切换国内或国外平台"
        value={mode}
        className={styles.select}
        onChange={(event) => setMode(event.target.value === "global" ? "global" : "domestic")}
      >
        <option value="domestic">国内短视频平台</option>
        <option value="global">国外短视频平台</option>
      </select>
      <ChevronDown className={styles.chevron} size={15} aria-hidden />
    </div>
  );
}
