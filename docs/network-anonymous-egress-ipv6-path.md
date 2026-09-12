# 当前配置下正常 DNS 的 IPv6 出口工厂调查

2026-09-08。**本次实际回显正文是 IPv6，但精确归因的 Chromium 应用 socket 是 IPv4，mihomo 当前链是 non-direct。** 本次同 IP 地理响应为 JP / AS215355。因此它不是 native IPv6 或大陆直连样本，不能签发 IPv6 许可；这不是沿用以前的日本回显结论。

## 独立产物

- 脚本：`scripts/electron-anonymous-egress-ipv6-path-probe.mjs`。
- 首次报告写入失败记录：`network-anonymous-egress-ipv6-path.results.json`，保留不变。
- 修正采样结果：`network-anonymous-egress-ipv6-path-v2.results.json`。
- 修正采样的 **11 份独立阶段记录**：`network-anonymous-egress-ipv6-path-v2.checkpoints.json`。

修正采样命令为 `node scripts/electron-anonymous-egress-ipv6-path-probe.mjs --repaired`，只执行一次。时间为 **2026-09-07 21:07:47.177–21:07:54.366 UTC**（北京时间 09-08 05:07:47–05:07:54）。Electron 43.3.0 / Chromium 150.0.7871.212 / Windows / unpackaged。

## 实验边界

独立隐藏子进程、临时 userData/sessionData、非持久私有 Session、默认 Session 全拒，没有账号或生产 bootstrap。实际调用当前 `AnonymousEgressProbe.probe("ipify-ipv6")`，保留 **12 秒默认超时**；整个修正轮只有 api6.ipify.org 一次匿名 GET 和工厂随后构造的同 IP ipwho.is 一次查询，无重试。

使用正常 DNS，没有 `host-resolver-rules`、强制 AAAA、额外 DNS 查询或用户配置写入。实际工厂执行 direct 初始化、立即关闭旧连接、清 Chromium DNS 缓存和匿名凭据设置。启动前调用实际关闭 QUIC 模块；这只限定本次 Chromium TCP 实验，不称绕过 TUN。默认证书验证、omit/manual/no-store、响应 Cookie/认证头剥离均由现有生产工厂执行，没有替换 TLS、Agent 或代理设置。

测量 shim 在实际原始 Response headers 返回后，最多延迟 2.5 秒交还 Response，读取该次 NetLog 和 Windows TCP 表。原始 NetLog 只存在于**无账号的隔离子进程**，不用于常规多账号续证。没有借另一个 WebContents 的 CDP，没有 DELETE 连接，没有把“只有一个 PID/同 host”当成请求归属。

请求前记录 selected-PID socket 与 mihomo connection 基线；根据本次精确 URL 的 NetLog 请求依赖找到单个 socket，再用 Windows Network Service PID 与源地址/端口、远端地址/端口全部一致的 Established tuple 核对。mihomo 匹配还要求基线没有的新 ID、源地址/端口和当前 host/443/TCP 对应。未知规则和 non-direct 链原样记录，不伪造 DIRECT。

## 当前实测

| 项目 | 回显 api6.ipify.org | 地理查询 ipwho.is |
| --- | --- | --- |
| 实际请求 | 1 次 | 1 次，仅本次回显 IP |
| HTTP / 缓存 / TLS | 200 / 非缓存 / Chromium 默认验证 | 同左 |
| factory / context | `clipdock-anonymous-egress-v1` / `05368e1b-6d46-4231-9b90-a6efe5208170` | 同一个实际工厂 context |
| Windows Network Service PID | 117612 | 117612 |
| 实际应用源端口 | 52174 | 57834 |
| NetLog 根 / 关联 socket | 1 / 1 | 1 / 1 |
| Windows 核验应用 socket 地址族 | **IPv4** | **IPv4** |
| 精确新 mihomo ID | `40ab84bf-1de0-485d-86e6-9764ce9b1a4c` | `249db6f2-5604-4cf0-836f-0493c3a53855` |
| 实际入站 / 链 | Tun / **non-direct** | Tun / **non-direct** |
| 当前规则解释 | 第 46 项 IPCIDR 起 unknown | 同左 |
| headers→取证完成 | 3128.691→4163.708ms | 4590.608→5724.389ms |

两次测量均未超过 2.5 秒；工厂最终 `available=true`。Windows reader 的 kernel owner 创建 ticks / 路径摘要与 controller owner 一致；这次 mihomo 的 processIdentity 实际有值，且与 Windows Network Service 路径摘要相同，没有从空值补造。

