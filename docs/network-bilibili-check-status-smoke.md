# B 站无页面状态检查：生产控制面隔离验证

**当前版本 45 项全部通过。** B 站无页面探测使用原账号 Session 的有界 `net.request` 适配器，从实际 redirect 事件维护最终目标。最终 origin、响应契约、挑战、节流、撤销与独立后续操作均已通过本机 TLS 复验。有限客户端审核已另行接入并绑定源码，详见[当前审核记录](./network-reviewed-operation-catalog.md)；没有宣称 Electron 的 `Session.fetch.Response.url` 已被修复或切换生产 strict。下文早期审核申请与旧轮次保留其历史边界。

最新复跑 **2026-09-07 22:28:32.389–22:28:35.812 UTC**（北京时间 2026-09-08 06:28）；45 个 bundle 源码输入运行前后及收尾哈希一致。其它五平台的未确认回应修复改变了共用 detector，B 站行为经源码复核和本轮 45 项重新确认。`gated-session-probe.ts`：`ed5dde262e6a246ffca65bd8c1462c58ce92695e327498ccc8cef8b07068936b`；`login-detector.ts`：`d9e54c76943548c5ae1dbdf468d27dcc7f906aa17b0de5ec712b16df09d2cdbc`；`account-service.ts`：`ace00fd56ef1a359a0ae4cdf84be898545a653477ac080dffab6d8f4217a5875`。上一轮完整结果保存在[修复前副本](./network-bilibili-check-status-before-cn-auth-fix.results.json)，20:05 审核副本及页面读取修正前的 [45 项历史](./network-bilibili-check-status-intermediate-45-before-page-bound.results.json)也独立保留。

此前最终 origin 守卫复查发现 Electron 43.3.0 的实际 Session.fetch 在本机正常 nav 200 响应中返回空 `Response.url`；接收端收到正确合成请求，守卫仍按缺失最终目标事实返回 unconfirmed。前 2 项闭闩通过、第 3 项成功确认失败，原始记录保留在 [origin 初始观察](./network-bilibili-check-status-origin-initial-observation.results.json) 与 [含透明响应事实的完整复查](./network-bilibili-check-status-origin-observation.results.json)。没有用发起 URL 回填一个自动跟随过重定向的 Response。

此前重定向／挑战响应／默认节流检查扩展 **44 项通过**，保留在 [44 项中间历史](./network-bilibili-check-status-intermediate-44.results.json)，其源码版本尚未核对最终响应 origin。该轮与 11、40 项统计均为历史结果；当前 45 项单独记录，不能互相替代。此前 28 项中的两条挑战误上线失败，以及后续发现的未探测却刷新验证时间问题均已修复；保留各轮原始证据。全部请求限受控本机 TLS。

44 项历史复跑：**2026-09-07 19:36:57.053–19:37:00.724 UTC**。41 个 bundle 输入源码在该轮运行前后及收尾复核时均一致。该轮 `login-detector.ts` 哈希 `42bc089386d32c0a9d7aa2c033e77e7bea46ebb6ac2892304d94d50f1337ba98`；`account-service.ts` 哈希 `ace00fd56ef1a359a0ae4cdf84be898545a653477ac080dffab6d8f4217a5875`。

2026-09-07 18:55:35.783–18:55:36.547 UTC 的基础轮次 **11 项通过**，单独保留在 [11 项历史结果](./network-bilibili-check-status-baseline-11.results.json)。Windows、Electron 43.3.0 / Chromium 150.0.7871.212（未打包）；基础轮次和本轮扩展均记录 bundle 输入源码起止哈希。

执行脚本：[electron-bilibili-check-status-smoke.mjs](../scripts/electron-bilibili-check-status-smoke.mjs)。完整结果与源码哈希：[当前结果](./network-bilibili-check-status-smoke.results.json)。复跑命令：`node scripts/electron-bilibili-check-status-smoke.mjs`。

## 实际执行的范围

