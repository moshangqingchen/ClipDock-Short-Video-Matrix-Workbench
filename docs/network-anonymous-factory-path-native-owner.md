# 原生 owner 读取修复后的匿名工厂单轮调查

时间：2026-09-08 03:52:39–03:52:53（Asia/Shanghai）。命令：`node scripts/electron-anonymous-factory-path-probe.mjs --native-owner`。使用[同一调查脚本](../scripts/electron-anonymous-factory-path-probe.mjs)和修复后的生产 TCP reader；[本轮独立结果](./network-anonymous-factory-path-native-owner.results.json)与[原失败结果](./network-anonymous-factory-path.results.json)分别保留。

**本轮取得了应用请求到内核入站的对应事实，以及两条内核物理 TCP 候选和它们的源地址限定查路结果；没有签发资格，也没有把唯一候选判成已关联的出站流。** 没有修改网络设置、两条待确认规则、生产签发器或 bootstrap。

## 范围和测量控制

- 独立隐藏 Electron 43.3.0 / Chromium 150.0.7871.212 子进程；临时 userData/sessionData，默认 Session 拒绝请求，无账号、真实 Cookie、Token 或生产主入口。
- 实际调用 `AnonymousProofProbe` 与 `AnonymousEgressProbe`，保留真实 factoryId、独立 transportContextId、响应结果和单调时间。没有替换代理、DNS、TLS 或 Agent，也没有使用另一个 WebContents 的 CDP。
- 仅原来的 3 个 host，各请求 1 次，没有公网重试、没有追加 IPv6 请求。每个请求前读取当时的 mode/TUN 与有序规则；均为 rule + TUN。开头和结束的可见配置及规则 hash 一致。
- 测试 shim 在原始私有 `Session.fetch` 收到响应头后短暂延迟交还 Response，最长 4.5 秒，用于读取 NetLog、TCP 和路由。三次实际测量约 2.506、2.472、1.074 秒，均未超限。TLS 工厂超时上限 10 秒、Egress 15 秒。
- NetLog 只在无账号的隔离子进程 Network Service 使用。原始日志、原 IP、回显正文和完整地理查询 URL 没有进入产物；临时日志和资料目录已清理。保存生产 bundle、脚本及所列源码 hash，所列源码在运行完成时仍一致。

## 实际结果

| 目标 | 工厂结果 | 请求前规则解释 | 本次内核条目 | 应用源端口 | 内核出站候选源端口 |
|---|---|---|---|---:|---:|
| api.bilibili.com/robots.txt | TLS 200 | Domain，第 16 条，DIRECT | DIRECT，processPath 缺失 | 60456 | 60457 |
| myip.ipip.net/ | 回显 200 | 第 46 条 IPCIDR 起 unknown | DIRECT | 65094 | 65096 |
| ipwho.is / 本次匿名 IP | 地理查询 200 | 第 46 条 IPCIDR 起 unknown | non-direct | 62044 | 未建立 DIRECT 候选 |

IPIP 回显的地址族为 IPv4；匹配同一回显 IP 的地理响应为 CN / AS4837。该国家来自地理服务，不从 ASN 注册地推断。地理查询本次经 non-direct 链路，属于无账号的诊断请求；它不证明其它请求可用代理。

每条请求都在其独立 NetLog 片段中找到：精确 URL 的 1 个 URL_REQUEST 根，经 source_dependency 关联到 1 个 TCP_CONNECT。该 tuple 再与生产 Windows reader 中 Network Service PID **107828** 的相同源地址/源端口/远端地址/端口对应，并与请求前不存在、相同源 tuple/host/443/TCP 的 mihomo 连接 ID 对上。内核的空 processPath 保持空，未补写为 Electron 路径。

这些记录中的应用 socket 地址族是 Chromium→TUN 的 IPv4，不能据此宣称物理出站只有 IPv4。应用的 transportContextId 也没有替换成任何账号 contextId。

## 物理候选与源地址限定查路

生产 TCP reader 在本轮成功读取内核 PID **43828**，精确创建 ticks 和路径身份与独立 controller owner reader 一致。对 api.bilibili.com 与 myip.ipip.net 的 `remoteDestination`，分别观察到 1 条该内核拥有的 Established IPv4 TCP tuple；二者均不在请求前基线中。

仅对这 **2 条真实 TCP 候选**，使用其实际 `socket.sourceAddress` 调用：

```ts
new WindowsRouteSelectionReader({
  addresses: [socket.remoteAddress],
  localAddress: socket.sourceAddress,
}).read();
```

两次返回 `basis: "windows-source-route-query"`，都满足：

| 观察字段 | 两条候选的结果 |
|---|---|
| 返回源地址与实际 socket 源地址 | 相等 |
| 物理接口 | hardwareInterface=true，interfaceIndex=12 |
| 接口状态 | Up / Connected |
| 源地址状态与地址族 | Preferred / IPv4 |
| 两候选的源地址 hash | 相同，`552354592821…` |
| 接口身份、next-hop、目的前缀 hash | 分别相同 |

查询没有绑定或修改 socket，也没有把 TUN 入口的路由当成物理路由。它支持“这些已观察 TCP 候选的源地址在该物理接口上存在一致查路结果”，**仍不能仅凭唯一候选证明候选就是指定 mihomo 入站连接的出站端**。所以 `kernelOutgoingFlowAttributionVerified=false` 保持不变。

## 可以用于下一步的事实与保留边界

本轮已实测：真实无 WebContents 的匿名 `session.fetch` 可以在完全隔离的资格调查中，通过 NetLog 请求依赖取到 socket，再用 Windows 实体 TCP 表核对；修复后的 native owner reader 能继续读取 mihomo 的物理候选，源地址限定查路也可执行。常规多账号生产运行仍不能开启同样的全 Network Service NetLog；这些资格实验不要求每次续证、每个业务目标重复。

尚未闭合的是内核入站到物理候选的流对应、当前 DNS/协议/所有可能地址族的适用性以及账号 transport profile 的资格。myip 的有序规则仍为 unknown；一次 DIRECT 连接和 CN 回显没有覆盖该缺口。因此本轮 `qualificationGranted=false`，不能转成 `applicabilityVerified=true` 或业务许可。

原调查 JSON 的 SHA-256 仍为 `A9BBCC960B8152B5498472DE77B90A03F58B48BDB37B1F0735952A3D25F0E24F`，没有改写。新脚本会拒绝覆盖已有同名结果，防止重复执行悄悄替换实验记录。
