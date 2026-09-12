# 阶段 2：DirectProof 签发证据的实际可获得性

核验日期：2026-09-07。范围：当前 Windows、Electron **43.3.0 / Chromium 150.0.7871.212**、`127.0.0.1:9790` 的 mihomo **424c2ef**、真实 `rule + TUN` 配置。只读控制器，不改模式、规则、节点、网卡或 DNS；不打开真实账号，不开启 strict，不签发许可。

**可以取得逐匿名连接的 DIRECT、真实拨号目标 IP 和进程/socket 联合证据；当前还不能把一个 CN 出口回显合理扩大成全部国内业务许可。** 新发现的可用字段是 `metadata.remoteDestination`。生产续证不得使用 `Session.netLog` 写盘取得源端口：它会记录同一 Network Service 下另一个 Session 的 URL/query，本轮已用本地合成数据实锤。

复现脚本：[electron-proof-evidence-probe.mjs](../scripts/electron-proof-evidence-probe.mjs)。结果：[脱敏 JSON](./network-stage2-proof-issuer-evidence.results.json)。默认运行包含 30 个候选域名的 A/AAAA 查询；`--reuse-dns` 只复用这份历史 DNS 记录，再做隔离实验，**不表示 DNS 已重新续证**。DNS 表来自约 23:15 上海时间的采样；JSON 最外层时间是最后一次隔离实验完成时间。

## 1. 本次取得的真实数据

### 控制器状态

| 字段 | 实测值 | 能说明什么 |
|---|---|---|
| `/version` | `meta=true, version=424c2ef` | 运行内核报告的版本；不是完整源码身份或二进制签名 |
| `/configs.mode` / TUN | `rule` / 开启 | 当前不是 global；TUN 不直接判不合格 |
| 规则数 | 3341 | 包括此前经授权合并的 30 条 DOMAIN,DIRECT |
| `ipv6` | `false` | 不能写成“Windows / Chromium / 所有出口 IPv6 均已禁用” |
| `find-process-mode` | `strict` | 不保证每条连接都有 process 字段 |
| `tcp-concurrent` | `true` | 需要考虑并发拨号及地址选择 |
| 全局 `interface-name` / `routing-mark` | 空 / 0 | API 没有给出一条已固定物理接口的证明 |
| TUN stack / auto-route / auto-detect-interface | `gVisor` / true / true | 内核自动处理路由和接口；当前实际选中的每目标接口未由此 API 暴露 |
| TUN strict-route | 字段未提供，记录 null | 未知，不解释成 false |
| `/proxies/DIRECT` type / interface / dialer-proxy | `Direct` / 空 / 空 | 内建 DIRECT 没有在此响应声明显式接口、上游 dialer |

DNS 批次前后选定配置及规则散列一致；最后一轮匿名传输前后完整 `/configs + /rules` 在内存中的散列也一致。原配置、节点列表、秘密和响应原文没有输出。前后相同不能排除中间改动又改回的竞态。

### 新的无 NetLog 连接实验

隔离进程使用全新临时 userData 和内存分区；外部只访问 `www.bilibili.com/robots.txt` 一次，以及对 `myip.ipip.net:443` 完成一次 Node TLS 握手。后者没有发送 HTTP 请求。Chromium 请求去除 Cookie/Authorization/Proxy-Authorization，丢弃 Set-Cookie，不绕过证书检查。外部实验开始前已停止本地 NetLog。

