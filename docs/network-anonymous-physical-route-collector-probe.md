# 匿名物理路径收集器：一次隔离实测结果

2026-09-08，本轮单次执行完成，**15/15 检查通过**，生产 collector 返回 `available: true`。执行区间为 UTC `00:27:37.503–00:27:57.357`，即北京时间 `08:27:37.503–08:27:57.357`，墙钟耗时 19.854 秒。旧 lifecycle-v3 与单流 collector 报告保留原样；它们没有作为本轮运行事实输入。

脚本：`scripts/electron-anonymous-physical-route-collector-probe.mjs`。默认仅构建，本次显式传入 `--single-dual-flow-run`。结果文件为 [network-anonymous-physical-route-collector-probe.results.json](network-anonymous-physical-route-collector-probe.results.json)，已存在时拒绝重跑。本次复核仅读取结果和源码摘要，没有重发请求或修改 JSON。

实测环境为 Electron `43.3.0`、Chromium `150.0.7871.212`、mihomo `424c2ef`，当前控制器为 `rule + TUN`。客户端来源、控制器、owner epoch、OS 网络及系统 hosts 的前后摘要一致。Chromium 在 ready 前设置了现有 TCP 传输配置，报告没有将它推导成 IPv6 禁用。

限定范围是已选客户端、本机 `127.0.0.1:9790` 控制器和两次匿名 `https://api.bilibili.com/robots.txt` GET。隔离 Electron 进程使用全新临时 userData/sessionData，不加载工作台启动入口，不建立账号或窗口。生产 `AnonymousPhysicalRouteCollector` 使用原 `AnonymousProofProbe`、`Session.fetch`、`AnonymousNetLogCapture`、socket parser、DNS/Windows 读取器；脚本不替换 `Session.fetch`、`net.fetch`、`net.request` 或返回模拟响应。

请求数量由独立的 `onSendHeaders` 观察钩子记录；生产匿名工厂负责自己的请求门闩、去除认证头和响应 Cookie。脚本核对零持久账号分区、真实零窗口状态，并检查原 fetch/request 函数未改变。这是程序边界计数，不是物理抓包的零公网断言。

本次计数为：1 次 collector 调用、25 次控制器读取轮次，共 123 条本机控制器 HTTP 请求；其中包括 9 次 connections 读取、12 次 DNS 查询、2 次精确 DELETE。另有 2 次完整输入采样、4 次 Windows TCP 快照、2 次 NetLog 捕获、2 条匿名 GET、2 次源地址约束的路由查询。创建 2 个匿名 Session，账号分区、窗口、WebContents 和异常请求计数均为 0；真实静默条件检查 90 次。

收集器只在两条流都由本次 app socket tuple 独立匹配后，调用生产 `ClashReader.closeConnection(id)` 关闭新出现的精确 UUID。关闭前重新读取该 ID、控制器与近期内核 owner；不使用批量关闭、重试或历史 ID。第一次关闭后必须同时保留 B 的入站记录、app TCP tuple、内核 TCP tuple和 observer hold；第二次关闭后再核对实际 socket 消失。HTTP 204 本身不作为 socket 关联成功。

两条流均为 `credentials: omit`、HTTP 200、非缓存响应和 Chromium 默认 TLS 证书验证。以下时间均为该隔离进程中的原始单调毫秒数：

| 原始记录 | A | B |
| --- | ---: | ---: |
| beforeSend DNS 读取 | 7108.6242–7123.2121 | 7194.6571–7212.7171 |
| DNS 快照原总截止 | 8115.6356 | 8203.7863 |
| 实际发送 | 7124.9440 | 7214.3191 |
| 实际响应头 | 7172.9401 | 7256.5925 |
| 精确 DELETE，均为 204 | 8565.8321–8566.8014 | 10003.7072–10005.0845 |
| 原 resolver 映射核对完成 | 11396.3983 | 11404.7729 |
| 源地址路由查询 | 11413.1779–12821.3207 | 12822.0068–14269.9563 |

每流 DNS 均在发送前完成，响应头在其原截止前到达。首轮 DNS 的 1 秒 TTL、后续 A 答案的 30 秒 TTL 等实际值原样保留；没有延长 TTL 或将较晚的映射核对时间倒填成请求时间。这里是保留的请求关联事实，不是把过期 DNS 继续当作当前许可。

四次 TCP/连接快照的变化如下；相同目的 IP 的两条流由选择性关闭区分，而非仅凭 IP 配对：

| 阶段 | TCP 原始窗口 | scoped 入站 ID 数 | 匹配的 Established socket 数 |
| --- | --- | ---: | ---: |
| baseline | 5897.8912–7093.3825 | 0 | 0 |
| 两流存活 | 7265.3402–8555.5981 | 2 | 4（2 app + 2 kernel） |
| 关闭 A 后 | 8567.4230–9983.3632 | 1，仅 B | 2，仅 B 的 app/kernel |
| 关闭 B 后 | 10005.7380–11394.2997 | 0 | 0 |

实际 app owner 为 PID `138520`，内核 owner 为 PID `43828`；原创建时间和可执行文件身份摘要在相关快照内一致。A 的 app/kernel 源端口分别为 `61525/61528`，B 为 `50634/50637`，目的端口均为 443。两个精确关闭 ID 的摘要分别为 `2e532ebdc5802ce0d19276d212a99bca8e3e758e4a4e7ebb659fa263eb773e95`、`6c9e48fd6fa1d158013bbb4da8e0ef9e32671169de57acc1c7fdbbf83bac82de`。

