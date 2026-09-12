# 当前实际通路的可验证性收口

调查时间：2026-09-08（Asia/Shanghai）。依据[冻结规格](./严格分流方案-合并定稿.md)第 1、4 节及[签发证据政策](./network-stage2-issuer-policy-decision.md)。本轮仅新增调查脚本与文档，没有改生产源码、mihomo 配置或系统网络；没有带账号凭据、登录页、业务 API 或公网 HTTP 请求。

## 结论和最小推进点

现有模块能取得当前来源文件、可见运行配置、完整有序规则、OS 代际及受控 TCP 观察。它们足以继续构建方案 A 的路径类别，但**当前没有一份已经合格的“业务目标与大陆匿名出口共享实际物理通路/地址族”的输入**，不能仅组合几个 hash 或传入 true 就生成它。

最先可消除的具体缺口是回显目标的当前规则：`myip.ipip.net` 和 `api6.ipify.org` 都在现有解释器中先遇未决 IPCIDR，不能依靠历史 DIRECT 连接批准当前回显取证。待审阅的最小配置补丁只有[两条精确 DOMAIN 规则](./network-stage2-diagnostic-direct-candidates.yaml)。本轮没有应用；不增加地理查询站点，不改 TUN，不关闭 IPv6，不增加代理节点。

两条规则通过审阅并应用后，下一步做一次有界、隔离的匿名通路资格实验：分别取得合格 IPv4、IPv6 样本（或得到确实约束单族的结论），同时把实际来源/目标、物理接口和所选路由绑定到当前 source、内核、OS 代际。成功后将该合格通路类供同类目标共享；正常续证检查现有规则/来源/路由/族适用性与 TTL，**不要求每次续证、每个业务目标都做 socket 归因或公网回显**。

没有证据要求用户现在关闭整机 IPv6。先执行上述 A 的实际验证；只有本机确实得不到合格 IPv6 通路且无法约束 Chromium/内核只走已验证族，才收窄为方案 B。真正的海外出口不会因加 DIRECT 规则或改证据字段变成大陆。

## 本轮新鲜只读采样

[脱敏结果](./network-path-source-readiness.results.json)：2026-09-07T17:14:06.735Z 至 17:14:12.701Z，约 6 秒。执行新的生产 `EffectiveConfigSource`、`ClashReader`、`WindowsNetworkFingerprintReader`；额外固定只读 PowerShell 查询 ActiveStore 路由、IP 接口、适配器、地址及 `Find-NetRoute`。控制器查询 3 个公开目标的 A/AAAA，共 6 次 DNS API 请求；没有向这些目标发 HTTP。resolver 后续是否产生 DNS 上游查询不计作“零网络”，这里只明确没有公网 HTTP 或账号请求。

| 检查 | 当前结果 |
|---|---|
| 配置来源 | `checking → candidate`；3341 条完整规则一致 |
| 模式/TUN | rule / true |
| OS ActiveStore 路由 | 67 条；18 个 IP 接口记录 |
| Up 的物理适配器 | 本轮仅 index 12；使用接口 GUID 摘要保存身份，不只用名称 |
| IPv4 默认路由 | 非物理 index 59，接口 metric 0；物理 index 12，接口 metric 20 |
| IPv6 默认路由 | 物理 index 12，route metric 256、interface metric 20 |
| 非链路本地全局 IPv6 | index 12 有 6 个，其中 2 个 Preferred；未记录原 IP |
| 内核 controller owner | PID 43828，创建时间 2026-09-07T04:59:05.7234678Z；不视为历史完整证明 |
| 控制器/OS 前后稳定 | 都为 true |

本轮 source 和 OS 摘要是当前读取结果，不是从旧报告复制。OS 指纹仍为 `306428bfbe068dcda645430de5215ba189e19fdd6fd82307932f99d49fe7977a`；与旧值相同也不延长旧证据的有效期。

后续生产[路由读取模块验证](./network-windows-route-selection.md)发现当前 index 59/IPv4 的 CIM `InterfaceMetric` 实际缺失。上表及本调查脚本曾用 `[int]` 转换，使缺项显示成 0，因此该 0 不能作为“API 显式返回优先级 0”的证据；新模块已保留 null。Find-NetRoute 选中 index 59 的实际结果不依赖这条转换推断，原 IPv4/IPv6 查路结果与边界仍成立。

| 目标 | 当前规则解释 | A / AAAA 数 | 对本次各族首个地址的 Windows 最佳路由 |
|---|---|---|---|
| www.bilibili.com | 第 42 条（零基）Domain → DIRECT | 4 / 4 | IPv4 index 59；IPv6 index 12 |
| myip.ipip.net | 第 46 条 IPCIDR 处不可验证 | 2 / 2 | IPv4 index 59；IPv6 index 12 |
| api6.ipify.org | 第 46 条 IPCIDR 处不可验证 | 0 / 1 | IPv6 index 12 |