| 联合字段 | Chromium 匿名 B 站 robots | Electron 主进程 Node TLS |
|---|---|---|
| HTTP / TLS | 200，h2，非缓存，非复用 | 证书校验通过；没有 HTTP 请求 |
| 应用侧远端 | `198.18.0.77:443` | `198.18.2.57:443` |
| 应用侧源端口 | Windows 表实测 **61420** | socket.localPort 实测 **61427** |
| socket owner | Network Service PID 31308 | Electron 主进程 socket |
| mihomo connection ID | `831de2fa-fa9f-4b1c-b7b7-a6f1a28a3b4e` | `9b62a46d-8a28-4174-a759-531e25995886` |
| mihomo sourcePort | 61420 | 61427 |
| dnsMode / type / network | fake-ip / Tun / tcp | fake-ip / Tun / tcp |
| chains | DIRECT | DIRECT |
| rule | Domain，payload 等于目标 host | DomainSuffix |
| destinationIP | **空** | **空** |
| remoteDestination | **123.234.3.167，IPv4** | **103.41.2.6，IPv4** |
| mihomo process / processPath | **均为空** | electron.exe / 本仓库 Electron 可执行文件 |

前一次独立复测得到同样形态：B 站源端口 51620，对应的 remoteDestination 仍为 123.234.3.167。两轮结果不能直接计作 Gate 的两个有效证明样本；出口适用性、账号 context、目录审核等前提并没有成立。

**必须区分三种地址：** 应用到 TUN 的 fake-IP、mihomo DIRECT 到站点的真实目的 IP、站点/回显服务器看到的公网来源 IP。本表补齐的是第二种地址，`remoteDestination` 绝不是公网来源/出口 IP。

## 2. 锁定源码与官方实现：哪些结论能使用

本次查询官方 `MetaCubeX/mihomo`：`/commit/424c2ef` 与该 ref 的 raw 源码返回 404，GitHub commits API 对该 ref 返回 422。没有找到可核对的官方完整提交。**不能声称当前二进制已经与某个官方提交逐项核对。** 后续应从发行者获取源码/VCS 信息和二进制散列，或另行采用能明确对应官方源码的构建；本轮未替换内核。

下面 mihomo 源码引用固定为本次读到的官方 Meta 提交 **ac017cdd246ce8bd547653d927e7bf77d7ee73d5**，只用于解释候选机制和设计待验收条件，不能替代 424c2ef 的实测。

1. `/dns/query` 将问题直接交给 `DefaultResolver.ExchangeContext`，返回 DNS Answer/CNAME/TTL；DIRECT TCP 使用的是 `DirectHostResolver`。两条调用并不等价，API 回答不是 DIRECT 刚才选择的拨号地址。当前 global `ipv6=false` 仍取得 AAAA 的实测与这一区别相符。[DNS API 源码](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/hub/route/dns.go)、[DIRECT 源码](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/adapter/outbound/direct.go)
2. fake-IP 预处理会将已确认的 fake-IP 从 `DstIP` 清除；TCP tracker 把连接的 `RemoteDestination()` 另写入 metadata。当前官方 DIRECT 包装从底层 RemoteAddr 取得真实目标，解释了“destinationIP 空、remoteDestination 有 IPv4”。非 DIRECT 链、UDP、无有效 literal 的返回不能沿用这一解释。[预处理与进程查找](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/tunnel/tunnel.go)、[TCP tracker](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/tunnel/statistic/tracker.go)、[连接包装](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/adapter/outbound/base.go)
3. `find-process-mode=strict` 允许按需找进程；只有 always 会提前调用查找。提前命中 DOMAIN 规则时 process 为空并不意味着它是另一个进程。本次 B 站空字段必须原样保留；此前另一个 host 记录到 electron.exe，不能补到本条上。[同一 tunnel 实现](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/tunnel/tunnel.go)
4. 当前官方 dialer 在没有指定接口时可能依据目的地址寻找接口；并发/双栈路径也由其选地址。`DIRECT` 名称不自动证明所有目标同接口、同地址族、同公网 NAT。`ipv6=false` 是 resolver 的限制，源码还有 hosts 等不同路径，不能当网络防火墙。[dialer](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/component/dialer/dialer.go)、[resolver](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/component/resolver/resolver.go)

## 3. 30 个候选域名的 DNS 覆盖

每个 host 分别请求 `/dns/query?name=<host>&type=A` 和 `type=AAAA`，最多两个并发；没有向创作者 API、登录轮询或验证码 API 发送 HTTP 请求。表中数字是 Answer 里的地址记录数，CNAME 不计。没有将境外地址叫作污染，没有用另一份 geo 数据重新解释内核规则。

