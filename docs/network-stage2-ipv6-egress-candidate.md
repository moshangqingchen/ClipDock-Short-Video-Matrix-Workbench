# IPv6 专用回显：正常 DNS 的一次候选路径实验

时间：2026-09-08 00:34:55（Asia/Shanghai）。[脚本](../scripts/electron-ipv6-egress-candidate.mjs)、[脱敏结果](./network-stage2-ipv6-egress-candidate.results.json)。保留此前 [B 站 IPv6 反例](./network-stage2-af-counterexample.md)及其两条结果，本轮没有重跑 B 站。

**本次匿名回显成功，服务端观察到的 IPv6 被地理服务识别为日本、AS215355；实际 Chromium socket 和 mihomo 链未归因，不能认定 native 或 DIRECT。** 这份样本不符合大陆出口政策，也不适用于国内账号签发。

## 范围与隔离

仅执行一次 `https://api6.ipify.org/` 回显，成功后执行一次 ipwho.is 地理核对，没有重试、强制 AAAA 或用户配置修改。ipify 官方说明 api6 是 IPv6 专用端点；这只约束服务器侧所见通路，经过代理时不能据此推出客户端 socket 的地址族。[ipify API](https://www.ipify.org/)

独立 Electron 43.3.0 临时进程/目录，默认 Session 全拒，匿名 Session 初始化 direct 后立即清旧连接，只允许一个目标 GET，拒绝其他外部目标和重定向。`session.fetch` 的响应原文仅在主进程内存中解析；地理核对同样只保留脱敏字段。原 IP 不传 renderer、不落盘，未使用 NetLog、账号或凭据。

实验仍为正常 DNS；独立主进程还读取当前控制器 AAAA，作为 socket 候选核对输入，**没有把查询结果注入 Chromium 解析器**。内核维持 rule + TUN、`ipv6=false`，可见 config/rules 前后哈希不变。

## 结果

| 检查 | 实测 |
|---|---|
| 实际匿名回显请求 | 1 条，HTTP 200 |
| 回显 IP 地址族 | IPv6 |
| 地理请求 | 1 条；返回 IP 与回显规范化后相等 |
| 国家 / ASN | JP / 215355 |
| 请求凭据头 / Cookie 存储 | 未出现 / 0 |
| 证书错误 | 无；未关闭验证 |
| WebContents CDP 是否看到该 Session.fetch | 否 |
| 独立 Windows socket 与目标 AAAA 的新连接匹配 | 0；未选择其他候选 |
| socket source 是否等于回显 | 未知，保留 null |
| mihomo 链 | UNATTRIBUTED，无可核验源 tuple，不借其他连接 |

服务端回显地址的 canonical IPv6 字符串 UTF-8 SHA256：`f647da8fd916ad8ff228abebfee8892c082432a8131f6fa94c80dff9920bb8e1`。这是**回显来源地址摘要**，不是已归因本机 socket 的源地址摘要。

辅助只读 OS 快照时间为 00:32:19，包含 14 个 IPv6 地址（其中 6 个 global、2 个 Preferred）。这个回显摘要与其中任何地址都不相等；快照距回显约 156 秒且未重采，因此只记录“与该历史快照无匹配”，不能保证其间地址没有变化，也不能替代本次 socket 归因或路由类判断。

此前 B 站强制 AAAA 实验的完整 socket sourceAddress 及其哈希均未保留，原临时进程已经退出。因此不能比较两次实际来源是否相等；结果明确标记 `UNAVAILABLE_ORIGINAL_SOURCE_OR_HASH_NOT_RETAINED`，没有从当前网卡信息补造历史值。

## 对证明模型的影响

本轮进一步说明“IPv6 专用回显能访问”不能等同“本机具有合格大陆 IPv6 通路”。当前样本既是 JP，又缺少目标/实际 socket/内核路径绑定，不能共用给 B 站或其他国内目标。

正常 DNS 下的回显、强制 AAAA 下的 B 站资源，是两个不同目标、不同解析条件的样本。不能用其中一个解释另一个，也不能把没有 `/connections` 记录直接写成“已经证实绕过 TUN”。保持原先判定：`ipv6=false` 本身不能授权单族放行；要运行仍需实际通路类及全部可能地址族的有效证据。没有继续消耗请求尝试填补本轮归因缺口。
