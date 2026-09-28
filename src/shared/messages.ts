import { getPlatform, platformEntryUrl, type PlatformId } from "./platforms";

export interface MessageEntry {
  url: string;
  kind: "inbox" | "douyin-header" | "guided";
  guidance: string;
}

/** Official UI only. No private inbox APIs, account credentials or message contents. */
export function messageEntry(platformId: PlatformId): MessageEntry {
  switch (platformId) {
    case "bilibili":
      return { url: "https://message.bilibili.com/#/whisper", kind: "inbox", guidance: "在官方消息中心选择私信会话，左侧查看消息列表，右侧查看并回复。发送权限以平台提示为准。" };
    case "xiaohongshu":
      return { url: "https://sxt.xiaohongshu.com/im/login", kind: "inbox", guidance: "小红书私信通：按官方页面登录并开通对应私信或客服权限，再选择会话查看和回复。普通账号可用范围以官方页面为准。" };
    case "douyin":
      return { url: platformEntryUrl(platformId), kind: "douyin-header", guidance: "在主页右上角打开「消息」，选择左侧会话后，在右侧对话框查看和回复。若提示登录，请先完成主页登录。" };
    case "weixin_channels":
      return { url: getPlatform(platformId).routes.home, kind: "guided", guidance: "在视频号助手选择「互动管理 → 私信」，再选择会话查看和回复。「私信」仅对有对应权限的账号显示；以官方页面提示为准。" };
    default:
      return { url: getPlatform(platformId).routes.home, kind: "guided", guidance: "在当前官方后台中查找「私信」或「消息」入口，并按平台要求登录。若当前账号没有网页私信入口，请在平台客户端回复；评论和系统通知不等同于私信会话。" };
  }
}
