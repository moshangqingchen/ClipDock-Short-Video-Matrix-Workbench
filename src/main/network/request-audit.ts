import type { NetworkReason } from "@shared/network";

export interface BlockedRequestSummary {
  accountId: string;
  host: string;
  resourceType: string;
  reason: NetworkReason;
  generation: number;
  canceled: true;
  sampled: true;
}

/** Bounded samples for diagnosis, never a physical packet counter or proof of no leakage. */
export class RequestAudit {
  private windowAt = 0;
  private readonly seen = new Set<string>();
  constructor(
    private readonly append: (summary: BlockedRequestSummary) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  record(input: {
    accountId: string;
    url: string;
    resourceType: string;
    reason: NetworkReason;
    generation: number;
  }): void {
    const now = this.now();
    if (now - this.windowAt >= 60_000 || now < this.windowAt) {
      this.windowAt = now;
      this.seen.clear();
    }
    if (this.seen.size >= 512) return;
    let host = "invalid";
    try {
      const candidate = new URL(input.url).hostname.toLowerCase();
      if (candidate.length <= 253 && /^[a-z0-9.:[\]-]+$/.test(candidate)) host = candidate;
    } catch {
      /* Omit malformed URL entirely. */
    }
    const resourceType = /^[a-zA-Z]{1,32}$/.test(input.resourceType) ? input.resourceType : "other";
    const summary: BlockedRequestSummary = {
      accountId: input.accountId,
      host,
      resourceType,
      reason: input.reason,
      generation: input.generation,
      canceled: true,
      sampled: true,
    };
    const key = JSON.stringify(summary);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    try {
      this.append(summary);
    } catch {
      /* Failed audit cannot reopen the request. */
    }
  }
}
