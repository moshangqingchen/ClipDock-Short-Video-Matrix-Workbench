# ClipDock 严格分流：实施记录与阶段门槛

## 22:52 最新构建

当前主入口使用 `strict` 互斥策略：系统代理或 TUN 开启时国内账号休眠，代理关闭并连续两次确认后恢复；国外网页仅在海外代理状态和主进程目标许可同时有效时打开。国外账号侧栏的刷新版本保护、首个账号默认选中、官网窗口清理和删除账号收尾已完成。最终全量 **138 个测试文件／4084 项通过**，typecheck、lint、打包和 `--packaged` Electron 冒烟通过。没有切换系统代理/TUN，也没有使用真实账号或凭据；真实平台登录、真实代理开关恢复和 API 授权仍未验收。

## 22:09 最终包

在 22:02 基础上补入代理未知态 fail-closed、国外窗口撤销清理、重复打开清理屏障、删除账号工作区清理和状态文案修正。`npx vitest run --maxWorkers=4` 为 138 个文件／4081 项全部通过；最终包哈希见[交付记录](./network-exclusive-delivery.md)。

## 22:02 最终验证

新增的严格互斥修正已进入最终包：Clash/控制器读数不可读或过期时显式保持 unknown，国内不会误判直连；代理资格撤销会同步关闭国外网页 relay 与 Chrome 窗口；官网账号删除不会留下选中工作区。`npx vitest run --maxWorkers=4` 通过 **138 个文件／4081 项**，`npm run typecheck`、`npm run lint`、`npm run pack` 和 `node scripts/electron-window-smoke.mjs --packaged` 均通过。最终包哈希记录在[交付记录](./network-exclusive-delivery.md)。

## 21:18 更新

国外网页登录已进入主程序：独立 Chrome 账号目录、主进程代理 relay、固定 YouTube／TikTok／X 官网入口、目标级许可、代理撤销和窗口清理均已接入；国外侧边栏与国内使用同样的账号树布局。官网状态和 API `authStatus` 分开，网络状态只保存在主进程／运行时内存，不写入 renderer 持久化。

已通过 `npm run pack` 生成新包。全量回归最近一次为 137 个文件／4074 项通过；网页入口、浏览器目录、生命周期、IPC 和 UI 相关回归另有 99 项通过。当前没有真实账号登录验收，X／TikTok 连续续证的一次失败仍按休眠处理，不把匿名连接结果写成“已登录”。

更新日期：2026-09-08。本文记录代码、实测状态及最新用户需求变更；最新明确要求优先于旧规格。

**19:58 历史记录：[国外网页代理通路与 Chrome 隔离实验](./global-web-transport.md)。** 当时新增主进程 CONNECT 传输和本地代理入口并通过 51 项受控测试；实际网页取证、浏览器进程管理与打开官网 IPC 尚待接线，已在本页 21:18 更新中完成。该段保留用于追溯，不代表当前入口状态。

**19:24 历史进度：[国内／国外分类、网页登录主入口方向、API 可选](./global-web-entry.md)。** 用户已改变早先“国际仅 API”的产品约束。分类和可选工具区进入 19:23:42 构建，76 项相关回归、typecheck、lint、打包及隔离桌面检查通过；分类截图已查看。当时独立网页登录仍在接入，尚不能从该版本实际打开隔离的官网账号环境；不要把占位状态、默认浏览器或 API 授权当成该阶段能力验收。随后网页隔离、代理控制和官网 IPC 已在 21:18 接入，当前状态以本文顶部和[国外网页登录记录](./global-web-entry.md)为准；本条保留作历史追溯，不改变当前实际代理／TUN。[历史构建](./network-exclusive-delivery.md)。

**19:04 历史进度：[YouTube 可恢复上传](./global-youtube-upload-delivery.md)已进入 19:02:59 构建。** 默认私密、独立上传授权、元数据声明、按服务器实际位置恢复和跨重启等待接入。19:01 全量 **128 文件／3949 项**（4 个 worker）全部通过，typecheck、lint、打包及新包桌面检查通过；实际 YouTube 上传截图已查看。首次测试缺失模拟及一次 worker 退出保留原报告，后者根因未确认。没有修改实际代理／TUN或使用真实平台 Token，真实授权和上传仍未验收。X 写入、平台侧撤销及真实国内／国际验收继续推进。[构建与原始结果](./network-exclusive-delivery.md)。

**18:15 历史进度：[TikTok 草稿上传与队列](./global-tiktok-draft-delivery.md)完成并进入当时构建。** 上传授权单独请求；用户选择素材后立即取得任务 ID，按代理资格执行，分片回应与官方收件箱状态分开显示，取消、原 publish ID 核对续传及迁移 10 密文保留通过。18:12 全量 **127 文件／3838 项**、typecheck、lint、打包通过，18:15 新包隔离桌面检查退出 0，实际 TikTok 面板已查看。没有真实开发者应用、平台 Token 或真实上传验收；未切换用户代理／TUN。当时 YouTube／X 上传、平台侧撤销和真实国内／国际验收仍待完成。[构建与原始结果](./network-exclusive-delivery.md)。

**17:20 历史进度：[国际隧道持续续证](./global-proxy-tunnel.md)完成并进入 17:19 构建。** 长业务请求不再阻塞匿名出口复核；原短许可到期前必须以同一连接的新证据取得替代许可，失败／取消／到期直接终止。原 TTL、平台目标限制和默认总超时未放宽。17:17 全量 **121 文件／3710 项**、typecheck、lint 与打包通过，17:20 新包隔离桌面冒烟退出 0。本机 6 MiB 慢请求跨过原 5 秒许可，只有一次 CONNECT／TLS；不是正式平台上传验收。三平台上传／草稿／发布、相关队列、远端撤销与真实验收当时仍未完成，用户代理／TUN 与账号目录未改。下面带时间条目为历史阶段。

**16:50 历史进度：[国际读取队列](./global-jobs-delivery.md)完成并进入 16:48 构建。** 提交立即返回任务 ID，代理不合格时等待；同账号合并、串行退避、可取消、页面退出保留，重启重新检查网络和授权。迁移 9 的授权版本区分新授权与 Token 刷新，旧回调不得复活取消任务。16:47 全量 **121 文件／3676 项**、typecheck、lint 通过，16:50 新包隔离桌面冒烟退出 0。真实代理／TUN 和账号目录未修改；用户没有官方开发者应用，没有真实平台授权、读取或队列业务验收。上传／草稿／发布、相应队列、远端撤销与真实验收仍待完成，目标继续保留。

**16:11 历史进度：[国际账号手动读取](./global-read-delivery.md)已接入当前构建。** 官方资料／指标／最近 20 条作品适配、按需 Token 刷新与 CAS、独立快照／审计、取消及界面完成；TikTok 当前仅 basic scope，统计／列表明确缺少权限。16:08 全量 **118 文件／3631 项**、typecheck、lint 通过；16:10 新包及16:11隔离桌面验收通过，三个未授权账号的读取在出网前拒绝。无真实授权或平台数据验收，系统代理／TUN 保持现状。上传、国际队列和远端撤销仍待完成，目标继续保留。下方15:39及以前条目是历史阶段。

**历史交付：15:39 构建与隔离桌面验证完成。** 国内继续按最新要求执行互斥；国际本机配置、主动官方授权／取消和本地清除已接入。真实代理来源组合、accepted socket 归属、首次取证撤销与按实际耗时续证已实现；15:38 全量 **111 文件／3468 项**、typecheck、lint 通过，随后打包和实际 exe 冒烟通过。构建哈希、原失败及匿名样本范围见[当前交付记录](./network-exclusive-delivery.md)。国际读取／上传、刷新／远端撤销、业务队列及真实官方授权仍待完成；按用户要求，真实系统代理／TUN 未切换，关闭后的国内恢复仍待验收。以下带时间的旧条目保留当时状态，不应将其“授权未接入／observe”理解为当前入口。

14:36 已继续完成[OAuth 生命周期与本地授权清除](./global-oauth-lifecycle.md)、[官方兑换](./oauth-exchange-contract.md)、[国际隧道读取与授权](./global-proxy-tunnel.md)。14:32 全量 **103 文件／3305 项**、类型检查、lint 通过；本地清除和数据库核验已进入 14:09 构建，14:36 新包隔离窗口验收通过。截图等待的失败与仅测试进程修正见[构建记录](./network-exclusive-delivery.md)。国际应用配置仍可使用；真实授权入口仍待真实出口资格来源与主入口组合，当前不可登录或调用国际 API。用户选择暂不切换真实代理／TUN，国内真实关代理恢复仍待验收。

13:30 已完成用户要求的[本机国际应用配置入口](./global-app-setup.md)：国际账号／设置页填写 YouTube、TikTok、X 的应用信息，秘密加密保存且不回显，身份／端口／密钥变更原子撤销该平台旧授权。当前不需要真实开发者应用，可保持未配置。13:26 全量 **98 文件／3025 项**、typecheck、lint 通过；13:27:55 新构建及随后实际可执行程序冒烟通过，合成密钥保存／清除、分区隔离和表单已核验。详见[当前构建](./network-exclusive-delivery.md)。真实官方授权／API 仍未启用，系统代理和 TUN 保持现状。

