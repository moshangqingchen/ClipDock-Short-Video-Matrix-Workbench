import { z } from "zod";

export type PublishScope = "domestic" | "global";
const draftSchema = z.object({
  title: z.string().max(200),
  description: z.string().max(5000),
  tags: z.array(z.string().max(200)).max(30),
  selected: z.array(z.string().max(200)).max(1000),
  recordId: z.string().max(200).optional(),
});
const savedSchema = z.object({ version: z.literal(1), savedAt: z.string().datetime(), draft: draftSchema });
export type PublishDraft = z.infer<typeof draftSchema>;
export interface DraftSnapshot { draft: PublishDraft | null; savedAt: string | null; error: string | null }
export const DRAFT_CHANGED = "clipdock:publish-draft-changed";
// This cache preserves current work if browser storage becomes unavailable. It never
// claims durability; the UI continues to show the write error until a retry succeeds.
const currentDrafts = new Map<string, DraftSnapshot>();
export const draftStorageKey = (scope: PublishScope, accountId: string) =>
  `clipdock:publish-draft:v1:${scope}:${encodeURIComponent(accountId)}`;

export function readPublishDraft(scope: PublishScope, accountId: string): DraftSnapshot {
  const key = draftStorageKey(scope, accountId);
  const current = currentDrafts.get(key);
  if (current?.error) return current;
  try {
    const text = localStorage.getItem(key);
    if (!text) return { draft: null, savedAt: null, error: null };
    const value = savedSchema.parse(JSON.parse(text));
    return { draft: value.draft, savedAt: value.savedAt, error: null };
  } catch {
    return { draft: current?.draft ?? null, savedAt: current?.savedAt ?? null, error: "本地草稿读取失败；原记录已保留，请重试读取或保存为计划。" };
  }
}

export function savePublishDraft(scope: PublishScope, accountId: string, draft: PublishDraft): DraftSnapshot {
  const key = draftStorageKey(scope, accountId);
  let result: DraftSnapshot;
  try {
    const savedAt = new Date().toISOString();
    const clean = draftSchema.parse(draft);
    localStorage.setItem(key, JSON.stringify({ version: 1, savedAt, draft: clean }));
    result = { draft: clean, savedAt, error: null };
  } catch {
    result = { draft, savedAt: currentDrafts.get(key)?.savedAt ?? null,
      error: "自动保存失败，草稿暂留在当前窗口；关闭前请重试保存或保存为计划。" };
  }
  currentDrafts.set(key, result);
  window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, { detail: key }));
  return result;
}
