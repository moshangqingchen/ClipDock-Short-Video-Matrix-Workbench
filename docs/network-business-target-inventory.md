# 六平台业务请求目标盘点

这是一份源码及已有实验的目标清单，供实际操作 scope 接入，不是新的总体计划或 DIRECT 许可目录。本次新增公网请求 **0**，没有打开生产账号，也没有改业务代码、平台注册表或用户规则。生成时间：2026-09-07T16:02:05.489Z。机器清单见 [network-business-target-inventory.json](network-business-target-inventory.json)。

确认 **38 个固定 collector 请求候选、6 个登录 probe 配置，合计涉及 7 个精确 API host，全部在既有 30 个观察种子内**。两轮匿名登录壳观察合计 **64 个平台/host 关联，56 个不在种子内**。这些观察额外资源、跳转分支与实际上传目标尚未成为已审核业务目录。

## 口径与来源

- “源码固定”表示程序会尝试该地址，不证明接口当前可用、该候选每次必需，或出口已经合格。[src/main/data/collectors/shared.ts:154](../src/main/data/collectors/shared.ts#L154) 的 fallback 按顺序尝试，休眠、撤销、任务取消、401 和限流不会继续试下一条。普通网络/解析失败可转下一个候选。
- 表中 URL 拆成精确 host、静态 path、query 键；不记录运行时 query 值、响应正文、Cookie 或 Token。同路径不同参数/body 的候选保留独立顺序和源码位置。HTTPS 默认 443，潜在 CORS OPTIONS 预检仍针对相同目标。
- “观察出现”包含被取消的尝试，allowed 只是实验允许发起，HTTP 200 也不能证明真实扫码、业务功能、依赖必要性或 DIRECT 出口。用途仅依据资源类型；没有凭主机名推定“登录必需”或“可忽略遥测”。
- 匿名实验未扫码、未过验证码、未进入认证后采集和实际上传。因此 QR 轮询、挑战分支、用户态 CDN、上传签名服务及完整重定向集合均未冻结。所有目标的 businessReviewed 均为 false。
- 源码行号及内容 SHA-256 放在 JSON sourceSnapshots，供后续源码变化时重新定位。运行观察是历史报告，不是本次采样；不能把报告生成时间当作原始 DNS 采样时间。

## 业务入口和传输上下文

| 入口 | 当前行为与目标来源 | 源码 |
| --- | --- | --- |
| 首次添加 / 打开 | 创建账号后打开 workspace，首次 ViewPool 加载 home；显式 login 只是另一个路由，不是唯一登录入口。 | [src/renderer/features/accounts/AddAccountModal.tsx:39](../src/renderer/features/accounts/AddAccountModal.tsx#L39)<br>[src/main/browser/view-pool.ts:130](../src/main/browser/view-pool.ts#L130)<br>[src/main/services/account-service.ts:159](../src/main/services/account-service.ts#L159)<br>[src/main/services/account-service.ts:178](../src/main/services/account-service.ts#L178) |
| 手动 / 活动 / 启动巡检 | 手动 checkStatus、页面活动防抖、启动 3 秒巡检、随后 5 分钟巡检都进入同一探测链；每账号巡检有错峰。 | [src/main/ipc/handlers/accounts.ts:20](../src/main/ipc/handlers/accounts.ts#L20)<br>[src/main/services/account-service.ts:195](../src/main/services/account-service.ts#L195)<br>[src/main/services/account-service.ts:443](../src/main/services/account-service.ts#L443)<br>[src/main/services/account-service.ts:454](../src/main/services/account-service.ts#L454) |
| 登录探测 | 有合格平台页时用页内 fetch；无页时按 probeFromMain 使用 gatedSessionFetch。探测最终 URL 可为平台登录重定向。 | [src/main/services/account-service.ts:221](../src/main/services/account-service.ts#L221)<br>[src/main/services/account-service.ts:295](../src/main/services/account-service.ts#L295)<br>[src/main/browser/login-detector.ts:222](../src/main/browser/login-detector.ts#L222)<br>[src/main/browser/login-detector.ts:242](../src/main/browser/login-detector.ts#L242)<br>[src/main/browser/login-detector.ts:107](../src/main/browser/login-detector.ts#L107) |
| 手动 / 事件 profile | refreshProfile 回调复用现有页或 pool.ensure(home)；account-online 会入采集队列，同时刷新 profile。两条调用链可能并发。 | [src/main/ipc/handlers/accounts.ts:21](../src/main/ipc/handlers/accounts.ts#L21)<br>[src/main/services/account-service.ts:404](../src/main/services/account-service.ts#L404)<br>[src/main/index.ts:189](../src/main/index.ts#L189)<br>[src/main/index.ts:254](../src/main/index.ts#L254) |
| 采集 / 指标 / 作品 | collector 全部通过 firstJson → pageJson → pageFetch，在账号页 fetch(credentials:include)。固定候选均为绝对 URL；页面包装 fetch 或加载额外资源仍属动态行为。 | [src/main/data/collectors/shared.ts:74](../src/main/data/collectors/shared.ts#L74)<br>[src/main/data/collectors/shared.ts:154](../src/main/data/collectors/shared.ts#L154) |
| keepalive | prepareView(forceNavigate=true) 后仍执行完整 collector.collect，包括 profile + works。可见同平台非登录页会保留，并非一定重新打开 home；loggedOut 结果会再 checkStatus。 | [src/main/data/scheduler.ts:279](../src/main/data/scheduler.ts#L279)<br>[src/main/data/scheduler.ts:288](../src/main/data/scheduler.ts#L288)<br>[src/main/data/scheduler.ts:494](../src/main/data/scheduler.ts#L494)<br>[src/main/data/scheduler.ts:292](../src/main/data/scheduler.ts#L292) |
| 发布助手 | 打开 upload 页面，用 DevTools 给 file input 附加本地文件。实际上传、分片、提交、授权 URL 由平台脚本选择，仓库没有对应固定 API。保存发布记录只写本地数据库。 | [src/main/services/publish-service.ts:51](../src/main/services/publish-service.ts#L51)<br>[src/main/services/publish-service.ts:57](../src/main/services/publish-service.ts#L57)<br>[src/main/services/publish-service.ts:116](../src/main/services/publish-service.ts#L116) |
| 任意导航 / 重定向 / popup | 用户地址、HTTP 重定向、window.open 可产生新精确 host。导航后缀白名单不等于目标许可，子框架及全部子资源依赖 Session 请求门闩。 | [src/main/ipc/handlers/views.ts:26](../src/main/ipc/handlers/views.ts#L26)<br>[src/main/browser/navigation-policy.ts:37](../src/main/browser/navigation-policy.ts#L37)<br>[src/main/browser/navigation-policy.ts:120](../src/main/browser/navigation-policy.ts#L120)<br>[src/main/browser/navigation-policy.ts:125](../src/main/browser/navigation-policy.ts#L125)<br>[src/main/network/session-observer.ts:66](../src/main/network/session-observer.ts#L66) |

## 抖音（douyin）

| 操作 | 精确初始目标或请求分组 |
| --- | --- |
| login | 首次 home：`creator.douyin.com/creator-micro/home`；显式 login：`creator.douyin.com/`。后续二维码/轮询/验证码/跳转尚未冻结。 |
| probe | GET `creator.douyin.com/web/api/media/user/info/`；probeFromMain=true（[src/shared/platforms.ts:152](../src/shared/platforms.ts#L152)）。已有页面时仍优先页内 probe。 |
| profile | `douyin.readProfile.1`；复用账号页或创建 home。 |
| metrics | `douyin.readProfile.1`、`douyin.readWorks.2`；profile + works 本地生成指标，没有独立 readMetrics。 |
| listWorks | `douyin.readWorks.2`；只是 collect 内部步骤，现有调度也会先读 profile。 |
| keepalive | `douyin.readProfile.1`、`douyin.readWorks.2`；按需准备 home，再执行完整采集，必要时转 probe。 |
| upload | `creator.douyin.com/creator-micro/content/upload`（[src/shared/platforms.ts:116](../src/shared/platforms.ts#L116)）；真正的上传 POST/分片/提交目标由页面生成。 |

固定 collector 候选：workingUrl=home（[src/main/data/collectors/douyin.ts:107](../src/main/data/collectors/douyin.ts#L107)），collect 实现 [src/main/data/collectors/douyin.ts:113](../src/main/data/collectors/douyin.ts#L113)。profile/works 是下面的分组编号，组内按顺序择首个符合 accept 的响应，不能把备选接口误写成每次全调用。

| 分组 / 候选顺序 | 方法与精确目标 | query / body 键 | 源码 |
| --- | --- | --- | --- |
| `douyin.readProfile.1` / 1 | GET `creator.douyin.com/web/api/media/user/info/` |  | [src/main/data/collectors/douyin.ts:34](../src/main/data/collectors/douyin.ts#L34) |
| `douyin.readProfile.1` / 2 | GET `creator.douyin.com/aweme/v1/creator/user/info/` |  | [src/main/data/collectors/douyin.ts:35](../src/main/data/collectors/douyin.ts#L35) |
| `douyin.readProfile.1` / 3 | GET `creator.douyin.com/web/api/creator/user/info/` |  | [src/main/data/collectors/douyin.ts:36](../src/main/data/collectors/douyin.ts#L36) |
| `douyin.readWorks.2` / 1 | GET `creator.douyin.com/web/api/media/aweme/post/` | query: `status`, `count`, `scene`, `max_cursor` | [src/main/data/collectors/douyin.ts:64](../src/main/data/collectors/douyin.ts#L64) |
| `douyin.readWorks.2` / 2 | GET `creator.douyin.com/web/api/media/aweme/post/` | query: `count`, `max_cursor` | [src/main/data/collectors/douyin.ts:65](../src/main/data/collectors/douyin.ts#L65) |
| `douyin.readWorks.2` / 3 | GET `creator.douyin.com/aweme/v1/creator/item/list/` | query: `count`, `cursor` | [src/main/data/collectors/douyin.ts:66](../src/main/data/collectors/douyin.ts#L66) |

概览不足时 collect 会 DOM 抓数（[src/main/data/collectors/douyin.ts:118](../src/main/data/collectors/douyin.ts#L118)），这一步读取当前 DOM，不新增固定网络端点；为该 DOM 加载资源的请求仍需单独覆盖。

页面元数据（可能被打开，不代表每次 API 操作都必须访问）：

| route | 精确目标 | 源码 |
| --- | --- | --- |
| home | `creator.douyin.com/creator-micro/home` | [src/shared/platforms.ts:113](../src/shared/platforms.ts#L113) |
| site | `www.douyin.com/` | [src/shared/platforms.ts:114](../src/shared/platforms.ts#L114) |
| login | `creator.douyin.com/` | [src/shared/platforms.ts:115](../src/shared/platforms.ts#L115) |
| upload | `creator.douyin.com/creator-micro/content/upload` | [src/shared/platforms.ts:116](../src/shared/platforms.ts#L116) |
| analytics | `creator.douyin.com/creator-micro/data-center/content` | [src/shared/platforms.ts:117](../src/shared/platforms.ts#L117) |
| works | `creator.douyin.com/creator-micro/content/manage` | [src/shared/platforms.ts:118](../src/shared/platforms.ts#L118) |
| comments | `creator.douyin.com/creator-micro/interaction/comment` | [src/shared/platforms.ts:119](../src/shared/platforms.ts#L119) |

现有种子 5 个：`creator.douyin.com`、`www.douyin.com`、`verify.snssdk.com`〔验证码候选〕、`verify.zijieapi.com`〔验证码候选〕、`rmc.bytedance.com`〔验证码候选〕。固定 collector/probe 的 host 缺漏：**无**。

种子里未在这两轮匿名壳观察出现：`www.douyin.com`、`verify.snssdk.com`、`verify.zijieapi.com`、`rmc.bytedance.com`。未出现不是“不会使用”的证明。

观察出现、种子缺少的精确 host（全部未获业务审核；详情和每一行 JSON Pointer 见机器清单）：

| host | 样本资源类型 | 历史状态 / 取消次数 | 官方精确静态引用 |
| --- | --- | --- | --- |
| `auth.zijieapi.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `lf-c-flwb.bytetos.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `lf-fe-creator.douyinstatic.com` | script, stylesheet | HTTP 200；取消 0 次 | 未作此项审核 |
| `lf-security.bytegoofy.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `lf-ucenter-web.yhgfb-cn-static.com` | script | 无完成状态；取消 9 次 | 未作此项审核 |
| `lf-zt.douyin.com` | subFrame | HTTP 200；取消 0 次 | 未作此项审核 |
| `lf1-cdn-tos.bytegoofy.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `lf3-config.bytetcc.com` | xhr | 无完成状态；取消 1 次 | 未作此项审核 |
| `lf3-short.ibytedapm.com` | script | HTTP 200；取消 1 次 | 已证精确引用；仅匿名静态诊断审核 |
| `lf3-static.bytednsdoc.com` | image | 无完成状态；取消 2 次 | 未作此项审核 |
| `mcs.snssdk.com` | xhr | 无完成状态；取消 1 次 | 未作此项审核 |
| `mon.zijieapi.com` | ping, xhr | 无完成状态；取消 7 次 | 未作此项审核 |
| `mssdk.bytedance.com` | xhr | 无完成状态；取消 4 次 | 未作此项审核 |
| `unpkg.byted-static.com` | script | HTTP 200；取消 4 次 | 已证精确引用；仅匿名静态诊断审核 |

API 响应里的动态地址：

- avatarUrl：响应字段 `avatar_thumb`、`avatar_medium`、`avatar_larger`、`avatar`、`avatar_url`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/douyin.ts:48](../src/main/data/collectors/douyin.ts#L48)）。
- coverUrl：响应字段 `video.cover`、`video.origin_cover`、`cover`、`video.dynamic_cover`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/douyin.ts:87](../src/main/data/collectors/douyin.ts#L87)）。
- url：`www.douyin.com/video/{remoteId}`，只保存 Work.url，不由 collector 请求（[src/main/data/collectors/douyin.ts:90](../src/main/data/collectors/douyin.ts#L90)）。

## 快手（kuaishou）

| 操作 | 精确初始目标或请求分组 |
| --- | --- |
| login | 首次 home：`cp.kuaishou.com/profile`；显式 login：`cp.kuaishou.com/`。后续二维码/轮询/验证码/跳转尚未冻结。 |
| probe | POST `cp.kuaishou.com/rest/cp/creator/pc/home/infoV2`；probeFromMain=false（[src/shared/platforms.ts:199](../src/shared/platforms.ts#L199)）。已有页面时仍优先页内 probe。 |
| profile | `kuaishou.readProfile.1`；复用账号页或创建 home。 |
| metrics | `kuaishou.readProfile.1`、`kuaishou.readWorks.2`；profile + works 本地生成指标，没有独立 readMetrics。 |
| listWorks | `kuaishou.readWorks.2`；只是 collect 内部步骤，现有调度也会先读 profile。 |
| keepalive | `kuaishou.readProfile.1`、`kuaishou.readWorks.2`；按需准备 home，再执行完整采集，必要时转 probe。 |
| upload | `cp.kuaishou.com/article/publish/video`（[src/shared/platforms.ts:171](../src/shared/platforms.ts#L171)）；真正的上传 POST/分片/提交目标由页面生成。 |

固定 collector 候选：workingUrl=home（[src/main/data/collectors/kuaishou.ts:123](../src/main/data/collectors/kuaishou.ts#L123)），collect 实现 [src/main/data/collectors/kuaishou.ts:129](../src/main/data/collectors/kuaishou.ts#L129)。profile/works 是下面的分组编号，组内按顺序择首个符合 accept 的响应，不能把备选接口误写成每次全调用。

| 分组 / 候选顺序 | 方法与精确目标 | query / body 键 | 源码 |
| --- | --- | --- | --- |
| `kuaishou.readProfile.1` / 1 | POST `cp.kuaishou.com/rest/cp/creator/pc/home/infoV2` |  | [src/main/data/collectors/kuaishou.ts:31](../src/main/data/collectors/kuaishou.ts#L31) |
| `kuaishou.readProfile.1` / 2 | POST `cp.kuaishou.com/rest/cp/creator/pc/home/info` |  | [src/main/data/collectors/kuaishou.ts:35](../src/main/data/collectors/kuaishou.ts#L35) |
| `kuaishou.readProfile.1` / 3 | GET `cp.kuaishou.com/rest/pc/creator/user/info` |  | [src/main/data/collectors/kuaishou.ts:38](../src/main/data/collectors/kuaishou.ts#L38) |
| `kuaishou.readProfile.1` / 4 | POST `cp.kuaishou.com/rest/cp/creator/pc/user/info` |  | [src/main/data/collectors/kuaishou.ts:40](../src/main/data/collectors/kuaishou.ts#L40) |
| `kuaishou.readWorks.2` / 1 | POST `cp.kuaishou.com/rest/cp/works/v2/video/pc/photo/list` | body: `pcursor`, `count`, `status`, `sortType`, `keyword` | [src/main/data/collectors/kuaishou.ts:80](../src/main/data/collectors/kuaishou.ts#L80) |
| `kuaishou.readWorks.2` / 2 | GET `cp.kuaishou.com/rest/cp/works/v2/video/pc/photo/list` | query: `pcursor`, `count` | [src/main/data/collectors/kuaishou.ts:84](../src/main/data/collectors/kuaishou.ts#L84) |
| `kuaishou.readWorks.2` / 3 | POST `cp.kuaishou.com/rest/pc/works/photo/list` | body: `pcursor`, `count`, `status`, `sortType`, `keyword` | [src/main/data/collectors/kuaishou.ts:87](../src/main/data/collectors/kuaishou.ts#L87) |

概览不足时 collect 会 DOM 抓数（[src/main/data/collectors/kuaishou.ts:134](../src/main/data/collectors/kuaishou.ts#L134)），这一步读取当前 DOM，不新增固定网络端点；为该 DOM 加载资源的请求仍需单独覆盖。

页面元数据（可能被打开，不代表每次 API 操作都必须访问）：

| route | 精确目标 | 源码 |
| --- | --- | --- |
| home | `cp.kuaishou.com/profile` | [src/shared/platforms.ts:168](../src/shared/platforms.ts#L168) |
| site | `www.kuaishou.com/` | [src/shared/platforms.ts:169](../src/shared/platforms.ts#L169) |
| login | `cp.kuaishou.com/` | [src/shared/platforms.ts:170](../src/shared/platforms.ts#L170) |
| upload | `cp.kuaishou.com/article/publish/video` | [src/shared/platforms.ts:171](../src/shared/platforms.ts#L171) |
| analytics | `cp.kuaishou.com/analysis/works` | [src/shared/platforms.ts:172](../src/shared/platforms.ts#L172) |
| works | `cp.kuaishou.com/article/manage/video` | [src/shared/platforms.ts:173](../src/shared/platforms.ts#L173) |
| comments | `cp.kuaishou.com/interaction/comment` | [src/shared/platforms.ts:174](../src/shared/platforms.ts#L174) |

现有种子 5 个：`cp.kuaishou.com`、`www.kuaishou.com`、`captcha.zt.kuaishou.com`〔验证码候选〕、`captcha.kuaishou.com`〔验证码候选〕、`sec.kuaishou.com`〔验证码候选〕。固定 collector/probe 的 host 缺漏：**无**。

种子里未在这两轮匿名壳观察出现：`www.kuaishou.com`、`captcha.zt.kuaishou.com`、`captcha.kuaishou.com`、`sec.kuaishou.com`。未出现不是“不会使用”的证明。

历史 DNS A/AAAA 均 NXDOMAIN 的候选：`captcha.kuaishou.com`、`sec.kuaishou.com`。它们属于 verificationHosts，未出现在固定 profile/listWorks 调用。本次没有复查，不直接删除，也不作为所有业务操作必须连通的目标。

观察出现、种子缺少的精确 host（全部未获业务审核；详情和每一行 JSON Pointer 见机器清单）：

| host | 样本资源类型 | 历史状态 / 取消次数 | 官方精确静态引用 |
| --- | --- | --- | --- |
| `gdfp.gifshow.com` | xhr | 无完成状态；取消 3 次 | 未作此项审核 |
| `log-sdk.ksapisrv.com` | ping, xhr | 无完成状态；取消 8 次 | 未作此项审核 |
| `p1-plat.wsbkwai.com` | image, script, stylesheet | 无完成状态；取消 7 次 | 未作此项审核 |
| `p1-plat.wskwai.com` | script, stylesheet | 无完成状态；取消 10 次 | 未作此项审核 |
| `p2-plat.wsbkwai.com` | script, stylesheet | 无完成状态；取消 4 次 | 未作此项审核 |
| `p2-plat.wskwai.com` | script, stylesheet | 无完成状态；取消 5 次 | 已证精确引用；仅匿名静态诊断审核 |
| `p23-plat.wsbkwai.com` | image, script, stylesheet | 无完成状态；取消 5 次 | 未作此项审核 |
| `p23-plat.wskwai.com` | image, script, stylesheet | 无完成状态；取消 8 次 | 未作此项审核 |
| `p3-plat.wsbkwai.com` | stylesheet | 无完成状态；取消 2 次 | 未作此项审核 |
| `p3-plat.wskwai.com` | script, stylesheet | 无完成状态；取消 3 次 | 未作此项审核 |
| `p4-plat.wsbkwai.com` | image, script, stylesheet | 无完成状态；取消 9 次 | 未作此项审核 |
| `p5-plat.wsbkwai.com` | stylesheet | 无完成状态；取消 1 次 | 未作此项审核 |
| `p5-plat.wskwai.com` | image, script, stylesheet | 无完成状态；取消 9 次 | 未作此项审核 |
| `p66-plat.wsbkwai.com` | script, stylesheet | 无完成状态；取消 2 次 | 未作此项审核 |
| `p66-plat.wskwai.com` | image, script, stylesheet | HTTP 200；取消 13 次 | 已证精确引用；仅匿名静态诊断审核 |
| `static.yximgs.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |

API 响应里的动态地址：

- avatarUrl：响应字段 `headUrl`、`avatar`、`headUrls`、`userHead`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/kuaishou.ts:51](../src/main/data/collectors/kuaishou.ts#L51)）。
- coverUrl：响应字段 `coverUrl`、`cover`、`coverUrls`、`thumbnailUrl`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/kuaishou.ts:105](../src/main/data/collectors/kuaishou.ts#L105)）。
- url：`www.kuaishou.com/short-video/{remoteId}`，只保存 Work.url，不由 collector 请求（[src/main/data/collectors/kuaishou.ts:106](../src/main/data/collectors/kuaishou.ts#L106)）。

## 小红书（xiaohongshu）

| 操作 | 精确初始目标或请求分组 |
| --- | --- |
| login | 首次 home：`creator.xiaohongshu.com/new/home`；显式 login：`creator.xiaohongshu.com/login`。后续二维码/轮询/验证码/跳转尚未冻结。 |
| probe | GET `creator.xiaohongshu.com/api/galaxy/user/info`；probeFromMain=false（[src/shared/platforms.ts:249](../src/shared/platforms.ts#L249)）。已有页面时仍优先页内 probe。 |
| profile | `xiaohongshu.readProfile.1`、`xiaohongshu.readProfile.2`；复用账号页或创建 home。 |
| metrics | `xiaohongshu.readProfile.1`、`xiaohongshu.readProfile.2`、`xiaohongshu.readWorks.3`；profile + works 本地生成指标，没有独立 readMetrics。 |
| listWorks | `xiaohongshu.readWorks.3`；只是 collect 内部步骤，现有调度也会先读 profile。 |
| keepalive | `xiaohongshu.readProfile.1`、`xiaohongshu.readProfile.2`、`xiaohongshu.readWorks.3`；按需准备 home，再执行完整采集，必要时转 probe。 |
| upload | `creator.xiaohongshu.com/publish/publish`（[src/shared/platforms.ts:219](../src/shared/platforms.ts#L219)）；真正的上传 POST/分片/提交目标由页面生成。 |

固定 collector 候选：workingUrl=home（[src/main/data/collectors/xiaohongshu.ts:127](../src/main/data/collectors/xiaohongshu.ts#L127)），collect 实现 [src/main/data/collectors/xiaohongshu.ts:133](../src/main/data/collectors/xiaohongshu.ts#L133)。profile/works 是下面的分组编号，组内按顺序择首个符合 accept 的响应，不能把备选接口误写成每次全调用。

| 分组 / 候选顺序 | 方法与精确目标 | query / body 键 | 源码 |
| --- | --- | --- | --- |
| `xiaohongshu.readProfile.1` / 1 | GET `creator.xiaohongshu.com/api/galaxy/user/info` |  | [src/main/data/collectors/xiaohongshu.ts:36](../src/main/data/collectors/xiaohongshu.ts#L36) |
| `xiaohongshu.readProfile.1` / 2 | GET `creator.xiaohongshu.com/api/galaxy/creator/user/info` |  | [src/main/data/collectors/xiaohongshu.ts:37](../src/main/data/collectors/xiaohongshu.ts#L37) |
| `xiaohongshu.readProfile.2` / 1 | GET `creator.xiaohongshu.com/api/galaxy/creator/home/personal_info` |  | [src/main/data/collectors/xiaohongshu.ts:44](../src/main/data/collectors/xiaohongshu.ts#L44) |
| `xiaohongshu.readProfile.2` / 2 | GET `creator.xiaohongshu.com/api/galaxy/creator/data/home/overview` |  | [src/main/data/collectors/xiaohongshu.ts:45](../src/main/data/collectors/xiaohongshu.ts#L45) |
| `xiaohongshu.readProfile.2` / 3 | GET `creator.xiaohongshu.com/api/galaxy/creator/home/data` |  | [src/main/data/collectors/xiaohongshu.ts:46](../src/main/data/collectors/xiaohongshu.ts#L46) |
| `xiaohongshu.readWorks.3` / 1 | GET `creator.xiaohongshu.com/api/galaxy/creator/note/user/posted` | query: `tab`, `page`, `pageSize` | [src/main/data/collectors/xiaohongshu.ts:83](../src/main/data/collectors/xiaohongshu.ts#L83) |
| `xiaohongshu.readWorks.3` / 2 | GET `creator.xiaohongshu.com/api/galaxy/creator/note/user/posted` | query: `tab`, `page` | [src/main/data/collectors/xiaohongshu.ts:86](../src/main/data/collectors/xiaohongshu.ts#L86) |
| `xiaohongshu.readWorks.3` / 3 | GET `creator.xiaohongshu.com/api/galaxy/creator/notes` | query: `page`, `page_size` | [src/main/data/collectors/xiaohongshu.ts:87](../src/main/data/collectors/xiaohongshu.ts#L87) |

前两组 readProfile 并行：身份信息一组，概览指标一组；组内才是 fallback。readWorks 随后在 collect 中调用。
概览不足时 collect 会 DOM 抓数（[src/main/data/collectors/xiaohongshu.ts:138](../src/main/data/collectors/xiaohongshu.ts#L138)），这一步读取当前 DOM，不新增固定网络端点；为该 DOM 加载资源的请求仍需单独覆盖。

页面元数据（可能被打开，不代表每次 API 操作都必须访问）：

| route | 精确目标 | 源码 |
| --- | --- | --- |
| home | `creator.xiaohongshu.com/new/home` | [src/shared/platforms.ts:216](../src/shared/platforms.ts#L216) |
| site | `www.xiaohongshu.com/explore` | [src/shared/platforms.ts:217](../src/shared/platforms.ts#L217) |
| login | `creator.xiaohongshu.com/login` | [src/shared/platforms.ts:218](../src/shared/platforms.ts#L218) |
| upload | `creator.xiaohongshu.com/publish/publish` | [src/shared/platforms.ts:219](../src/shared/platforms.ts#L219) |
| analytics | `creator.xiaohongshu.com/statistics/data-analysis` | [src/shared/platforms.ts:220](../src/shared/platforms.ts#L220) |
| works | `creator.xiaohongshu.com/new/note-manager` | [src/shared/platforms.ts:221](../src/shared/platforms.ts#L221) |
| comments | `creator.xiaohongshu.com/creator/comment` | [src/shared/platforms.ts:222](../src/shared/platforms.ts#L222) |

现有种子 2 个：`creator.xiaohongshu.com`、`www.xiaohongshu.com`。固定 collector/probe 的 host 缺漏：**无**。

种子里未在这两轮匿名壳观察出现：`www.xiaohongshu.com`。未出现不是“不会使用”的证明。

观察出现、种子缺少的精确 host（全部未获业务审核；详情和每一行 JSON Pointer 见机器清单）：

| host | 样本资源类型 | 历史状态 / 取消次数 | 官方精确静态引用 |
| --- | --- | --- | --- |
| `apm-fe.xiaohongshu.com` | xhr | 无完成状态；取消 50 次 | 未作此项审核 |
| `as.xiaohongshu.com` | xhr | 无完成状态；取消 13 次 | 未作此项审核 |
| `customer.xiaohongshu.com` | xhr | 无完成状态；取消 2 次 | 未作此项审核 |
| `edith.xiaohongshu.com` | xhr | 无完成状态；取消 3 次 | 未作此项审核 |
| `fe-platform.xhscdn.com` | xhr | 无完成状态；取消 3 次 | 未作此项审核 |
| `fe-static.xhscdn.com` | image, script, stylesheet | HTTP 200；取消 0 次 | 未作此项审核 |
| `fe-video-qc.xhscdn.com` | media, script | HTTP 200；取消 7 次 | 未作此项审核 |

API 响应里的动态地址：

- avatarUrl：响应字段 `userAvatar`、`avatar`、`image`、`images`、`userDetail.avatar`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/xiaohongshu.ts:57](../src/main/data/collectors/xiaohongshu.ts#L57)）。
- coverUrl：响应字段 `images_list.0.url`、`cover.url`、`cover`、`image`、`images_list`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/xiaohongshu.ts:106](../src/main/data/collectors/xiaohongshu.ts#L106)）。
- url：`www.xiaohongshu.com/explore/{remoteId}`，只保存 Work.url，不由 collector 请求（[src/main/data/collectors/xiaohongshu.ts:109](../src/main/data/collectors/xiaohongshu.ts#L109)）。

## 哔哩哔哩（bilibili）

| 操作 | 精确初始目标或请求分组 |
| --- | --- |
| login | 首次 home：`member.bilibili.com/platform/home`；显式 login：`passport.bilibili.com/login`（query 键 `gourl`）。后续二维码/轮询/验证码/跳转尚未冻结。 |
| probe | GET `api.bilibili.com/x/web-interface/nav`；probeFromMain=true（[src/shared/platforms.ts:299](../src/shared/platforms.ts#L299)）。已有页面时仍优先页内 probe。 |
| profile | `bilibili.readProfile.1`、`bilibili.readProfile.2`、`bilibili.readProfile.3`；复用账号页或创建 home。 |
| metrics | `bilibili.readProfile.1`、`bilibili.readProfile.2`、`bilibili.readProfile.3`、`bilibili.readWorks.4`；profile + works 本地生成指标，没有独立 readMetrics。 |
| listWorks | `bilibili.readWorks.4`；只是 collect 内部步骤，现有调度也会先读 profile。 |
| keepalive | `bilibili.readProfile.1`、`bilibili.readProfile.2`、`bilibili.readProfile.3`、`bilibili.readWorks.4`；按需准备 home，再执行完整采集，必要时转 probe。 |
| upload | `member.bilibili.com/platform/upload/video/frame`（[src/shared/platforms.ts:268](../src/shared/platforms.ts#L268)）；真正的上传 POST/分片/提交目标由页面生成。 |

固定 collector 候选：workingUrl=home（[src/main/data/collectors/bilibili.ts:96](../src/main/data/collectors/bilibili.ts#L96)），collect 实现 [src/main/data/collectors/bilibili.ts:107](../src/main/data/collectors/bilibili.ts#L107)。profile/works 是下面的分组编号，组内按顺序择首个符合 accept 的响应，不能把备选接口误写成每次全调用。

| 分组 / 候选顺序 | 方法与精确目标 | query / body 键 | 源码 |
| --- | --- | --- | --- |
| `bilibili.readProfile.1` / 1 | GET `api.bilibili.com/x/web-interface/nav` |  | [src/main/data/collectors/bilibili.ts:27](../src/main/data/collectors/bilibili.ts#L27) |
| `bilibili.readProfile.2` / 1 | GET `api.bilibili.com/x/web-interface/nav/stat` |  | [src/main/data/collectors/bilibili.ts:35](../src/main/data/collectors/bilibili.ts#L35) |
| `bilibili.readProfile.3` / 1 | GET `api.bilibili.com/x/space/upstat` | query: `mid` | [src/main/data/collectors/bilibili.ts:39](../src/main/data/collectors/bilibili.ts#L39) |
| `bilibili.readWorks.4` / 1 | GET `member.bilibili.com/x/web/archives` | query: `status`, `pn`, `ps`, `coop`, `interactive` | [src/main/data/collectors/bilibili.ts:60](../src/main/data/collectors/bilibili.ts#L60) |
| `bilibili.readWorks.4` / 2 | GET `member.bilibili.com/x/web/archives` | query: `status`, `pn`, `ps` | [src/main/data/collectors/bilibili.ts:61](../src/main/data/collectors/bilibili.ts#L61) |

readProfile 第 1 组先读 nav；成功后第 2 组 nav/stat 与第 3 组 upstat 并行，upstat 仅在 nav 返回非空 mid 时调用，mid 仅作为动态 query 值。readWorks 使用 member.bilibili.com，与 profile 的 api.bilibili.com 是两个目标。

页面元数据（可能被打开，不代表每次 API 操作都必须访问）：

| route | 精确目标 | 源码 |
| --- | --- | --- |
| home | `member.bilibili.com/platform/home` | [src/shared/platforms.ts:265](../src/shared/platforms.ts#L265) |
| site | `www.bilibili.com/` | [src/shared/platforms.ts:266](../src/shared/platforms.ts#L266) |
| login | `passport.bilibili.com/login`（query 键 `gourl`） | [src/shared/platforms.ts:267](../src/shared/platforms.ts#L267) |
| upload | `member.bilibili.com/platform/upload/video/frame` | [src/shared/platforms.ts:268](../src/shared/platforms.ts#L268) |
| analytics | `member.bilibili.com/platform/data-up/video/overview` | [src/shared/platforms.ts:269](../src/shared/platforms.ts#L269) |
| works | `member.bilibili.com/platform/upload-manager/article` | [src/shared/platforms.ts:270](../src/shared/platforms.ts#L270) |
| comments | `member.bilibili.com/platform/comment/article` | [src/shared/platforms.ts:271](../src/shared/platforms.ts#L271) |

现有种子 9 个：`passport.bilibili.com`、`member.bilibili.com`、`www.bilibili.com`、`api.bilibili.com`、`static.geetest.com`〔验证码候选〕、`api.geetest.com`〔验证码候选〕、`gcaptcha4.geetest.com`〔验证码候选〕、`geetest.com`〔验证码候选〕、`gt4.geetest.com`〔验证码候选〕。固定 collector/probe 的 host 缺漏：**无**。

种子里未在这两轮匿名壳观察出现：`member.bilibili.com`、`www.bilibili.com`、`static.geetest.com`、`api.geetest.com`、`gcaptcha4.geetest.com`、`geetest.com`、`gt4.geetest.com`。未出现不是“不会使用”的证明。

观察出现、种子缺少的精确 host（全部未获业务审核；详情和每一行 JSON Pointer 见机器清单）：

| host | 样本资源类型 | 历史状态 / 取消次数 | 官方精确静态引用 |
| --- | --- | --- | --- |
| `i0.hdslb.com` | xhr | 无完成状态；取消 1 次 | 未作此项审核 |
| `s1.hdslb.com` | image, script, stylesheet, subFrame | HTTP 200；取消 0 次 | 未作此项审核 |

API 响应里的动态地址：

- avatarUrl：响应字段 `nav.data.face`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/bilibili.ts:46](../src/main/data/collectors/bilibili.ts#L46)）。
- coverUrl：响应字段 `archive.cover`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/bilibili.ts:78](../src/main/data/collectors/bilibili.ts#L78)）。
- url：`www.bilibili.com/video/{remoteId}`，只保存 Work.url，不由 collector 请求（[src/main/data/collectors/bilibili.ts:79](../src/main/data/collectors/bilibili.ts#L79)）。

## 百度百家号（baijiahao）

| 操作 | 精确初始目标或请求分组 |
| --- | --- |
| login | 首次 home：`baijiahao.baidu.com/builder/rc/home`；显式 login：`baijiahao.baidu.com/builder/theme/bjh/login`。后续二维码/轮询/验证码/跳转尚未冻结。 |
| probe | GET `baijiahao.baidu.com/builder/app/appinfo`；probeFromMain=true（[src/shared/platforms.ts:342](../src/shared/platforms.ts#L342)）。已有页面时仍优先页内 probe。 |
| profile | `baijiahao.readProfile.1`、`baijiahao.readProfile.2`；复用账号页或创建 home。 |
| metrics | `baijiahao.readProfile.1`、`baijiahao.readProfile.2`、`baijiahao.readWorks.3`；profile + works 本地生成指标，没有独立 readMetrics。 |
| listWorks | `baijiahao.readWorks.3`；只是 collect 内部步骤，现有调度也会先读 profile。 |
| keepalive | `baijiahao.readProfile.1`、`baijiahao.readProfile.2`、`baijiahao.readWorks.3`；按需准备 home，再执行完整采集，必要时转 probe。 |
| upload | `baijiahao.baidu.com/builder/rc/edit`（query 键 `type`）（[src/shared/platforms.ts:317](../src/shared/platforms.ts#L317)）；真正的上传 POST/分片/提交目标由页面生成。 |

固定 collector 候选：workingUrl=home（[src/main/data/collectors/baijiahao.ts:118](../src/main/data/collectors/baijiahao.ts#L118)），collect 实现 [src/main/data/collectors/baijiahao.ts:124](../src/main/data/collectors/baijiahao.ts#L124)。profile/works 是下面的分组编号，组内按顺序择首个符合 accept 的响应，不能把备选接口误写成每次全调用。

| 分组 / 候选顺序 | 方法与精确目标 | query / body 键 | 源码 |
| --- | --- | --- | --- |
| `baijiahao.readProfile.1` / 1 | GET `baijiahao.baidu.com/builder/app/appinfo` |  | [src/main/data/collectors/baijiahao.ts:34](../src/main/data/collectors/baijiahao.ts#L34) |
| `baijiahao.readProfile.1` / 2 | GET `baijiahao.baidu.com/pcui/user/getinfo` |  | [src/main/data/collectors/baijiahao.ts:35](../src/main/data/collectors/baijiahao.ts#L35) |
| `baijiahao.readProfile.1` / 3 | GET `baijiahao.baidu.com/builder/author/appinfo` |  | [src/main/data/collectors/baijiahao.ts:36](../src/main/data/collectors/baijiahao.ts#L36) |
| `baijiahao.readProfile.2` / 1 | GET `baijiahao.baidu.com/builder/author/statistic/overview` |  | [src/main/data/collectors/baijiahao.ts:43](../src/main/data/collectors/baijiahao.ts#L43) |
| `baijiahao.readProfile.2` / 2 | GET `baijiahao.baidu.com/pcui/statistic/overview` |  | [src/main/data/collectors/baijiahao.ts:44](../src/main/data/collectors/baijiahao.ts#L44) |
| `baijiahao.readProfile.2` / 3 | GET `baijiahao.baidu.com/builder/author/data/overview` |  | [src/main/data/collectors/baijiahao.ts:45](../src/main/data/collectors/baijiahao.ts#L45) |
| `baijiahao.readWorks.3` / 1 | GET `baijiahao.baidu.com/pcui/article/lists` | query: `type`, `collection`, `pageSize`, `currentPage` | [src/main/data/collectors/baijiahao.ts:80](../src/main/data/collectors/baijiahao.ts#L80) |
| `baijiahao.readWorks.3` / 2 | GET `baijiahao.baidu.com/pcui/article/lists` | query: `type`, `collection`, `pageSize`, `currentPage` | [src/main/data/collectors/baijiahao.ts:81](../src/main/data/collectors/baijiahao.ts#L81) |
| `baijiahao.readWorks.3` / 3 | GET `baijiahao.baidu.com/builder/author/article/list` | query: `type`, `page`, `size` | [src/main/data/collectors/baijiahao.ts:82](../src/main/data/collectors/baijiahao.ts#L82) |

前两组 readProfile 并行：身份信息一组，概览指标一组；组内才是 fallback。readWorks 随后在 collect 中调用。
概览不足时 collect 会 DOM 抓数（[src/main/data/collectors/baijiahao.ts:129](../src/main/data/collectors/baijiahao.ts#L129)），这一步读取当前 DOM，不新增固定网络端点；为该 DOM 加载资源的请求仍需单独覆盖。

页面元数据（可能被打开，不代表每次 API 操作都必须访问）：

| route | 精确目标 | 源码 |
| --- | --- | --- |
| home | `baijiahao.baidu.com/builder/rc/home` | [src/shared/platforms.ts:315](../src/shared/platforms.ts#L315) |
| login | `baijiahao.baidu.com/builder/theme/bjh/login` | [src/shared/platforms.ts:316](../src/shared/platforms.ts#L316) |
| upload | `baijiahao.baidu.com/builder/rc/edit`（query 键 `type`） | [src/shared/platforms.ts:317](../src/shared/platforms.ts#L317) |
| analytics | `baijiahao.baidu.com/builder/rc/statistics/content` | [src/shared/platforms.ts:318](../src/shared/platforms.ts#L318) |
| works | `baijiahao.baidu.com/builder/rc/content`（query 键 `type`） | [src/shared/platforms.ts:319](../src/shared/platforms.ts#L319) |
| comments | `baijiahao.baidu.com/builder/rc/interaction/comment` | [src/shared/platforms.ts:320](../src/shared/platforms.ts#L320) |

现有种子 2 个：`baijiahao.baidu.com`、`wappass.baidu.com`〔验证码候选〕。固定 collector/probe 的 host 缺漏：**无**。

种子里未在这两轮匿名壳观察出现：无。未出现不是“不会使用”的证明。

观察出现、种子缺少的精确 host（全部未获业务审核；详情和每一行 JSON Pointer 见机器清单）：

| host | 样本资源类型 | 历史状态 / 取消次数 | 官方精确静态引用 |
| --- | --- | --- | --- |
| `code.bdstatic.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `h2tcbox.baidu.com` | image | 无完成状态；取消 0 次 | 未作此项审核 |
| `hercules.cdn.bcebos.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `now.bdstatic.com` | script, stylesheet | HTTP 200；取消 0 次 | 未作此项审核 |
| `nsclick.baidu.com` | image | 无完成状态；取消 0 次 | 未作此项审核 |
| `passport.baidu.com` | script, stylesheet, xhr | HTTP 200；取消 5 次 | 未作此项审核 |
| `pic.rmb.bdstatic.com` | font, image, media, script, xhr | HTTP 200；取消 15 次 | 未作此项审核 |
| `ppui-static-pc.cdn.bcebos.com` | image, script, stylesheet | HTTP 200；取消 0 次 | 未作此项审核 |
| `ppui-static-wap.cdn.bcebos.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `ttl-bjh.baidu.com` | image | HTTP 200；取消 0 次 | 未作此项审核 |
| `xlab.baidu.com` | ping, xhr | 无完成状态；取消 4 次 | 未作此项审核 |

API 响应里的动态地址：

- avatarUrl：响应字段 `avatar`、`avatar_url`、`logo`、`head_img`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/baijiahao.ts:56](../src/main/data/collectors/baijiahao.ts#L56)）。
- coverUrl：响应字段 `cover_images.0.src`、`cover_images.0`、`cover_url`、`cover`、`thumb`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/baijiahao.ts:97](../src/main/data/collectors/baijiahao.ts#L97)）。
- url：从响应 url / share_url / article_url 取值，host 不固定，只保存元数据（[src/main/data/collectors/baijiahao.ts:100](../src/main/data/collectors/baijiahao.ts#L100)）。

## 微信视频号（weixin_channels）

| 操作 | 精确初始目标或请求分组 |
| --- | --- |
| login | 首次 home：`channels.weixin.qq.com/platform`；显式 login：`channels.weixin.qq.com/login.html`。后续二维码/轮询/验证码/跳转尚未冻结。 |
| probe | POST `channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data`；probeFromMain=true（[src/shared/platforms.ts:394](../src/shared/platforms.ts#L394)）。已有页面时仍优先页内 probe。 |
| profile | `weixin_channels.readProfile.1`；复用账号页或创建 home。 |
| metrics | `weixin_channels.readProfile.1`、`weixin_channels.readWorks.2`；profile + works 本地生成指标，没有独立 readMetrics。 |
| listWorks | `weixin_channels.readWorks.2`；只是 collect 内部步骤，现有调度也会先读 profile。 |
| keepalive | `weixin_channels.readProfile.1`、`weixin_channels.readWorks.2`；按需准备 home，再执行完整采集，必要时转 probe。 |
| upload | `channels.weixin.qq.com/platform/post/create`（[src/shared/platforms.ts:360](../src/shared/platforms.ts#L360)）；真正的上传 POST/分片/提交目标由页面生成。 |

固定 collector 候选：workingUrl=home（[src/main/data/collectors/weixin-channels.ts:119](../src/main/data/collectors/weixin-channels.ts#L119)），collect 实现 [src/main/data/collectors/weixin-channels.ts:130](../src/main/data/collectors/weixin-channels.ts#L130)。profile/works 是下面的分组编号，组内按顺序择首个符合 accept 的响应，不能把备选接口误写成每次全调用。

| 分组 / 候选顺序 | 方法与精确目标 | query / body 键 | 源码 |
| --- | --- | --- | --- |
| `weixin_channels.readProfile.1` / 1 | POST `channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data` | body: `timestamp`, `_log_finder_uin`, `_log_finder_id`, `rawKeyBuff`, `pluginSessionId`, `scene`, `reqScene` | [src/main/data/collectors/weixin-channels.ts:45](../src/main/data/collectors/weixin-channels.ts#L45) |
| `weixin_channels.readWorks.2` / 1 | POST `channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/post/post_list` | body: `timestamp`, `_log_finder_uin`, `_log_finder_id`, `rawKeyBuff`, `pluginSessionId`, `scene`, `reqScene`, `pageSize`, `currentPage`, `onlyUnread`, `userpageType`, `needAllCommentCount` | [src/main/data/collectors/weixin-channels.ts:67](../src/main/data/collectors/weixin-channels.ts#L67) |
| `weixin_channels.readWorks.2` / 2 | POST `channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/post/post_list` | body: `timestamp`, `_log_finder_uin`, `_log_finder_id`, `rawKeyBuff`, `pluginSessionId`, `scene`, `reqScene`, `pageSize`, `currentPage` | [src/main/data/collectors/weixin-channels.ts:81](../src/main/data/collectors/weixin-channels.ts#L81) |

readWorks 两个候选使用同一 POST endpoint，区别是 body 字段；timestamp 等由代码生成，本清单仅保留字段名。

页面元数据（可能被打开，不代表每次 API 操作都必须访问）：

| route | 精确目标 | 源码 |
| --- | --- | --- |
| home | `channels.weixin.qq.com/platform` | [src/shared/platforms.ts:358](../src/shared/platforms.ts#L358) |
| login | `channels.weixin.qq.com/login.html` | [src/shared/platforms.ts:359](../src/shared/platforms.ts#L359) |
| upload | `channels.weixin.qq.com/platform/post/create` | [src/shared/platforms.ts:360](../src/shared/platforms.ts#L360) |
| analytics | `channels.weixin.qq.com/platform/statistic/post` | [src/shared/platforms.ts:361](../src/shared/platforms.ts#L361) |
| works | `channels.weixin.qq.com/platform/post/list` | [src/shared/platforms.ts:362](../src/shared/platforms.ts#L362) |
| comments | `channels.weixin.qq.com/platform/comment` | [src/shared/platforms.ts:363](../src/shared/platforms.ts#L363) |

现有种子 7 个：`channels.weixin.qq.com`、`captcha.qq.com`〔验证码候选〕、`t.captcha.qq.com`〔验证码候选〕、`ssl.captcha.qq.com`〔验证码候选〕、`captcha.gtimg.com`〔验证码候选〕、`global.captcha.gtimg.com`〔验证码候选〕、`sg.captcha.qcloud.com`〔验证码候选〕。固定 collector/probe 的 host 缺漏：**无**。

种子里未在这两轮匿名壳观察出现：`captcha.qq.com`、`t.captcha.qq.com`、`ssl.captcha.qq.com`、`captcha.gtimg.com`、`global.captcha.gtimg.com`、`sg.captcha.qcloud.com`。未出现不是“不会使用”的证明。

观察出现、种子缺少的精确 host（全部未获业务审核；详情和每一行 JSON Pointer 见机器清单）：

| host | 样本资源类型 | 历史状态 / 取消次数 | 官方精确静态引用 |
| --- | --- | --- | --- |
| `astra-web.weixin.qq.com` | xhr | 无完成状态；取消 4 次 | 未作此项审核 |
| `localhost.weixin.qq.com` | xhr | 无完成状态；取消 6 次 | 未作此项审核 |
| `lp.open.weixin.qq.com` | script | HTTP 200；取消 0 次 | 未作此项审核 |
| `open.weixin.qq.com` | image, subFrame | HTTP 200；取消 0 次 | 未作此项审核 |
| `res.wx.qq.com` | font, image, media, script, stylesheet | HTTP 200；取消 3 次 | 未作此项审核 |
| `support.weixin.qq.com` | image | 无完成状态；取消 3 次 | 未作此项审核 |

API 响应里的动态地址：

- avatarUrl：响应字段 `headImgUrl`、`headImg`、`avatar`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/weixin-channels.ts:54](../src/main/data/collectors/weixin-channels.ts#L54)）。
- coverUrl：响应字段 `desc.media.0.coverUrl`、`desc.media.0.thumbUrl`、`coverUrl`、`thumbUrl`；host 不固定，由壳 img 展示触发独立 Session 请求（[src/main/data/collectors/weixin-channels.ts:99](../src/main/data/collectors/weixin-channels.ts#L99)）。
- url：固定 null，没有作品链接（[src/main/data/collectors/weixin-channels.ts:102](../src/main/data/collectors/weixin-channels.ts#L102)）。

## 动态跳转、QR、CDN 和上传的空白范围

pageFetch 和两种登录 probe 均未指定 redirect:error，沿用 fetch 默认重定向语义；login-detector 还检查返回的最终登录 URL。源码仅固定首个端点，不能据此声称下一跳一定同 host。运行时真实重定向仍逐目标检查；不能把“这是登录必需”当成清单外放行理由。页面自带的 fetch 拦截器、子框架、WebSocket、worker 和上传请求也不是源代码中几个 URL 的子集。

匿名报告没有记录 URL/path/query 或跳转链，只能确认 host 与资源类型。例如 open.weixin.qq.com 出现过 subFrame/image，lp.open.weixin.qq.com 出现过 script；这不足以反推 QR 轮询端点。localhost.weixin.qq.com 是观察到的域名，不等于获准访问的公共 CDN，其真实目的及解析范围尚未核验。

新增官方精确静态引用仅覆盖抖音 lf3-short.ibytedapm.com、unpkg.byted-static.com，以及快手 p66-plat.wskwai.com、p2-plat.wskwai.com；它们也只取得“可继续匿名静态诊断”的证据。其他相似 wskwai/wsbkwai 前缀不能靠命名规律放开。XHR、ping 等被取消的资源更不能自动归入可用业务目录。

真实上传目标完全由平台页在文件附加/用户操作后选择，可能涉及签名 URL、授权服务、分片、CDN、提交 API。upload 页面 host 的证明不等于这些目标的证明。当前 repo 未硬编码各平台上传 API，因此本清单没有猜造 uploadVideo/publish 端点。

## 账号 Session 之外的资源

头像与作品封面由 API 返回，经业务数据进入 React img：[src/renderer/components/ui/index.tsx:164](../src/renderer/components/ui/index.tsx#L164)、[src/renderer/features/browser/ObservePanel.tsx:309](../src/renderer/features/browser/ObservePanel.tsx#L309)、[src/renderer/features/metrics/MetricsPage.tsx:611](../src/renderer/features/metrics/MetricsPage.tsx#L611)。壳 [src/main/window/main-window.ts:78](../src/main/window/main-window.ts#L78) 没有设置账号 partition，CSP [index.html:8](../index.html#L8) 允许 HTTPS 图片。它们使用默认 Session，**不会自动共享账号 partition Cookie**，但 URL 本身仍可能带签名。不能声称账号守卫覆盖了这条路径，也不应把全部动态图片 host 强塞给每次账号 probe。

显式“在浏览器打开” [src/renderer/features/accounts/AccountMenu.tsx:57](../src/renderer/features/accounts/AccountMenu.tsx#L57) 与 openExternal IPC [src/main/ipc/handlers/settings.ts:37](../src/main/ipc/handlers/settings.ts#L37) 使用系统浏览器网络及其登录态，不属于账号 partition 执法范围。Work.url 目前只保存链接元数据，本次未找到对此字段发起的直接业务 fetch。素材服务 [src/main/services/asset-service.ts:180](../src/main/services/asset-service.ts#L180) 的 net.fetch(file:) 是本地文件读取，不是遗漏的公网 API。

## 30 个种子、额外观察与历史 NXDOMAIN

| 平台 | 种子 | 固定 API host | 观察 host | 观察额外 host | 历史 NXDOMAIN |
| --- | ---: | ---: | ---: | ---: | --- |
| 抖音 | 5 | 1 | 15 | 14 | 无 |
| 快手 | 5 | 1 | 17 | 16 | captcha.kuaishou.com, sec.kuaishou.com |
| 小红书 | 2 | 1 | 8 | 7 | 无 |
| 哔哩哔哩 | 9 | 2 | 4 | 2 | 无 |
| 百度百家号 | 2 | 1 | 13 | 11 | 无 |
| 微信视频号 | 7 | 1 | 7 | 6 | 无 |

DNS 来源 [network-stage2-proof-issuer-evidence.results.json](network-stage2-proof-issuer-evidence.results.json) 的报告生成时间为 2026-09-07T15:20:01.406Z，dnsSampleReused=true；这不是本次实时结论，也未重新指定原始采样时间。captcha.kuaishou.com 与 sec.kuaishou.com 在该历史样本中 A/AAAA 都为 rcode 3；AAAA 的 status=0 但无 AAAA 地址是 NODATA，不是 NXDOMAIN。两个 host 应标作“疑似陈旧待审核候选”，不能断言永久失效，也不能自动移除。

## 盘点时 AccountProofScope 的错配与后续修正

candidateTargets [src/main/network/catalog.ts:7](../src/main/network/catalog.ts#L7) 合并所有 routes、probe 和 verificationHosts；defaultScope [src/main/network/runtime.ts:59](../src/main/network/runtime.ts#L59) 对每个种子再展开 IPv4/IPv6。AccountProofScope [src/main/network/direct-proof.ts:15](../src/main/network/direct-proof.ts#L15) 没有 operation 字段。验证 [src/main/network/direct-proof.ts:187](../src/main/network/direct-proof.ts#L187) 要求 batch 与 scope 的目标数完全一致，并在 [src/main/network/direct-proof.ts:193](../src/main/network/direct-proof.ts#L193) 对每个目标检查，任意失败使整个 batch 不合格。

以上段落与源码行属于本次盘点时的历史快照。2026-09-08 后续实现已改为[操作目录与 Runtime 接线](network-operation-catalog.md)：注册 Session 不再默认采样；外层声明真实操作和页面 origin，当前页面操作合集按必需目标 AND。新增 `view-navigate` 精确目标，合计六平台 × 八类操作；同边界且独立已审核的后台操作可共享现有许可，新目标/审核变化先撤证。历史候选与运行时观察仍不自动成为必需目标或可信审核。

**所有当前必需目标都要有证据，不能替换成所有历史候选对每次操作都必需。** 快手 profile/listWorks 固定只发往 cp.kuaishou.com，却可能被两个历史 NXDOMAIN 的验证码候选拖住；抖音 www.douyin.com 是可选 site 路由；B 站多种 geetest 不是 nav/stat 的固定前置请求。当前 catalogReviewed=false 正确地保持未审核目录不放行，不能通过改 true 或从同一个 scope 的证据里悄悄漏掉失败项来“修好”上线。

用于真实操作 scope 接入的结论是：将固定 probe、profile 组、collect/keepalive 的 profile + works、upload 页面与其真实上传目标区分；只有实际被选中的分支才成为该操作的必需范围，选中后缺证仍拒绝。还要并入正在运行页面的已审核资源，不能只证明 API host 就声称整页合格。

existing view 可复用另一个同平台页面；account-online 的 profile 与采集可能并行。并发操作与旧页面仍有请求时，不能静默替换一个账号级 scope 而丢失覆盖。IPv4/IPv6 必需目标也必须匹配实际可证明的传输路径，不要求 IPv4-only 操作去证明不可用的 IPv6 候选；同时不得由 A 成功推导 IPv6 安全。上述区别不放松未知真实请求的 fail-closed。

## 历史样本版本与剩余补证

- [network-stage2-login-catalog.results.json](network-stage2-login-catalog.results.json)：2026-09-07T14:17:07.564Z，rule + TUN=true，3341 条规则，rulesHash `10d4aad5e5d8103457178c7e7c3928ff49c3056615a0d181a51f749323ade849`。匿名壳观察，内核上下文稳定，未完成真实登录。
- [network-stage2-login-catalog-followup.results.json](network-stage2-login-catalog-followup.results.json)：2026-09-07T15:18:25.512Z，rule + TUN=true，3341 条规则，rulesHash `10d4aad5e5d8103457178c7e7c3928ff49c3056615a0d181a51f749323ade849`。匿名壳观察，内核上下文稳定，未完成真实登录。

仍缺每个平台的 QR 轮询/验证码分支、认证后页面和跳转、实际采集页资源、真正上传目的地及长连接的审核。JSON 已分列 42 个 platform + operation 盘点组合（login/probe/profile/metrics/listWorks/keepalive/upload）、38 个 collector 候选、6 个 probe、所有页面元数据、来源行、种子/观察差集、历史 DNS 和独立壳图片路径；这套历史盘点分类不同于后续运行时八类操作，不更改原 JSON 样本。它可作审核输入，不能直接导入许可清单。独立壳图片路径后续已由 shell-network-guard 在 strict 下拦截远程请求，observe 保持原行为，详见[实施状态](network-implementation-status.md)。