13:00 已开始[国际官方 API 基础设施](./global-api-foundation.md)：独立国际账号 CRUD／IPC／页面接入新版，OAuth、ProxyTransport、原子 Token 提交模块及受控测试完成。真实代理授权器及官方 API 调用尚未接线，页面明确显示未开放，不把代理模式等同海外业务已运行。国内互斥策略保持不变，当前系统代理／TUN 未修改。

**最新需求已改为国内／海外互斥切换，主进程及界面已完成接线。** 正常国内网络且系统代理、TUN 均明确关闭时，国内侧才可恢复；系统代理或 TUN 任一开启，国内立即休眠。该要求覆盖旧的“rule + TUN 命中 DIRECT 后两边同时运行”，不再继续为双通路资格追加解析、路径或公网实验。仅打开代理客户端 UI 不等于启用代理；未知状态保持 `checking`、闭闩且不亮绿，关闭后须连续两次稳定并确认国内网络可用。主进程守卫、停调度、在途取消、登录／网络双轴和凭据不进备份继续保留。国际授权入口已接入但真实授权及业务 API 尚未验收，不能把“代理开启”显示成海外业务已运行。完整变更边界见[互斥切换补充](./network-exclusive-switch.md)。

以下 11:31 及以前的验证、代码说明和实验均为变更前基线，保留原始结果及失败历史；其中“双通路”方向的后续安排已被上述新需求覆盖。**2720 项测试通过不等于新互斥策略已完成验收**，新代码与实际切换结果完成后另行记录。

12:04 新互斥代码验证：正式 `index.ts` 已选用 strict + ExclusiveNetworkSwitch，退出旧的同时分流 ProofCoordinator 接线；无账号许可持久化。全量 **85 文件／2808 项**、typecheck 通过；测试的一处 `prefer-const` 已修，全仓 lint 随后通过。Windows 读取、18 项切换状态机、Runtime 六平台互斥与渲染投影回归已覆盖；窗口实测显示代理模式和国内闭闩，凭据安全保存删除正常。修复的两项同步竞态与出口缓存计龄均有回归；新本机受控接收端结果另记。未关闭当前真实 TUN、未用真实账号测试不合格路径；真实“关闭代理后恢复”尚未验收，国际 API 仍未接入。

12:10 [互斥策略本机 Electron 验收](./network-exclusive-runtime-smoke.md)单次 **25／25 通过**。真实 Switch→Runtime→Session 请求控制链在合成代理／CN输入下验证：未知和开代理后的请求零到达；主进程及页面两条响应流各发送 2 块后实际终止；旧 DIRECT 观察不能重开；关代理仍需两轮恢复。主进程 fetch、页内 fetch、XHR 和恢复请求均带本轮合成 Cookie 到达 loopback TLS；账号写入／online 事件／通知均为 0，27 个生产源码摘要稳定，真实在途、窗口、WebContents 清理归零。没有修改实际系统代理／TUN、访问公网或使用真实账号；上传及当前 Windows 真正关闭代理后的恢复未由此轮覆盖。

12:23 [当前构建与交付验证](./network-exclusive-delivery.md)：新增 `exclusive-business.integration.test.ts` **21 项集成检查通过**，实际 Switch、Runtime、CollectScheduler、PublishService、AccountService 与内存 SQLite 覆盖六平台休眠排队、定时／保活合并、仅合格登录账号恢复、迟到结果拒绝及发布助手休眠拒绝；Electron 与平台响应为受控替身。全量 **86 文件／2829 项**、typecheck、全仓 lint 通过；`npm run pack` 成功，随后 `--packaged` 冒烟实际启动新可执行文件，使用一次性数据目录验证壳、IPC、互斥 strict、网络状态不持久化及加密凭据保存／删除。用户明确要求暂不切换当前系统代理／TUN，本轮未修改其状态；真实关闭后的国内恢复仍未验，国际 API 未接入。

12:35 [上传中途撤销实验](./network-exclusive-upload-smoke.md)完成：H1、H2 各 **18／18 通过**，各两次 32 MiB main/XHR 上传被生产互斥撤销链截断，闭闩后的新请求零到达、资源清理归零。H2 两次断言失败原样保留，修正 Node 兼容流 `complete`／`end` 不等于正文收全的语义误用；最终依据不足正文长度、取消事件、RST CANCEL 和真实连接关闭验收。只使用 loopback TLS 与合成 Cookie，未切换真实代理或验证平台上传；缓冲字节仍可能在撤销后到达。

09:44 配置推进：用户明确确认后，`myip.ipip.net`、`api6.ipify.org` 两条匿名诊断 DOMAIN DIRECT 已应用并验读；当前共 **3343 条规则**，原 3341 条保持原序，原 30 个业务候选与新增两目标均先匹配 DIRECT。配置、内核版本及 DIRECT 路由参数完整核验一致；备份密文保留。首轮报告重载校验失败，随后独立核验确认原文件和规则已经恢复；原记录没有保留足够差异字段，不能认定唯一原因。后续检查发现脚本把主动重载会更换的实例 ID 与路由参数一起比较，现仅在主动重载后单列实例变化，写前 CAS 和生产代际检查不放宽，第二次应用成功。详见[应用与恢复记录](./network-diagnostic-direct-preparation.md)。规则成功尚不是出口或路径许可；后续真实匿名出口实验单独记录。

09:58 出口推进：[实际生产匿名工厂观察](./network-diagnostic-egress-after-rules.md)两轮均取得 IPIP 的 **CN / AS4837、IPv4** 结果，并以请求图和唯一 Windows TCP 四元组确认实际 IPv4 socket。第二轮只复核 IPIP；其新的 Tun/TCP/DIRECT 候选与请求目标、源端口和创建时间匹配，内核进程字段为空，独立 Windows 进程身份完整。旧实验辅助函数因此返回不匹配，原 JSON 保留；生产 mapper 已支持“独立进程证据完整、内核字段为空”的情况，不增加新的产品限制。API6 首轮不可用，没有重试，不能据此认定业务仅有 IPv4。下一步补正常请求的实际解析任务、完整可选地址族及其时效；仍未签发路径资格或账号许可。

10:19 正常解析推进：[一次实际 B 站匿名请求](./network-normal-resolver-observation.md)得到非缓存 HTTPS 200；精确请求图关联到 Windows SYSTEM 解析任务，其终端结果包含一个 IPv4 地址，与实际 TCP 目的摘要一致，无未知地址形状或截断。JOB 计划查询仍为 A、AAAA、HTTPS，IPv6 可达性事件为 true/cached，Secure DNS mode 为 0。本次 SYSTEM 返回集合只有 IPv4，不能据此限制后续请求或写成长期单族证明。没有独立 DNS 预暖、强制族、账号会话或设置变更。后续应验证仍可能的 IPv6 物理通路，或取得明确有效的单族约束；不再重复只为看到 IPv4 成功的探针。

10:37 API6 限定失败观察：[独立一轮正常解析记录](./network-normal-resolver-observation.md)使用真实匿名出口工厂的原 12 秒总上限，仅一次 echo、零 geo。SYSTEM 解析在 1 ms 后返回一个 IPv4 地址，JOB 仍计划 A/AAAA/HTTPS，IPv6 标志为 true/cached；随后记录 `ERR_CONNECTION_CLOSED`，工厂不可用。socket 解析没有取得唯一完整连接事实（`SOCKET_AMBIGUOUS`），故不能把这一轮写成 IPv6 拨号失败或据此删掉 IPv6 要求。两轮控制器规则摘要一致、14 个源码摘要稳定，原始临时数据与资源清理完成；`executionCompleted=true` 仅指失败观察完整，不是出口成功。旧 B 站和出口记录未覆盖。下一步仍需正常传输上下文的有效族约束，或补齐仍可能的 IPv6 路径/出口证据；正式 observe、q/账号许可均未改变。

10:53 独立 IPv6 推进：[强制当前 AAAA 的单次观察](./network-native-ipv6-observation.md)取得真实 IPv6 / CN / AS4837，回显 IP 等于应用 socket 源地址；NetLog 精确请求图与唯一 Windows Established owner 一致，以实际源地址查路返回物理接口 12。当前 AAAA 原 TTL 305 秒，未倒填；echo 至 geo 正文完成约 4.17 秒，保持真实工厂 12 秒总上限。仅 1 echo + 1 geo，无账号/窗口/配置修改，18 个生产源码摘要、OS/控制器前后摘要一致，清理完成。这是 `normalDns=false` 的独立强制解析 profile，不能自动等同正常账号传输或从报告恢复 q；下一步审核正常 IPv6 分支的适用性并接入已有实时准备流程，不重复只为显示成功的探针。正式 observe 与许可状态未改变，旧失败记录保留。

11:28 DNS 对比推进：[一次隔离 Chromium／内核地址族对比](./network-resolve-host-family-comparison.md)中，API6 与 B 站默认 `resolveHost()` 各只返回一个 IPv4，显式 AAAA 各返回 `ERR_NAME_NOT_RESOLVED`；同轮内核 AAAA 分别有 1 个与 4 个 IPv6 候选，原 TTL 在对比时仍有效。共 4 次 Chromium DNS、2 次内核 AAAA、2 轮本机控制器读取，无业务 HTTP、账号、NetLog 或配置变更。Chromium TTL 未暴露；空 IPv6 集合虽是内核集合的数学子集，不能成为地址族资格。原生控制器连接关闭未观察，清理记录只承诺明确列出的 Promise 与 Session 范围。本轮另取得[只读 IPv6 路由覆盖库存](./network-native-ipv6-route-coverage.md)，它没有把特殊目的或不同源地址自动列入公网路径资格。

