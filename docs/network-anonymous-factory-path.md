# 真实匿名工厂路径调查

时间：2026-09-08 03:26（Asia/Shanghai）。[脚本](../scripts/electron-anonymous-factory-path-probe.mjs)，[本轮原始脱敏结果](./network-anonymous-factory-path.results.json)。**本轮没有签发资格，没有开启 strict，也没有修改 mihomo 规则。**

独立隐藏 Electron 子进程使用临时 userData/sessionData，默认 Session 拒绝请求。实际加载本仓库 `AnonymousProofProbe`、`AnonymousEgressProbe` 及其隐私控制模块，没有加载生产主入口或真实账号。运行时 Electron 43.3.0 / Chromium 150.0.7871.212，开发版；保存了所列模块的源码 SHA-256，采样完成时这些源码仍一致。

仅发出三个公开请求，每个 host 一次，无重试：

| 真实工厂 | 目标 | 工厂结果 | 本次内核连接观察 | 当前规则解释 |
|---|---|---|---|---|
| TLS | api.bilibili.com/robots.txt | 200 | DIRECT，processPath 缺失 | 第 16 条 Domain，DIRECT |
| Egress(ipip) 回显 | myip.ipip.net/ | 200，CN / AS4837，回显地址族 IPv4 | DIRECT | 第 46 条 IPCIDR 起不可解释，unknown |
| 同一次 Egress 地理查询 | ipwho.is / 已解析匿名 IP | 200，返回 IP 与查询 IP 在内存核对 | non-direct | 第 46 条 IPCIDR 起不可解释，unknown |

没有执行可选 IPv6 回显。地理查询无账号身份，non-direct 仅如实记录；它不能证明回显或国内账号允许使用代理。myip 本次连接为 DIRECT，仍不能代替当前有序规则证明。两条待确认诊断规则没有修改。

## 测量方法与实际取得的事实

测试 shim 只包装该隔离进程中新建私有 Session 的 `fetch`。仍调用原始 Chromium fetch，并在收到响应头后短暂延迟交还 Response，进行只读取证；它没有更改代理、DNS、TLS、Agent、请求 URL 或生产隐私钩子，也没有用另一个 WebContents 的 CDP 代替 `session.fetch`。TLS 工厂本次超时上限 10 秒、Egress 15 秒；响应头后的测量上限 4.5 秒。结果同时保留真实响应头观察时间和工厂完成时间，测量延迟没有被隐藏。

NetLog 仅在完全无账号的隔离子进程中使用。它仍覆盖该子进程的 Network Service，**不是 Session 专属日志**。每个请求分别从精确 URL 的 URL_REQUEST 根沿 source_dependency 图寻找 TCP_CONNECT，排除 DNS/代理/证书验证的公共依赖；多根或多 socket 保持未归因。本轮三条请求均观察到一个请求根和一个相关 TCP socket，源端口分别为 50529、59877、61340；并与请求前不存在的 mihomo 连接 ID、相同源地址、源端口、host、目的端口对上。日志中的 TCP_CONNECT 本次实际含 `local_address`、`remote_address` 字段。

这比“同 PID、同 host 找第一条”多了独立请求依赖和源 tuple。它证明本次隔离请求的 Chromium socket 与对应的内核连接观察，**没有补写内核空 processPath**。尤其 Chromium→TUN 的 IPv4/fake-IP socket 不是物理出站地址族证明；`remoteDestination` 也只是内核报告的拨号目标。

## 未取得的证据

三次生产 `WindowsTcpSocketReader` 调用均返回 `available:false`。因此本轮没有取得可验证的 Windows 应用 owner/socket 联合记录、内核物理出站 TCP tuple，也没有凭猜测的源地址调用源地址限定查路。复合 `appSocketAttribution` 保持 UNATTRIBUTED，`kernelOutgoingFlowAttributionVerified=false`，源地址限定路由结果为空。

即使下一次取得唯一内核 TCP 候选，也仍需将其与这条实际请求关联。`kernelOutgoingCandidates` 的设计只保存候选，不能自动改成 flow ownership。资格只能覆盖已调查的 runtime/factory/协议/有效配置/路由类，不能直接覆盖运行中的其它账号 context 或每个未来样本。

随后仅进行了本机只读排查，没有再次请求这些公网 host：运行内核 PID 43828 的 `Get-Process.StartTime` 可读、`.Path` 为空，而现有限权 Win32 owner reader 可读路径身份；旧 TCP reader 在包含该内核的受限 scope 下复现不可用。此实际故障已独立修复并通过[无公网回归](./network-windows-tcp-native-owner.results.json)。原调查结果不随修复改写，具体修复见 [TCP reader 说明](./network-windows-tcp-sockets.md)。

## 产物与下一步复用

结果只保存 IP 的规范化 SHA-256、端口、必要 owner/连接标识、字段形状和规则决策，没有保存回显正文、原 IP、完整地理 URL、原配置、代理节点名或 Cookie。原始临时 NetLog 与隔离资料目录已验证删除。新脚本未来可复用 `netlogRequest()` 的精确请求依赖取证、响应头期间的 Windows 表读取，以及至多两条已观测内核候选的 `Find-NetRoute -LocalIPAddress` 查询。**本轮没有重新执行修复后的公网采样，也没有产出生产 conformance 或许可。**

后续经独立授权进行了[修复后的单轮调查](./network-anonymous-factory-path-native-owner.md)，另存新结果。本页与原 JSON 继续描述修复前这次实验，没有将原失败改写为成功。
