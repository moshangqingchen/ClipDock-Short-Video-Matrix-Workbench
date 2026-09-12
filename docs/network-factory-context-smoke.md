# B 站无视图探测与匿名工厂的有限传输审查

2026-09-08 08:09:58–08:10:03（上海时间），Windows / Electron **43.3.0** / Chromium **150.0.7871.212**，未打包。当前真实三条入口的本机对照 **18/18** 通过：[独立结果](./network-factory-context-smoke.20260908T000957940Z.results.json)。42 个 bundle 输入源码起止哈希相同，清理完成；没有修改工厂、正式审核哈希或生产 enforcement，没有产生 `RetainedPathQualification`、`flowReviewed` 或许可。

脚本：[electron-factory-context-smoke.mjs](../scripts/electron-factory-context-smoke.mjs)。`node ... --build-only` 只构建；省略参数执行受控本机实验。

## 实际入口和归因

| 入口                    | 本次调用链                                                                             | Session 与凭据                                             | 接收端事实                              |
| ----------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| B 站无视图 check-status | 实际 `AccountService.checkStatus → detectLoginState → gatedSessionProbe → net.request` | 随机假账号的持久 partition；仅随机合成 `SESSDATA/bili_jct` | nav 1 次、200，实际服务确认合成登录回应 |
| 匿名 TLS                | 实际 `AnonymousProofProbe.probeTls → Session.fetch`                                    | 独立内存 Session；`omit`                                   | robots 1 次、200，零 Cookie             |
| 匿名出口                | 实际 `AnonymousEgressProbe.probe → Session.fetch`                                      | 另一独立内存 Session；`omit`                               | echo 和 geo 各 1 次、200，均零 Cookie   |

没有创建任何 WebContents 或账号页面。四个请求均为 GET，三个入口均实际传入 `redirect:manual`、`cache:no-store`。B 站额外明确 `bypassCustomProtocolHandlers:true`；匿名 fetch 设置 `no-referrer`，不能把这些不同字段写成完全相同。

TLS 接收端只监听 `127.0.0.1:443`。每次到达后记录该请求所属 socket 的完整客户端/接收端地址和端口，再调用生产 `WindowsTcpSocketReader`，只读取当轮 `app.getAppMetrics()` 中 NetworkService PID、远端 `127.0.0.1:443` 的 socket。必须完整四元组唯一匹配、状态为 Established，并且原生 owner 身份与读取前后 NetworkService metrics 一致，才记录归因。**归因不是“只有一个 PID / 同 host 就选它”。**

四条完整 tuple 均匹配 NetworkService **PID 137036**，原生创建时间 `639244229986359508`、可执行路径身份一致；主进程为 **PID 137120**。因此可以确认这次真实 `net.request` 和两匿名工厂都由同一个 Chromium NetworkService 实例执行。本次三个 Session 的身份不同，两个匿名 `transportContextId` 原样保留；没有用账号 context 替换匿名 context。

三 Session 在各自首次请求之前均实际完成 `setProxy({mode:"direct"}) → closeAllConnections() → clearHostResolverCache()`，请求后只读 `resolveProxy` 均为 DIRECT。真实启动模块在 app ready 前安装 `disable-quic`。接收端实际为 TLS 1.3 / HTTP/1.1 / loopback IPv4；本轮不重复 QUIC 阳性对照，启动约束的独立阳性实验见 [QUIC 报告](./network-quic-constraint-smoke.md)。

## 明确保留的差异与实验改写

- 账号 Session 持久化、保留 Cookie；匿名 Session 无存储路径、清空认证缓存并禁用 NTLM 域，完成后 Cookie 仍为空。账号本次未配置相同的匿名隐私策略，不能把“匿名无环境凭据”结论外推给账号 Session。
- 账号 UA 为去掉 Electron 标识的 Chrome UA；两个匿名工厂的 UA 含 `Electron/43.3.0`。平台响应可以据此不同，不能用本机成功推断真实认证响应语义。
- 本轮固定 `api.bilibili.com / myip.ipip.net / ipwho.is` **仅在隔离子进程中映射 loopback**，其它主机解析失败。因而没有真实公网 DNS、TUN、内核规则、物理网卡或出口地理证据。
- 证书只在每个私有 Session 的实际调用前按本轮固定主机与生成证书指纹 pin；没有系统信任修改、忽略证书开关。匿名观察对象原本的 `chromium-default` 标签在本报告明确标为 **报告标签，实际实验信任为 fixture pin**，不能据此声称公网默认信任验收。
- 接收端在 headers 之前持有响应约 1.2–1.4 秒，等一次限定 TCP 查询完成；未延长生产工厂的 8 秒 / 12 秒期限。echo IP、国家和 ASN 都是合成回应，`reportedAddressFamily` 不是公网实际 socket AF。
- B 站的两轮 Gate 证据和目录审核均为隔离 fixture 合成数据，仅用于进入真实业务函数；不进入正式来源或审核记录。真实账号、扫码、公开请求、控制器读取均为零。

## 可用于资格组合的有限范围

`transport.accountProfileId` 应限定为 **B 站、无视图、check-status、原 partition 的 ClientRequest**；不能顺带覆盖页面导航、扫码、采集、上传或其他平台。两个匿名 profile 继续引用各自真实 factory ID，并保留当次 context。

本报告与当前源码可作为同一构建/启动约束下的默认 Chromium 入口、实际 NetworkService、direct 初始化和 TCP 传输 review 引用。两个匿名工厂与账号路径没有局部 Node Agent、显式代理或单独 DNS 客户端；这些是入口级适用依据，不是把三个 Session 合并成一个。

**没有必要因此要求每个 profile 或每个续证轮次再关联公网 socket。** 方案 A 允许将已保留、真实取得的匿名 TLS resolver-flow mapping，与这份入口/工厂审查、当前有效 hosts/DNS/出站策略依赖组成显式 `profileEquivalence` 论证。原 mapping 仍必须是真实对象并通过自身来源/窗口验证，当前依赖和目标适用性由现有适配器检查；本报告不能提供或补填 `kernelAddresses`、fake→real 映射、TUN inbound/process 字段、物理 route、仅 IPv4 或大陆出口。

旧 [进程实验](./network-stage2-process-context.md) 和 [验收包实验](./network-packaged-process-context.md) 可作对应构建的历史支持，但不替代本次准确入口，也不能外推到最终安装路径或另一个 NetworkService 实例。B 站响应与撤销的范围仍引用既有 [45 项无视图测试](./network-bilibili-check-status-smoke.md)，本轮只新增入口/传输上下文事实。

## 保留的首次不完整记录

[首次结果](./network-factory-context-smoke.20260908T000621608Z.results.json) 仅留前三项及 B 站归因，后续匿名阶段未形成完整结果，且旧脚本未记录终止阶段、watchdog 或 cleanup；它不能当作通过或产品路径失败证据。该版本把仅允许 B 站 URL 的透明 `net.request` 包装保留到了匿名阶段，可能干扰 Electron 内部委托。修正为 B 站调用后立即恢复，同时补逐阶段 checkpoint、失败和 watchdog 记录，才进行上述独立复验。旧文件没有改写。