11:31 生产修正：已审核 real resolver 分支允许非空、合法、无重复的传输地址子集；全部当前内核候选仍逐个查路，未选中候选的路由不合格也使整轮拒绝，TLS/出口采样零调用。新增 10 项回归，路径适配器 157 项通过；fake 映射、规则、期限与 profile 审核不变，未因此接通正常 profile 或启用 strict。具体边界与验证历史见[本轮记录](./network-resolve-host-family-comparison.md)。

最新完整验证：11:31 全量 **83 个测试文件、2720 项通过**，typecheck、lint 通过。首次全量为 2719 通过、1 项测试超时：`effective-config-source.test.ts` 的 stalled decoder 用例使用真实 30 ms 定时器，可能在 decoder 进入前触发，导致等待进入的测试达到 5000 ms 超时；只将该测试改为进入 decoder 后推进受控假时钟，目标文件 41 项及全量复跑通过，没有修改生产超时策略。此前 09:16 的 2710 项与 CRLF diff 检查、09:17 窗口冒烟、来源运行时 19 项、显式准备拒绝 25 项，以及实际本机 TLS 的 HTTP/1.1 44 项、HTTP/2 50 项保留各自验证时间。08:27 生产匿名双流物理收集器单次公网实测 **15 项通过**，08:09 三类实际入口的本机有限对照 **18 项通过**。8 组精确内核 IPv6 fake-IP 实验、3 配置 × 5 分支 DIRECT 族实验保留原范围与时间。正式应用仍为观察模式，尚未取得可用的完整路径资格。

**当前已完成阶段 1、阶段 2 观察基础，以及阶段 3 门闩核心与业务接线；正式主入口使用 strict 互斥策略。** 该入口按系统代理/TUN 状态切换国内与国外资格，未知状态保持闭闩；它不等同于真实六平台登录或国际 API 业务验收。采集使用持久任务队列、即时受理和取消界面，国内休眠时不因网络问题改写登录结论。

主入口现已接入配置来源生命周期门面和明确目录设置；observe 在门面内拒绝接收证据。当前来源补充有限政策明细、基于显式 fake-IP 范围的候选分类，以及生产路径输入的系统 hosts 前后核对。严格组件已补上到期前来源续读，避免首轮取证被来源过期反复清掉；它不延长旧证据，不在观察模式自动发起续读。默认组件现有显式准备入口和原始资格组合器，正式主入口仍缺完整审查与准备窗口，不能把“来源能读到”或“地址不是 fake-IP”理解为已能给账号签发许可。

## 已落地的代码

| 范围                | 已实现                                                                                                                                                    | 边界                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 国内/国际类型       | `CN_PLATFORM_IDS`、`CnPlatformId`、独立国际 ID；国内账号创建/读取/导入的运行时断言；导入分区由本地 UUID 重建                                              | 现有 `PlatformId` 仍限国内；没有新增国际账号分区或 API                                                                     |
| 凭据                | SQLite 版本 2 `credentials` 密文表，主进程 `CredentialVault`，safeStorage 加密；渲染层只有元数据/写入/删除 IPC                                            | 不提供秘密读取 IPC；不可加密拒绝保存；解密失败保留原密文                                                                   |
| 备份                | 显式业务 DTO schema；导出、读入、应用再次校验；v1/v2 导入先验原校验和，再规范化字段                                                                       | 不读取凭据表；不收网络配置/运行许可/活动队列；旧 settings 私有字段不能导回                                                 |
| 设置边界            | 普通设置按白名单读取/写入；公共网络配置独立保存；控制器只接受本机字面 IP 地址                                                                             | 禁止地址携带凭据、路径、query、重定向和端口 0                                                                              |
| 观察器              | 当前内核 `/configs`、`/rules`、`/version`、实际 `/proxies/DIRECT` 稳定策略元数据，有序规则子集，匿名 Chromium 双路采样                                    | 四个响应任一失联使本轮不可用；可见版本变化撤证，仍不等于完整 DNS/hosts 配置证明                                            |
| 会话入口            | 无视图 `checkStatus` 改经 `configureAccountSession()`；启动为全部账号注册 Session；单个请求监听器同时承载观察和门闩策略                                   | 当前网络策略为观察；生产 `strict` 分支已由本机接收端测试，未对真实账号启用                                                 |
| UI                  | 顶栏、网络设置、匿名出口、候选规则复制、凭据输入；可见“观察模式 · 尚未拦截”                                                                               | 不合格/未验收不会亮出允许灯；输入的秘密只短暂用于写入 IPC，提交后立即清空                                                  |
| 状态                | `AccountNetworkState` 只走主进程内存、IPC、renderer 内存；序号/实例/有效期校验                                                                            | 数据库仍叫 `status`，语义是登录状态，不增加 `authStatus` 或 `dormant` 数据库状态                                           |
| 证据失效            | 控制器失败、规则变化、重配置、系统挂起/恢复、stop 清旧结果；独立 epoch 防止 A→B→A 迟到结果；Gate 用单调时钟主动过期                                       | `strict` 撤销实测使用合成凭据和测试证据，不代表已经取得真实平台的出网证明                                                  |
| Windows 网络代际    | 主进程只读接口、全部 ActiveStore 路由、DNS，内存散列；变化/失联立即撤代，两次稳定采样后才恢复取证资格                                                     | 含具体目标路由；读取超时/超限也不可用；轮询不等于路由锁，稳定不等于 DIRECT                                                 |
| 当前连接证据        | `ClashReader.readConnections()` 精确 host 范围；源地址/端口、目标、入站、路径散列、生命周期匹配；DIRECT TCP 的真实目的 IP 独立保留                        | 非生产签发器；缺失/冲突/歧义/过期拒绝，不用 TCP 表单一候选冒充请求归属；路径散列不是二进制证明                             |
| 规则证明来源        | 新增 `current-ordered-rules`，保留 `correlated-connection`；实际解释当前规则并核对真实 Direct 出站及独立路径记录                                          | 不再要求每目标每轮必有连接记录；缺出口、DNS、路径适用性或地址族依据仍拒绝                                                  |
| Windows TCP 读取    | 固定命令、范围限定的 PID/远端地址端口、进程创建时间和路径身份；受控窗口关联器                                                                             | 生产输入模块已实现；TCP 表不提供 Session 归属，不能用单一候选推断业务请求身份                                              |
| 壳远程资源          | 壳守卫 strict 拦远程 HTTP(S)/WS；新增主进程受控图片缓存、local/null DTO 和本地 remote 协议；严格入库及所有模式备份清除原图片引用                          | 观察模式保留原显示行为；生产媒体用途与 Session 路径尚未审核，缓存授权返回 unreviewed，无无门闩图片代理                     |
| 当前配置来源        | `EffectiveConfigSource` 只读前后文件核对，同轮 controller 共同字段与完整有序规则比较；显式 YAML/解码器、短 TTL、单飞、变化撤代                            | 已通过明确目录设置接入主入口来源门面并实测返回 candidate；不是路径资格或业务许可                                           |
| 操作目录            | 6 平台 × 8 操作；真实操作、已有页面与导航目标独立声明；主入口已选用构建绑定的有限审核解析器                                                               | 仅 B 站无页面 check-status 的客户端行为已审核；有页面、扫码、采集、上传及其它平台仍未审核，目录本身不提供出口许可          |
| 匿名 TLS 输入       | 有界非持久 Chromium 池、固定公开轻请求、无凭据、拒绝缓存/不可信证书；撤销与清理失败不能复用                                                               | 已由本机 HTTP/1.1 与 HTTP/2 接收端验证；只输出 TLS 观察，不推断 DIRECT、出口、地址族                                       |
| 续证协调            | `ProofCoordinator` 已接正式 bootstrap、Runtime ready scope、来源门面与 Gate 当前网络版本；Issuer 按账号合并、两轮新样本、单调截止提前续证                 | observe 门面拒绝签发；真实资格缺失时不进入采样。清理未完成不能更换来源，未签发真实账号许可                                 |
| 内核生命周期        | `WindowsControllerOwnerReader` 固定只读命令核对当前控制器监听、PID 和精确创建时间；主入口新增绑定当前控制地址的生命周期观察                               | 实机只读成功；路径不可读时保留 null，不把空路径变成摘要；切地址及旧异步结果不能保留可用状态                                |
| 内核 DNS            | `KernelDnsReader` 使用当前内核 A/AAAA、真实 Question/Answer、CNAME 与 TTL；前后控制器版本相同才保留候选                                                   | 已适配本机 Go DNS Question 格式；缺族、fake-IP/地址类别未知仍明确不可验证，不能据此推断 Chromium 最终解析                  |
| 同轮输入            | `PathInputReader` 组合真实配置、owner、OS、DNS 和分批路由；检查原始读取窗口、代际、来源及期限，取消时保留真实槽位                                         | 已接受控组合工厂；当前缺资格时不会调用。既有 observed 和 INPUT_EXPIRED 实测均不是 DirectProof                              |
| 原始匿名出口模块    | `AnonymousEgressProbe` 固定匿名回显与同 IP 地理查询、有限 Session 池、实际单调截止和撤销；50 项模拟测试，已有隔离实际工厂采样                             | 未接 bootstrap 或取得完整物理路径关联；报告 IP 的族不等于 socket 族，同 URL 主进程客户端证书事件存在归属歧义，详见模块说明 |
| 路径适用性校验      | `route-applicability.ts` 核对实际当前规则、Direct 策略、各目标候选地址、物理路由类别及保留的资格记录                                                      | 不能用 TUN 查路或非空 evidenceId 冒充物理出口和外部事实                                                                    |
| 证据组合来源        | `ProductionProofSource` 与 `PathConformanceAdapter` 已接通，复用同轮输入、批量源地址限定查路，并重新绑定缓存样本                                          | 可用真实路径资格尚缺，Source 未装入正式 bootstrap；正向模块测试不是公网签发                                                |
| 配置来源关联        | `configuration-association.ts` 将预先选定的已知加载方式与当轮 source/controller/owner/OS 关联；已完成本机真实只读组合                                     | 保留观察模型支持假设和 runtimeConfigurationProven:false，不把文件一致冒充完整运行 payload 证明                             |
| 指定源地址查路      | 路由读取器新增显式 localAddress 的只读查询，并以独立 basis 与普通/TUN 路由区分                                                                            | 实际 OS 验证可读且来源相符；它不修改路由或证明某个 socket 使用了该源                                                       |
| Chromium 协议约束   | 主入口在 app ready 前调用统一启动模块关闭 QUIC，保留主进程启动事实                                                                                        | 已通过本机 UDP 阳性对照；只约束 Chromium HTTP 传输，不证明 DNS、地址族或大陆直连                                           |
| 已选客户端适配      | `SelectedClientConfig` 固定当前猫猫云版本/源码摘要，使用 Electron 原生 ASAR 与纯数据解码，经来源门面接主入口                                              | 当前本机 12 项实测及来源运行时复验通过；保留已知加载方式假设，不执行客户端 JS，不提供默认路径资格                          |
| 有序规则参数        | 当前源保留逐行参数及指纹；解释器新增明确目的地址阶段与 IPv4/IPv6 CIDR                                                                                     | 参数缺失、阶段未知或需要未提供的解析时仍 unknown；上层尚未提供真实阶段，不扩大正式放行                                     |
| Session DNS 清理    | 严格初始化按 direct→关闭连接→清解析缓存；撤销等待页面/worker 停止后最后清 DNS；匿名工厂每轮发前清理                                                       | 清理失败继续闭闩；不清账号 Cookie，不构成 DNS 路径等价或 IPv4 约束                                                         |
| 请求与 fake-IP 对应 | 有界 NetLog 请求图、实际 Windows 四元组、本次内核入站连接和原 TTL 内的 DNS 对应；路径适配器新增独立 fake-IP 分支                                          | 本机 TLS 日志已验证解析；映射不等于大陆出口、物理 socket 或业务地址族约束，生产资格仍未安装                                |
| 短 TTL 与后验时间   | 末次 DNS 移到较慢的系统复核之后；保留资格的审核完成时刻与原请求有效期分开                                                                                 | 不延长 DNS TTL、不倒填审核时间；当期输入过期、代际变化或缺少独立路径事实仍拒绝                                             |
| 原始双流收集        | `AnonymousPhysicalRouteCollector` 使用真实匿名工厂、私有 NetLog、每流新 DNS、原生 TCP 与精确自身连接关闭，保留两条物理路径配对                            | 15 项单次实测通过；原样本不给 q/许可，不代替大陆出口、其它地址族或正式账号流程                                             |
| 路径资格组合        | `ObservedPathQualificationProducer` + `PathQualificationLifecycle` 组合明确审查与实际原观察；每组 resolver 保留独立原输入，真实清理后再核对版本/审查/期限 | 诊断目录缺项在采样前拒绝；实际主入口仍没有可安装的完整审查与全部地址族资格，不能恢复报告 JSON                              |