此 fixture 运行实际 `AccountService`、`login-detector`、`gatedSessionProbe`、`configureAccountSession`、`NetworkRuntime`、`EgressGate`、`CollectScheduler` 和 SQLite repositories。没有页面时，固定 B 站探测由实际原账号 Session 的 ClientRequest 到达本机 TLS 接收端。透明计数器核对 Session 身份和 GET/include/manual 选项，记录 request、redirect、follow 次数，不修改目标或响应。旧 Session.fetch 观察仍单列，本轮调用为 0。

账号和数据库全部新建：内存 SQLite、随机假账号 UUID、临时 `userData/sessionData` 和仅本轮使用的分区；只设置随机合成 `SESSDATA/bili_jct`。未读取或使用真实用户 Cookie、Token、账号库或工作台会话。未启动生产 `main/index.ts`、未扫码、未访问真实用户信息 API、未读取/修改 mihomo 控制器和配置。

基础轮次 Chromium 子进程独立设置 `api.bilibili.com → 127.0.0.1`，其余主机解析失败，接收端仅处理固定 nav 请求。扩展轮次增加一个受控同 origin 最终路径和映射到同一本机端口的 passport 接收目标，用于实际检出越界第二跳。接收端只监听 `127.0.0.1:443`；端口占用则失败，不结束占用进程。临时自签证书只在假账号 Session 内按**两个精确主机和生成证书的指纹**放行，其余证书一律拒绝。没有全局忽略证书开关、系统证书修改或真实站点 TLS 放宽。

测试解析器仅给 `bilibili / check-status / activePageOrigin:null` 注入**受控测试专用**流程审核，required targets 限 `api.bilibili.com:443` 的两族。两轮 Gate 输入也是明确标识的合成测试数据；其中 DIRECT、CN 和地址族字段是为了验证状态机，不能作为真实路径证据。其他操作继续使用默认未审核目录，生产 `flowReviewed` 和主入口 enforcement 均未改变。

## 基础 11 项历史验证结果

| 控制面行为 | 结果 |
|---|---|
| 初始闭闩 | `checkStatus` 保留原认证状态和 `lastCheckedAt`；Session.fetch 调用 0、接收端到达 0。 |
| 只有一轮测试证据 | 仍不调用 Session.fetch，仍无接收端到达。 |
| 两轮完整测试证据 | 实际探测读取合成 `code:0 / isLogin:true` 响应，并将假账号状态变为 online。 |
| 会话凭据与目标 | 两次实际 nav 请求均由隔离账号 Session 携带合成 Cookie 到达本机；未创建页面。 |
| 响应体未结束时撤销 | Gate 撤销使真实流断开，业务 Promise 及时结束；旧账号保留 offline 和原验证时间，没有新增 account-online 事件。 |
| 撤销后再次检查 | 不再调用 Session.fetch，无新增到达。 |
| 后续 profile | 真实服务声明其独立操作后被拒绝；不调用 profile 下载依赖，不借用 api 单 host 许可。 |
| 空采集队列收到 allowed 回调 | 保留 check-status 许可，不检查 collector 的工作页目标，也不产生任务。 |
| 后续 collect | 实际调度器声明 collect 后任务进入 waiting-network；不创建视图、不运行 collector、不增加网络到达。 |

最终接收端：nav 2、合成 Cookie 请求 2、其他请求 0、仅 loopback 为真、撤销流关闭 1。调用计数：Session.fetch 2、profile 0、collector 0、视图动作 0、account-online 1。

## 首次失败与修正

首次运行保留在 [初始观察结果](./network-bilibili-check-status-initial-observation.results.json)：前 8 项通过，第 9 项 `idle_scheduler_preserves_an_unrelated_check_status_permit` 失败。

原 `CollectScheduler.resumeNetworkAccount()` 在没有待恢复任务时仍检查 collector 的工作页 `member.bilibili.com`。生产主入口会对 allowed 状态调用这个方法，因此合法的 api 单 host 检查许可会被空队列的 UNKNOWN_TARGET 检查撤销。

修正限定在 [scheduler.ts](../src/main/data/scheduler.ts)：没有 queued/waiting-network 任务、或认证状态不具备采集资格时，只清理 suspension，不声明采集范围或查询 collector 目标；确实有任务时，先按实际 trigger 声明 collect/keepalive，再检查该操作许可。恢复通知不会新增采集任务；offline 账号的等待任务不会自动运行。

