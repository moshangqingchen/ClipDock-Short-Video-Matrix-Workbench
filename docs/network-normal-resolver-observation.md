# 正常解析单次匿名观察

2026-09-08 **02:19:20.912 UTC（北京时间 10:19:20.912）**，真实 `AnonymousProofProbe` 对 `api.bilibili.com:443` 的固定公开轻请求完成一次非缓存 HTTP 200。精确请求图和解析任务图均关联成功。本轮没有建立单族约束、路径资格或账号出网许可。

原始脱敏记录：[本次不可改写 JSON](./network-normal-resolver-observation.20260908T021920700Z.results.json)。它与此前 [匿名出口观察](./network-diagnostic-egress-after-rules.md) 分开保存，不能将两份历史记录拼成当前资格。

| 观察层 | 本轮事实 | 结论范围 |
| --- | --- | --- |
| 解析请求 | 精确 URL_REQUEST 26 经实际 dependency 连到请求本地 source 33 和 resolver job 34；无 host 冲突或已观察到的外部附着 | 本请求参与了所列解析任务；没有按同 host 或全局事件补关联 |
| 请求与 JOB 计划 | 请求 `dns_query_type=UNSPECIFIED`；请求任务序列 `[4,9,0]`；JOB 的 `dns_query_types=[A,AAAA,HTTPS]`、剩余 `tasks=[0]`、`secure_dns_mode=0` | 计划包含多个查询类型，不代表本次分别发送了 A、AAAA、HTTPS DNS 报文 |
| 实际 SYSTEM 返回 | `HOST_RESOLVER_SYSTEM_TASK` 从原始 ticks `414393879` 到 `414393880`，相差 1 ms；END 的 `address_list` 返回一个 IPv4 地址 | 这是本次系统解析任务返回的集合；不是未来所有解析结果，也不证明 AAAA 被禁用 |
| IPv6 检查 | 请求本地同一 ticks 记录 `ipv6_available=true`、`cached=true` | 使用了当时短期缓存的 IPv6 可用性判断；没有执行或证明持续 IPv6 出口合格 |
| 实际连接 | socket 36 的本地、远端均为 IPv4；远端端口 443，远端地址摘要与 SYSTEM 返回地址相同 | 本次选择了 IPv4 TCP；此脚本未采样 Windows socket owner、内核映射或物理网卡路由 |

