# 头像／封面受控缓存：小范围实现审计

核查日期：2026-09-08。仅阅读仓库与官方接口文档，未发送账号请求，未下载真实头像／封面，未改业务源码或用户网络规则。

**定稿第 8.3 条尚未完整交付。** 当前 strict 壳守卫已拦住默认 Session 的远程图片，Avatar 有文字回退；还没有主进程匿名图片下载、本地缓存和阻止签名 URL 进入 renderer 的 DTO 投影。冻结要求见[合并定稿第 8.3 节](严格分流方案-合并定稿.md#83-主界面的头像与封面)。下面是可以直接接下一轮实现的最小接口与条件，不另改总架构。

## 1. 当前数据链与具体缺口

| 路径 | 当前事实 | 必要接线 |
| --- | --- | --- |
| collector → 账号／作品 | 六平台解析 `avatarUrl`、`coverUrl`，host 来自响应字段；固定 API host 清单不能代表图片 host。[collector 输入盘点](network-business-target-inventory.md) | 保留 collector 字段解析；在主进程接收结果后交给媒体服务，不由 renderer 提供下载 URL。 |
| 采集落库 | [scheduler.ts](../src/main/data/scheduler.ts#L322) 将作品直接 upsert；头像直接 accounts.update。[account-service.ts](../src/main/services/account-service.ts#L466) 的独立资料刷新也直接保存头像。 | 两个写入入口都要纳入处理；下载不应在 SQLite transaction 内等待，图片失败不改变采集结果或 auth status。 |
| 账号 IPC | [accounts.ts](../src/main/ipc/handlers/accounts.ts#L7) 的 list/create/update/checkStatus/refreshProfile/reset 返回内部 Account；[index.ts](../src/main/index.ts#L204) 的 evAccountChanged 也直接发送 Account。 | 所有返回账号的接口与事件统一 `projectAccount()`，不能只改 accountList。 |
| 指标／作品 IPC | [read-model.ts](../src/main/data/read-model.ts#L168) 将头像并入 PlatformSummaryView，overview 再嵌入平台汇总；[metrics.ts](../src/main/ipc/handlers/metrics.ts#L40) 直接返回 Work[]。 | 平台汇总、总览的嵌套账号头像和 worksList 分别投影。metricsAccount 本身没有图片字段；evMetricsUpdated 只含 accountId。 |
| renderer 头像 | [Avatar](../src/renderer/components/ui/index.tsx#L141) 直接 `<img src={src}>`，所有账号侧栏、工作区、总览、指标、发布页共用。当前 failed 状态不会随 src 改变自动重置。 | 保留组件调用形态，但生产 DTO 只给本地引用/null；本地缓存就绪换 src 时须重置旧失败状态，否则第一次失败后永远显示文字。 |
| renderer 封面 | [DataDrawer](../src/renderer/features/browser/DataDrawer.tsx#L154)、[ObservePanel](../src/renderer/features/browser/ObservePanel.tsx#L308)、[MetricsPage](../src/renderer/features/metrics/MetricsPage.tsx#L610) 直接使用 Work.coverUrl；没有统一加载失败占位。 | 三处统一本地封面组件／失败占位，禁止 onError 回退到原远程 URL。 |
| URL 持久化与备份 | [accounts repository](../src/main/db/repositories/accounts.ts#L93)、[metrics repository](../src/main/db/repositories/metrics.ts#L189) 保存原 URL；[backup.ts](../src/main/security/backup.ts#L36) 的头像与 coverUrl 字段仍在显式 schema 内。 | 签名 URL 即使不含名为 token 的 JSON 键，也可能保留 query/path 中的访问能力。缓存目录与远程 URL 不进备份，旧备份导入也要去除这两类远程引用。 |
| 已有本地协议 | [AssetService](../src/main/services/asset-service.ts#L170) 只服务用户素材表的 file/thumb；未知 hostname 目前也落入 file 分支。[shell-network-guard](../src/main/network/shell-network-guard.ts#L41) 只允许 file/thumb 两种 sv-asset host。 | 可复用协议注册，但远程图片缓存需独立分支与独立目录；不能简单写入用户素材表，混进 Assets 页、发布附件或素材备份。 |

renderer 当前账号 Zustand 存的是整个 IPC Account；它没有给头像单独设置安全边界。只改 `<img>` 会阻止加载，但原签名仍能留在 renderer 内存，所以应先完成主进程投影。

`accountUpdateSchema.avatarUrl` 当前允许 renderer 提供任意 URL（[shared/ipc.ts](../src/shared/ipc.ts#L51)）。媒体服务不能把这条入口变成任意地址下载器：内部更新可保留头像字段，公开更新 schema 应拒绝/移除远程头像设置，或明确只接受现有本地引用；不得信任旧数据库里的 URL 就等于可信 collector 来源。

## 2. 可否直接用已获许可的账号 Session 匿名下载

**可以作为最小路径，但“相同 Session”只是必要条件之一。** Electron 的 `ses.fetch` 使用 Chromium 网络栈，会触发 Session 的 webRequest；`net.fetch` 默认使用 defaultSession，不能用于这条路径。官方文档还注明 Response.url/type 有限制，因此不应依赖返回 URL 判断是否偷偷跳转。[Electron Session API](https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init)

Fetch 的 `credentials: "omit"` 表示不附带环境凭据，也不采用响应返回的凭据；仍应构造固定请求头，不能接受调用方传入的 Authorization/Cookie。签名图片 URL 自身可能是一种访问凭据，omit 不会抹掉 URL 中的签名；这里的“匿名”仅指不附带账号 Cookie/认证头，不应把它作为公开诊断请求。[Fetch 凭据模式](https://fetch.spec.whatwg.org/#concept-request-credentials-mode)

下载前必须同时具备：

1. 账号仍存在，Session 是统一工厂为该账号登记的原 Session，contextId 未重建，Session 保护已完成。
2. 图片精确 `https + host + port` 已有该账号当前许可；实际地址族未知时全部可能分支有效。只有同域名的另一 Session／Node 探针证据不够。路径证据须明确适用于该账号 context 下的主进程 ses.fetch，而不能从“都叫 Electron”推导。
3. 主进程已审核该平台的图片来源／请求方式可匿名使用。这一用途审核与目标出口许可都要满足；HTTP 200 或 API 返回了 URL 不能自动成为审核。
4. 从下载开始到 body 读完、文件与引用提交前均持有并检查当前 lease；撤销、退出、账号删除、来源换版或单项取消都会终止工作。

**不要调用现有 `gatedSessionFetch`。** [实现](../src/main/network/gated-session-fetch.ts#L23) 无条件把 credentials 改成 include，且是最多 20 KB 的文本探测器。应新增专用二进制下载函数，复用 `beginBusinessOperation(accountId, url)` 的 lease 语义，不修改登录探测现有行为。

建议最小请求配置为固定 GET、`credentials: "omit"`、`cache: "no-store"`、`redirect: "error"`、`referrerPolicy: "no-referrer"`，仅固定图片 Accept 头，不收外部 RequestInit/body/headers。首期拒绝重定向；后续确需跳转时，每一跳必须在发送前审核和证明，不能先 follow 再检查最终 URL。Fetch 规范推荐直接用 redirect:error 排除重定向响应。[Fetch 重定向处理](https://fetch.spec.whatwg.org/#dom-response-url)

在锁定 Electron 43 + Windows 的受控接收端，用合成 Cookie、认证缓存／401、Set-Cookie、同账号同时进行的普通页面请求验证 omit 隔离；本次只有文档与源码核对，没有把这些实验写成已通过。不要在真实账号 Session 全局删除 Cookie/Authorization 或 Set-Cookie，那会破坏扫码、保活与 CookieGuard。若要增加请求头审计/剥离，必须归入统一 Session 生命周期挂钩并精确识别下载 request ID，不能再覆盖 onBeforeRequest，也不能靠“同一个 URL”区分并发登录请求。

## 3. 最小服务与 DTO 接口

建议新增 `src/main/services/remote-media-service.ts`，单独管理缓存，不复用用户素材 importFile：

```ts
type RemoteMediaSubject =
  | { accountId: string; kind: "avatar" }
  | { accountId: string; kind: "cover"; workId: string };

type LocalMediaUrl = `sv-asset://remote/${string}`;
type MediaPreview = {
  url: LocalMediaUrl | null;
  state: "cached" | "waiting-network" | "unreviewed" | "unavailable";
};

interface RemoteMediaService {
  // Main-process collector/result pipeline only. Never an IPC URL input.
  offer(subject: RemoteMediaSubject, input: {
    sourceUrl: string;
    sourceRevision: string;
  }): void;
  preview(subject: RemoteMediaSubject): MediaPreview; // local-only, no request
  forgetAccount(accountId: string): Promise<void>;
  responseFor(cacheId: string): Promise<Response>;   // local-only, no cache-miss fetch
  dispose(): Promise<void>;
}
```

Session/Gate/review resolver 由构造依赖提供，service 内解析 accountId 到权威平台、Session 与当前 scope。`sourceRevision` 绑定本次采集／资料结果；更晚结果替换 URL 后，旧下载即使成功也不得更新新引用。相同账号、图片用途、来源版本合并任务；缓存就绪通过主进程事件驱动现有账号/指标刷新，不由 renderer 反复提交 URL。

DTO 可沿用 `avatarUrl`、`coverUrl` 字段名以减少 UI 改动，但类型和投影严格收窄：`AccountDto = Omit<Account, "avatarUrl"> & { avatarUrl: LocalMediaUrl | null }`，WorkDto 与 PlatformSummary/Overview 的嵌套头像同理。内部 store Account/Work 与 renderer DTO 分开。所有 IPC 返回和 account-changed 事件只给 local/null，不向 renderer 提供 sourceUrl、重定向 Location、远程 host/path/query 或缓存文件全路径。需要等待原因时另给有限枚举，而非原始异常消息。

最小下载／缓存约束：

- 仅消费主进程接收的 collector 结果；URL 校验拒绝 userinfo、非 HTTPS、IP literal、畸形 host/port 与不合格目标。缓存预览和 protocol 请求本身永不触发公网下载。
- 使用有界队列，例如全局 2 个、每账号 1 个并发；这些是实现默认值，不是路径证明参数。休眠不重试，恢复只处理最新来源，图片失败不令账号掉线、不重跑采集、不修改发布记录。
- 下载 deadline、stream 字节上限、允许的图片格式及像素上限；超限中止。首期只接收经验证的 PNG/JPEG/WebP，拒绝 SVG/HTML/视频；不要只信 Content-Type。解码前检查格式尺寸边界，解码后统一生成缩略位图，避免把主动内容或未验证的大文件当图片缓存。
- 在独立管理目录暂存并原子提交；索引用随机 cacheId 和内容摘要，不用原 URL/path 做文件名。manifest 只含本地对象、归属、版本、类型、尺寸和时间，不存 signed URL；原 URL 在有界任务内存中，重启缺图等待下次合法采集，不靠备份恢复发送资格。
- 校验缓存文件的实际路径仍在管理目录内，strict 拒绝 UNC／重解析逃逸；`responseFor` 只按不透明 ID 取已知本地图片，返回固定 Content-Type/nosniff，不转发请求 headers，不回落默认 Session。缓存命中可在账号休眠时显示，不需要续发网络请求。

缓存与原远程 URL 都不进 BackupPayload。新写入入口避免继续将签名 URL 原文留在 accounts/works 的可备份字段；可存本地引用或空值，原响应解析不改。对现有数据库与旧备份的两字段要显式迁移/导入清理，不允许旧 avatarUrl 自动发起下载；跨电脑恢复缺少本地缓存时使用占位。若将来产品要求跨重启保留待下载签名 URL，需另行按秘密加密保存，并与备份隔离，不能把它顺手放进 settings。

## 4. sv-asset 与 UI 最少需要改的地方

| 文件／入口 | 最小改动 |
| --- | --- |
| `services/remote-media-service.ts` + 二进制下载器 | 实现上述队列、已有许可检查、匿名 fetch、受控缓存、取消与本地响应。 |
| `services/account-service.ts`、`data/scheduler.ts` | 在独立资料刷新和采集结果接收处 offer；替换持久化媒体字段及结果投影，不改 collector 解析。 |
| `ipc/handlers/accounts.ts`、`ipc/handlers/metrics.ts`、`main/index.ts` 账号事件 | 统一 DTO 投影，覆盖嵌套汇总和 worksList；cache ready 后发送安全刷新信号。 |
| `shared/types.ts`／`shared/ipc.ts`／preload 类型 | 内部记录与 renderer DTO 区分；公开更新拒绝远程头像输入；不用新增 download(url) IPC。 |
| `services/asset-service.ts` | 在唯一 `protocol.handle("sv-asset", …)` 中按 exact hostname 分派 remote/file/thumb；未知 host 拒绝，remote 只查独立媒体缓存。 |
| `network/shell-network-guard.ts` | 允许新增本地 remote 分支；远程 HTTP(S)/WS 规则不放宽。不要注册第二个覆盖监听器。 |
| `renderer/components/ui` 与三处封面 | 头像 src 变化重试、封面统一占位；生产只接受本地引用。阶段 2 observe 的现有原 URL 显示策略保持；strict 接 DTO 本地投影后再加对应的 CSP/源检查，不提前删全局 CSP 的 HTTPS 破坏观察模式。 |
| `security/backup.ts` + 旧数据处理 | 两字段不再备份原 URL；导入旧值不恢复出网任务、不继承缓存 ID 的有效性。 |

本地缓存不会出现在用户素材列表，也不能被 publishAttachFiles 的 assetIds 误引用。不要提供“图片加载失败则外部浏览器打开”或无门闩反向代理。

## 5. 当前许可模型带来的真实边界

现有 Runtime 的整账号 scope 对 requiredOrigins 做 AND；reviewedRequestRange 只表示可审核/取证范围，**并不是图片已获许可**。缓存任务应先只读核对当前已发布 scope 的精确目标和媒体用途审核，缺目标则占位，不能先调用会触发 UNKNOWN_TARGET 撤证的业务请求来试图学习 CDN。

这使首个实现可以安全处理“图片目标已在该账号当前许可中”的情形，但不能据此声称六平台所有头像／封面都恢复了。当前图片地址由动态响应给出，匿名首页报告和 30 个种子没有提供各平台图片 host 的完整审核；本次也未猜测或添加任何 CDN host。

不能为每张可选头像扩一次普通 collect scope：新增目标会撤销现有许可、关闭页面，CDN 暂时不合格还会使不依赖图片的采集休眠。若图片目标本来就是当前已审核页面必需资源，可在对应流程记录里明确列为 additionalRequiredOrigins，依旧全量取证。若产品需要下载独立可选 CDN，必须另行设计可撤销的“账号 Session 上匿名媒体请求”用途权限和逐请求识别，保持普通业务必需目标 AND；那超出本轮最小补丁，不能用 some 有证放行或借另一 Session 的证明替代。

仍缺以下真实条件：各平台媒体响应来源与精确 host/port 审核；匿名 GET 是否可用、是否依赖签名/Referer/Cookie；真实重定向分支；当前主进程 ses.fetch 传输上下文与目标/地址族/出口的适用证据；实际签发的可用目标许可。未经这些条件，strict 显示缓存/占位是正确结果。

## 6. 下一轮验收最小集合

1. 受控 TLS 接收端证明：账号 Session 有合成 Cookie/认证缓存时，媒体请求无 Cookie/Authorization/Proxy-Authorization/Referer；Set-Cookie 不落库、不触发 CookieGuard 保活；同 Session 普通登录请求保持原认证行为。
2. 闭闩、缺媒体用途审核、缺精确目标或一族证据失败时，接收端零到达；缓存读取仍可用。新增未知 CDN 不自动改 scope、不导航、不令账号 auth status 变更。
3. 重定向、401/403、坏 TLS、错误图片、体积/像素超限均不回落带 Cookie／代理／默认 Session，错误日志不含原 URL。
4. 下载中撤许可/删账号/退出/更换来源，实际接收端断流，旧结果不能提交；并发和重试有界。
5. 全部账号返回、账号事件、嵌套指标汇总、作品列表、备份与旧备份导入均无原签名 URL；协议缓存 miss 不出网，路径/host/query 变体不能访问任意本地文件。
6. renderer 仅请求本地协议：新缓存到达后 Avatar 能从旧失败恢复，三处封面有占位；observe 原显示和素材库/人工发布助手不回归。

本轮结论仅为源码审计与实施接口建议。不能把现有 strict 默认 Session 阻断，或上述未运行的验收清单，写成第 8.3 条已完成。
