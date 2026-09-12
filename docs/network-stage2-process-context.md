# 阶段 2：四条匿名路径的 mihomo 进程上下文实测

日期：2026-09-07。此报告补充此前的 [请求取消实验](./network-stage2-experiments.md)，不改动其已冻结结果。

**四条路径均已在真实 mihomo `/connections` 中匹配成功。** 本次开发版环境中，页内 fetch、`session.fetch`、独立诊断 Session、Electron 主进程 `node:https` 都被内核识别为同一个 `electron.exe` 路径，且本次目标的 `chains` 均为 `["DIRECT"]`。这不是根据 PID 推断的结果。

## 1. 运行方式与隔离

```text
node scripts/electron-process-context-probe.mjs
```

- [脚本](../scripts/electron-process-context-probe.mjs)单独启动隐藏 Electron 进程，使用全新临时 `userData`、`sessionData` 和独立的内存 partition。
- Electron **43.3.0**，Chromium **150.0.7871.212**；`app.isPackaged = false`。
- 没有打开 ClipDock 生产主入口、真实账号或生产分区，没有设置任何 Cookie。
- 四条路径只主动请求公开匿名端点 `https://myip.ipip.net/json`。Chromium 请求使用 `credentials: "omit"`，并从请求头移除 Cookie、Authorization、Proxy-Authorization；响应中的 Set-Cookie 也丢弃。Node HTTPS 不使用任何 cookie jar 或认证头。
- 回显结果只记状态码和字节数，不保存返回的出口 IP 内容。
- controller 只读访问 `127.0.0.1:9790` 的 `/configs` 和 `/connections`，没有修改规则、模式、节点或配置文件。
- [原始脱敏结果](./network-stage2-process-context.results.json)保留匹配连接 ID、端口、NetLog 证据和内核返回字段。只保存本次匹配连接的元数据，不保存其他用户连接或代理节点列表；若 chain 非 DIRECT，节点名称会替换为稳定散列标签。

## 2. 实测前提

实验开始与结束时只读确认均为：

| 字段 | 值 |
|---|---|
| mihomo mode | `rule` |
| TUN | 开启 |
| find-process-mode | `strict` |

脚本在不是 rule + TUN 时会停止外部诊断，不替用户切换模式。

## 3. 连接归因方法

每条路径依次执行，使用以下联合证据，避免把同 host 的其他活动连接当成本次请求：

1. 请求前读取 `/connections`，保存已经存在的连接 ID。
2. 发起本条匿名请求，在约 3.8 秒窗口内读取活动连接，只收集新连接 ID 且 host 为 `myip.ipip.net`、目的端口为 443 的候选。
3. Chromium 路径从临时 Session 的公开 NetLog 记录读取 `TCP_CONNECT` 的真实本地源端口；Node 路径从本次 `https.request` 所属 socket 的 `localPort` 读取源端口。
4. 使用独立获得的源端口与 `/connections.metadata.sourcePort` 精确匹配，最终再记录该连接上的 `process`、`processPath`、`chains`。

没有使用“PID 看上去一样”代替内核归因。匹配不到源端口，或元数据中缺少 process/processPath，脚本会明确写成未验证或进程上下文缺失。

## 4. 四条路径结果

| 路径 | 独立观测的源端口 | `/connections.process` | `chains` | HTTP |
|---|---:|---|---|---:|
| 临时账号形态 partition 的页内 fetch | 63238 | `electron.exe` | `["DIRECT"]` | 200 |
| 临时账号形态 partition 的 `session.fetch` | 63394 | `electron.exe` | `["DIRECT"]` | 200 |
| 另一个独立匿名诊断 Session 的 fetch | 50225 | `electron.exe` | `["DIRECT"]` | 200 |
| Electron 主进程内 `node:https` | 60238 | `electron.exe` | `["DIRECT"]` | 200 |

四条匹配连接的实际 `processPath` 均为：

```text
D:\project development\短视频平台管理\node_modules\electron\dist\electron.exe
```

共同字段：`inboundType = Tun`，`network = tcp`，`ruleType = DomainSuffix`，host 为 `myip.ipip.net`，目的端口 443。每条路径只有 1 个候选，且该候选与独立取得的源端口匹配；controller 读取失败次数均为 0。

这里的 Node HTTPS 是**嵌入 Electron 主进程的 Node 网络栈**，不是另起 `node.exe`。不能把这条结果外推成独立 Node CLI 进程的身份。

## 5. 目标地址与证据边界