匿名直连 Session 和业务工厂的严格分支均等待 `setProxy({ mode: "direct" })`，紧接着等待 `closeAllConnections()`，再等待 `clearHostResolverCache()` 后完成初始化。重用的匿名采样 Session 每轮发前也清解析缓存。撤销时先关连接并停止页面/worker，待两者完成后最终清 DNS，避免页面销毁期间补回旧缓存。这些清理**不能绕过 TUN**。当前观察模式不修改业务 Session 的代理设置。

## 实测结果

1. [Electron 取消实验](./network-stage2-experiments.md)：锁定 Electron 43.3.0 / Windows，23 项新请求取消测试通过。分区合成 Cookie、页内 fetch/XHR、session.fetch、资源、重定向、SW fetch、WS 握手都同时核对受控接收端，未发真实账号凭据。
2. `closeAllConnections()` 和 `offline:true` 不能单独终止已有响应流/WS。主进程 fetch 需要 AbortController；关闭 WebContents 可截断本次 renderer 上传和 WS；已排队字节仍可能继续到达。
3. 清除 `serviceworkers` 存储在 fixture 中终止了后台 worker 活动并保留 Cookie，但属于注销，不能当成平台无副作用的暂停。
4. [真实进程归因](./network-stage2-process-context.md)：页内 fetch、session.fetch、独立诊断 Session、Electron 内嵌 Node HTTPS 的四条新连接均通过实际源端口匹配 mihomo `/connections`。本次开发版均是 `electron.exe`、DIRECT、Tun。相同公开目标的匹配不能互认证其他目标或打包版。
5. 同一机器匿名采样：direct/proxy 访问 myip 均为 CN/IPv4；访问 Cloudflare 均为 JP/IPv6。**`setProxy(direct)` 不是 TUN 绕行；连接 mixed 口也不保证目标走海外代理链。** IPv6 端点出口已观察，本机原生 IPv6 和平台目标路径未证实。
6. [真实规则结果](./network-stage2-live-rules.md)：用户授权合并后，当前 rule+TUN 内核载入 **3341 条规则**，原 3311 条保持顺序，新增 30 条 DOMAIN DIRECT 位于首条 IP-CIDR 前。30 个候选均可解释到 DIRECT，重载前后 `/configs` 深比较一致。已保存原密文备份；未测试订阅刷新或客户端重启的覆盖行为。
7. [六平台匿名登录资源](./network-stage2-login-catalog.md)：观察到 56 个平台与 host 的关联；快手 13 个注册范围外 CDN 和抖音额外脚本被取消；完整登录清单仍为 0 份，HTTP 200 不能冒充扫码完成。
8. [生产模块集成实测](./network-runtime-smoke.md)：最新 **44 项通过**。直接加载本次生产 Runtime/Gate/Session 钩子和业务 fetch，隔离 Session、本机 TLS、合成 Cookie；闭闩时受控接收端零到达，两轮测试证据后可达，单任务取消和门闩撤销均实际断流。生产匿名工厂保留默认 TLS 验证；fixture 仅对本机端点、端口及证书指纹临时固定证书，另验证默认不可信证书拒绝。初始化重置覆盖旧 fixture 证书固定导致的失败结果已保留。测试证据不能用于真实业务放行。
9. [打包进程实验](./network-packaged-process-context.md)：`app.isPackaged=true` 的临时同名打包壳与开发版各四条匿名连接完成归因；内核看到的进程名由 `electron.exe` 变为 `短视频矩阵工作台.exe`。实验用隔离入口，不等于正式产品入口和最终安装路径已验收。
10. [登录目录补证](./network-stage2-login-catalog-followup.md)：从官方 HTML/显式脚本引用核实 4 个额外静态 host；两平台合计 25 个 host 关联，其中 8 个是本轮新增。快手其余 11 个待查目标未提升为允许清单，没有完成扫码/验证码/轮询闭环。
11. [证明来源实测](./network-stage2-proof-issuer-evidence.md)：无 NetLog 的 Windows TCP 表＋CDP 在受控单连接环境可关联源端口；两个 Session 同目标的歧义反例拒绝。mihomo `remoteDestination` 是 DIRECT 的真实拨号目的地址，不能当公网来源 IP。NetLog 跨 Session 记录 query 已实测，禁止生产续证靠它写盘。候选 DNS 中 2 个当前 NXDOMAIN，不能把全部候选当必需域名。
12. [Windows 网络观察器](./network-windows-fingerprint.md)：固定命令只读采样成功，约 1.3 秒；主入口已接变化撤销、挂起/恢复和退出生命周期。`Runtime.networkReadiness` 在 strict 下缺失/不可用时默认拒绝；稳定状态只让后续重新取证，不能复活旧证明。
13. [HTTP/2 生产模块实测](./network-runtime-http2-smoke.md)：最新 **50 项通过**，包含同一 H2 连接上的多路响应和 8 MiB 合成流式上传。实际销毁后上传被 reset，未完整收到预定请求体，后续字节停止增长；撤销前已排队字节可能继续到达。首次把 readable end 误判成完整上传、以及后续 fixture 证书设置被生产初始化覆盖的失败记录分别保留，没有改写历史结果；最终 fixture 的精确证书固定只在隔离实验中启用。
14. [Windows TCP 输入模块](./network-windows-tcp-sockets.md)：42 项单元测试及本机只读 loopback 实验通过，真实读取约 2.4 秒；只作为独立取证输入，不发许可证。
15. [源码业务目标清单](./network-business-target-inventory.md)：38 个 collector URL 候选、6 个登录探针，固定 API 涉及 7 个 host，均在首批 30 条规则内。源码目录与完整运行流分开；候选中的失效域名、未用官网和可选验证码不能全部变成每次采集的必需目标。壳头像/封面的默认 Session 远程图片路径已由独立 strict 守卫收口；observe 保留原有显示，strict 图片失败时 Avatar 使用文字回退，三个作品入口均使用封面占位。

