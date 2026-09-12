# 国际只读快照适配器

2026-09-08 核对官方文档；本轮只有文档读取和合成响应测试，没有真实平台账户/API 调用。`GlobalReadAdapter` 通过注入的 `ProxyTransport.request` 读取资料及最多 20 条作品，不建立另一种出网方式，也不刷新 Token、自动翻页或重试。现有 Token 的实际 scopes 决定请求；没有开发者应用及用户授权时不能据此宣称已可采集。

```ts
new GlobalReadAdapter({ transport, now?: () => epochMilliseconds }).read({
  token: GlobalTokenEnvelope,
  signal: AbortSignal,
  assertCurrent(): void,
}): Promise<GlobalReadData>
```

## 固定调用链与首期字段

| 平台    | 顺序与上限                                                                                                                                                                                                                                                                                                                                                                                        | 投影字段与身份校验                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube | `GET https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true&maxResults=2`；取得 uploads playlist 后 `GET /youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=20&playlistId=...`；最后 `GET /youtube/v3/videos?part=snippet,contentDetails,statistics&id=...`，至多 3 请求                                                                   | channel `id` 必须唯一并等于 Token.remoteId；资料 `snippet.title/customUrl`；合计 `subscriberCount/videoCount/viewCount`。作品使用 `contentDetails.videoId`，再校验视频 `snippet.channelId`，读取 `snippet.title/publishedAt` 与 `statistics.viewCount/likeCount/commentCount`。不把 playlist item 的插入日期当视频发布时间。 |
| TikTok  | 必须 `GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name`；仅已获 `user.info.profile` 时追加 `username`。有 stats scope 才另读同 endpoint 的 `open_id,follower_count,following_count,likes_count,video_count`。有 `video.list` 才 `POST /v2/video/list/?fields=id,title,create_time,view_count,like_count,comment_count,share_count`，JSON `{"max_count":20}`。至多 3 请求 | 两次 user/info 的 `open_id` 都必须等于 Token.remoteId；视频列表由同一个已核对用户 Bearer Token 取得（列表本身没有 owner 字段，不伪造）。保留上述计数和作品，`create_time` 按 Unix 秒解释。                                                                                                                                   |
| X       | `GET https://api.x.com/2/users/me?user.fields=id,name,username,public_metrics`；`GET /2/users/{verifiedId}/tweets?max_results=20&tweet.fields=id,text,author_id,created_at,public_metrics&exclude=retweets`。2 请求                                                                                                                                                                               | `me.id` 和每条 `author_id` 必须等于 Token.remoteId。资料 `name/username`；合计粉丝、关注、帖子数；作品 `id/text/created_at` 与公开曝光、点赞、回复、转发计数。包含本人回复，排除单纯转帖；没有请求私有/广告指标。                                                                                                            |

