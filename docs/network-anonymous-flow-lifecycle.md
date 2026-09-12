# 匿名工厂双流受控关闭：物理 TCP 归因结果

2026-09-08 定稿。最后一轮取得有效的双流生命周期配对：真实 `AnonymousProofProbe` 请求 → NetLog 请求依赖中的 app TCP tuple → Windows Network Service TCP tuple → 自身新 mihomo connection ID → 选择性关闭对应的 kernel 物理 TCP tuple。它补足这两次观察的物理连接归因，**没有生成完整路径资格或生产许可**。

## 产物与范围

- 脚本：`scripts/electron-anonymous-flow-lifecycle-probe.mjs`。
- 原设计失败：`network-anonymous-flow-lifecycle.results.json`，原样保留。
- 第二轮时序无效：`network-anonymous-flow-lifecycle-v2.results.json`，原样保留。
- 修正后有效观察：`network-anonymous-flow-lifecycle-v3.results.json`。

三轮分别获得授权，每轮最多两次同一公开资源 `https://api.bilibili.com/robots.txt` 请求，无重试。没有账号、Cookie、Authorization、OS 配置变化、ETW、EStats 或抓包。只对精确归属本实验的新连接 ID 使用 `DELETE /connections/{id}`，没有全量断连。失败记录没有被覆盖。

有效轮运行于 2026-09-07 20:47:10.142–20:47:21.764 UTC（北京时间 09-08 04:47:10–04:47:21），Electron **43.3.0 / Chromium 150.0.7871.212 / Windows / unpackaged**。`flowAssociationObserved=true`，`qualificationGranted=false`，子进程正常退出，临时原始日志已删除。

## 为什么采用选择性关闭

现内核连接 API 的 `sourceIP/sourcePort` 表示入站，`remoteDestination` 给出实际目标 IP，不能直接提供 kernel 出站的本地 TCP 端口。官方当前 tracker 的底层连接不作为 JSON 暴露；按 ID 关闭会关闭对应 tracker。**HTTP 204 不能单独作为证据**，不存在的 ID 也可能收到同样响应，必须同时验证自身 ID 的精确归属、存在性与后续物理变化。[mihomo tracker](https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/tunnel/statistic/tracker.go)、[connections handler](https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/hub/route/connections.go)。这些源码解释实验设计，不冒充对本机二进制的完整源码核验。

EStats 动态统计通常默认不收集；未启用时相关数据不能使用。开启收集会改变连接统计状态，且需要相应权限，并不能直接把用户态代理的两条 OS socket 配成一对。本轮没有启用。[Microsoft GetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getpertcpconnectionestats)、[SetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-setpertcpconnectionestats)。ETW 的 TCP tuple / connid 能关联同一 OS 连接的事件，也不会自动给出 mihomo 入站与出站的转发关系。[Microsoft TCP/IP event fields](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip-typegroup1)。

因此采用冻结的观察信任模型：两个独立工厂请求均保持，先关闭精确归属的 A，要求只有一条物理 tuple 退出且 B 保持；再关闭 B，要求另一条退出。不同远端 IP 同样能够实施，**两请求必须同一个远端 IP 不是产品条件**。不把唯一候选本身当成配对，也不把物理绝对零竞态设成目标。

## 隔离、归属及时间约束

子进程使用临时 userData/private 非持久 Session，默认 Session 全拒。实际生产工厂执行 direct 初始化、清连接池、清 DNS 缓存、默认 Chromium TLS 验证及匿名请求；实际启动模块在 ready 前关闭 QUIC。每次 Session、factory ID、transportContextId 均保留原值，不拿账号 context 替换。

测量 shim 仅在实际私有 `session.fetch` 收到原始 Response headers 后延迟交还 Response，**不改代理、解析、TLS、请求参数或 Agent**。GET/omit/manual/no-store 和固定公开 URL 必须精确匹配。NetLog 仅在无账号的隔离子进程中收集，逐请求停止解析；排除共享 DNS/代理/证书依赖造成的错误关联，只接受单请求根与单个可关联 socket。这里不使用另一个 WebContents 的 CDP 来替代工厂取证。

Windows 读取使用生产 native identity / TCP reader：指定 Network Service 与 kernel PID，通过精确源地址、源端口、远端地址、远端端口核对 app socket；kernel PID、创建 ticks、可执行路径摘要与控制器 owner 一致。每个待删除 ID 必须是基线没有的新 ID，且匹配当前精确 app tuple、目标 host/port、TCP 与 DIRECT。删除前再次读取该精确 ID 和当前规则/控制器；owner 使用刚完成、距删除不超过 500ms 的完整 TCP/owner 快照。没有通过 host/PID 唯一性猜 Session，也没有补空 `processIdentity`。

有效轮保持原有 **8s headers hold / 10s factory timeout**，没有延长超时。删除 A 前要求至少剩余 4.5s，删除 B 前至少 2.2s。每次 TCP 快照前后检查 held、factory 内部 abort、外部 signal、settled 与单调截止；任何自清理或超时介入即使数据看似可配对，也判该轮无效。

两次 `Find-NetRoute -LocalIPAddress` 移至生命周期配对完成、Response 释放后。仅使用已经观测到的两个真实 kernel source/remote，最多两次源限定查询；原始 socket 的观察时间不刷新成查路时间。最终核对 OS 网络摘要、controller 可见配置/规则/DIRECT 策略摘要及 kernel owner 在实验前后保持一致。控制器可见摘要不宣称覆盖隐藏 DNS 配置。