16. [有效配置来源](./network-stage2-effective-config-source.md)：00:28 只读确认当前密文仍匹配已知加载来源、3341 条规则同序一致、11 个共有配置字段无差异，前后状态稳定。必要 DNS/hosts/sniffer 与 OS hosts 摘要已实际取得；缺项保留未知。按观察信任模型可以继续核验当前配置，不能从历史报告自动签发许可。
17. [IPv6 反例](./network-stage2-af-counterexample.md)：两条无凭据公开轻请求中，正常 DNS 样本经 IPv4 关联到 Tun/DIRECT，临时强制本次真实 AAAA 的样本通过 IPv6 成功，但未找到可匹配的 mihomo 连接。因此全局 ipv6=false 不能单独证明整个 Chromium 路径只走 IPv4；没有匹配也不能直接认定绕过 TUN 或取得大陆出口。
18. [正常 DNS 的 IPv6 回显](./network-stage2-ipv6-egress-candidate.md)：追加仅一条 api6.ipify.org 回显与一条地理查询，返回来源被核对为 JP / AS215355；请求没有取得独立 socket 来源归因，不能给业务目标复用，也不能称为 native 或 mihomo DIRECT。未强制解析、未重试，不发真实账号凭据。
19. [图片缓存生产模块](./network-remote-media-smoke.md)：Electron 43.3.0 / Windows **22 项通过**。同一 Session 的普通 include 与媒体 omit 实际并发，接收端确认图片请求无 Cookie/Authorization/Referer，Set-Cookie 不入分区；Basic 认证缓存已实际建立，媒体未复用。重定向无第二跳、撤销结束响应流且不提交缓存、nativeImage 生成 PNG、本地协议无网 miss 均通过，最终源码哈希一致。许可仅为本机合成测试依赖，不代表真实 CDN 或大陆出口验收。
20. [同轮通路输入](./network-path-input-reader.md)：02:30 当时版本的只读复验约 5.43 秒，配置、内核生命周期、OS 与目标地址集前后一致。初读 1 秒 DNS TTL，末读由运行内核实际刷新为 54–248 秒，按原有 15 秒候选上限截断后取得 observed；没有改 TTL。首次完整测量因末次 DNS 在 owner 复核期间过期而返回 INPUT_EXPIRED，原结果另行保留。两次都没有账号、公开 HTTP(S) 请求或配置修改，也没有许可；DNS 查询由实际运行内核处理。之后增加的地址族范围优化另经模块测试，没有把本次旧源码读数标成新版的公网验收。

21. [B 站无页面登录检查](./network-bilibili-check-status-smoke.md)：最新 **45 项通过**。真实 AccountService、login-detector、Session 工厂与 Runtime 接线，仅用本机 TLS 和合成 SESSDATA/bili_jct。实际发现并修复挑战页误上线、节流时错误刷新验证时间，以及 Electron Session.fetch 缺最终 URL 的兼容问题。B 站主进程改用同一 Session 的有界 net.request，逐跳核对 origin/门闩；实际同源重定向成功，跨源第二跳与凭据均零到达，撤销不写回状态。原 11/44 项及各失败记录分别保留，不代表真实 B 站出口或扫码验收。
22. [最小操作范围](./network-minimal-operation-scope.md)：B 站 `check-status` 在无既有视图时只需源码实际使用的 `api.bilibili.com:443`，不用未调用的首页或创作者页代替验收。匿名公开 TLS 观察不提升完整流程的 `flowReviewed` 标记。
23. [生产来源真实预检](./network-production-source-preflight.md)：使用真实 ProductionProofSource 与当前本机控制器；B 站 API 命中 DIRECT，两个固定回显目标仍在前置 IP 规则处不可验证。来源在后续输入、路径关联和匿名 HTTP 采样前拒绝。测试目录标记仅为越过目录前置检查的显式 fixture，正式目录和配置没有改变。

24. [当前配置来源关联](./network-configuration-association.md)：实际核对当前客户端静态加载路径，读前固定所选契约；新的 PathInputReader 轮次约 4.46 秒，关联成功、当前验证成功、复制对象拒绝。首次实测暴露消费端误拒 sourceGeneration=0，已按真实生产者约定修复并保留失败记录；没有给候选运行 payload 或出口补 true。
25. [源地址限定查路](./network-windows-route-selection.md)：03:34 对实际内核返回的 B 站 API IPv4 候选，普通查询返回 TUN index 59；指定实际 OS 物理源地址后返回物理 index 12。两类结果有不同 basis/scope，主路径采样明确拒绝混用。没有创建测试 socket 或发公开 HTTP。
26. [真实匿名工厂调查](./network-anonymous-factory-path.md)：仅三个 host 各一次，TLS 工厂取得 API 公开 200，Egress 工厂取得匿名 CN/AS4837 IPv4 回显。隔离 NetLog 中的精确请求依赖和源 tuple 可与 mihomo 新连接对上；这仍是 Chromium→TUN 关联。生产 Windows TCP reader 当时因内核 Path 字段不可读而失败，没有取得物理出站归因，也没有因本次 DIRECT 连接跳过当前规则 unknown。
27. [TCP 原生 owner 读取修复](./network-windows-tcp-sockets.md)：复用限权 Win32 方法读取真实 PID 创建时间和路径身份。无公网复验中 TCP reader 成功，内核身份与 ControllerOwnerReader 完全一致；受限 loopback 范围没有 socket。随后独立进行下一项复跑，原失败调查未改写。
28. [修复后的匿名工厂调查](./network-anonymous-factory-path-native-owner.md)：三个 host 各一次；真实请求、Network Service socket 与 mihomo 入站 tuple 均匹配。两条内核物理出站候选分别以实际 sourceAddress 查路，都返回物理接口 12；仍未把唯一候选等同于流归属，资格保持不可用。未修改配置，原失败记录保留。
29. [QUIC 受控对照](./network-quic-constraint-smoke.md)：**13 项通过**。页内 fetch、session.fetch 和 net.request 在对照组各发出 6 个实际 QUIC Initial UDP；保留相同强制测试参数并调用生产启动约束后，三种入口各 TCP 200 一次，UDP 为 0。全部位于隔离本机 TLS/UDP 接收端，无公网请求或 OS 修改，不提升真实通路资格。
30. [路径适配器](./network-path-conformance.md)：**53 项模块测试通过**，包含实际 ProductionProofSource 的复制对象调用、真实配置关联和路由校验器、双族范围及旧出口样本重绑。原资格版本先核对，原采样时间不重写；同步撤销不能恢复缓存，取消后保持底层读取槽位直到结束。生产默认使用真实 Windows 查路和 Chromium 启动事实；缺实际保留资格时返回不可用，当前候选未被升格。
31. [首条有限目录](./network-reviewed-operation-catalog.md)：主入口已明确选用仅 B 站无页面 check-status 的审核解析器。固定绑定 8 个客户端实现摘要、选择键及 Electron 版本，11 项实际构建注入测试通过；其它操作仍未审核。这项接线没有安装 Source 或改变 observe。
32. [已选客户端工厂](./network-selected-client-config.md)：22 项单测与当前 Electron 12 项实测通过；原生 ASAR、固定客户端原文数据解码、3341 条运行规则比较成功。过期、修改、失联、取消与通知重入均撤销 selection；输出仍为 candidate，不是路径资格。两次 ASAR 类型误判失败记录保留。
33. [规则目的地址上下文](./network-rule-destination-context.md)：规则与来源模块合计 104 项测试通过。`no-resolve` 在已知真实目的 IP 时仍匹配，明确尚无目的 IP 时才跳过；DNS 答案不能直接冒充该阶段。当前 myip 可继续补真实上下文；api6 的未决/REJECT 分支没有变成 DIRECT，两条额外诊断规则未应用。
34. [匿名双流物理归因](./network-anonymous-flow-lifecycle.md)：最后一轮两次匿名 TLS 请求、两次精确自身连接 ID 关闭，分别观察到 A 单独退出、B 保持，再关闭 B；持有窗口全程有效。两条已配对物理 socket 均以真实源地址查到接口 12；原两轮前置/时序失败独立保留。这是当轮 TLS 工厂 IPv4 观察，未补出口回显、DNS、其它地址族或账号传输等价，也不要求生产每轮 NetLog/关闭连接。
35. [DNS 缓存实测](./network-dns-cache-smoke.md)：Electron 43.3.0 / Windows 6 项通过，一次匿名 A 查询、无 HTTP。关闭连接后仅本地查询仍命中旧 DNS；显式清解析缓存后为 cache miss。启动脚本初版的 ready 等待未完成记录保留。实际 API 行为不等于路径等价；对应生产清理顺序和失败/取消回归已落地。
36. [当前规则入口调查](./network-rule-entry-policy-audit.md)：05:02 的只读来源/控制器投影 15 项通过，无公开 HTTP 或额外 DNS 查询。myip 域名规则前实际有 148 条 IP 规则及进程规则；fake-IP 和 sniffer 成功/失败可留下不同目的阶段。仅凭当前开关不能删除这些分支。全规则源参数、上下文与分支结果现已完成生产组合接线，真实匹配阶段生产者仍缺事实。
37. [正常 DNS 出口路径复核](./network-anonymous-egress-ipv6-path.md)：05:07 修正轮仅发两次匿名请求，出口模块成功返回 IPv6 地址、JP / AS215355；实际应用 TCP 为 IPv4，精确对应新的 mihomo 非 DIRECT 入站。11 份脱敏阶段记录保留，源码与环境未漂移。它不是大陆 IPv6 或原生 IPv6 直连资格；首轮脚本未回传完整结果的失败记录另行保留。
38. [来源生命周期只读实测](./network-proof-source-runtime-smoke.md)：05:38 的真实 ProductionProofRuntime 与默认组件 16 项通过。明确选择既有目录，一次来源读取、4 个本机固定 GET，3341 条运行规则同源一致；observe collect 拒绝，Session/DNS/公开请求尝试均零。正常退出与 28 个源码摘要一致；没有加载路径资格、账号或旧报告。