**unknown 不等于实际走代理。** 它表示当前生产规则解释器不能证明跳过这个早期 IP 规则；历史 myip 的 DomainSuffix/DIRECT 连接不能用于替换当前有序解释。两条精确规则能让已审核诊断目标在未决分支之前终止，同时仍要核对实际出站类型和路径。

`Find-NetRoute` 返回 Windows 在给定目的地址下的最佳本地源地址和路由；它没有观察 mihomo socket，也没有自动代入内核的接口绑定策略。[Microsoft 文档](https://learn.microsoft.com/en-us/powershell/module/nettcpip/find-netroute?view=windowsserver2025-ps)

因此，IPv4 这里选到 index 59 只能描述普通 OS 查路进入非物理路径；不能把它当成 DIRECT 最后一跳。IPv6 选到 index 12 说明存在实际可选的物理 IPv6 路由，仍不能单凭它证明某次请求绕过/经过 TUN或已是大陆出口。每个族只取了本轮首个 DNS 地址，没有覆盖所有地址；部分回答 TTL 仅 1 秒，采样结束时已经到期。本表是路径调查，不能用这些过期 DNS 候选签发许可。

## IPv6 反例真正限定了什么

[B 站反例](./network-stage2-af-counterexample.md)证明：当前 `ipv6=false` 不是整个 Chromium 出网链的强制单族限制。强制真实 AAAA 时，证书有效 HTTPS 通过 IPv6 成功；实际内核链没有归因。它没有证明正常业务总在用 IPv6，也没有证明该 IPv6 出口在海外。

[api6 回显](./network-stage2-ipv6-egress-candidate.md)实际返回 JP/AS215355，但其 socket/内核链未归因。本轮也证实该 host 不在当前可直接解释的早期 DIRECT 范围。因而它不能代表国内目标 DIRECT 的 IPv6 通路，更不能直接导出“必须关闭 IPv6”。该旧回显摘要与本轮 OS 地址仍无匹配，只是跨时间的地址摘要比较；没有把它称成当时 socket 源地址。

现有数据支持把可能路径至少分开调查：

- IPv4：应用侧 fake-IP/非物理接口 → TUN → 实际 DIRECT 拨号 → 物理出口。既有隔离实验已取得应用 tuple 与内核 `remoteDestination`；还需给合格出口样本保留实际内核出站 socket/source/interface 的对应。
- IPv6：当前 OS 物理默认路由存在；可能经不同处理或被当前解析影响。先把诊断 host 的策略变得可解释，再获取本次实际路径/来源。不能把 IPv4 通路类沿用到这里。

这些是候选分类，没有产生 `ValidatedRulePath` 或许可。若某族实际入口/路由不在首期已验收 Chromium/TUN 范围，单独说明并验证或排除；不要把它改名 DIRECT 掩盖差异。

## 生产模块已有能力与剩余输入

| 输入/机制 | 现在能实际取得什么 | 还缺什么；不能作何推断 |
|---|---|---|
| `effective-config-source.ts` | 当前密文/明文来源有界读取、必要 DNS/hosts/sniffer/TUN/族/出站摘要、3341 规则及共同配置核对；缺项保留 | 候选不自动证明隐藏字段已加载；按 A 保留当前来源/加载事件和内核生命周期边界，不要求隐藏配置永不变 |
| `windows-network-fingerprint.ts` | 全部 ActiveStore 路由、接口、地址、DNS 的稳定 hash，失联/变化撤销 | 当前仅输出 hash，不能反推具体目标命中的物理接口/下一跳；需要实际只读路由选择记录，或在同一次主进程采样内保留受限结构 |
| 本轮 `Find-NetRoute`/接口读取 | 目标地址对应最佳路由、源地址和物理适配器身份可读 | 是 OS 查路；若内核另绑接口，要结合实际拨号观察或已验收策略；不能因为只有一个物理网卡就默认同通路 |
| `windows-tcp-sockets.ts` | 选定 owner/remote 范围的真实 source/remote tuple、PID 创建时间、路径身份 | 不自动定位 Network Service/内核 owner，也不单独证明 Session 归属；适合作一次隔离资格实验及矛盾诊断，不必每轮使用 |
| 当前连接证据 | 在受控窗口已能匹配应用源 tuple、Tun/DIRECT、真实 `remoteDestination` | 尚未完成实际内核物理拨号来源与大陆回显样本的通路绑定；控制器没有记录时保持未归因 |
| `anonymous-proof-probe.ts` | 匿名 Chromium TLS/缓存事实、独立 contextId | 当前 API 不提供 peer、AF、source 或出口正文，不能凭成功补这些字段；应把必要的真实取样接入适用的受控诊断流程 |
| DNS/族 | 配置保留缺项、控制器 A/AAAA 可读，OS 双族路由可读 | DNS API 不是最终 DIRECT 选址，单次无 AAAA 也不是单族约束；还需作用于真实业务路径的双族符合性或可验证的单族限制 |

## 不修改网络也能先做的最小实施工作

先把当前来源、OS 网络代际和目标路由选择的**真实记录**串在一个当前轮次中，维护接口 GUID/源地址族、目的路由前缀/下一跳、实际 DIRECT 策略及配置/内核身份。不要仅建立一个接收布尔值的“校验器”，也不要从纯 hash 生成虚构接口选择。

接着准备一个隔离匿名资格实验，复用既有 Windows TCP reader 和已通过的 CDP 控制窗。只需针对待支持通路类验证代表目标与回显；若可取得内核实际 DIRECT TCP tuple，把源地址映射到当前 OS 接口，核对目的对应路由与回显来源。由合格、同类的当前样本支持共享，目标有更具体路由或 DNS/出站覆盖时另分一类。网络指纹/策略改变后先撤销再做当前适用性复核；不把启动时一次成功永远缓存。

普通多账号运行时不具备全局静默的网络服务，不能假装每次都有无歧义 socket 控制窗。资格取证可以在启动预检/明确隔离窗口完成；日常续证继续以有来源的规则、策略、当前路由适用性和短 TTL 进行，不将 TCP 表唯一性当 Session 证明。仍不要求完整官方源码、逐目标服务器或每轮 socket。

## 两条诊断规则的可审阅应用边界

当前新采样的插入点为首条 IPCIDR（零基索引 46），即之前已经合并的 30 条候选规则之后、首条未决 IP 规则之前。实际应用时必须重新定位，不能硬编码 46；若并发配置改变，停止并重新核对。本轮没有应用。

可以复用前次合并的安全流程，而不是直接重跑写死 30 条候选的旧脚本：

1. 显式既有解码器仅在内存解析。读取当前密文和 live `/configs`、有序 `/rules`；逐项确定文件/运行配置仍一致。加密前进行 round-trip 检查。
2. 为原始密文创建独立备份；只将缺少的两条精确 DOMAIN 规则插在首个 IP 规则前。预期 live 规则为当前原序列加两条，原规则 3341 条完全保留、相对顺序不变；若本轮基线不同则按新基线核对，避免重复插入。
3. 写前再比较原密文 hash 及 live 配置/规则，作为 CAS 防并发；保留当前 rule、TUN、端口及其它有效运行设置。客户端程序代码不改，不输出或落盘解密配置。
4. 按已验证的客户端密文格式提交与重载，再用新 Source/Reader 从当前轮次验证 3343 条预期规则完整同序、两条新诊断目标在未决分支前 DIRECT、原 30 个候选仍合格、所有应保留的运行字段一致。
5. 任一步失败，恢复备份密文并明确恢复此前 live 配置/规则；不能只恢复文件后让内核退回 global。只有文件与 live 两边都验证恢复才报告回滚成功。

这段调整只使匿名取证入口可解释，不授权账号使用代理、扫码或采集。地理查询请求只处理匿名出口元数据，独立诊断即可，不需要给其 host 添业务路由证明。

## 何时才需要用户调整或补信息

当前只需审阅上述两条诊断规则即可继续 A 取证；无需先购买服务器、提供整份秘密配置、替换内核或关闭 IPv6。机器上只有一个当前 Up 物理适配器，可以自动记录其身份，但“这是受支持的大陆上网链路、没有按目标海外分流的上游网关”属于冻结的环境支持假设，不能单靠网卡名称证明；有反证或多出口歧义时，再向用户确认具体接口/上游情况。

若 A 最终证实 IPv6 通路不合格或没有可验证的选族约束，备选 B 是明确的 direct 出站配合 `ip-version: ipv4` 与选定物理接口，再在当前内核做正反向符合性实验。文档中 `ipv4` 表示只用 IPv4，`ipv4-prefer` 允许双栈；接口字段约束该出站连接，但本机 424c2ef 的实际实现仍需验收。[Direct 示例](https://wiki.metacubex.one/en/config/proxies/direct/)、[字段说明](https://wiki.metacubex.one/en/config/proxies/)

若业务 IPv6 可能绕过这条出站，仅添加该字段仍不够；需要对整条支持路径验证约束，或由用户选择范围明确的路由/IPv6 调整。现在没有提出或实施这种调整，也不把它设为 A 的先决条件。
