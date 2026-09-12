# 单次匿名 fake-IP → 自身 flow → 内核 DNS 观察

2026-09-08。**已取得一次真实匿名工厂请求的 fake-IP → 精确自身 mihomo flow → 同轮内核 DNS 候选映射观察，15/15 检查通过。** 它只覆盖该次 TLS 工厂请求和实际 IPv4 路径，不是完整 resolver equivalence 或出网许可。早期缺失结果、闭网络诊断和解析失败均按各自实际时间原样保留，没有合并成成功。

## 当前成功观察：23:10 的独立复验

UTC **2026-09-07 23:10:21.041–23:10:27.625**（北京时间 09-08 07:10），使用显式 `--single-public-recheck` 单独执行一次。当前 [机器结果](./network-fake-ip-flow-observation.results.json) 对应该轮；23:00 的失败 JSON 已在运行前原字节归档，前三份历史也保留不动。脚本检查和仅构建检查通过后才运行，无自动重试。

| 当前真实记录 | 结果 |
|---|---|
| 工厂 / 匿名 Session / native GET | 各 **1**，固定 api.bilibili.com/robots.txt |
| 响应 | **200**、非缓存、credentials omit、默认 Chromium TLS 验证，无本机 pin |
| DNS | A/AAAA 前后各 1 次，共 **4** |
| Controller | 4 个配置读取批次、4 个 DNS、3 个 connections，共 **23 个固定 loopback GET** |
| DELETE / 额外 HTTP | **0 / 0** |
| 规则 | rule + TUN、3341 条，零基第 16 项 Domain → DIRECT；内置 DIRECT、dialer none |
| 当前生产 parser | root **34** → TCP socket source **41**，与透明图 tuple 相同 |
| 独立 Windows 后验 | Network Service PID **128192**，源端口 **61891**，精确四元组 Established，基线无该 tuple |
| 精确自身 flow | `0deb6b53-ce57-4783-bb89-49184cdf45e1`，新 ID、同源地址/端口、TCP/443/Tun/DIRECT；核对时仍持有 |
| app 实际目的 | IPv4 fake-IP，摘要 `d04d19d38d1ef5b9e6f50d32fb7cf118c34bbef8015b1bb818922ee33cd4e1b4` |
| flow 实际 remoteDestination | IPv4 real 候选，摘要 `22486cf19e74f381adb5660d52ce0dab93d74ee571c6807fdc51297279764f75`；同时属于本轮 A 前后答案 |

flow 的 `destinationIp` 和 `processIdentity` 本次均缺项，保留 null；没有用 app owner 身份填补内核未提供的字段。实际请求归属来自 NetLog 图、独立 Windows tuple 和精确新 flow 的组合。`remoteDestination` 是目标地址，不是公网源出口或地理位置。

原始工厂 observation 保留 `clipdock-anonymous-tls-v1`、实际 context `e12fee8a-0e6d-41d6-a50a-0d11d50b9dfe`，采样 **3215.665–4639.0167ms**。报告另有包装器调用时间 3211.1546ms，它只表示调用开始；不得拿它重写生产 observation 的开始时间。

| 同进程单调时间 | 实际值 |
|---|---|
| 前轮 A 查询 | 3240.6592–3247.0086ms，TTL 均为 **1 秒**；最短原截止 **4240.6592ms** |
| 请求发出 / headers | **3247.4867 / 3299.9303ms** |
| 后轮 A 查询 | 3300.4889–3304.7724ms，原返回 TTL 为 **167/88 秒**；相关链最短原截止 **91300.4889ms** |
| 时敏读取完成 | **3330.6398ms**，仍在前轮 1 秒窗口内 |
| Windows tuple 读取 | 3348.3652–4636.2643ms；持有原 Response 期间后验 |
| 释放 Response | **4638.976ms**；未延长 8 秒持有或 10 秒工厂上限 |
| 最终环境后验完成 | **6648.441ms** |

后轮 TTL 变长是这次查询的实际回答，不是把前轮 1 秒样本延长。最终后验时前轮 DNS 已过期，报告仍为 `dnsBeforeStillFreshAtFinalVerification=false`；后轮 DNS 及前后两个配置候选尚在原期限内。保留的是原窗口内发生的映射观察，不把过期前样本恢复成当前许可。

来源文件、policy、source generation、当前 loader、Controller、kernel owner、OS 和系统 hosts 前后均稳定；系统 hosts 对本目标匹配数始终 0。生产 parser evidenceId 为 `40ae2d26a78d3b0ba9d8440b2c5444893fd475face43d291419a8bf1695526bb`。15/15 检查通过，退出码 0，6 项 cleanup 与 3 项 drain 全部 fulfilled；23 个生产源 hash 前后稳定，原始临时日志和分区已清理。

