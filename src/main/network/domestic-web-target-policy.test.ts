import { describe, expect, it } from "vitest";
import { isPlatformHost } from "@shared/platforms";
import { isDomesticWebHost } from "./domestic-web-target-policy";

describe("domestic page resource families", () => {
  it.each(["p1-plat.wskwai.com", "p3-plat.wsbkwai.com", "p66-plat.wskwai.com", "video.djvod.ndcimgs.com", "v4.oskwai.com"])(
    "permits Kuaishou resource %s without making it a login/navigation origin",
    (host) => {
      expect(isDomesticWebHost("kuaishou", host)).toBe(true);
      expect(isPlatformHost("kuaishou", host)).toBe(false);
      expect(isDomesticWebHost("douyin", host)).toBe(false);
    },
  );
  it.each(["evilwskwai.com", "p1-plat.wskwai.com.evil.com", "wskwai.com:443", "user@wskwai.com"])(
    "rejects lookalike and malformed resource host %s",
    (host) => expect(isDomesticWebHost("kuaishou", host)).toBe(false),
  );
});
