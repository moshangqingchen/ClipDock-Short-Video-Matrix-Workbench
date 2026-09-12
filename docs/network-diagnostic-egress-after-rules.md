# 两条诊断规则生效后的匿名出口观察

**两次 IPIP 观察均取得 CN / AS4837 的 IPv4 匿名回显及确切 IPv4 app socket。第二次候选的源端点、目标、Tun、DIRECT 与请求时间均匹配；旧实验辅助相关器仍因内核元数据没有进程身份而拒绝。这个额外要求不是当前生产 mapper 的阻断条件。** 本文原两轮中，IPv6 专用回显仅在首轮请求一次、结果不可用，第二轮只复核 IPIP；这两轮没有追加 API6 重试。后续的[正常解析失败观察](./network-normal-resolver-observation.md)和[独立强制 AAAA 的 IPv6 成功观察](./network-native-ipv6-observation.md)各有新记录，不改写本文历史。这些都是有限观察，不是账号许可、完整路径资格或阶段 3 验收。

## 首轮：保留原结果

执行起点为 **2026-09-08T01:50:38.390Z**（北京时间 09:50:38），结果见 [首轮独立 JSON](./network-diagnostic-egress-after-rules.20260908T015038173Z.results.json)。文件 SHA-256 为 `e9f213424249fee55fb8f14e5ec04e786611b124ce864dc365a8df59d3ccc572`，原结果不因后续脚本修正而改写。

本轮使用 Electron 43.3.0 / Chromium 150.0.7871.212、独立临时资料目录、实际 `AnonymousEgressProbe`、正常 DNS、生产启动前 QUIC 约束和原有 12 秒采样上限。没有账号、窗口、真实 Cookie、生产 bootstrap、配置写入或控制器 DELETE；未替换 `Session.fetch` 或工厂内部状态。

| 项目 | 实际记录 |
| --- | --- |
| 当前控制器 | `rule`、TUN 开启、内核 `424c2ef`、3343 条规则 |
| 两目标规则 | `myip.ipip.net` / `api6.ipify.org` 分别命中索引 46 / 47 的 Domain → DIRECT |
| 前后检查 | 5 轮控制器读取的 fingerprint、规则摘要与 Direct 政策摘要一致 |
| 原工厂调用 | 两目标各 1 次，无重试 |
| 实际发送边界 | echo 2 次、geo 1 次；非预期请求 0 |
| 本地观察 | NetLog capture 2 次、Windows TCP 查询 1 次、connections 查询 3 次 |
| 清理 | 子进程正常退出，真实工作排空，原始临时资料删除，15 个源码摘要稳定 |

### IPIP：出口与 socket 事实

`myip.ipip.net` 回显与仅针对该匿名 IP 的 `ipwho.is` 地理查询均得到非缓存 HTTP 200，使用正常 Chromium 证书校验、`credentials: omit`。工厂核对地理响应 IP 与回显 IP 相同后，返回 **IPv4、CN、ASN 4837**。ASN 仅为辅助字段，CN 来自匹配 IP 的地理结果。

原请求发送至响应头的单调时间为 **173.4399–436.2645 ms**。私有 NetLog 的确切请求图找到一个 IPv4 socket，Windows 查询 **447.0016–1827.617 ms** 核对到唯一 Established 四元组，进程身份与当前 Electron 一致。因此 `windowsOwned=true`；它不是由回显正文的 IPv4 字样推断出来的。

回显正文完成时间为 **1828.4829 ms**，地理正文完成时间为 **3352.2098 ms**。响应头之后的观察耗时也在原工厂期限内，没有延长或倒填采样时间。原始 IP、地理 URL、响应正文和原始 NetLog 没有进入报告。

入站关联返回 **`CONTEXT_MISMATCH`**，`echoRouteObservation.available=false`。首轮脚本给辅助相关器传入固定 `TUN`，而运行内核此前实际返回过 `Tun`；该辅助函数区分大小写。首轮 JSON 未保存这次候选连接的原始入站字段，所以仅凭此文件不能宣称已经定位唯一原因，更不能事后把失败改成匹配成功。

### API6：只记录这一次不可用

`api6.ipify.org` 实际发送一次 echo，请求最终为 `PROBE_UNAVAILABLE`，没有进入 geo；未取得响应头、socket 归属或国家结果。该结果不能表示所有 IPv6 不可用，不能证明业务仅有 IPv4，也不能重新解释为原生 IPv6 已经绕行。脚本没有重试。