当前 parser hash：`b4894c199c396a63ee415942e186bd0506e396737056339a68d5f99525caaaac`；本轮脚本 hash：`0fbb7554a71fa5c9d6ae377e8aaba87a3f6199d65101703eecf389138c40cb4d`。`observationRetained=true` 仅表示上述单次映射成立；`possibleFamiliesConstraintProven=false`、`resolverEquivalenceQualified=false`、`qualificationGranted=false`、`permitIssued=false` 保持。未将它扩展为所有 AF、账号/出口工厂等价或大陆出口证据，也未再次进行双流 DELETE 归因实验。

## 首轮：结果缺失，不能补造请求计数

脚本为 `scripts/electron-fake-ip-flow-observation.mjs`。首次实际子进程使用隔离 userData、真实 `AnonymousProofProbe`，上限为一次 `https://api.bilibili.com/robots.txt` GET，无重试。执行前语法与仅构建检查通过。父进程结果于 UTC 2026-09-07 22:48:20 落盘；子进程没有提供自己的开始/结束时间及计数，父进程记录 `CHILD_RESULT_MISSING`、退出码 1。

当时只读观察到隔离目录下已创建 `request.netlog.json`，但大小仍为 0；这不证明请求已发送，也不证明没有发送。23 个实际生产源码 hash 在前后保持一致，临时目录已移除。原结果字节保留在 [首轮缺失结果](./network-fake-ip-flow-observation.initial-missing-result.results.json)，没有将后续数据倒填进该轮。

代码复核发现脚本错误沿用了纯解析实验的 `net.request = forbid`。Electron 的真实 `Session.fetch` 会到达此入口，这个拦截与所测工厂冲突。旧脚本又缺少阶段 checkpoint 与未处理异常记录，无法从首轮文件确定内部最终异常。不能因此给首轮补写“零请求”“DNS 成功”或映射结论。

## 闭网络入口诊断：取得实际参数形状

UTC **2026-09-07 22:53:13.630**，以 `--transport-entry-only` 执行一次真实工厂调用。该模式跳过配置、Controller、DNS 与 TCP 基线，在调用原 `net.request` 之前无条件抛出固定错误。它没有调用 native 请求函数，不能启动本次请求的网络连接。

| 实际记录 | 结果 |
|---|---|
| 工厂调用 / 新匿名 Session | 1 / 1 |
| 到达 Electron 传输入口 | 1 |
| 原 nativeRequest 调用 | **0** |
| Controller / DNS / connections / DELETE | 全部 0 |
| URL / Session | 精确 robots.txt URL、实际工厂持有的 Session |
| method / credentials / redirect | GET / omit / manual |
| autoSessionCookies / useSessionCookies | **两者均缺项**，不是显式 false |

实际 options keys 为 `cache, credentials, method, origin, redirect, referrerPolicy, session, url`。没有记录原 Session 对象或任意参数内容。修复后的护栏接受实测缺项；这些 Cookie 选项若出现，则只接受 false，同时仍要求原工厂 Session、精确 URL、GET、omit、manual 和一次 native 调用上限。工厂原有匿名 Cookie/Auth 清理及请求头守卫保持。

固定阻断随后触发 `unhandledRejection`，退出码为 1。新增 fatal checkpoint 保留了上述记录，父进程 watchdog 没有触发；**不把这次诊断写成正常完成或映射通过**。原字节另存 [同步抛错入口诊断](./network-fake-ip-flow-observation.transport-entry-sync-throw.results.json)，23 个生产源 hash 稳定，原临时目录已清理。

## 本地 Writable stub：入口和清理验证通过