39. [有限政策明细](./network-source-policy-details.md)：当前根配置只投影有界 DNS、hosts、sniffer 字段，缺项/未知不补默认。58 项投影及 41 项真实 YAML 来源回归通过；DNS 候选分类 107 项通过。当前文件零网络复核显示 IPv6 fake-IP 范围和过滤模式缺失，过滤/跳过列表仍有不支持条目，不能提升为完整解析或规则入口证明。
40. [系统 hosts](./network-windows-system-hosts.md)：默认系统文件 11 项真实只读检查通过，三个固定目标没有映射；41 项 reader 测试覆盖解析、变化和实际读取清理。生产输入现已前后读取并纳入当前关联、保留资格与生命周期；文件变化、测试来源或旧半轮不能复用。无条目不证明解析器使用该文件。

追加验证（2026-09-08 06:01，Asia/Shanghai）：当前完整执行 **74 个测试文件、2044 项通过**；`typecheck`、全仓 `lint`、`git diff --check` 和完整 Electron 窗口冒烟通过。本轮新增有限政策投影、显式 fake-IP 候选分类、系统 hosts reader 及其前后输入/关联/保留资格/退出接线。四处接线独立复核未发现阻塞问题。05:58 的真实来源运行时复验仍为 16/16，通过 31 个当前源码摘要核对；一次选定源读取、4 个本机 GET，未创建账号/匿名 Session、未发 DNS 或公网探针。另两份文件只读实验没有网络请求，没有更改 mihomo 或 OS 配置。正式运行仍 observe，实际资格缺省；renderer 既有大 chunk 提示仍在。

## 尚不能越过的阶段 2 门槛

- 30 个初始目标的真实规则匹配已通过；新发现资源、API 和验证码的具体目标仍须分别解释，不能借用首批 30 个目标的结论。
- 六个平台登录、验证码、轮询、API/CDN 的完整资源清单尚未经过平台兼容性验收。现有 30 个候选只来自仓库元数据，不是已冻结清单。
- 已取得开发版、隔离打包壳与一个匿名 B 站目标的局部进程/socket 结果；正式产品入口、生产并发、六平台路径及所有可能地址族仍未形成一致性结论。
- 当前出口回显/地理查询只是匿名诊断，不是绑定实际业务 host/传输上下文的证明签发器。
- 当前 DIRECT 的实际物理接口/地址族约束、目标与回显端点的出口适用性仍缺证据。按[最小证据政策](./network-stage2-issuer-policy-decision.md)继续验证现有规则配置；完整官方源码身份、每目标公网回显和每轮连接关联不是冻结规格的必要条件，也不能因此给路径适用性补一个 true。
- HTTP/1.1 与 HTTP/2 的生产模块隔离验收、当前构建的 QUIC 关闭对照已通过；真实路径的 DNS/地址族、平台上传、ServiceWorker 注销后恢复等仍需分别验证。

因此界面的验收项继续显示未完成，四态中的“已合格国内/海外”不会因一次匿名探测而变绿，也不会把“未证明”显示成物理断网。

## 阶段 3 核心已实现、尚未启用

1. `direct-proof.ts`、`egress-gate.ts`：目标/协议/端口/地址族、传输上下文、规则版本与 generation、短期有效期；单调时钟主动撤销；两轮独立新采样才唤醒，改 sample ID 不能给旧观测续命。默认目录未审核；未提供已验证族解析器时，对真实 URL 同时检查 IPv4 与 IPv6，任一不合格即拒绝。显式解析器返回空值/异常/错目标仍拒绝，不能转成默认放行。
2. `runtime.ts`、`session-observer.ts`：Session 生命周期统一管理；单个请求监听器覆盖全 partition，视图释放不卸载；启动未就绪即关闭；初始化和撤销清理完成前不能恢复许可。
3. `business-access.ts`、`gated-session-fetch.ts`、`page-evaluation.ts`：导航、无视图探测、启动巡检、profile、account-online、采集/保活、打开上传与挂文件使用统一检查；请求 lease 保留至响应体/页面计算结束。强制销毁后未返回的 Electron Promise 由主进程结束。
4. 撤销先关闭 Gate/abort lease，再停调度、关闭账号全部已知视图（含 LRU 已移出的视图）、清 ServiceWorker 与连接；明确等到 destroyed。任一步失败保持闭锁。旧回调不能写登录状态、资料/指标或重试入队。清 ServiceWorker 属于注销，真实平台兼容性仍未验收。
5. `cn_jobs`（数据库版本 3）保存采集任务，IPC 立即返回 ID；账号重复触发合并，重启恢复、等待网络、取消可见。数据/采集记录/任务完成事务提交。登录失效账号不随网络恢复采集；不自动登录、挂文件或发布。
6. 删除、重置、备份替换在数据改变前撤销任务和 Session；同 UUID 不得跨平台复用，包括运行时已退役 Session 的身份。观察模式下重建期间也禁止新探测；退出后刷盘依据工厂持有的 Session，不依赖已销毁视图。
7. `RequestAudit` 复用现有审计仓库，只写脱敏 host/资源类型/原因/generation，按时间窗口限量取样；不含 path/query/header。其记录数不能作为物理包计数。
8. `windows-network-fingerprint.ts` 纳入 Windows 网络变化。全部活动路由、接口和 DNS 只在内存计算散列，不进 renderer/备份。网络读取不稳定时，业务检查和 lease 结果提交都拒绝；观察模式仍保持原有业务行为。
9. 启动/退出竞态已收紧：壳加载结束后检查退出标记与 Runtime 身份，不能重启已销毁实例的观察器/调度器；清理期间重复 quit 继续等待，只有清理完成才放行退出。该调整后再次通过 typecheck、定向 lint 与 Electron 窗口冒烟。
10. `shell-network-guard.ts` 在默认 Session 首次加载前安装，生命周期跟随 Session。严格策略拒绝直接加载远程头像/封面等资源，异常默认关闭，不输出可能含签名的 URL。真实本机 TLS 接收端已确认 strict 请求零到达、同一传输下 observe 正常收到请求；账号 Session 的允许/撤销测试继续通过。没有修改阶段 2 的业务取消行为。

11. [ProofIssuer/ProofCoordinator](./network-proof-issuer.md) 已接正式启动/退出、ready scope、当前 Gate 网络版本和来源门面；默认通过 Gate 单调截止提前续证，最小续证间隔 3s。采样失败即使触发清理/重新 upsert，也保留 10s 退避。正式策略仍 observe，实际资格缺省，没有生产签发结果。
12. [匿名 TLS 采样器](./network-anonymous-proof-probe.md) 与[操作目录](./network-operation-catalog.md)已实现并经过模块验证。钩子安装失败的匿名 Session 仍计入池；连接清理失败不能因并发复用而继续请求。注册账号不再隐式声明首页取证范围，真实外层操作明确声明所需目标，候选验证码/未用官网不会全部变成必需域名。
13. [当前配置新模块实测](./network-effective-config-source-live.md)：01:05 新读数返回 candidate，3341 条完整规则同序、30 个初始目标 DIRECT、20 个共同 JSON Pointer（11 顶层字段）相符，前中后稳定；没有改配置、重载或发账号请求。文件候选明确不是许可。

14. 账号外层打开/导航/检查/资料刷新、采集/保活、发布助手均先声明真实操作再检查许可；休眠只读已有页面 origin 供取证，不读 Cookie 或调用业务 probe。采集内部 pageFetch 不反复切范围。历史前后退先读真实目标并验证国内 host；切回已有登录视图不再额外要求或加载未用首页。
15. 受控 Electron 实验已通过真实 ProofCoordinator → Issuer → Gate → Runtime 通路注入两轮明确标记的测试证据，并实测停止协调器会同步撤权和结束在途请求。生产 source 仍缺省；测试来源无法用于真实平台。
16. [通路来源收口](./network-path-source-readiness.md)确认两个当前回显目标先遇未决 IP 规则；它们的历史 DIRECT 连接不能替代当前规则依据。[两条诊断规则补丁](./network-stage2-diagnostic-direct-candidates.yaml)已准备并向用户提出确认，尚未应用；原 3341 条配置未再修改。

