import { Sparkles } from "lucide-react";
import island from "@renderer/assets/illustrations/creative-island.png";
import studio from "@renderer/assets/illustrations/creator-studio.png";
import styles from "./section-illustration.module.css";

/** Decoration stays separate from live data and interactive controls. */
export function SectionIllustration({ title, description, scene = "island" }: {
  title: string; description: string; scene?: "island" | "studio";
}) {
  return <section className={styles.banner}>
    <img src={scene === "island" ? island : studio} alt="" aria-hidden="true" loading="lazy" />
    <div><span><Sparkles size={13} /> CREATIVE MOMENTS</span><h2>{title}</h2><p>{description}</p></div>
  </section>;
}
