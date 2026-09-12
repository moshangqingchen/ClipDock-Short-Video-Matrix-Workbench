# 国际 OAuth Code 兑换与身份确认

2026-09-08 核对官方资料；实现为 `src/main/api/oauth-exchange.ts`。本轮只有合成响应测试，没有真实授权、Token 请求或平台账号实测。

主进程接口：`new OAuthCodeExchanger({ transport, readClientSecret, now? }).exchange(input, app)`。`input` 为现有 `OAuthCodeExchangeInput`，`app` 为当前 `GlobalAppConfiguration`；结果为主进程 `GlobalTokenEnvelope`，随后仍须由 `GlobalTokenStore.commitAuthorization(token, context)` 原子核对账号、保存密文与授权状态。`readClientSecret(app)` 必须按该应用 UUID 从主进程 Vault 读取；未配置返回 `null`，不可解密必须抛错，不能伪装成未配置。

| 平台    | 固定兑换与最小身份接口                                                                                                          | 当前合同                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube | POST `https://oauth2.googleapis.com/token`；GET `https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=2` | Desktop PKCE，secret 可选；响应需实际授予 `youtube.readonly`；只接受唯一、无后续分页的频道 ID，未创建频道或多频道歧义都不自行挑选。                                              |
| TikTok  | POST `https://open.tiktokapis.com/v2/oauth/token/`；GET `https://open.tiktokapis.com/v2/user/info/?fields=open_id`              | `client_key`、secret、原 verifier 必填；`user.info.basic` 必须实际获授；用户接口 `error.code=ok`，且其 `open_id` 与 Token 响应一致。                                             |
| X       | POST `https://api.x.com/2/oauth2/token`；GET `https://api.x.com/2/users/me`                                                     | 首期 Native/public PKCE，在表单传 `client_id`，不读取或发送 secret；实际获授 `users.read tweet.read offline.access` 后以 `data.id` 确认身份。Confidential 客户端不在本接口范围。 |

Google 的可选 secret、表单参数、`expires_in` 秒数与实际 scope 核对来自 [Desktop OAuth 文档](https://developers.google.com/identity/protocols/oauth2/native-app)；`mine=true` 只返回授权用户拥有的频道，见 [channels.list](https://developers.google.com/youtube/v3/docs/channels/list)。本模块不使用 `id_token` 推断 YouTube 频道。

TikTok 的兑换参数、逗号分隔 scope 和有效期来自 [User Access Token Management](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)，Desktop verifier/challenge 规则见 [Login Kit Desktop](https://developers.tiktok.com/doc/login-kit-desktop/)。`user.info.basic` 对应 `open_id`、Bearer 头与成功错误对象见 [Get User Info](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info)。只请求身份字段，不获取头像或指标。

X 的 public/confidential 差异、表单兑换端点来自 [Authorization Code Flow](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token)；scope 含义见 [PKCE 与权限说明](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)，身份端点见 [Get Users Me](https://docs.x.com/x-api/users/get-my-user)。官方 SDK 的 [`GetTokenResponse` 和秒数换算](https://github.com/xdevplatform/twitter-api-typescript-sdk/blob/main/src/OAuth2User.ts) 补充字段依据；实现必须读取实际 `expires_in`，不硬编码“两小时”，也不推断收费套餐已允许业务接口。

每次兑换最多两次 HTTP，全部由显式注入的 `Pick<ProxyTransport, 'request'>` 执行；不创建 Session、不调用默认 fetch、不重试或跟随重定向。Token/code/verifier/secret 不进 URL；Bearer 只放身份请求头。原 code 已由 OAuth callback 解码，表单编码不再次解码。输入需与配置平台、client ID、固定 loopback 回调路径和已选端口匹配。

读取秘密、每次请求以及最终返回均复核 `signal` 和 `assertCurrent`。输入和公开配置先复制，代际变化由调用方的真实 `assertCurrent` 提供；本模块不以配置副本代替当前性。HTTP 必须为 200、JSON MIME、有效 UTF-8、对象、至多 64 KiB；挑战、限流、错误体、缺权限、未知身份及晚到成功均拒绝，错误只有固定代码。

有效期从 Token 请求开始的时间加实际 `expires_in` 保守计算，身份核对耗时不会延期。只保留实际返回的 refresh token。16:01 修订将平台明确返回的刷新期限保存到 main-only v1 envelope 的可选 `refreshExpiresAt`：TikTok 使用 `refresh_expires_in`，Google 使用可选 `refresh_token_expires_in`，均从原请求开始计时；有新 TikTok refresh token 却无合法期限时拒绝。旧 v1 数据保持可读，X 不编造期限。按需刷新已单独实现，见[刷新合同](oauth-refresh-contract.md)；不据此承诺长期在线、上传或发布。

验证：新增 67 项合成测试通过；Electron TypeScript 和该模块/测试的 ESLint 通过。覆盖三个成功表单与身份、public/secret 差异、权限和身份失败、固定错误脱敏、格式/大小/UTF-8 限制、过期、撤销、迟到响应和输入快照；这不是官方应用审核或真实代理出口验收。
