# 强制当前 AAAA 的本机 IPv6 有限观察

2026-09-08 **02:53:44.373 UTC（北京时间 10:53:44.373）**，独立临时 Electron 中的一次真实 `AnonymousEgressProbe` 取得 **IPv6 / CN / AS4837**。回显地址等于实际应用 socket 的本地地址；精确 NetLog 请求图、唯一 Windows Established 四元组和真实进程身份一致，以该真实源地址查路返回物理接口 **12**。这是强制解析实验的成功观察，未生成路径资格或账号许可。

原记录：[不可改写 JSON](./network-diagnostic-egress-after-rules.20260908T025343031Z.results.json)，SHA-256 `e719dc1fbf4b315f24a9b852023d3ad04238b97848b1a98a9a694ce69f814063`。此前[正常解析 API6 失败](./network-normal-resolver-observation.md)和[原两轮出口观察](./network-diagnostic-egress-after-rules.md)保持各自的时间、结果与哈希。

| 证据 | 本轮实际记录 |
| --- | --- |
| 独立解析 profile | `isolated-forced-api6-current-aaaa-v1`；`normalDns=false`，仅在 ready 前将 API6 映射到本次内核返回的一个 AAAA，geo 仍用正常 DNS |
| 原 AAAA 与时效 | 固定目标查询 status 0、未截断；一个 AAAA，原 TTL **305 秒**。原读取 `1072.506–1217.2047 ms`，映射 `1218.2972 ms`，截止严格为 `1072.506 + 305000 = 306072.506 ms` |
| 请求时序 | echo 发送 `1332.8575 ms`、非缓存 200 响应头 `1896.3085 ms`；均在原 AAAA 期限内。geo 正文完成 `5499.9536 ms`，发送至完成 **4167.0961 ms**，工厂原 **12 秒总上限**未改 |
| 请求与 Windows 归属 | NetLog root 30 / socket 34 的真实 IPv6 四元组；Windows 在 `1906.0107–3295.4682 ms` 查到唯一 Established 匹配，PID 172556、创建时间和可执行文件身份与该 Electron Network Service 一致 |
| 源条件查路 | `3295.8561–4920.0729 ms`，使用上述真实本地/远端地址调用只读 `windows-source-route-query`；精确源/目标一致，接口 12 为 hardware、up、Connected，源为 Preferred，`skipAsSource=false`，路由 Alive |
| 出口地理 | echo 与匹配 IP 的 geo 均非缓存 HTTPS 200、Chromium 默认证书校验、`credentials:omit`；工厂核对 IP 后返回 CN / AS4837，回显 IP 等于应用 IPv6 源地址。CN 来自地理结果，ASN 为辅助字段 |

AAAA、socket 远端与路由目标的摘要均为 `fd3a2197eb80329261219772825aa09b900113f753de212f729bb420a333f9ff`；应用源、路由源与出口回显的摘要均为 `c14369fec915485501913934102f69af6b12b73980e620508aad06891318f8a6`。没有将原始 IP、geo 路径或 NetLog 保存到报告。

前后控制器均为 `rule + TUN / 424c2ef / 3343`，API6 命中索引 47 的 DOMAIN DIRECT，配置/规则/Direct 政策摘要一致；前后 OS 网络 hash 均为 `7d4c5275a41fa0f0281cf94528e8bf3399156bccea30cc9cad96d69f8aa0044c`。当前 host/源端口范围内没有匹配的内核入站候选，脚本保留 `incoming.matched=false / NOT_ASSERTED_FOR_FORCED_PHYSICAL_OBSERVATION`；**没有用“无入站”来证明物理直连**，上述正面事实来自实际 app socket、独立 Windows owner、源条件查路和相同 IP 回显。

启动采用两段时序：先顶层 await 完成本机前置读取和当前 AAAA 映射，再调用不被顶层 await 的 child，随后等待 ready。零网络启动自检已经验证映射确实发生在 ready 前；时序依据见 [Electron ESM 官方说明](https://www.electronjs.org/docs/latest/tutorial/esm#you-must-use-await-generously-before-the-apps-ready-event)。没有替换 `Session.fetch`、调整真实工厂期限或使用取消后的新信号抢救结果。

计数为 **1 echo + 1 geo**、1 次 AAAA 查询、2 轮控制器读取、2 次 connections、2 次 OS 读取、1 次 Windows TCP、1 次源条件路由读取、1 个匿名 Session、1 次仅覆盖 echo 的 NetLog capture。账号、窗口、意外请求和配置修改均为 0。子进程正常退出，无 watchdog，真实资源 drain 完成、未留读取任务，原始临时目录已删除；**18 个生产输入源码摘要**起止一致。

脚本摘要 `a9f36aed6c75b6e325203c84847bb15c51f1ed68661a6e785a70d6730ea4e25d`，bundle 摘要 `d72717fa3e6ba59b5669fa3ae06c51e208926da6dda8041a8498f9de7528050e`。私有 echo parser 只改变固定根 URL 匹配和函数名，原日志不改；16 项本机检查不是公网许可验收。

本轮已取得明确的 IPv6 socket、物理源路由和大陆出口事实；仍不能把强制 AAAA profile 自动等同于正常解析的账号 Session，也不能用历史 JSON 恢复 q。下一步是把正常传输可能采用的 IPv6 分支与这一有限路径事实进行适用性审核，并接入已有实时准备流程；无需为“看到 IPv6 成功”重复本实验。B 站无视图 check-status 的客户端审核仍与路径审核分开，正式应用保持 observe，六平台范围没有缩减。
