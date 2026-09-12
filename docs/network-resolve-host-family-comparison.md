# Chromium 与内核 DNS 地址族：一次隔离对比

根代理于 **2026-09-08 03:28:28.643 UTC（北京时间 11:28:28.643）**执行一次 DNS 对比。两个目标的 Chromium 默认 `resolveHost()` 均只返回一个 IPv4；显式 `AAAA` 查询均返回 `net::ERR_NAME_NOT_RESOLVED`，同轮 mihomo AAAA 查询却取得有效 IPv6 候选。这是不同解析入口的当轮差异，未生成路径资格或账号许可。

原记录：[不可改写 JSON](./network-resolve-host-family-comparison.20260908T032828492Z.results.json)，SHA-256 `44acbff45a58ec49fff630b6b019c460dfee7600ea410e0ba1eaa8e3a463d763`。没有重跑 DNS 或改写此前的正常解析、出口及强制 IPv6 记录。

| 目标               | Chromium 默认解析                                | Chromium 显式 AAAA                                                                      | 同轮内核 AAAA                                                                                         |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `api6.ipify.org`   | 一个 IPv4；实际调用至结算 `188.3988–191.2192 ms` | `queryType: AAAA, cacheUsage: disallowed`；`191.9126–192.8973 ms`，名称解析失败，未超时 | status 0、未截断，一个 AAAA，原 TTL **1 秒**；读取 `184.215–186.9925 ms`，原截止 `1184.215 ms`        |
| `api.bilibili.com` | 一个 IPv4；`235.5927–236.4802 ms`                | 同样的显式选项；`237.0204–237.6805 ms`，名称解析失败，未超时                            | status 0、未截断，四个 AAAA，原 TTL **63 秒**；另有 CNAME TTL **273 秒**；读取 `193.8544–234.8029 ms` |

内核答案在各目标最后一次 Chromium 查询结算时仍处于原 TTL 内。Chromium 不提供 TTL，报告保持 `ttl:null`；没有借用内核 TTL 给 Chromium 结果补有效期。默认查询的 IPv6 集合为空，因此报告中的 `firstSubsetOfSecond:true` 同时标有 `emptyFirst:true`、`equal:false`；**空集的数学子集关系不是 IPv6 资格或单族约束**。显式 AAAA 是失败，不是成功返回空答案。此次未捕获 NetLog，不能把它写成已经识别了具体 SYSTEM/DNS 任务，也不能用独立 `resolveHost()` 代替实际 HTTPS 传输。

实验使用 Electron **43.3.0 / Chromium 150.0.7871.212**、ready 前配置的 TCP profile、同一个新建非持久匿名 Session。每次 Chromium 查询前只清其解析缓存；没有 MAP、resolver 重配置或系统设置修改。计数为 **4 次 Chromium DNS、2 次内核 AAAA、2 轮本机控制器读取**；没有业务 HTTP 请求、真实账号、窗口或 WebContents，没有使用 NetLog。DNS 自身可能使用的上游传输不被描述为“物理零 HTTP”。

控制器前后均为 `rule + TUN / 424c2ef`，fingerprint 均为 `7673abd51fa0cde637d55f27a481f62af933e155ff44e9c7e3f586037052fa05`。12 个生产输入源码摘要起止一致；子进程正常退出、无 watchdog，临时目录已删除。`cleanup.drained=true` 的范围是实际 `resolveHost()` 原 Promise、本机控制器公共读取 Promise 和 Session 清理；**控制器原生 HTTP 连接关闭未被观察**，原字段 `controllerReadTransportCloseObserved:false` 保留。脚本摘要 `801abf6412840d52c0b9413759c7bbe9b3ab917375919934f19df32d84d5e7ef`，bundle 摘要 `d2dcb8ed597a00edab62e5333b72e7d91ba22a74b4a5b9bdb957aaf09316e2c1`；6 项本机检查与这次实际 DNS 结果分别记录。

本轮另修正生产 `PathConformanceAdapter` 的已审核 real 分支：允许非空、合法、无重复的 `transportAddresses` 是 `kernelAddresses` 的子集。新增 **10 项回归**，本文件 **157 项通过**；正例经过实际 `ProductionProofSource` 与路由校验，全部当前内核候选仍逐个查路。即使传输未选中某个候选，该候选的下一跳不符合已审核路由类，也使整轮拒绝，TLS/出口采样不调用。空集合、越界地址、错族、无效地址和重复地址均拒绝；fake 映射、规则、期限和 profile 审核没有放宽。这项修正不把本次空 IPv6 集合变成资格，也没有自动接通正常 profile。

11:31 CST 最终全量为 **83 个测试文件、2720 项通过**，typecheck、lint 通过。首次全量为 **2719 通过、1 失败**：`effective-config-source.test.ts` 的 `a stalled decoder times out without overlapping another read or surfacing its secret error` 达到 5000 ms 测试超时，原 30 ms 真实计时可能在文件读取进入 decoder 前触发，使 `await entered` 无法完成。只修改测试时序：先创建 fixture，仅对定时器与 performance 使用假时钟，确认 decoder 已进入再推进 30 ms，最后 drain 并还原真实时钟。该文件 41 项及随后全量复跑通过，未改生产超时上限。

下一步将本次解析差异与[当前 IPv6 路由覆盖库存](./network-native-ipv6-route-coverage.md)分别用于有限路径适用性审核。不能假设公开域名只返回公网地址，也不能仅凭同一物理接口覆盖 ULA、link-local、本机 on-link 或所有源地址选择。正式应用仍为 observe；六平台范围不缩减，历史 JSON 不会被加载为运行资格。