[scheduler.test.ts](../src/main/data/scheduler.test.ts) 新增空队列启动/重复恢复、四种 trigger 的声明顺序、声明未审核时零目标检查、offline 等待任务零采集检查等 7 项回归。该文件共 **18 项通过**；相关源码/测试 ESLint 和项目 typecheck 均通过。修正后上述真实 Electron fixture **11/11 通过**。

## 不能据此宣称完成的部分

这是受控本机业务控制面验证，不是大陆真实出口、mihomo 实际连接归因、Windows 真实选路、Chromium 最终 DNS、IPv4/IPv6 公网通路或扫码流程验收。完整主入口事件总线未启动；fixture 显式执行与生产一致的调度恢复方法，并分别触发 profile/collect 入口。

真实 B 站 probe 的有效/失效认证响应、实际重定向分支、持久会话后台流量及传输上下文仍需在合格真实路径下按 [最小操作范围](./network-minimal-operation-scope.md) 补证。这一项可以独立推进，无需要求全部六平台全部登录/CDN 范围同时完成；当前真实操作审核继续未完成。

## 扩展分支观察与修正前证据

本轮仍只运行隔离假账号、合成回应和测试许可。证书 SAN 与进程内主机映射同时覆盖 `api.bilibili.com`、`passport.bilibili.com`，二者均只映射本机；未给 passport 签发请求许可。新增 `.bilibili.com` 域合成 Cookie，并在请求前通过本地 Cookie 查询确认它们确实匹配 passport 目标，避免把 Cookie 不匹配误当作门闩有效。

后续 account-online 事件按当前主入口的同一组服务调用执行：resume、enqueue(login)、refreshProfile；不启动主入口或真实账号。这样可区分“没有调用真实采集依赖”与“因错误上线而产生了多余等待任务”。

| 分支 | 实际观察 |
|---|---|
| 同 origin 302 / 307 | 第二跳到同 host 的受控路径，返回合成有效 JSON；online 合理，随后 profile/collect 因独立目录要求继续等待，未借用单 host 许可。 |
| 跨 origin 302 / 307 | 指向 passport；第二跳到达 0、凭据到达 0，原 offline 和验证时间不变，不发 account-online 或新采集任务。 |
| HTTP 401 / JSON 未登录 | 保持 offline，不发 account-online，不创建任务。 |
| HTTP 200 挑战 HTML | 首次失败为 offline→online，并创建 1 个 waiting-network 任务。修正后旧 offline/online 均逐字段保留原账号，没有新事件或任务；HTML 图片未执行。 |
| HTTP 200 未知 JSON 错误 | 首次失败为 offline→online，并创建 1 个 waiting-network 任务。修正后保持原账号全部字段；JSON 为合成 `{code:-352,...}`，不声称是本轮真实平台响应或确定的验证码要求。 |
| HTTP 204 空内容 / HTTP 200 坏 JSON | 修正后均在旧 offline、旧 online 两种状态下验证：保留原账号和全部验证时间，没有新 account-online、profile、采集任务或请求。 |

初次失败不可覆盖，保存在 [挑战回应初始观察](./network-bilibili-check-status-challenge-initial-observation.results.json)，该历史结果是 26/28，通过前不改写失败。

修正只针对 B 站固定 nav 探测：JSON 必须明确 `code===0 && data.isLogin===true` 才支持 online；`code===-101`、`data.isLogin===false` 或 HTTP 401 才明确失效。未知回应返回仅主进程使用的 `DetectionResult.unconfirmed`。AccountService 仍先核对 lease、dispose 和账号 epoch，再直接返回当前账号；不更新数据库 status、lastCheckedAt、lastOnlineAt、sessionExpiresAt、lastProbeAt，也不发账号变更/上线通知。不新增数据库状态，其他平台、collector 解析不改。

挑战响应修复后的 [40 项中间结果](./network-bilibili-check-status-intermediate-40.results.json) 单独保留。该轮全部主动探测，尚未覆盖默认检查的 30 秒节流分支。

