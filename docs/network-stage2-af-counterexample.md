# IPv6 单族约束的有界反例实验

时间：2026-09-08 00:26（Asia/Shanghai）。[复现实验](../scripts/electron-af-counterexample.mjs)、[脱敏结果](./network-stage2-af-counterexample.results.json)。本轮没有修改生产源码或用户配置，没有开启 strict，没有真实账号、Cookie、Authorization 或 NetLog。

**结论：当前全局 `ipv6=false` 不能单独证明 Chromium 仅可 IPv4 出网。** 强制真实 AAAA 的临时 Chromium 请求经 IPv6 成功完成证书有效的 HTTPS；但未关联到 mihomo 记录，不能进一步声称 mihomo 的 DIRECT 拨号使用了 IPv6。

## 实验约束

锁定 Electron 43.3.0 / Chromium 150.0.7871.212，内核 424c2ef，规则模式 + TUN，`global ipv6=false`。公开目标为 `www.bilibili.com` 的 `robots.txt`；运行规则已有精确 DOMAIN → DIRECT，当前内核 DNS 返回 4 个真实 AAAA。强制轮次在启动前重新读取 AAAA，选用记录 TTL 为 18 秒；公开目的地址仅保留散列，不记录本机完整源地址。

正常解析与强制解析使用**两个独立 Electron 进程、两个临时目录**。默认 Session 全拒；独立匿名 Session 仅准一条目标轻 GET，执行 `await setProxy(direct)` 后立即 `await closeAllConnections()`，不允许重定向或其他目标。保持证书验证，关闭缓存/QUIC以限定本次 TCP 实验；请求头删除凭据头、响应删除 Set-Cookie，结果确认凭据头未出现、Cookie 存储为 0。

强制轮次仅在该临时进程使用 `--host-resolver-rules=MAP www.bilibili.com [本次AAAA]`。此开关是 Electron 官方支持的主机解析覆盖，保留原 HTTPS 主机身份；Chromium 资料说明此类覆盖可绕过正常 IPv6 连通性预检。因此它用于检验“配置是否构成强制禁用”，不是原业务正常 DNS 行为的样本。[Electron 开关文档](https://www.electronjs.org/docs/latest/api/command-line-switches/)、[Chromium DNS 说明](https://chromium.googlesource.com/chromium/src/net/+/1e29b69e0eb6d68127804cc4cd8e8231ca060295/dns/)

## 实际结果

| 项目 | 正常 DNS | 强制本次真实 AAAA |
|---|---|---|
| 实际获准目标请求 | 1 条匿名 GET | 1 条匿名 GET |
| HTTP / TLS / 协议 | 200 / TLS 1.3 / h2 | 200 / TLS 1.3 / h2 |
| 缓存/ServiceWorker/连接复用 | 均否 | 均否 |
| CDP remote AF | IPv4 | IPv6 |
| 独立 Windows 新 socket | 唯一，源/目的 IPv4，源端口 62856 | 唯一，源/目的 IPv6，源端口 65155 |
| mihomo 当前连接归因 | 精确匹配 1 条 | 没有匹配记录 |
| 实际链 / 入站 | DIRECT / Tun | UNATTRIBUTED / 未知 |
| mihomo remoteDestination AF | IPv4 | 未取得，不能补为 IPv6 |
| 可见 config/rules 前后哈希 | 不变 | 不变 |

归因使用临时进程 `app.getAppMetrics()` 的 Network Service PID、请求前 socket/内核连接基线、CDP remote IP/port/未复用标记及 Windows TCP 表。内核匹配还要求**源地址和源端口同时相等**、目标 host/port/TCP 相符、当前新连接及有界时间窗；没有按 host 取第一条记录。正常轮次内核 `process` 为空，记录这一缺失，没有伪填。强制轮次没有匹配，不能借其他进程的 DIRECT 记录解释它。

两个临时进程的 Network Service 身份各自在本轮采样前后稳定；实验结束关闭连接并移除本实验自行创建的临时目录。未处理其他实验的目录。

## 可以与不可以推出什么

- 可以否定：仅见 `/configs.ipv6=false` 就将所有 Chromium 目标硬填 IPv4。即使该设置影响内核正常解析，仍未构成整个 Chromium 出网路径的 IPv6 禁止。
- 不能确定：强制 IPv6 请求是否绕过 TUN、为何没有控制器记录、mihomo DIRECT 自身是否能拨 IPv6。实验没有用于区分这些原因的充分证据，链保持 UNATTRIBUTED。
- 不能推出：正常业务此刻已经用 IPv6；强制解析路径等同账号正常路径；IPv6 服务器所见来源 IP 在中国大陆。这里没有出口回显/地理证据，也不签发 `applicabilityVerified`。
- 实现取向：继续要求未知地址族的全部可能分支有证，或采用**另有实际有效配置与正反向实验支持**的单族约束。当前这一个全局字段不够。以后负向请求若失败，也只能记未证实，不能把失败当单族约束成功。

初始页内 HEAD fixture 在请求钩子前结束（获准请求 0、CDP 请求/响应 0），没有作为网络证据；随后改成相同公开资源的轻 GET。本轮总共实际获准 2 条目标请求，没有为失败追加账号请求或带凭据探测。
