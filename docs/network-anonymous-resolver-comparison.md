# api.bilibili.com 匿名解析对照

2026-09-07T22:13:08.875Z 至 22:13:12.495Z（北京时间 2026-09-08 06:13），隔离 Electron 43.3.0 执行一次限定目标的解析实验。脚本：`scripts/electron-anonymous-resolver-comparison.mjs`；[脱敏实际结果](./network-anonymous-resolver-comparison.results.json)。没有重试，没有修改 mihomo 或 OS 配置，没有复用账号 Session。

**结果：Chromium 的独立解析返回 fake-IP，内核 API 返回另一组地址；不能把两者当成同一组目的 IP。** 本轮没有生成 resolver equivalence 资格、实际 fetch 解析证明或网络许可。

## 实际执行

使用当前支持的猫猫云来源选择器、真实 `ensureDirectSession()`、匿名凭据配置和启动期 TCP 配置。新非持久 Session 的初始化记录为 `setProxy(direct) → closeAllConnections → clearHostResolverCache`。没有设置外部 DNS、强制地址族、host-resolver 映射或关闭系统 IPv6。

| 调用 | 实际选项 | 结果 |
|---|---|---|
| Chromium 默认解析，1 次 | `ses.resolveHost(host)`，完全省略 options | 1 个 IPv4，落入当前显式 fake-IP 范围 |
| Chromium 显式 A，1 次 | `{ queryType: "A", cacheUsage: "disallowed" }` | 与默认解析相同的 IPv4 hash |
| Chromium 显式 AAAA，1 次 | `{ queryType: "AAAA", cacheUsage: "disallowed" }` | `ERR_NAME_NOT_RESOLVED` |
| 内核 A，前后各 1 次 | 当前本机 `/dns/query`，同一目标 | 每次 4 个 IPv4，均在显式 fake 范围之外，当前分类器标 real |
| 内核 AAAA，前后各 1 次 | 当前本机 `/dns/query`，同一目标 | 每次 4 个 IPv6；范围缺项，分类仍为 unknown |

两次显式 Chromium 查询前仅清理该隔离 Session 的 DNS 缓存；未清理系统或内核缓存。默认调用允许解析器自行决定来源、地址族与 Secure DNS 行为；显式 A/AAAA 是另外的测量条件，不能冒充业务请求的选族。该 API 不提供回答 TTL，本报告保留 `ttlAvailable:false`。[Electron resolveHost](https://www.electronjs.org/docs/latest/api/session#sesresolvehosthost-options)

## 稳定性与时效

当前来源/解码器选择、配置文件及政策摘要、Controller 可见版本、内核 owner、OS 网络指纹、系统 hosts 文件前后均稳定。系统 hosts 对本目标前后均为 0 项匹配。只记录文件/版本摘要，没有保存原配置、上游 DNS、系统 hosts 内容或秘密。

脚本共执行 12 次固定本机 Controller GET：前后两个配置读取批次共 8 次，加 4 次 DNS 查询。Chromium 解析 3 次；业务/公开 HTTP 调用或页面请求尝试为 0。默认解析器内部可能使用何种 DNS 传输没有观测，不能把这里的 HTTP 计数解读为“整个机器绝无 DNS-over-HTTPS”。

内核所有回答 TTL 均为 1 秒，按各查询开始时间计算原始截止时间。Chromium 对照发生在这些初始回答的截止时间之前；最终 owner/OS 复核完成时，内核回答已过期，所以结果保留 `kernelAnswersStillFresh:false`。两个来源候选当时仍在各自期限内。**没有延长源或 DNS 时效；保留的是当轮观察，不是可继续使用的许可。**

7 项自检及所有相关源码前后 hash 检查通过。报告中地址只存规范字符串 SHA-256、地址族、分类及与显式范围/前后答案集合的重合状态；CNAME 与答案名称也只保留 hash。公开报告没有原始 IP 或 DNS 响应。

## 能得出的结论

当前配置下，本目标的 Chromium 默认解析与 `/dns/query` 出现了有完整调用记录的表示差异：Chromium 返回一个 fake IPv4，而 API 返回另一组地址，尚未观测二者的实际映射和最终拨号关系。`real` 分类只指普通地址位于该族已知 fake 范围之外，不表示大陆、DIRECT 或实际请求已经使用它。

默认解析仅返回 IPv4、显式 AAAA 失败，都不能推出实际 fetch 的全路径单族约束。独立 `resolveHost` 不触发平台 TLS/HTTP 业务，不能观察嗅探后的 Host/DstIP，也没有检验账号/TLS/egress 工厂跨 profile 的等价性。本轮没有请求诊断回显站，没有应用两条待授权诊断规则。