| host | A | AAAA |
|---|---:|---:|
| api.bilibili.com | 4 | 4 |
| api.geetest.com | 1 | 0 |
| baijiahao.baidu.com | 1 | 1 |
| captcha.gtimg.com | 6 | 3 |
| captcha.kuaishou.com | NXDOMAIN | NXDOMAIN |
| captcha.qq.com | 1 | 0 |
| captcha.zt.kuaishou.com | 4 | 0 |
| channels.weixin.qq.com | 4 | 4 |
| cp.kuaishou.com | 4 | 0 |
| creator.douyin.com | 16 | 0 |
| creator.xiaohongshu.com | 8 | 1 |
| gcaptcha4.geetest.com | 1 | 2 |
| geetest.com | 16 | 0 |
| global.captcha.gtimg.com | 6 | 3 |
| gt4.geetest.com | 1 | 0 |
| member.bilibili.com | 4 | 4 |
| passport.bilibili.com | 4 | 4 |
| rmc.bytedance.com | 5 | 0 |
| sec.kuaishou.com | NXDOMAIN | NXDOMAIN |
| sg.captcha.qcloud.com | 2 | 0 |
| ssl.captcha.qq.com | 1 | 1 |
| static.geetest.com | 2 | 2 |
| t.captcha.qq.com | 2 | 2 |
| verify.snssdk.com | 16 | 0 |
| verify.zijieapi.com | 12 | 0 |
| wappass.baidu.com | 2 | 2 |
| www.bilibili.com | 4 | 4 |
| www.douyin.com | 20 | 2 |
| www.kuaishou.com | 4 | 4 |
| www.xiaohongshu.com | 3 | 1 |

结果：28 个 host 返回 A，17 个返回 AAAA，2 个当前 NXDOMAIN。候选是导航元数据抽出的起点，并非“每个账号必须连通的全部清单”；把两个 NXDOMAIN 候选也写成所有账号的必需证明会造成错误的永久休眠。应按平台审核实际需要的登录/验证码/轮询/资源域名，删除已确认不使用的候选必须经过目录审核；未知的新请求仍拒绝。

此 DNS 批次没有给任何 target 签发 `tlsVerified`、`countryCode=CN` 或 `applicabilityVerified`。即使同 host 的 AAAA 本次为 0，也不能据此永久排除 IPv6、缓存、HTTPS/SVCB、Alt-Svc 或内核重新解析。

## 4. NetLog 的 Session 范围：生产禁用，隔离验收可用