本次正文地址族为 **IPv6**，规范地址 SHA-256 为 `ee50358b7d3465ece9e130d6cc3eae873b3de63065daf0d14af7b03604d62524`。工厂验证 geo 返回的 IP 与正文规范化后相等，countryCode=**JP**、ASN=**215355**；国家来自地理响应，不由 ASN 注册地推断。已归因 app socket 的源地址不等于正文回显地址。

本轮两条 non-direct 连接的 `remoteDestination` 原始字段形状均为**纯 IPv4 字符串**，报告仅保存其摘要与地址族。由于它们走代理链，这个 API 字段不冒充指定请求的物理出站 socket 证据。生产 parser 的 DIRECT-only remote 字段仍为 null，没有为追物理端口扩大代理候选，也没有借之前 B 站双流配对解释这两条代理连接。

## 解析路径取得了什么

隔离 NetLog 中出现显式 api6/ipwho host 的 `HOST_RESOLVER_MANAGER_REQUEST`、`HOST_RESOLVER_SYSTEM_TASK` 开始/结束，以及同 host resolver source 的 `HOST_RESOLVER_MANAGER_CACHE_HIT`。这是正常系统解析任务和本轮缓存命中的观察，不能从事件名推断系统 DNS 服务器、fake-IP 转换或实际 AAAA 集合。

本轮脱敏提取器保留了 `address_list`、`ipv6_available` 等**字段名**，但未提取 `address_list` 的嵌套内容或 `ipv6_available` 的布尔值。因此 JSON 中 `addresses=[]` 表示没有成功提取地址，**不是 DNS 没返回地址**。不借此宣布 IPv6 被禁用，也不把共享 resolver source 反向连接到无关 socket。`resolverPathEquivalenceVerified=false` 保持不变。

当前仍为 rule + TUN / global ipv6=false。可见配置/规则/DIRECT 摘要、OS 网络 hash 和 kernel owner 前后稳定；这些观察不把可见 API 哈希冒充隐藏 DNS 配置的完整版本。

## 第一次报告失败及修正

第一次运行在最终清理中错误调用了 `WindowsTcpSocketReader.dispose()`；这个生产 reader 只有有界的单次读取，没有 dispose API。异常发生在最终 JSON 写入之前，导致 `CHILD_RESULT_MISSING`。原始临时资料已经删除，**不能恢复或猜测该次已发数量、地址族、国家及链结果**；脚本本身的上限是 echo/geo 各一次，但不将“最多两次”写成“实际零次”。原失败 JSON 保持 SHA-256 `9c54cafc3164c1baa60534772d9bc8a33d33fe3ea4b4b71b1196b9984312bd81`。

修复后每个阶段先保存脱敏独立 checkpoint，最外层异常只追加固定错误标记；最终清理失败也保留已有 facts。清除不存在的 dispose 调用，没有给生产 reader 添加伪 API。`--cleanup-selfcheck` 的 **4 项无公网检查**验证：阶段 facts 可读、模拟清理异常保留 facts、只读 reader 无 dispose 正常结束、独立 checkpoint 不覆盖。随后经任务协调才执行以上一次修正采样，没有在失败后循环请求。

修正采样保存 11 份阶段数据，`cleanupSucceeded=true`、`environmentStable=true`、`sourcesStillCurrentAtCompletion=true`，子进程退出且临时原始日志删除。bundle SHA-256 为 `fa9bc99486e11b49753107cb229a0f62b3c00224a47dd6e2a1a2410255925b53`；脚本 SHA-256 为 `bd388ed875fbb6746f2af029bf4b93f47e744002cad3c09f5342f55a6d9e68e8`。语法和 Prettier 检查通过；仓库 ESLint 忽略 scripts，未把忽略结果宣称为 lint 覆盖。

## 对当前方案的结论

本次补上了早期正常 DNS 回显调查缺失的实际应用 tuple/入站链归因：**IPv6 正文可以经本机 IPv4 app socket 与代理链取得**。它支持继续区分 `reportedAddressFamily` 与实际传输地址族。

它没有证明原生 IPv6 不可用，也没有取得合格的大陆物理 IPv6 出口。`nativeIpv6Qualified=false`、`qualificationGranted=false`；不调整生产 AF 默认、不为任何账号签发许可、不更改用户配置。此前强制 AAAA 反例和旧 JP 候选报告独立保留，既不改写，也不作为这次结果的替代证据。
