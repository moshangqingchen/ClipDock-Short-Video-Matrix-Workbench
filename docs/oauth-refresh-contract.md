# 国际 Token 刷新兑换合同

2026-09-08。`src/main/api/oauth-refresh.ts` 提供主进程 `OAuthTokenRefresher`，只返回尚未提交的 `GlobalTokenEnvelope`。本轮使用合成 transport 测试，没有兑换真实 Token、读取真实应用秘密或访问平台业务接口。

```ts
new OAuthTokenRefresher({ transport, readClientSecret, now }).refresh({
  token,
  app,
  signal,
  assertCurrent,
});
```

`transport` 必须显式提供 `ProxyTransport.request`。每次刷新只有一个固定 token 端点 POST，使用 `application/x-www-form-urlencoded`，不发送旧 access token，不发送 Cookie，不建立 Chromium Session，也没有默认 fetch、重试或授权浏览器跳转。账号、应用配置和网络许可的存续核对由调用方的同步 `assertCurrent` 提供；本模块在读取秘密与异步请求前后复核，并保留原 AbortSignal。数据库提交、每账号串行、Token 轮换的 CAS 与失败后的 UI 状态由调用方处理。

| 平台             | 固定端点与客户端合同                                                                                                        | 返回值处理                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube / Google | `https://oauth2.googleapis.com/token`；`client_id`、`refresh_token`、`grant_type=refresh_token`，桌面应用 secret 可选       | 未返回新 refresh token 时保留旧值；有 `refresh_token_expires_in` 才据实记录新刷新期限。见 [Google 桌面应用刷新说明](https://developers.google.com/identity/protocols/oauth2/native-app#refresh)。         |
| TikTok           | `https://open.tiktokapis.com/v2/oauth/token/`；`client_key` 与 `client_secret` 必需                                         | 必须返回相同 `open_id`、有效 refresh token 和 `refresh_expires_in`；轮换时使用新 token。见 [TikTok 用户 Token 管理](https://developers.tiktok.com/doc/oauth-user-access-token-management)。               |
| X                | `https://api.x.com/2/oauth2/token`；当前配置只支持 public client，用 `client_id`，不读取或发送 secret / Basic Authorization | 有轮换 token 时替换，省略时保留；不编造文档未提供的刷新到期时间。`offline.access` 仍是必需 scope。见 [X OAuth 2.0 刷新示例](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token)。 |

响应 scope 必须合法、去重，只能是原授权集合的子集，同时保留当前平台 profile 的必需项；不要求所有历史可选 scope 都留下。Google/X 省略 scope 时只继承原集合，不增加权限；TikTok 按其接口要求返回逗号分隔 scope。[RFC 6749 第 5.1、6 节](https://www.rfc-editor.org/rfc/rfc6749.html#section-6)规定刷新授权范围与可选新 refresh token 的处理。

主进程 v1 密文 envelope 兼容新增可选 `refreshExpiresAt`，它不是数据库明文列、IPC 字段或网络许可。旧 v1 仍可读取；TikTok 旧记录缺少明确刷新期限时要求重新授权，零 HTTP，不用固定 365 天反推原签发日期。Google/X 旧记录没有刷新期限时可提交一次官方刷新；一旦已有明确期限，发送前必须仍有效。请求与响应给出的相对时限均从实际请求开始计算，响应等待和回调不能延长期限；未返回新期限时保留原值。

固定错误均使用 `OAUTH_REFRESH_` 前缀：`REAUTH_REQUIRED` 用于缺少/已知过期 refresh 凭据及明确 `invalid_grant` / `invalid_token`；`RATE_LIMITED` 对应 HTTP 429；`NETWORK_UNAVAILABLE` 对应 transport 失败、5xx 或明确服务暂不可用。`invalid_client` / `unauthorized_client` 归为应用秘密不可用；未知 401/403、挑战 HTML 或错误 JSON 不自动宣称账号失效。错误不含原始响应、Token、secret 或 URL。所有错误都不会自行清空凭据或重试。

15:55 CST 的 50 项受控测试通过，覆盖三个固定请求、轮换与原期限、权限缩减/越界、TikTok 身份不变、旧数据不盲刷、秘密读取失败、请求中撤销、输入快照、状态分类和有界响应解析；Electron 类型检查和两文件 lint 通过。它验证客户端兑换行为，不代表真实开发者应用授权、平台配额或代理出口已经验收。