## 仅 IPIP 复核：新结果独立保留

第二次起点为 **2026-09-08T01:57:50.413Z**（北京时间 09:57:50），见 [仅 IPIP 的独立 JSON](./network-diagnostic-egress-after-rules.20260908T015750202Z.results.json)，SHA-256 为 `33cab0d699360c34d1a03797c283e2a912d4b7a0ffef0461fa89969220f4978d`。

本次脚本预先固定预期入站类型为当前兼容范围的 `Tun`，没有从候选学习或改写候选字段；仅增加脱敏匹配明细，仓库辅助相关器不变。`--ipip-only` 同时约束父／子进程的选择、规则核验、Session 与请求计数。根任务执行命令为：

```powershell
node scripts/electron-diagnostic-egress-after-rules.mjs --run-once --ipip-only
```

| 项目 | 第二次实际结果 |
| --- | --- |
| 公开请求 | IPIP echo 1 次、匹配 IP 的 geo 1 次；API6 0 次 |
| 本地检查 | 3 轮控制器读取、2 次 connections、1 次 Windows TCP、1 次 capture |
| 出口与请求 | 非缓存 HTTPS 200，IPv4 / CN / ASN 4837；唯一真实 IPv4 app socket，Windows owner 匹配 Electron |
| 当前规则 | 3343 条，IPIP 命中 Domain → DIRECT；前后 fingerprint 与首轮相同 |
| 生命周期 | 1 个匿名 Session、无窗口/账号、非预期请求 0；清理排空、子进程退出、原始资料删除、15 个源码摘要稳定 |

原发送至响应头时间为 **174.184–352.2156 ms**；Windows 观察为 **361.6293–1829.9073 ms**；回显正文完成 **1830.8634 ms**，地理正文完成 **2288.7768 ms**。这些是各自原时刻，没有把慢后验伪装成请求开始时的事实。

本次保存的候选明细消除了辅助函数拒绝原因的不确定性：唯一候选为本轮新 ID，源地址／源端口／目标端口／host／sniff host／TCP／请求开始时间均匹配，`inboundType` 实际为 `Tun`，路线为 `direct`。但是 **`processIdentityPresent=false`、`processIdentityMatches=false`**，辅助函数因此仍返回 `CONTEXT_MISMATCH`，脚本的组合 `echoRouteObservation.available` 保持 false。独立 NetLog → Windows 唯一 Established 四元组与原进程身份已另行核对；不能将内核的空进程字段填成该 Electron 身份来制造辅助函数匹配。

第二次脚本摘要为 `b35ce4dc82214c9ab5f344bbfa6e442c0f9e1a832fff5b4e076e2461edc7b973`；bundle 与首轮相同。该次也未改变工厂、正常解析、请求参数、12 秒期限或原 NetLog。10 项本地 parser／相关器／脱敏检查只用于验证实验脚本，不计为公网许可验收。

## 本轮结论边界

现在已有规则更新后的新鲜 CN IPv4 回显、原请求 socket 与独立 Windows owner 事实。只读源码核查确认，`correlateProbeConnection` 目前仅用于测试／实验脚本，没有生产调用；实际 [resolver-flow-mapping](../src/main/network/resolver-flow-mapping.ts) 在先核对独立 Windows owner、原 socket 和本轮唯一入站后，已经允许 `metadata.processIdentity=null`，有值时才要求与已验证 owner 一致。

因此保留脚本的 `incoming=false`，但不把这个旧辅助函数的额外条件升级为产品新门槛；也不需要为了凑齐内核进程字段重复请求 IPIP。下一步按原生产 mapper 及正常传输 profile 的 DNS／地址族／路径适用性审核推进。该 mapper 的其他来源、时间、地址与关联条件仍必须满足，不能仅用这份脱敏结果构造新的运行资格。

上述两次结果都不单独证明内核物理出站归属、两工厂路径等价、全部可能地址族或出口样本对 B 站业务的适用性；`qualificationGranted` 与 `permitIssued` 均为 false。API6 的一次失败也不能替代 IPv4-only 约束。首轮失败和新复核分别保留，没有把历史失败改写为已匹配。

首轮脚本摘要为 `a8559c10082c220d78a336212e5d599f2a7138e361b464ee94c2215f753a2b6a`，实际 bundle 摘要为 `924ac09985c75ec68f5d08a620e93477dfb524a90ec7240e6a2700784b3babb8`。这些摘要仅对应首轮；新脚本结果必须另记自己的摘要。
