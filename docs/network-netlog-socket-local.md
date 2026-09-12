# 本机 NetLog source 误删调查

UTC **2026-09-07 23:07:03.578–23:07:03.703**，Electron 43.3.0 / Chromium 150.0.7871.212，仅执行一次真实 `AnonymousProofProbe` 到合成本机 TLS fixture。脚本：`scripts/electron-netlog-socket-local-probe.mjs`；[实际结果](./network-netlog-socket-local.results.json)；[可离线重放的裁剪日志](./network-netlog-socket-local.fixture.json)。

**已确定本机可复现的根因：事件名描述操作，不能据此删除整个 source。** 一个实际 TCP socket source 会产生证书验证事件；旧逻辑将其当成共享 verifier source，导致请求图丢失真正的 socket。

| 实际 source | 类型 | 同一 source 中的关键事件 | 旧整节点删除的后果 |
|---|---|---|---|
| 31 | HTTP_STREAM_JOB_CONTROLLER（32） | PROXY_RESOLUTION_SERVICE、HTTP_STREAM_JOB_CONTROLLER_PROXY_SERVER_RESOLVED | 错删请求的连接调度节点 |
| 33 | SSL_CONNECT_JOB（5） | HOST_RESOLVER_MANAGER_REQUEST、HOST_RESOLVER_MANAGER_TASK_SEQUENCE_CREATED | 错删 TLS 建连节点 |
| 36 | SOCKET（10） | TCP_CONNECT、TCP_CONNECT_ATTEMPT、CERT_VERIFIER_REQUEST、CERT_VERIFIER_REQUEST_BOUND_TO_JOB | 错删实际 TCP socket |

对同一裁剪日志纯离线重放旧 `eventName → excluded source IDs → 删除节点后遍历` 规则，得到排除集合 **[31, 33, 36]**，从根 29 仅能到达 **[29, 32]**，socket 36 不可达。这是对明确旧算法的重放，没有将当前 parser 改回旧代码，也没有继续网络请求。

## 当前 parser 与裁剪重放

本机实验加载主代理已修复的当前生产 parser（hash `517f3ef81ba78b0839b03812644ceafd225655708db28a71e634763dae160700`）。原日志与裁剪日志都返回 `available=true`，输出逐字段完全相同：根 29、socket source 36、本机 tuple `127.0.0.1:61139 → 127.0.0.1:51013`，evidenceId `a0a6687473904e198da2b2cf1216b00d781a10b0c46b64a8a1a66130b71e0386`。

裁剪 fixture 保留 `constants.logSourceType/logEventTypes`，117 条相关事件、7 个 source，以及原 source id/type、event type、phase/time。params 只保留 source_dependency、address_list、source_address、local_address、address、remote_address 和固定合成 robots URL。所有保留地址字段均经检查为 loopback；没有 headers、证书、响应正文、raw bytes 或真实账号数据。fixture SHA-256：`e018fd8a1d324c17df3de2594703d5d9599df214afd40978c9184286bde6e612`。

## 隔离与边界

3/3 自检通过，退出码 0；受控接收端收到 1 次 GET/200，Cookie/Auth 为 0，额外请求为 0。生产工厂原有初始化与匿名守卫保留；仅在该隔离私有 Session 的固定 host/端口请求前安装本轮合成证书精确 pin，未设置全局忽略 TLS 标志、修改系统证书或用户网络。该 factory 返回的 `chromium-default` 字段是生产 DTO 原值，本实验实际加入了明确 fixture pin，不能宣称验证了公网默认信任。

5 项清理均 fulfilled；12 个生产输入 hash 前后稳定。临时原始 NetLog、证书私钥和 userData 已清理，只保留上述合成裁剪 fixture。没有调用 Controller 或公网，也没有再发 B 站请求。公网失败报告保持原样；本机重现证明了算法缺陷与当前修复在该 fixture 上有效，不能倒写之前公网失败为成功或授予路径资格。