17. [Windows 实际查路输入](./network-windows-route-selection.md)已实现并完成只读双遍实测；IPv4 选择 TUN 接口、IPv6 选择物理接口。实际 interfaceMetric 缺项保留 null，不转换为 0；网络指纹也区分这两种读数。Find-NetRoute 不是实际 socket 或公网出口证明。
18. [图片缓存与 DTO](./network-remote-media-implementation.md)已接资料/采集提交、本地协议、IPC 投影、备份和界面占位。严格模式不保存或下发原始头像/封面 URL；缓存下载用途与真实 Session 路径尚未审核，生产 authorize 保持 unreviewed，尚未给真实平台下载图片。
19. 主入口同时检查 Windows 网络与绑定当前控制地址的内核生命周期。`networkConfigure` 提交后同步撤销旧 owner 观察；恢复需要新采样，异步回调再次核对 URL、reader 身份与 revision。`readObservation()` 保留底层实际读取时间，旧 `read()` DTO 仍只有 available/hash；共享在途调用不能更新证明年龄。
20. [匿名原始出口读取](./network-anonymous-egress-probe.md)尚未安装为生产 source。它不读账号 Session，结果只留主进程内存；单调时钟超期即使定时器未运行也拒绝成功。失败 Session 固定占池，不能通过不断重建实例恢复；同 URL、无 WebContents 的客户端证书事件采取拒选并明确保留归属歧义。

21. [当前证据组合来源](./network-production-proof-source.md)已实现正向与拒绝路径。目标、上下文、输入和依赖回调之间使用独立快照；内外异步返回间再次核对撤销和网络代际。出口缓存保留原始观测时间和路径，逐轮重新绑定当前目标；没有通过 mock 一致性记录给正式账号签发。
22. KernelDnsReader 新增真实候选上限；PathInputReader 的 DNS 身份、查路地址及期限按声明 host + 地址族计算，保留完整双族原始答案。无关族变化不误撤有依据的单族范围；默认仍核对双族，缺查询、未知路径或缺单族约束都不产生许可。
23. B 站固定 nav 的认证判断只接受明确 code=0/isLogin=true、明确未登录或 401；挑战 HTML、未知 JSON、空/坏回应保留原身份和真正验证时间。其它五平台现也将未发探测、空/HTML/未知回应与非 401 异常 HTTP 标为 unconfirmed；成功信封沿用现有 collector 的兼容约定，未提升为完整平台接口审核。主进程 unconfirmed 分支在 lease/epoch 检查后返回原账号，不写数据库、不发 account-online 或新增采集任务。视频号主进程 POST 补上 application/json，与页内探测一致。
24. [同轮规则上下文](./network-rule-destination-context.md)已贯穿 Source、路径适配器、路径校验和最终规则证据。原配置关联跨复制保留；目标、操作上下文、传输配置、实际 TCP、输入和所有匹配分支统一核对。未知规则可先读同轮来源参数，但 HTTP 前必须完成判定；显式缺证不回退。规则上下文最短期限贯穿路径、绑定与最终证据，异步绑定后重验原集合。64 项解释器、22 项集合及 17 项跨层新增回归通过；未提供实际匹配阶段或路径资格的生产默认值。
25. [来源生命周期](./network-proof-source-runtime.md)已接启动、设置/秘密变更、挂起/恢复、手动刷新与退出。明确目录通过现有公共网络设置保存；来源失效先撤 Gate，再等待旧文件/PowerShell/控制器工作结束。5 个底层类增加真正的 whenIdle；匿名池跟随应用，换配置不能重置失败槽位。当前保守上下文生产者仅产生 TCP + unknown；没有真实资格或地址类别依据时保持不可用。

26. [来源续读与两轮恢复](./network-proof-source-renewal.md)修复单账号恢复死循环：来源候选先到期会撤掉首轮成功记录，默认第二轮永远来不及。严格组件按真实来源完成时间提前续读，忙槽合并、等待已有维护，旧样本截止时间不变；续读不代替第二轮 TLS/出口采样。真实文件到期、规则改变仍撤销。
27. [当前匿名解析实测](./network-anonymous-resolver-comparison.md)：Chromium 默认解析和显式 A 均返回当前 fake-IP，内核 A/AAAA 返回另一组地址；独立查询不能建立它们与实际请求拨号的映射。最终复核时内核 1 秒 TTL 已过期，按实情保留，未把默认只返回 IPv4 写成单族约束。
28. [其它国内平台登录探测回归](./network-cn-check-status-observation.md)先在真实 Electron、合成 Cookie、本机 TLS 上复现三平台 18 例全部刷新验证时间、9 例误发上线事件，再在修复后验证 18 例全部保留原字段、上线事件为 0。B 站原 45 项重新通过后更新有限客户端审核摘要；其它五平台仍未标为 flowReviewed。

29. [生产匿名链路收集器](./network-anonymous-flow-collector-probe.md)已采用实际匿名工厂回调，完成同轮输入、私有 NetLog、真实 Windows socket、自身内核连接及 HTTP 后环境复核。请求和头部时间由工厂直接记录，不因 Windows 读取而延长；静默窗口、单调截止、撤销代次、实际清理和不同轮输入均检查。独立应用必须提供真实静默窗口，不得在仍有账号业务的进程里直接开启全局 NetLog。07:44 一次实际匿名 B 站请求 12 项通过，不再依赖替换 Session.fetch 的实验方法；收集器不产生 q 或许可。
30. `PathQualificationLifecycle` 增加显式异步准备、同步只读资格入口与真实工作清理等待；取消即时清资格，未结束的旧工作占槽，缺省 producer 仍不可用。31 项测试通过。生命周期骨架不是已完成的实际资格生产者，正式主入口没有因此获得放行能力。
31. [精确内核 IPv6 fake-IP 兼容实验](./network-mihomo-ipv6-fake-pool-compatibility.md)完成 8 组仅本机 DNS 对照。当前二进制与当前控制器版本匹配后，已选客户端工厂生成本轮限时附件，允许将缺省 range6 下的普通 IPv6 答案分类为真实候选；显式 null/空值/非法范围、未知二进制或过期仍不可验证。它不代表 Chromium 只走 IPv4，不提供解析等价、大陆出口或 DIRECT 许可。
32. 兼容附件逐轮更新不再触发 Source/Adapter 重建，避免清掉仍有效的出口缓存。重建按稳定选择身份快照和原资格对象判断；真正换选择、证据或资格仍重建。当前 DNS 分类始终读取最新附件，TLS 每轮新采样保持原策略。12 项回归修前复现 4 项失败，修后通过。本次完整匿名准备耗时约 14.7 秒、77 次本机控制器 HTTP，属于单次准备实测；尚未作为每 URL 或常态续证频率启用，批量准备、合并与时限仍需校准。

接下来仍须完成当前工厂与全部可能地址族的实际审查、大陆出口、六平台完整登录目录，以及媒体用途和实际路径，再为主入口接入有实际用途的启动准备窗口。显式准备不等于证明已经齐全。真实平台兼容性与端到端分流验收未通过前，不启用主入口严格策略，不发布“严格模式完成”或“零外泄”结论。

10s 续证、15s 许可、60s 出口采样仍是出发默认值，未声称经过真实扫码压力测试冻结。调整只能改变数值与合并粒度，不能把历史连接或其他目标的证据提升为许可。

## 可复跑检查

```text
npm run typecheck
npm run lint
npm test
npm run smoke:electron
node scripts/electron-egress-probe.mjs --inspect-clash
node scripts/electron-process-context-probe.mjs
node scripts/electron-anonymous-egress-sample.mjs
node scripts/electron-network-runtime-smoke.mjs
node scripts/electron-network-runtime-smoke.mjs --http2
node scripts/electron-login-catalog-probe.mjs --followup
node scripts/electron-proof-evidence-probe.mjs
node scripts/electron-af-counterexample.mjs
node scripts/electron-ipv6-egress-candidate.mjs
```

Electron 冒烟使用临时数据目录与隐藏窗口，检查 preload/IPC、可见观察提示、系统加密凭据写入/删除及 renderer 无网络许可持久化。实验报告记录其各自运行环境和边界，不以单元测试代替出口验证。

本轮验证（2026-09-08 02:03，Asia/Shanghai）：`typecheck`、`lint`、`git diff --check` 通过；**52 个测试文件、833 项通过**；Electron 窗口冒烟通过，Windows 系统加密实际保存/删除验证通过；生产网络模块 **HTTP/1.1 43 项、HTTP/2 49 项、图片缓存 22 项 Electron 实测通过**，测试结束均核对源码哈希一致。缓存目录不可用的额外窗口实验仍可启动并显示缺图；初版用 renderer.fetch 测本地协议被既有 connect-src CSP 拒绝，随后改用实际 img 路径验证，未放宽 CSP。原始基线为 9 文件、47 项测试，保留通过。构建仍有既有体积提示（renderer 主 chunk 超过 500 kB），不影响本次检查通过。

追加验证（2026-09-08 02:35，Asia/Shanghai）：`typecheck`、全仓 `lint` 通过；**57 个测试文件、1109 项通过**（`npm test -- --maxWorkers=1`）。首次两 worker 全量执行有一个 worker 意外退出，未把不完整执行算通过；单 worker 完整复跑无未处理错误。新的主入口接线通过 Electron 43.3.0 窗口冒烟，观察模式提示、IPC、网络状态不持久化和系统凭据加密正常。上段 HTTP/1.1、HTTP/2、图片缓存是此前已记录的实际验收，本次没有把单元测试计数替代它们或宣称新增模块已完成公网验收。