YouTube 当前 `youtube.readonly` 可用于这条授权用户 uploads 链。`playlistItems` 每页最多 50，`nextPageToken` 交给 `pageToken`；本实现固定取 20，后续 Token 只转成 `hasMoreWorks`，不保存/返回游标。`videos.list` 的 `id` 查询不支持 `maxResults/pageToken`，因此这里直接传已取得的 ≤20 个 ID。[Channels list](https://developers.google.com/youtube/v3/docs/channels/list)、[PlaylistItems list](https://developers.google.com/youtube/v3/docs/playlistItems/list)、[Videos list](https://developers.google.com/youtube/v3/docs/videos/list)。

TikTok 当前仓库只请求 `user.info.basic`，因此实际只调用一次基本资料，统计和作品能力均为 `scope_required`。`username`/简介/认证/资料链接需 `user.info.profile`；粉丝/关注/总获赞/公开视频数需 `user.info.stats`；公开视频列表和视频指标需 `video.list`。本次没有改动 `GLOBAL_APP_PROFILES`。[用户字段与 scope](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info)、[Scopes Reference](https://developers.tiktok.com/docs/en/tiktok-api-scopes)。额外 scopes 需要应用获批且用户授权，用户可只同意部分权限，不能靠本地更改字符串补齐已有 Token。[Scopes Overview](https://developers.tiktok.com/docs/en/scopes-overview)。

TikTok 列表按创建时间倒序，默认 10、上限 20；`has_more/cursor` 控制下一页，cursor 是毫秒时间戳。首期仅保留 `has_more`。分享数投影到公共 DTO 的 `reposts`，界面应按平台称“分享”。[List Videos](https://developers.tiktok.com/doc/tiktok-api-v2-video-list)、[Video Object](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object)。

X 现有 `users.read`、`tweet.read` 足够这两项读取，`offline.access` 用于授权生命周期，不是额外统计权限。用户帖子每页 5～100，`meta.next_token` 对应 `pagination_token`；首期固定 20，禁止自动循环。[OAuth endpoint mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping)、[Get Posts](https://docs.x.com/x-api/users/get-posts)。官方页面当前存在命名过渡：[数据字典](https://docs.x.com/x-api/fundamentals/data-dictionary) 使用 `tweet_count/retweet_count`，[Get Users Me](https://docs.x.com/x-api/users/get-my-user) 示例使用 `post_count/repost_count`。适配器仅兼容这两组已文档化名称；两者同时返回且不同则该计数为 null。X `impression_count` 在 DTO 中占 `views`，界面必须称“曝光”，不能当视频播放量，也不把 quote_count 加入 reposts。

## 限额和错误边界

- YouTube 三种 list 调用各 1 quota unit；每页另计，额度不足也可能是 403，不能等同账户退出。当前官方 quota 页面列其他 endpoints 合用每日 10,000 units，具体额度以该项目控制台为准；本模块没有调用搜索或上传接口。[Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)、[API errors](https://developers.google.com/youtube/v3/docs/errors)。订阅数本来就是约三位有效数字，隐藏时输出 null；`videoCount` 是公开视频数量；频道 commentCount 已废弃。[Channel resource](https://developers.google.com/youtube/v3/docs/channels)。
- TikTok 需要 Login Kit/Display API 产品和相应 scope 审批；用户同意与应用获批是两道条件。三个 Display endpoints 当前分别默认每分钟滑窗 600 次，不把它理解为本程序应高频轮询。[Get Started](https://developers.tiktok.com/doc/display-api-get-started)、[Rate Limits](https://developers.tiktok.com/docs/en/tiktok-api-v2-rate-limit)。`access_token_invalid` 为 401；官方 `scope_not_authorized` 也可能为 401，`scope_permission_missed` 为 400，所以不能用“所有权限错误都是 403”做业务假设。[Error Handling](https://developers.tiktok.com/docs/en/tiktok-api-v2-error-handling)。
- X 当前是预购 credits 的按量付费，不按旧 Free/Basic/Pro 套餐许诺可用。官方当日标价普通 user read 为 $0.010/resource、post read 为 $0.005/resource；Owned Reads 的 $0.001/resource 另要求访问用户也是开发者应用所有者，授权他人的号不自动满足。价格、余额及限额以开发者控制台为准，授权成功不证明 API 付费额度可用。[Pricing](https://docs.x.com/x-api/getting-started/pricing)。403 可能是权限/产品访问，429 可能是限流或使用额度；HTTP 200 也可能混合 data/errors，本适配器不把部分错误包装为完整成功。[Response Codes & Errors](https://docs.x.com/x-api/fundamentals/response-codes-and-errors)。

适配器所有请求与 await 返回后检查原 signal、Token 到期和 `assertCurrent()`。401 一律抛固定 `GLOBAL_READ_REAUTHORIZE`；身份变化、响应错误、代理资格撤销或网络失败都会拒绝整次结果。只有独立可选统计/列表的 403/429 可以分别显示 `forbidden/rate_limited`；基础资料失败不保存空成功。调用层决定是否刷新/重新授权，本模块不改账号 auth 状态。

计数只输出规范十进制字符串或 null：字符串保持精度；JSON 数字若超出安全整数范围则为 null，不把已舍入的 int64 伪装为准确数值。不通过最近 20 条作品推算账户总获赞/总曝光。资料和标题有明确长度上限；原响应、授权信息、头像/封面地址、嵌入 HTML、原错误信息及分页游标都不进入 DTO。Token/identity/scopes 在首次外部回调前复制，最终再经 `globalReadDataSchema` 校验。

验证：29 个合成响应定向测试通过，覆盖三条实际请求链、已有 basic scope 的零越权请求、精度/未知值、身份变化、可选 403/429、401、撤销与迟到回调、调用方对象变更、20 条上限、X 部分错误及脱敏。没有真实平台授权/统计值验收，后续必须用用户自己的已配置开发者应用完成首次读取。