已核对相同 Chromium `150.0.7871.212` 的固定版本字段：任务 `0` 是 [SYSTEM](https://raw.githubusercontent.com/chromium/chromium/150.0.7871.212/net/dns/host_resolver_manager.h)，secure DNS 模式 `0` 是 [kOff](https://raw.githubusercontent.com/chromium/chromium/150.0.7871.212/net/dns/public/secure_dns_mode.h)；[IPv6 检查](https://raw.githubusercontent.com/chromium/chromium/150.0.7871.212/net/dns/host_resolver_manager.cc)使用 1000 ms 的短缓存窗口。SYSTEM 的 A+AAAA 输入转换为 UNSPECIFIED 地址族；系统返回值可能来自 hosts、系统缓存或 DNS 等，不能据此识别具体 DNS 服务器或新的线上的 AAAA 否定答复。[地址族转换](https://raw.githubusercontent.com/chromium/chromium/150.0.7871.212/net/dns/host_resolver.cc)、[SYSTEM 任务与结果处理](https://raw.githubusercontent.com/chromium/chromium/150.0.7871.212/net/dns/host_resolver_manager_job.cc)。这些字段解释与本次实际事件互相核对，不扩大为平台或出口保证。

SYSTEM 返回地址和 socket 远端的 SHA-256 均为 `d04d19d38d1ef5b9e6f50d32fb7cf118c34bbef8015b1bb818922ee33cd4e1b4`；原始地址未保存。返回集合投影的未知形状计数为 0、未截断；JOB/REQUEST 的 END 没有返回地址字段，不能把这些空字段另算成“无 AAAA”的证据。本轮没有关联的 `HOST_RESOLVER_DNS_TASK` 完成结果。另有三条不属于精确请求图的 IPv6 检查，保留在 `unattributedIpv6Reachability`，未合并到该请求。

运行环境为 Windows、Electron **43.3.0 / Chromium 150.0.7871.212**，使用既有 ready 前 QUIC 约束、正常 DNS 和工厂原有 **8 秒**上限。没有 `resolveHost` 或内核 DNS 预暖、强制地址族、请求替身、NetLog 改写、账号分区或窗口。请求使用 `credentials:omit` 和 Chromium 默认证书校验；计数为一次工厂调用、一次公开请求头发送、一个匿名 Session、两轮控制器读取，意外请求为 0。

控制器前后均为 `rule + TUN`、版本 `424c2ef`、3343 条规则；固定目标命中索引 16 的 DOMAIN DIRECT，fingerprint 和 rulesDigest 前后一致。这是当轮规则观察，不替代实际出口地理位置或业务 Session 适用性。主进程单调时钟中请求发送 `176.2467 ms`、响应头 `234.9704 ms`、清理回调 `246.1867 ms`；NetLog ticks 保留原值，未换算成或延长许可期限。

本次子进程正常退出，真实资源 drain 完成，无 watchdog，原始临时目录已删除；15 个生产输入源码哈希起止一致。运行结果 `executionCompleted=true` 表示本次有限观察及清理完成，不等于路径验收。正式 enforcement 和目录审核均未改变。

记录摘要：JSON `4ce4c167703fe10ae715fe32616ffccdb6f5b303f8e55db8cbf953427876c0bb`；脚本 `12c48903ad0969c20d1f1e7b9e1bc555d2d6c4444d2d8a26ac5a4cc3e58473d6`；bundle `4d537f4e8890c98f18edcb747191b3c49b4abe19a73c0f3e32d854cd2ef55bd2`。后续实现可使用本次结果判断下一步，但不得从这份 JSON 恢复资格或把正常传输上下文改成 IPv4-only。

## API6 单次失败观察（独立轮次）

2026-09-08 **02:37:00.321 UTC（北京时间 10:37:00.321）**，使用固定 `--api6` 模式、实际 `AnonymousEgressProbe` 和原有 **12 秒总上限**执行一次匿名 echo。工厂返回 `available=false / PROBE_UNAVAILABLE`；echo 记录 `net::ERR_CONNECTION_CLOSED`，未取得有效 HTTP 响应头，未进入 geo 请求。[本轮不可改写 JSON](./network-normal-resolver-observation.20260908T023700119Z.results.json)独立保存，不覆盖上面的 B 站成功轮或更早的出口失败轮。

本轮精确 URL_REQUEST 31 关联到请求本地 source 34 和 resolver job 35，`associated=true`、无 host 冲突。JOB 仍计划 `[A,AAAA,HTTPS]`、实际剩余任务 `[0]`、`secure_dns_mode=0`；SYSTEM 从 ticks `415453285` 到 `415453286`，在 1 ms 后返回一个 IPv4 地址，摘要 `0f06b475016e8b659d9c35cae84dfdc87016cd19981b626697774b790a7ecd63`，未知形状为 0、未截断。请求本地 IPv6 判断依然是 `true/cached`；另外一条全局 IPv6 事件单列，没有归入该请求。

这不是一次已证明的 IPv6 拨号失败：`api6` 名称不决定实际传输族，SYSTEM 本次确实返回了 IPv4，而 socket 解析器返回 `SOCKET_AMBIGUOUS`，没有输出唯一、完整的连接四元组。因此不能补写实际 socket 的地址族、Windows owner、内核转发目的或关闭原因；也不能把 `ERR_CONNECTION_CLOSED` 归因为 AAAA 解析失败、IPv6 不可用或某一方主动阻断。已取得的解析返回与未取得的连接事实必须分别保留。

计数为一次工厂调用、一次 echo 请求头事件、零 geo、一个匿名 Session、两轮控制器读取，意外请求/窗口/账号均为 0；请求头事件不等同于接收端收包证明。控制器前后均为 `rule + TUN / 424c2ef / 3343`，目标命中索引 47 的 DOMAIN DIRECT，fingerprint 和规则摘要与前轮一致。没有 DNS 预暖、强制族、请求替身、配置修改或取消后日志抢救。仅捕获 echo；正常连接错误发生后，在原 signal 仍有效的 cleanup 内保存脱敏解析图。主进程单调时间 beforeSend 为 `166.2225 ms`，echo cleanup 为 `192.4501 ms`，最终清理记录为 `205.45 ms`；本次不是耗尽 12 秒的超时轮。

`executionCompleted=true` 仅表示观察和清理完整：子进程正常退出、无 watchdog、真实 drain 完成、原始临时数据删除、14 个生产输入摘要起止相同；它不改变工厂的失败结论。脚本只对私有 parser 的固定根 URL 做一处替换，原生产 parser 与原 NetLog 未改。JSON SHA-256 为 `9037fb3bb52b911f5f71c7fd9b66ac94c102df113baf121ef620bfe3617b8f1d`；脚本为 `54088ad03b07309937f257bef1bb7b7343c81412650304986dcd422fd34eae34`；bundle 为 `2f1c191793c9919bc6852969aa1b8f9e5d928a9c9343c8f68d081ba195e189ca`，私有 adapter 为 `850e8362b60aa7af97a8325dedbe0547c149004de75da37340b3631132c19147`。

真正剩余的是正常传输上下文的可能地址族及其适用期限：没有明确有效的单族约束就保留双族要求，并补齐仍可能的 IPv6 路径/出口证据。本次失败不能代替这项工作；重复同一个 API6 请求也不会自动补齐它。正式应用继续 observe，未生成 q、AF 约束或账号许可。