已核对 Electron **v43.3.0** 官方 `net-fetch.ts`：它先创建 deferred Promise 并安装 abort 监听，再调用 `request(options)`；同步抛错会阻止原 Promise 正常返回。后续工厂取消可能触发未被接收的 Promise 拒绝及尚未初始化的请求引用。该顺序解释了入口诊断异常；无需修改生产工厂或 Electron 库。[官方源码](https://raw.githubusercontent.com/electron/electron/v43.3.0/lib/browser/api/net-fetch.ts)

闭网络模式改为返回纯本地 `Writable`：提供 `_urlLoaderOptions`、空 `setHeader`、`abort/destroy`；在 `end` 后异步发送固定错误，让真实 `net-fetch` 先返回 Promise 并接上错误处理。stub 不持有 socket，也从不调用原 `nativeRequest`。它明确是测量用的本地替代传输，不能当成网络请求成功。

UTC **2026-09-07 22:56:52.900** 执行一次修正后的闭网络模式，**4/4 检查通过，退出码 0**：实际工厂/匿名 Session/传输入口各 1；native 请求、Controller、DNS、connections、DELETE 均为 0；stub 异步错误 1 次、abort 1 次；工厂按预期返回 unavailable。所有 6 项清理及 3 项底层等待均 fulfilled，没有 fatal 事件或 watchdog。

该轮 [闭网络 stub 结果](./network-fake-ip-flow-observation.transport-entry-stub.results.json) 已在再次公网执行之前原字节归档；23 个源码 hash 前后稳定，隔离目录已清理。已执行脚本 SHA-256 为 `1b773c52a0fbc112d164356eb869db9adc766efe1761f5585417596c0d96dd28`。前两次结果也均原样保留，没有覆盖成通过。

## 授权后的单次公网复验：解析器拒绝，保留失败

UTC **2026-09-07 23:00:58.430–23:01:01.478**，显式 `--single-public-run` 执行一次，[解析失败结果](./network-fake-ip-flow-observation.socket-ambiguous.results.json) 对应该轮。开始前归档并核对成功 stub JSON 字节摘要；运行开关不允许自动重放。

| 实际记录 | 结果 |
|---|---|
| 工厂 / Session / native 请求 | 各 **1** |
| 公开请求 | 固定 robots.txt GET **1 次**，headers 为 **200** |
| DNS 查询 | A/AAAA 前后各一次，共 **4** |
| 控制器 | 3 个配置读取批次，加 4 个 DNS 和 2 个 connections，共 **18 个 GET** |
| DELETE / 被护栏拒绝的额外 HTTP | 0 / 0 |
| 开始时规则 | rule + TUN，3341 条；第 16 项（零基）Domain → DIRECT |
| 内置 DIRECT | 当前类型 direct，dialer 为 none |
| 生产 socket parser | `available=false / SOCKET_AMBIGUOUS` |
| 最终结果 | `PRODUCTION_SOCKET_PARSER_UNAVAILABLE`，退出码 1 |

初始化实际记录为 `direct → close → clear-dns → clear-dns`：后一个是生产工厂每轮请求前的缓存清理。请求发起单调时间 **3047.6929ms**，headers **3096.0793ms**，时敏读取完成 **3105.0377ms**。前轮 A/AAAA 分别在 3043.7426/3043.9867ms 开始，所有相关回答 TTL 均为 1 秒；后轮在 3096.6687/3096.8054ms 开始。因此本次请求与时敏读取没有耗尽前轮的 1 秒窗口；**这只证明时间布局成立，不能代替地址映射和归属**。

旧透明 NetLog 图得到根 36、单一 socket source 43（TCP_CONNECT，源端口 55022，远端端口 443），地址仅留 hash；生产解析器对同一份日志返回 SOCKET_AMBIGUOUS，脚本立即拒绝，没有用旧图 fallback。不能把此处解释为已确定存在两个 socket，也不能只因旧图唯一而放行；具体解析差异尚待离线分析。

拒绝发生在 Windows app tuple 后验、实际 factory/context 结果提取和来源/owner/OS/hosts 末验之前。这些未完成步骤没有补 true，`mapping` 和最终 `stable` 均为 null。原日志仅在隔离目录短暂存在，结束后已清理；保留的脱敏图边及 DNS 时间不能恢复所有原字段，也不能用于补发许可。

23 个生产源 hash 前后稳定。生产 parser hash 为 `9a170e5eefacef019c1cf992d3a5a1a745b1ec4bffe7ef45dff69ddf8f980fb4`，脚本 hash 为 `6e9bb9eb7f043e957fd7e596807ecde15ccbedf4eeeb23bbf3c780cefe6fbe9c`。6 项 cleanup 与 3 项 drain 全部 fulfilled，没有 fatal 事件或 watchdog。该次没有自动重试，后续本机调查和 23:10 修复复验分别记录。

## 后续已准备好的单次流程

正式观察分支会先完成当前 Selected 来源、Controller、kernel owner、OS、系统 hosts 和 TCP 基线。真实工厂完成 direct → close → clear DNS 后，在原 `session.fetch` 的透明包装内读取该 host 的前轮 A/AAAA，立即调用原 fetch；headers 到达后并行读取自身 connections、后轮 A/AAAA 和控制器版本。

时敏读取完成后才停止并解析 NetLog。生产 `parseAnonymousRequestSocket` 与已有透明依赖图解析同一份原日志，必须得到相同 tuple。随后用实际 Windows Network Service 精确 tuple 和唯一新 mihomo ID 后验，保留 `sniffHost`、原 `destinationIp`、`remoteDestinationIp`、开始时间和实际 factory/context。慢的来源、owner、OS 与 hosts 后验放在窗口之后。

DNS 仍使用各查询原始开始时间加回答 TTL；相关 CNAME 的最短截止也计入。要求该次实际 remoteDestination 属于同轮前后答案，前答案覆盖实际请求及热窗口；原时效不被后验时间刷新。没有达到条件时只保留观察，不能通过重试或延长 TTL 变成成功。

脚本已增加 startup、工厂调用前、native 入口、headers、后验和 cleanup 的安全 checkpoint；顶层/fatal 错误写固定失败类别；清理操作用 `Promise.allSettled` 隔离同步异常。明确的运行开关用于保留实验历史、防止脚本意外重放，不是产品权限 API，也不要求用户逐请求审批。该次脚本没有自动重试；后续修复复验分别记录。

这份记录取得了当前单次请求的实际映射观察；它仍不证明完整 resolver equivalence、所有可能地址族、业务/出口工厂等价或大陆出口。历史各轮 observationRetained 值保持原样，当前 true 不倒写到此前失败中；没有生成路径资格或许可。