## 未探测的默认检查不能刷新验证时间

随后只读审查发现：同一 online 账号成功探测后，默认 `checkStatus()` 会在 30 秒内设置 `skipProbe`。此前该分支返回 inconclusive，继而根据本地 Cookie 推断 online，导致没有发请求也更新 `lastCheckedAt`、`lastOnlineAt` 和会话到期时间。若期间强制探测收到挑战回应，下一次默认检查仍可走这条旧路径；40 项强制探测结果未覆盖它。

本轮仅为 B 站收紧这一分支：`skipProbe`、没有探测器或探测返回 null 均返回 unconfirmed，`probeStatus:null` 表示没有 HTTP 观察。服务返回原账号，不落库、不推进真正验证时间、不发事件、不产生任务。其他平台的既有 Cookie 启发式保持；已经识别的当前验证码页仍优先返回 needs_verification。

真实 Electron 新增同一账号的连续场景：成功探测 → 默认检查 → 强制挑战 → 默认检查。两次默认检查均没有额外 Session.fetch；挑战之后与成功之后的默认结果都逐字段保持最后一次真实成功记录，数据库也一致，无额外 profile、account-online 或采集任务。单元回归另覆盖 null 探测、验证码页优先，以及 Cookie 活动排入的自动检查不会刷新这些字段。

44 项历史统计：初始 nav 18、同 origin 最终请求 2、合成 Cookie 请求 20、跨 origin 请求/凭据 0、scope 外 HTML 资源 0；profile 下载依赖、collector、视图动作均为 0。仅基础成功和两次同 origin 成功发出共 3 个 account-online；扩展真实后续事件处理只由两个有效成功触发，其任务等待独立许可。未知回应和未发探测的检查没有新增任务。该轮相关三个单元测试文件共 **80 项通过**（探测器、账号服务、调度器）。

## 最终目标事实与当前 45 项结果

锁定版本的本地官方声明已写明 Response.url/type 不正确；内嵌 `net-fetch.ts` 创建 `new Response(...)` 时未赋最终 URL。其 `redirect:manual` 直接传给 ClientRequest，但 fetch 没有 redirect 监听器；底层同步事件中未调用 `followRedirect()` 会拒绝为 `Redirect was cancelled`，不能用它获得可读 3xx/Location 再逐跳 fetch。这一调查只读取本地 Electron 二进制内嵌源码和声明，没有新增公网请求。

生产修复只用于 B 站主进程 GET 探测：`gatedSessionProbe` 使用原 Session、`credentials:include`、no-store、manual redirect 与现有 webRequest，最多跟随 5 次同 HTTPS origin 重定向。每跳先检查许可与撤销；不合格跳转不跟随，返回当前已知目标的 3xx 空正文，由认证解释器保持 unconfirmed。最终 URL 来自初始请求和**实际发生且被批准跟随**的 redirect 链；没有用 fetch 缺失字段猜测最终目标。10 秒期限、20 KB 上限与在途 abort 保持有界；超限正文不接受截断的 JSON 前缀。不新建 Session、不复制 Cookie、不回落 fetch；页面内 fetch 继续使用 Chromium 页面实际提供的 response.url。

当前 45 项：ClientRequest 创建 **18** 次，同 origin follow **2** 次，redirect 事件 **4** 次；接收端 nav **18**、同 origin 最终路径 **2**、合成 Cookie 请求 **20**。跨 origin 第二跳/凭据 **0**，Session.fetch **0**，撤销响应流关闭 **1**。profile 下载依赖、collector 与视图动作均 **0**。两个正常同 origin 成功触发的后续任务等待各自许可，未知回应与默认节流检查不新建任务。跨 origin 拒绝验证逐字段保留状态和真正验证时间，不要求为同一已审核 origin 以外的未发送跳转额外撤销全账号许可。

探测器、账号服务、调度器三个定向文件共 **102 项通过**，相关 ESLint/typecheck 通过。net.request 的 mock 以原 Session 身份匹配回复，使用真实 EventEmitter/Readable 行为；没有 mock 掉 gatedSessionProbe。额外断言 B 站适配器失败也不会回落 Session.fetch。新适配器自身的专项测试由其实现文件对应测试单独记录，不与这 102 项重复计数。