- Chromium NetLog 与 Node socket 中，目标 socket 地址均是 `198.18.2.57:443`；这是本次 TUN 环境的 fake-ip 地址。
- 内核匹配连接的 `destinationIP` 字段均为空。报告没有把 fake-ip 伪装成真实站点 IP，也没有补猜真实远端地址。
- 本次可确认“这一条匿名请求的 sourcePort 对应内核记录、host、processPath 和 DIRECT chain”。**真实目标 IP、外部出口归属和后续业务请求的链路仍未由本实验证明。**
- 首条 Chromium 路径的 NetLog 另有 4 个源端口未匹配本次目标，报告保留其数量和 socket 记录，不把它们归因成页内请求。NetLog 会记录该隔离进程的底层连接活动；内容请求白名单不等于证明没有任何 Chromium 底层后台连接。这些附加 socket 的用途未验证，没有从它们推导目标站点的链路。

## 6. 对方案的直接影响

1. **开发版四路径进程上下文的必要实验已补齐。** 原取消实验报告中“四路径未验”是当时状态，本报告提供后续真实连接证据。
2. 根据本次观测，给 `electron.exe` 配 PROCESS-NAME / PROCESS-PATH 规则不能区分这四种流量。同一可执行文件下的独立 Session、Node 网络栈不自动获得独立的进程规则身份。
3. 本次四个请求命中同一公开 host 的 DomainSuffix DIRECT；不能推导六个平台的 API、CDN、验证码、上传 host 都命中 DIRECT，不能直接用作全平台 DirectProof。
4. 本次没有证明修改规则、网络切换或旧连接复用期间的原子性；本次成功不允许缓存无限延长，也不解除不可验证时休眠的要求。

仍未验收：**打包版**可执行文件的名称与路径、真实平台 host 的匿名链路覆盖、真实目的 IP 与出口归属、IPv6/QUIC 等路径、模式/规则变更后的旧连接行为。阶段 3 的严格放行不能仅依赖这张进程身份对照表。

## 7. 补充：有界匿名出口与地址族对照

2026-09-07 21:18（上海时间），另用 [匿名出口脚本](../scripts/electron-anonymous-egress-sample.mjs)按当前 `AnonymousDiagnostics` 的两个端点完成采样；[脱敏原始结果](./network-stage2-anonymous-egress.results.json)单独保存。没有重跑或改动前述 23 项取消实验结果。

两套全新临时 Chromium Session 分别设置：

- `direct`：`session.setProxy({ mode: "direct" })`；
- `proxy`：显式 `fixed_servers` 指向 `127.0.0.1:10090`，配置与当前诊断实现一致。

每套 Session 对两个端点各请求 **1 次**，共 **4 次回显请求**。只对 **2 个唯一出口 IP** 各查一次 `ipwho.is`，共 **2 次归属请求**，没有重试。API 返回 IP 与查询 IP 在内存中核对。完整 IP、回显正文、地理 API 正文没有落盘或输出，未开启 NetLog；仅保存脱敏 IP、国家和 ASN。没有 Cookie、Authorization、账号接口或生产资料参与。

| Session 配置 | 回显端点 | API 返回国家 / ASN | 脱敏出口 | 端点观察到的出口地址族 | TLS |
|---|---|---|---|---|---|
| direct | `myip.ipip.net/` | CN / AS4837 | `123.234.*.*` | IPv4 | HTTPS 正常 |
| direct | `www.cloudflare.com/cdn-cgi/trace` | JP / AS215355 | `2a14:67c0:…` | IPv6 | HTTPS 正常；端点报告 TLSv1.3 |
| proxy | `myip.ipip.net/` | CN / AS4837 | `123.234.*.*` | IPv4 | HTTPS 正常 |
| proxy | `www.cloudflare.com/cdn-cgi/trace` | JP / AS215355 | `2a14:67c0:…` | IPv6 | HTTPS 正常；端点报告 TLSv1.3 |

四次均为 HTTP 200，使用 Chromium 默认 HTTPS 证书校验；没有忽略证书错误或替换证书验证。TLS 正常只证明连接端点的 HTTPS 成功，不证明链路没有经过 TUN 或代理。

这里 **direct / proxy 是 Session 配置名称，不是实际出口结论**。实验开始与结束时内核都是 `rule + TUN`。同一 Session 配置访问不同端点，得到不同国家、不同地址族的出口；通过 10090 访问国内回显端点也仍得到 CN。两条配置并不构成独立、强制相反的出网路线。

IPv6 的结论必须分开：**已观察到 Cloudflare 端点接收到 IPv6 出口，且归属 API 返回 JP**。但本实验没有证明本机原生 IPv6、大陆物理 IPv6 或 Chromium 到 TUN/显式代理之间实际使用的 socket 地址族；这些仍为未验证。尤其不能把这个结果写成“IPv6 不可达”或“无 IPv6 泄漏”。

本次不解析和绑定 fake-ip 背后的真实目标 IP，也不把回显端点的 CN 结果升级为六个平台的 DirectProof。`ipwho.is` 的国家/ASN 是当前第三方归属结果，不能替代逐目标链路证明。打包版、平台 API/CDN/验证码链路、IPv6 策略和路由切换仍需后续验收。