追加验证（2026-09-08 03:13，Asia/Shanghai）：最终全量 **59 个测试文件、1316 项通过**，`typecheck`、全仓 `lint` 和 `git diff --check` 通过；Electron 窗口冒烟再次通过。证据组合来源 106 项、路径适用性 75 项，包含调用者/依赖可变对象隔离、内外异步返回间撤销，以及 IPv4 映射地址不同 IPv6 拼写的一致拒绝。当前源码实际 HTTP/1.1 44 项、HTTP/2 50 项、B 站无视图检查 11 项均已记录；新来源的真实只读预检 3 项通过且 14 个 bundle 输入哈希一致。该预检结果是“当前规则不可验证时提前拒绝”，不是实际国内许可。应用继续处于观察模式，真实一致性记录生产者、六平台完整流程与阶段 3 上线验收仍未完成。

追加验证（2026-09-08 04:23，Asia/Shanghai）：最新全量 **64 个测试文件、1522 项通过**；项目 `typecheck`、`lint`、`git diff --check` 与 Electron 窗口冒烟通过。B 站当前受控实测 45 项、QUIC 阳性对照 13 项通过；路径适配器 53 项和有限目录构建绑定 11 项测试通过。正式主入口已接 QUIC 启动约束和 B 站无页面状态检查的有限客户端目录；实际 Source 尚未安装，仍为 observe。真实路径资格、其它平台及有页面流程、阶段 3 上线验收仍未完成。

04:23:09 再次只读核对运行控制器：mode=rule、TUN 开启、3341 条规则；30 条预期 DOMAIN DIRECT 全在首条 IPCIDR 前，零基索引 16–45，首条 IPCIDR 为 46。本次复核没有再写配置；两条另行准备的诊断规则仍未应用。

追加验证（2026-09-08 04:53，Asia/Shanghai）：最新全量 **65 个测试文件、1616 项通过**；项目 `typecheck`、`lint` 与 `git diff --check` 通过。DNS 清理改动后的当前生产模块实际 HTTP/1.1 **44 项**、HTTP/2 **50 项**、B 站无页面检查 **45 项** 全通过，均核对源码未漂移；Electron 窗口冒烟再次通过，观察提示、IPC、网络状态不持久化、系统加密正常。QUIC 13 项与图片缓存 22 项为先前已记录的实测，本轮没有重标其执行时间。正式应用仍 observe，生产 Source、真实 DNS/地址族与六平台完整流程验收未完成。

04:52:41 最后只读复核：rule + TUN，3341 条规则；原 30 条 DOMAIN DIRECT 全在索引 16–45，首条 IPCIDR 为 46。当前配置没有追加变更，也没有将实验结果转为账号许可。

追加验证（2026-09-08 05:20，Asia/Shanghai）：最新全量 **67 个测试文件、1719 项通过**；`typecheck`、全仓 `lint`、`git diff --check` 和 Electron 窗口冒烟通过。新增跨层测试在修复前实际复现 5 个期限/传输错配失败，修复后全部通过；正向用例经过真实 Source 与验证器仍可构造合成证据。窗口检查确认 observe 提示、IPC、网络状态只在内存及系统凭据加密正常。此次没有重标此前 HTTP/1.1、HTTP/2 或真实账号实验的时间，也没有启用正式严格策略。原 30 条规则之外的两条诊断规则仍未应用；实际匹配阶段、DNS/所有可能地址族及平台流程仍待验收。

追加验证（2026-09-08 05:42，Asia/Shanghai）：最新完整执行 **71 个测试文件、1811 项通过**。`typecheck`、全仓 `lint`、`git diff --check` 通过；修改后的完整主入口通过 Electron 窗口冒烟，来源运行时另经 16 项真实只读检查。新增生命周期 21 项、组件 13 项、保守上下文生产者 30 项，及设置/旧读取等待回归均通过。正式运行仍 observe，实际路径资格缺省；本轮没有改变 mihomo 配置或发公开 HTTP 探针。构建仍有既有 renderer 大 chunk 提示。

追加验证（2026-09-08 06:34，Asia/Shanghai）：最终完整执行 **75 个测试文件、2096 项通过**（06:33:51 开始，27.84 秒）；typecheck、lint 与 git diff --check 通过。当前主入口窗口冒烟及来源运行时 16 项实际检查通过，仍显示观察模式，网络状态只在内存，系统加密正常。此前全量 2087 项通过后，独立审查发现控制器变更撤销需提前，已用两个先失败的时序反例修复，再完成本次全量 2096 项及两个 Electron 复验。B 站 45 项与三平台 18 例实测均绑定未再变动的业务源码；三平台误刷新验证时间和误发上线事件均为 0。所有凭据请求只到本机受控 TLS；另一次匿名解析实验没有业务 HTTP 请求。真实配置仍为 3341 条，未追加两条待授权诊断规则。当前 fake-IP/实际目的地址对应、可能地址族、真实路径资格和六平台完整流程仍待验收，未启用正式严格策略。

00:22 的新版生产 ClashReader 只读实测仍为 rule + TUN、3341 条规则、30/30 候选 DIRECT；实际策略 type=Direct、dialer 为空、接口未显式指定、ip-version 未返回。此时可见版本已包含 DIRECT 策略元数据（排除 alive/history 统计），没有签发真实业务许可。

追加验证（2026-09-08 07:12，Asia/Shanghai）：新增 [fake-IP 对应模块](./network-resolver-flow-mapping.md)、实际 NetLog source 类型校验、短 TTL 读取顺序修复，以及保留资格后验时间修复。全量 **77 文件、2194 项通过**（07:11:02 开始，30.53 秒），typecheck、lint、git diff --check 与 Electron 窗口冒烟通过；来源运行时 16 项、32 个构建源哈希核对通过。07:07 的本机真实 TLS 日志通过且保存合成裁剪 fixture；07:10 的单次匿名公网复验通过 15 项，实际 fake-IP、应用 TCP 与自身 mihomo 连接、内核真实 DNS 目的地址一致。07:00 的旧解析器失败结果原样保留，没有用修后结果改写旧实验。生产路径资格提供者、所有可能地址族、工厂适用性、大陆出口及六平台完整流程仍未验收，未启用 strict。当前配置仍为 3341 条，未追加两条待授权诊断规则。

打包实验的临时目录 `docs/.compare/packaged-context-TrkTkL` 仍保留。其清理遭自动审批拒绝，工具仅返回 `blocked by policy`；未尝试绕过。两个实验进程均已退出，未生成或运行正式安装程序。

追加验证（2026-09-08 07:55，Asia/Shanghai）：最终全量 **81 文件、2374 项通过**（07:54:24 开始，30.61 秒），全项目 typecheck、lint、diff 检查和 Electron 窗口冒烟通过。来源运行时 16 项实际只读复验通过，当前仍为 rule + TUN、3341 条规则，没有追加配置变更。当前匿名工厂经 HTTP/1.1 44 项、HTTP/2 50 项受控测试；生产匿名收集器另在 07:44 完成唯一一次公网 GET，12 项通过、源码摘要稳定，未替换 Session.fetch、未使用账号凭据、未产生资格或许可。原始 NetLog 与该次临时目录已清理，历史报告保持各自执行时间。

追加验证（2026-09-08 09:02，Asia/Shanghai）：[显式准备接线](./network-proof-source-runtime.md)已使用实际 lifecycle、producer 与物理收集器，同一来源/匿名池保留真实清理等待；审查撤回、同 ID 改内容、清理后或采样后失效均拒绝旧证据。匿名诊断新增暂停/排空/嵌套释放，控制器继续轮询，原生暂停与 snapshot 同步重入问题已修复，41 项定向测试通过。09:00 全量 2643 项及窗口冒烟通过；09:01 两个隔离运行分别 16/16、22/22，均只有 4 个本机 GET，零 Session/DNS/公开请求尝试，39 个源码输入摘要稳定。[精确内核 DIRECT 地址族实验](./network-mihomo-direct-family-compatibility.md)使用自有本机进程和接收端：当前 global IPv6 关闭时测试的 IPv6 分支未到达，开启的对照组实际到达；SOCKS 回复成功码不能代替接收端结果。它未覆盖 Chromium 绕过内核的 IPv6 通路，因此没有设置单族资格或签发许可。当前 3341 条真实配置未变，两条待授权诊断规则仍未应用。

追加验证（2026-09-08 09:18，Asia/Shanghai）：修复[操作范围与请求地址族不一致](./network-family-projection.md)，两处现在使用同一主进程已验证投影，切族先撤旧许可，null 不回落。getter 不隐式读文件/控制器/探测，原资格与当前来源、审查、版本、上下文均复核。正式主入口已接回调但仍 observe；67 项新增回归、全量 2710 项、窗口、两组来源隔离检查和 H1/H2 实测通过，源码摘要稳定。另完成[普通解析政策只读审核](./network-normal-resolver-policy-review.md)：六项模式对三目标可以明确负匹配，但 filter-mode 缺项与物理 IPv6 DNS 库存意味着仍不能确认完整解析或单族路径；尚未给真实账号签发许可。

便携目录复制到其他电脑或 Windows 用户后，Clash/代理秘密可能无法解密，需要重新输入；保留不可解密密文，不转为明文、不自动删除。国际 API/ProxyTransport/GlobalAccount 仍属独立后续里程碑。
