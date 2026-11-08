import { ArrowRight, Clapperboard, FolderHeart, Globe2, Plus, Sparkles } from "lucide-react";
import { Button } from "@renderer/components/ui";
import { useAccounts, useUi } from "@renderer/store";
import studio from "@renderer/assets/illustrations/creator-studio.png";
import island from "@renderer/assets/illustrations/creative-island.png";
import styles from "./dashboard.module.css";

export function WorkbenchWelcome() {
  const accounts = useAccounts(s => s.accounts);
  const activeId = useUi(s => s.activeAccountId);
  const active = accounts.find(account => account.id === activeId);
  const openCreator = () => {
    if (active) useUi.getState().openAccount(active.id);
    else useUi.getState().setRoute("creator");
  };
  return <>
    <section className={styles.hero} aria-label="创作工作台">
      <img src={studio} alt="蓝发创作者与云朵伙伴，在海边工作室记录灵感" className={styles.heroImage} fetchPriority="high" />
      <div className={styles.heroContent}>
        <span className={styles.heroTag}><Sparkles size={13} /> 每一份热爱，都值得被看见</span>
        <h2>把灵感，<br />变成下一份精彩。</h2>
        <p>账号、素材与数据，在这里有序相遇。<br />留一点轻盈，给今天的创作。</p>
        <div className={styles.heroActions}>
          <Button variant="primary" icon={Clapperboard} onClick={openCreator}>{active ? "继续创作" : "进入创作者平台"}<ArrowRight size={14} /></Button>
          <Button icon={Plus} onClick={() => useUi.getState().setAddAccountOpen(true)}>连接新账号</Button>
        </div>
      </div>
      <span className={styles.heroSignature}>YOUR LITTLE CREATIVE UNIVERSE</span>
    </section>
    <section className={styles.quickGrid} aria-label="快捷工作区">
      <button type="button" className={styles.quickCard} onClick={() => useUi.getState().setRoute("assets")}>
        <img src={island} alt="" aria-hidden="true" />
        <span className={styles.quickIcon}><FolderHeart size={20} /></span>
        <span className={styles.quickText}><strong>灵感素材库</strong><small>让每一份素材，随手可用</small></span>
        <ArrowRight size={16} />
      </button>
      <button type="button" className={styles.quickCard} data-tone="lavender" onClick={() => useUi.getState().setRoute("publish")}>
        <span className={styles.quickIcon}><Clapperboard size={20} /></span>
        <span className={styles.quickText}><strong>发布准备间</strong><small>挑选素材，接着上次的草稿</small></span>
        <ArrowRight size={16} />
      </button>
      <button type="button" className={styles.quickCard} data-tone="mint" onClick={() => { useUi.getState().setCreatorMode("global"); useUi.getState().setRoute("creator"); }}>
        <span className={styles.quickIcon}><Globe2 size={20} /></span>
        <span className={styles.quickText}><strong>探索更多平台</strong><small>YouTube · TikTok · X</small></span>
        <ArrowRight size={16} />
      </button>
    </section>
  </>;
}