## 有效轮的独立事实

当前 `rule + TUN`，该公开 host 命中第 16 项（零基）`Domain → DIRECT`；内置节点 API 的类型确为 `Direct`，`dialer-proxy` 确实返回空字符串。两个请求均为新鲜、非缓存、默认 TLS 验证的 200，最终实际 factory 结果均 `available=true`。

| 项目 | A | B |
| --- | --- | --- |
| factory | `clipdock-anonymous-tls-v1` | 同左 |
| 实际 context | `87ac4401-c3d8-4e99-83a6-08c058661f74` | `1b9cfbbc-457e-4f0b-9bda-78bdb002edc3` |
| Windows Network Service PID / app sourcePort | `110400 / 54969` | `110400 / 65094` |
| 精确自身 mihomo ID | `fe41046c-42c2-4c43-bf67-1e8a1a7d7757` | `b778d068-fe7a-4e39-8b04-007cd249b607` |
| 生命周期配对的 kernel PID / sourcePort | `43828 / 54973` | `43828 / 65097` |
| 实际 TCP 地址族 | IPv4 | IPv4 |
| 远端 IP | 与 B 不同；仅留摘要 | 与 A 不同；仅留摘要 |

下表为同一个隔离子进程的单调毫秒，Windows 表和控制器读取有区间，不视作原子快照。

| 事件 | 时间 / 结果 |
| --- | --- |
| A / B headers | 2529.718 / 2592.383 |
| 第一次双流快照 | 2605.386–4198.864；两条新 kernel Established，两自身 ID 在 |
| DELETE A | 4208.724–4221.361，204；删除前剩余约 6325ms |
| after A | 4221.375–5676.349；A ID 消失，只有 B 的原 tuple 仍 Established、B ID 在 |
| DELETE B | 5696.027–5697.911，204；删除前剩余约 4838ms |
| after B | 5697.924–7394.835；两个自身 ID 与两条原 Established 均退出 |
| 完成配对 / 释放 Response | 7394.859 / 7394.915；此刻两 hold 仍有效，最早截止仍剩约 3139ms |
| 两 factory 完成 | 7396.422 / 7396.440，均 available |
| 两次源限定查路 | 7396.821–8939.149、8939.264–10322.901，发生在配对之后 |

两条真实 source 查路均得到 `windows-source-route-query`、IPv4、hardware interface 12、Preferred / Up / Connected，source 与实际 socket 一致。OS hash 前后同为 `7d4c5275a41fa0f0281cf94528e8bf3399156bccea30cc9cad96d69f8aa0044c`，owner 与可见控制器配置稳定。原 IP 和原始配置未写入结果。

该轮 bundle SHA-256 为 `8219338298b9bc2ae13372509ab7fcb0cdd5c3691204bc78e6be21a1c53e68d1`，脚本 SHA-256 为 `2f2b85ecf142d6f147f49e83e25e2575efd2a00bb3d65da1737b8112ca396f68`。JSON 保留各生产源文件摘要，`sourcesStillCurrentAtCompletion=true`。

## 两次失败记录的解释

1. **首轮 20:35:03–20:35:06 UTC**：2 次匿名请求均新鲜 200，0 次 DELETE；在组合前置条件 `TWO_DISTINCT_SAME_DESTINATION_CONNECTIONS_REQUIRED` 拒绝。旧版本在记录 incoming pair 之前拒绝，所以 `requests=[]` 是报告分阶段写入的缺陷，不能读作没发请求；`publicRequestsIssued=2` 与真实 factory 结果保留。它不能区分当时究竟是不同 ID 还是同远端条件未满足。后续结果不能倒推填补首轮事实。
2. **第二轮 20:40:24–20:40:36 UTC**：允许不同远端，前置 app/incoming/两物理候选与查路均取得；2 请求、只 DELETE A。两次约 3s 的查路和重复 owner/TCP 读取占据持有窗口，DELETE A 在 10127ms；after-A TCP 读取跨越 10141–11766ms，而两个 8s hold 约在 10564/10636ms 到期。自己的 factory 清理混入观察，两条物理连接都已不在。结果 `PHYSICAL_A_NOT_SELECTIVELY_CLOSED` 不能证明关闭 A 导致 B 消失，也不能说明产品通路不可行。没有 DELETE B。第三轮修正记录与关键窗口布局，不延长生产超时，也未擦除第二轮。

## 可用结论与边界

最小独立补充证据已实际取得：**同轮两个精确自身入站 ID 的选择性生命周期干预及存活对照**，足以在约定的观察模型下把本轮两个真实 TLS 工厂 flow 与物理 TCP tuple 配对。源限定查路为这些已观测 tuple 补上物理接口/源的一致性，不能单独替代 flow 归属。

这份材料可作为有来源、保留原时间和版本的 `clipdock-anonymous-tls-v1 / IPv4 / api.bilibili.com` 观察记录。它没有测 egress echo factory，没有给出公网出口国家，没有证明所有 DNS 路径、IPv6 或业务账号/page-fetch/net.request 与该工厂等价；没有将这些字段自动填 true。生产仍须按已有 conformance 合同引用确实覆盖的材料，不能将其扩写为任意 host、所有 AF 或所有 Session 的资格。它也不要求后续每轮每个目标再次使用 NetLog/DELETE 取证，更不允许在含账号的常规续证中开启全局 NetLog。

本轮仅新增/改动实验脚本与报告，不接生产 bootstrap，不开 strict，不改用户配置。脚本语法检查通过；实验本身取得上述实际结果。