收尾审查还在 B 站**有页面**探测中复现了旧切片问题：有效 JSON 加空格补到 20,000 字符后，再追加无效尾部，完整正文不是 JSON，旧 `text.slice` 却把前缀交给解析器并错误确认 online。仅 B 站生成脚本已改为最多缓存 20,000 **字节**，必须读到真实结束才解释完整正文；超限立即停止读取、返回空正文，并在 finally 取消和释放 reader。其余平台的解析行为保持。新增 4 项回归执行真实生成脚本及真实 ReadableStream，覆盖正常分块 JSON、有效前缀加超限尾部、UTF-8 字节数大于字符数、恰好 20,000 字节完整结束；同时检查未读取后续块、取消与释放。这些是内存受控脚本验证，不冒充有页面公网或完整扫码验收；本轮真实 45 项仍限定 no-view，并绑定修正后的 detector 哈希。

## 固定 API 目录与出口证据分别验收

**当前版本前置限制：** B 站在解释 JSON 或 HTTP 401 之前，必须确认实际响应最终 URL 与配置 probe 同 origin，即 HTTPS、`api.bilibili.com`、默认 443，且 URL 没有用户凭据。不同 host、协议、端口，无效或缺失 URL 都只返回 unconfirmed；同 origin 的不同 path 仍按原受限响应契约处理。定向回归确认 observe 下跨 origin 目标的成功或 401 也不会落库、刷新时间或创建任务；ClientRequest 在第二跳发送前拒绝，页面探测返回的错误最终 origin 也被认证解释器拒绝。

冻结规格第 4.3 节将“目标属于审核范围”和 DIRECT、出口、TLS、地址族证据列为独立条件；第 4.6 节要求新目标先拒绝。因此 `bilibili / check-status / activePageOrigin:null` 可以审核**有限且明确的客户端行为**：只发源码固定 API，响应仅按受限契约解释，同 origin 重定向仍受原精确目标约束，跨 origin 及未知分支明确不支持。该目录审核不等于真实出口许可，不需要先把全部登录页面、验证码、CDN 和六个平台同时验收。

源码枚举加基础 11 项不足以直接签下审核；现已补齐挑战误上线、默认节流、受控重定向拒绝和最终目标事实的适配器实测。拟提交给主进程审核者的有限范围仍是：`bilibili / check-status / activePageOrigin:null`，`requiredOrigins` 与建议的 `reviewedRequestRange` 均仅含 `https://api.bilibili.com:443`，`additionalRequiredOrigins:[]`。这是受限客户端固定 API 行为的审核申请，不是全站登录完成；本轮没有生成或安装 `flowReviewed:true` 的正式记录。

审核记录必须绑定当前 `sourceVersion + selectionKey`，并保留本次 42 个业务依赖源码哈希和实验引用。当前 `sourceVersion` 基于平台元数据及枚举清单，不会自动覆盖所有服务实现变化，不能因元数据未变就沿用旧业务实现的审核结论。新适配器仍使用原 Session，但后续路径证据应对准其实际 GET/redirect 上下文，不把之前另一种调用的探针结果直接视为等价性验收。

**真实外部数据与此范围审核分开记录：** 对“本程序仅支持这个固定目标及有限响应契约”的目录审核，不需要读取真实账号资料；源码、受控响应分支和实际 Gate 拒绝可以证明该有限客户端边界。若要宣称“真实 B 站这个接口当前兼容且账号判断正确”，还需真实响应的 HTTP 状态、Content-Type、各跳 Location/最终 origin，以及最小 `code` 数值和 `data.isLogin` 是否为布尔值的语义证据；不需要昵称、UID、头像、WBI 图片密钥或完整正文。匿名请求至多覆盖未登录分支，不能代表已认证成功分支；该分支只能以后在已确认合格的网络中验证。DNS/进程/Socket/大陆出口仍由另一套路径证据核对，不能把它们当作目录审核的同一个布尔值。