| 原始端点含义 | 地址 SHA-256，未公开原地址 |
| --- | --- |
| app 本地地址 | `ffe6deda608686b5edbe952091ac123bcfe2b4d8f247c76778ce7b05e30a606d` |
| app 连接的 fake-IP | `d04d19d38d1ef5b9e6f50d32fb7cf118c34bbef8015b1bb818922ee33cd4e1b4` |
| 内核物理出站源地址 | `552354592821b7e6b76f87d10c0cb4ff512ffed049dde0e40769a0bcf9f50c8d` |
| 两流共同的真实目的地址 | `1800cb73058a490b69c4c02051a12686404959133eee4ecd381901f25260e1a1` |

两次 Windows 查询均为 `windows-source-route-query`，使用刚关联的内核源地址约束同一真实目的地址，结果为 **IPv4**、相同硬件接口，`adapterUp=true`、`sourceState=Preferred`、`skipAsSource=false`、`interfaceConnection=Connected`、`routeState=Alive`。接口身份为 `95b76a19b444b8c8e70bb179975538f3e379a3e56b2921262f7b9c6e0ab29a25`，两次 selectionHash 均为 `51dd7e703283cc9c79955964214acfd242b78a3274390c5c54038f6779ecd540`。路由查询仍保留 `socketObserved=false`；socket 归属依据来自先前独立 TCP 读取及选择性关闭，查询本身没有观察在途包。

原始 DNS 答案及每条流的真实 beforeSend 时间、两次抓取、四次 TCP 快照、源地址约束的物理路由查询、配置/owner/系统网络/hosts 后验均保留在主进程内。报告只写主机、用途、状态、时间、计数和地址/连接 ID 摘要，不保存源配置、Cookie、NetLog 原文或历史凭据。

初次输入为 `292.6144–5890.0017`，后验在两次路由查询完成后真实开始，为 `14270.4996–19915.6202`。collector 于 `19922.0969` 完成，晚于后验完成且早于新输入截止 `29280.9898`。首次输入截止 `15308.4087` 没有被改写。控制器 fingerprint 为 `5cc197058efc435fabbd518ff97564995e80b4af5a09f8961b989ce627db14ee`，当前源文件 fingerprint 为 `066c3bd42d095c7614d42396a603eb3f989d0b2f1d19b12e0fcde9f6125d3a58`，前后相同。

成功也只形成原始物理关联事实：当前匿名工厂、当前传输 profile、实际 AF 和当前配置关联。脚本不构造资格 q，不选择保留期限，不宣称账号工厂等价、IPv6 限制或大陆出口；生产仍需独立完成后续资格和许可判定。

本次工厂为 `clipdock-anonymous-tls-v1`，传输 profile 为 `isolated-physical-anonymous-bilibili-ipv4-v1`，`qualificationGranted=false`、`permitIssued=false`、`expiryAssigned=false`。这不能代替 B 站账号 `net.request` 探测工厂的等价审核、IPv6 路径覆盖、真实出口地理判定或最终 strict 验收。JSON 中的摘要也不能在进程结束后恢复原 WeakMap 品牌或构造运行资格。

真实 drain 完成，拒绝数为 0，NetLog 临时文件与本轮临时目录均已删除；子进程退出码 0，父进程 watchdog 未触发。全部生产依赖源码的执行前后 SHA-256 一致，独立复核时仍与当前文件一致。主要摘要：

- collector：`6ba5bb951eb1ab19f3fdbe9614ad9dcff0137ff70c8892731ec174883399fefd`
- 脚本：`a6fc875bc0379c276809aff5fdf1d057bd555e64abedd2006d20f3cead486411`
- 实际 bundle：`b5242795f672c71562730920f0b6d217c01020f36b6e0e5fe72748a9fb2d95b6`
- 本次未修改的结果 JSON：`79b6e79ac5ce549bfa6cf9a019822771e016570e31b48f57811ce5af708d26ad`

## 随后的清理失败传播修正（未重新执行公网）

2026-09-08，北京时间 08:43 完成一处错误路径修正：`whenIdle()` 在等待本实例的真实 pending/drain 完成后，若已有 sticky `cleanupFailed`，向调用方抛固定 `PHYSICAL_COLLECTOR_CLEANUP_FAILED`；`dispose()` 同样保留这个失败，避免上层把清理不确定误作成功并更换实例。没有提前释放并发槽，也没有改变成功路径、请求范围、时间预算或路由判定。

新版 collector SHA-256 为 `1470cc14ec6923cff0bb5bb95b675397c13ab9af8c43b2f17d5c31f1bf072b6c`。受控单元测试 39/39、Electron TS 与目标 lint 通过，覆盖真实延迟 drain 未结束时仍为 BUSY、完成后 `whenIdle/dispose` 均拒绝、重复 collect 不再发请求，以及同步清理异常不跳过其它实际 drain。

上述 **15/15 实机结果仍只属于原 collector 摘要 `6ba5bb95…`**，未改写为新版已验。新版没有重新运行公网脚本，结果 JSON 保持原始字节和摘要；这段追加记录仅说明受控错误路径验证。
