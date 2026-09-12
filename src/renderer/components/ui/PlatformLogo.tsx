import douyin from "@renderer/assets/platforms/douyin.ico";
import kuaishou from "@renderer/assets/platforms/kuaishou.png";
import xiaohongshu from "@renderer/assets/platforms/xiaohongshu.png";
import bilibili from "@renderer/assets/platforms/bilibili.png";
import baijiahao from "@renderer/assets/platforms/baijiahao.ico";
import weixin_channels from "@renderer/assets/platforms/weixin_channels.ico";
import youtube from "@renderer/assets/platforms/youtube.png";
import tiktok from "@renderer/assets/platforms/tiktok.png";
import x from "@renderer/assets/platforms/x.ico";

const logos: Record<string, string> = {
  douyin,
  kuaishou,
  xiaohongshu,
  bilibili,
  baijiahao,
  weixin_channels,
  youtube,
  tiktok,
  x,
  twitter: x,
};

export function PlatformLogo({ platformId, size = 28 }: { platformId: string; size?: number }) {
  const source = logos[platformId];
  return source ? (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0, borderRadius: 6 }}
    />
  ) : (
    <span aria-hidden="true" style={{ width: size, height: size, display: "inline-block" }}>
      ◻
    </span>
  );
}