Electron 43.3.0 的 `Session.netLog` 从自己的 BrowserContext 创建 exporter；底层 Chromium 150 的 NetworkContext 却共用 NetworkService 的 NetLog，exporter 会先收集该服务的活动对象，再观察共享 NetLog。没有 Session 请求过滤参数。[Electron C++](https://github.com/electron/electron/blob/v43.3.0/shell/browser/api/electron_api_net_log.cc)、[Chromium exporter](https://github.com/chromium/chromium/blob/150.0.7871.212/services/network/net_log_exporter.cc)、[NetworkContext 的共享 net_log](https://github.com/chromium/chromium/blob/150.0.7871.212/services/network/network_context.cc)

本地实测：

- 两个全新 Session，只有 A 调用 `netLog.startLogging({captureMode:'default'})`。
- B 请求本机受控 HTTP 服务，URL 带 **B_ONLY_NON_SECRET_MARKER** 合成 query；A 请求另一合成标记。
- A 的临时日志同时包含 A、B 两个完整 query 标记；真实账号/秘密均未参与，临时原始日志已删除。
- default 会避免某些敏感头记录，但不能保证 URL/query 没有秘密。事后删 query 不能撤销它曾写盘的事实。

因此不能把生产中的“独立匿名 Session”误写成“独立 NetLog 日志范围”。也不能把 exporter 的路径改成临时目录就视作符合凭据不进日志。公开 Electron NetLog 只提供路径式导出，没有 socket 事件的 JS 内存订阅接口。[锁定版本 NetLog API](https://github.com/electron/electron/blob/v43.3.0/docs/api/net-log.md)

普通 CDP `Network.responseReceived` 可在主进程内存中给出 requestId、remoteIPAddress、remotePort、connectionId、是否复用和协议，**没有本地源端口**。本轮普通 HTTP 请求也核实如此。`connectionId` 是 Chromium 连接标识，不是 Windows 端口或 mihomo UUID。CDP 中有 localPort 的 Direct Sockets 事件针对 TCPSocket/UDPSocket API，不能用于普通 fetch/session.fetch。[锁定 Chromium 的 Network 协议](https://github.com/chromium/chromium/blob/150.0.7871.212/third_party/blink/public/devtools_protocol/domains/Network.pdl)

## 5. 可实施的内存 socket 归因方法及不能越过的歧义

### Windows TCP 表 + CDP：受约束时可用

本轮已跑通：`app.getAppMetrics()` 找到 `serviceName=network.mojom.NetworkService` 的 PID；固定只读 PowerShell 命令读取该进程的 TCP tuple；与单个匿名请求的 CDP remoteIP/port、请求前基线、非缓存/非复用条件联合匹配。源端口再与当前 `/connections` 的 target/port/sourcePort 对齐。所有原始表都只在内存中，产物仅保留本次目标的行。[Electron process metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric)、[Windows GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable)

**生产可接受条件必须同时成立：**

1. 获取固定 PID 及进程创建时间/已验证可执行文件散列；不是按进程名字猜，Network Service 重启立即更换上下文版本。
2. 匿名诊断 Session 全新或已清理该 Session 的旧连接，无账号 Cookie/认证、无缓存/ServiceWorker 回复，精确 host/protocol/port，TLS 正常。
3. 请求前基线已读到，采样期间只有一个可归因的新 tuple；必须匹配实际 remoteIP/port、socket owner、源地址和端口，并使用有界时间窗。端口重用、PID 重用、多个候选、socket 已消失都拒绝。
4. 同一 Network Service 里的其他账号可能对相同 fake-IP 建连接。诊断串行化只限制诊断任务，**不限制其他账号**；因此需全局连接创建协调/短暂静默并验证无复用和旁路，或真正能按请求关联 socket 的底层事件源。仅“表里刚好剩一条”不足以证明它是本请求，另一条可能刚关闭。
5. `/connections` 中同源 tuple、target、当前连接生命周期与规则代际恰好匹配；只接受预期入站与 tcp，拒绝同 host 第一条、历史连接、模糊进程匹配。
6. 成功只生成匿名当前连接观测，不能自动认证账号 Session 的 context，更不能直接成为 CN 出口证明。

并发反例也已实测：两临时 Session 访问同一个本地 IP/端口，CDP 给 B 一个 connectionId，但同一 Network Service 的 Windows 表同时存在源端口 **64614、52240** 两条候选。脚本明确 `ambiguityRejected=true`，没有把任何一条猜分配给 B。生产续证若无法消除这种歧义，应保持不可验证。

### 不要忽略 session.fetch 和协议差异

对隐藏诊断页可获取 CDP 的普通页请求事件；不能假设某个 WebContents 的 debugger 自动拥有整个 Session 的 `session.fetch`、ServiceWorker、所有 WebSocket 的事件。对这些路径要分别验收；重用其他页的 connectionId 不合格。无源端口时不能给 correlator 传 controller.sourcePort 充当“独立证据”。

Windows GetExtendedTcpTable 只解决 TCP socket 信息，不提供每个 HTTP 请求所属 Session。QUIC/UDP 不能套用 TCP 表；生产第一版若收窄到 HTTPS/WSS over TCP，需真实关闭/约束 QUIC 并验证，不能在证据对象里把 network 强填 tcp。Windows 固定命令 reader 可以由主进程调用，不需要常驻助手 exe；原生只读 IP Helper 接口可作为后续性能优化。

### 当前内核 process 为空时的选择

当前证据验证器若要求内核的 processPath/可执行文件散列，则 B 站上述样本仍须拒绝。未来可以选择明确支持的 `find-process-mode=always` 并重做实测，或新增**独立 Windows socket-owner 证明类型**：对准确 tuple 读 owner PID/创建时间/执行路径/散列，单独保留来源，并确认当前已解释规则不存在未决 PROCESS 条件。两者都不能通过补写内核空字段实现；本轮未改设置，也未实现后一证明类型。

## 6. 如何绑定出口、目标、路径和地址族

### 每个目标需要的证据不是一张“公网 IP 正常”截图

建议采集接口如下；它是待实现的输入约束，**不是已经签发的生产类型**：

```ts
type TransportEvidence = {
  probeId: string;
  observedAtMono: number;
  generation: number;
  rulesVersion: string;
  kernelIdentity: { version: string; executableSha256: string };
  contextId: string;
  target: { protocol: 'https:' | 'wss:'; host: string; port: number };
  socket: {
    ownerPid: number; ownerStartedAt: number; executableSha256: string;
    sourceAddress: string; sourcePort: number;
    destinationAddress: string; destinationPort: number;
    source: 'windows-tcp-table-cdp' | 'owned-node-socket';
    correlation: 'unique-controlled-window';
  };
  kernelConnection: {
    id: string; startedAt: string; observedAtMono: number;
    sourceAddress: string; sourcePort: number;
    targetHost: string; destinationPort: number;
    inboundType: 'Tun'; network: 'tcp'; chains: ['DIRECT'];
    processPath: string | null;
    destinationIP: string | null;
    remoteDestination: string; // 有效公网 literal，DIRECT 的实际拨号目的
  };
  pathPolicy: {
    osRouteVersion: string; interfaceVersion: string; dnsVersion: string;
    directResolverVersion: string; outboundPolicyVersion: string;
    possibleOutboundFamilies: ('ipv4' | 'ipv6')[];
    reviewedDestinationClass: string;
  };
};
```

与当前核心接线时，证据按来源保存，不为了满足结构断言创造 `correlationVerified/applicabilityVerified=true`。公网目的 IP 只作为本次 route/DNS 证据，不用于替代 countryCode。公开审计仅保留必要投影，不输出原始 tuple 全表、秘密 URL 或可执行文件以外的用户资料。

### 出口回显怎样才能适用于另一 host

受控匿名回显至少绑定：回显服务器身份、一次性随机关联值、请求上下文、同一 DIRECT 出站策略/物理接口/地址族、规则与 OS 路由代际、采样单调时间，以及服务器观察到的来源 IP。国家归属要标来源、时效与置信规则，ASN 是附加信息。

要把这个样本用于某个国内 target，还必须证明 target 与回显端点落入同一**受约束的出站路由类**，包括目的地址变化仍适用的接口/路由/NAT 策略。仅同进程、同 chains= DIRECT、同 DNS 服务、相同 ASN 或当前某个 IP 相同都不够。

当前 `interface-name` 为空、auto-detect-interface=true，API 没有给出每个拨号的实际源接口/地址及其选择版本。Windows `Find-NetRoute/Get-NetRoute/Get-NetIPInterface` 的只读投影可以补 OS 路由、源地址/接口选择及变化监测；还要证明这与锁定内核的真实 bind/自动接口策略一致。若上游另有按目的地址分流的 VPN/网关，接口相同也不能证明公网 NAT 相同，必须收窄信任条件或继续拒绝。

因此当前 myip 的 CN IPv4 样本不能自动覆盖 B 站，更不能覆盖百家号、视频号的所有 CDN。已有 Cloudflare JP IPv6 对照也不是这 30 个 DIRECT 目标已经走 IPv6 的证据。目标路径与出口证明两步都不能省略。

### onBeforeRequest 没有 AF：可以检查所有可能 families，不能猜 IPv4

这里的 family 应指**凭据最终被 DIRECT 拨往目标时的地址族**，不能拿应用连接 fake-IP 的 IPv4 代替。未知实际选族时，可让请求检查对 `{ipv4, ipv6}` 中每个可能分支都执行 Gate，并要求全部有当前有效证明；不得先取第一张绿证书。

- “可能分支集合”必须来自已验证的出站策略约束。默认集合含两族；一次 A-only 回答或一次 IPv4 连接不能把集合缩小。
- 若一族被真实约束禁用，并已用锁定构建和负向试验验收，可以用只含另一族的集合；不要求对一个根本不可出网的分支伪造可达样本。
- 若两族都可能，每一族都必须有适用于该目标路由类的证据；其中一族取不到、过期、不可归因，整条请求拒绝。
- DNS/接口/路由/内核/代理配置或 Network Service 代际变化先撤证；后续连接重试、重定向和 Alt-Svc 不继承过期证据。

这保留目标与 context 绑定模型，只把未知 AF 的检查变成“所有可能分支均合格”。当前 Runtime 默认 resolver 为 null 的拒绝行为在这些条件落地前应保留。

## 7. 首期可以支持的收窄配置与明确缺口

可产品化的首期范围是**明确域名 DIRECT + 可核对内核 + 经验证的固定出站约束 + TCP**，不需要自己的 TUN 驱动，也不需要把国内浏览栈改成 Node 客户端。

1. 目标目录审核完成；优先精确 DOMAIN 或审核过的 DOMAIN-SUFFIX，必须在会影响目标的不可解释规则之前。复杂 RULE-SET/GEO 不能解释时继续要求用户显式域名规则，不能猜。
2. 锁定可核对的内核构建及配置版本；当前 424c2ef 的官方源码身份仍缺失。
3. 在能证明的情况下约束 DIRECT 使用单一允许地址族、确定的物理出站接口和可审核路由策略。官方当前自定义 `type: direct` 支持 `ip-version: ipv4`、`interface-name`；但本机旧构建支持情况尚未验，现有 Gate 又只认内建 DIRECT 链，不能直接换一个名字就算兼容。若采用命名 Direct 出站，需先验证真实类型/拨号语义，并显式扩展链验证。[官方 direct 配置](https://wiki.metacubex.one/en/config/proxies/direct/)
4. 实施主进程 Windows 网络/网卡/路由/DNS 变化观察，变化时先撤销 generation，再重新采样；只读控制器心跳不覆盖 OS 路由变化。
5. 实施不落盘的 socket 证据来源并明确解决生产 Session 并发归因；处理进程空字段、端口/PID 重用、缺失/超时，均 fail-closed。
6. 受控匿名回显按允许 family 采样，并建立 target 到出站路由类的适用性证明；没有适用性，不签 `applicabilityVerified`。

仍无法靠当前读 API 消除的边界：外部在核验后改路由的 TOCTOU、上游网关按目标重新 NAT、没有可归因 socket 事件的并发 Chromium 请求、未知内核二进制行为。方案承诺继续是“按有效证据执法”，不是物理零包；这些边界也不能用一句“规则模式已经 DIRECT”隐藏。

## 8. 本轮交付与下一步

已交付：真实 30 host DNS 结果；remoteDestination 的两轮实际 TCP 核验；默认 NetLog 跨 Session/query 实验；Windows TCP 表 + CDP 的成功单连接归因；相同目标双 Session 的歧义拒绝反例；锁定 Electron/Chromium 的源码依据及内核源码身份限制。

下一步可分别落地主进程只读连接 reader/correlator、Windows 网络代际 reader、经审核的出站策略解释器和独立出口样本类型。然后在**没有真实账号凭据**的受控矩阵中检验“同目标、同上下文、同代际、所有可能地址族、无歧义、同出站路由类”才能进入 issuer 集成。

本轮没有修改业务源码，没有开启 strict，没有将当前诊断结果包装成 DirectProof，也没有把历史 DNS 缓存当作新的两次样本。
