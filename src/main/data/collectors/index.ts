import type { PlatformId } from "@shared/platforms";
import type { Collector } from "./shared";
import { douyinCollector } from "./douyin";
import { kuaishouCollector } from "./kuaishou";
import { xiaohongshuCollector } from "./xiaohongshu";
import { bilibiliCollector } from "./bilibili";
import { baijiahaoCollector } from "./baijiahao";
import { weixinChannelsCollector } from "./weixin-channels";

export type { Collector, CollectorContext, CollectorProfile, CollectorResult } from "./shared";
export { LoggedOutError, RateLimitedError } from "./shared";

export interface CollectorRegistry {
  get(platformId: PlatformId): Collector | undefined;
  list(): Collector[];
}

export function createCollectorRegistry(): CollectorRegistry {
  const collectors = new Map<PlatformId, Collector>(
    [
      douyinCollector,
      kuaishouCollector,
      xiaohongshuCollector,
      bilibiliCollector,
      baijiahaoCollector,
      weixinChannelsCollector,
    ].map((c) => [c.platformId, c] as const),
  );
  return {
    get: (id) => collectors.get(id),
    list: () => [...collectors.values()],
  };
}
