# 阶段 2：Electron 请求取消与活动连接撤销实验

实验日期：2026-09-07。执行入口：`node scripts/electron-egress-probe.mjs --inspect-clash`。

本报告记录已经运行的结果。**新请求门闩有效，`closeAllConnections()` 或 `offline:true` 不能单独切断已有流量。** 不能凭这次通过就宣称国内严格模式已通过实机验收。

## 1. 环境、隔离与证据

- 锁定 Electron **43.3.0**，Chromium **150.0.7871.212**，内嵌 Node **24.18.1**，Windows x64。
- 单独启动隐藏 Electron 进程；`userData`、`sessionData`、持久化 partition 全部是本次新建的临时资料。未启动 ClipDock 生产主入口、未读取真实账号、未使用生产 `userData`。
- 受控 HTTP 服务只监听 `127.0.0.1` 的随机端口。测试 Cookie 为合成值、HttpOnly、仅此回环地址；日志只记“是否收到合成 Cookie”，不记 Cookie 值。
- 新 session 创建后先安装 `onBeforeRequest`，只允许本次回环端口。所有非回环请求都拒绝。实测外部请求数为 **0**。
- 每项新请求测试有放行对照。依据同时包括 Electron 钩子记录、客户端结果和受控服务端请求数；不能只凭 `fetch` 抛错判断没有发出请求。
- 原始结果：[network-stage2-experiments.results.json](./network-stage2-experiments.results.json)。可复跑脚本：[electron-egress-probe.mjs](../scripts/electron-egress-probe.mjs)。脚本不改 mihomo 配置，不修改应用源代码或生产资料。

## 2. 新请求：23 项通过，0 项失败

| 路径 | 放行对照 | 门闩拒绝时的服务端结果 |
|---|---|---|
| 分区 `session.fetch(credentials: include)` | 收到合成 Cookie | 0 次请求；`onBeforeRequest` 取消 |
| 默认隔离 session 的 `net.fetch` | 收到合成 Cookie | 0 次请求；钩子取消 |
| 账号页 `fetch(credentials: include)` | 收到合成 Cookie | 0 次请求；钩子取消 |
| 账号页 XHR，`withCredentials = true` | 收到合成 Cookie | 0 次请求；钩子取消 |
| iframe | 收到合成 Cookie | 0 次请求；钩子取消 |
| 图片、脚本、CSS | 各自收到合成 Cookie | 各自 0 次请求；钩子取消 |
| WebSocket 握手 | 收到合成 Cookie | 0 次 Upgrade 请求；钩子取消 |
| ServiceWorker 内 `fetch` | 收到合成 Cookie | 0 次请求；钩子取消 |
| `session.fetch` 加 `bypassCustomProtocolHandlers: true` | 单列阻止实验 | 0 次请求；仍触发钩子并取消 |
| HTTP 302 重定向 | 起点收到 1 次请求 | 终点重新经过钩子，被取消；终点 0 次请求 |
| 顶层导航 | 使用同一分区，先装门闩 | 0 次请求；`ERR_BLOCKED_BY_CLIENT` |

结论：本次锁定版本下，**不能再假设 `session.fetch` 会绕过 `webRequest`**。仍需要 `gatedSessionFetch`：休眠时根本不调用带凭据探针，避免调度误报，并为在途请求提供主进程 AbortController 注册与撤销。

## 3. 活动请求：取消新的请求不等于停止旧连接

服务端每 50 ms 写一个合成响应块。门闩关闭发生在服务端已经收到 Cookie 之后。任何 API 都不能收回已经送出的 Cookie。

| 撤销动作 | 本次实际观察 | 可得结论 |
|---|---|---|
| 主进程 `session.fetch`：关门闩 + `closeAllConnections()` | 客户端响应块继续增加，服务端 socket 未关闭 | 不能作为在途 fetch 的撤销保证 |
| 主进程 `session.fetch`：`AbortController.abort()` + `closeAllConnections()` | 客户端 reader 停止，服务端 socket 关闭 | 本 fixture 的主进程在途 fetch 已撤销 |
| renderer HTTP 响应流：关门闩 + `closeAllConnections()` | 服务端继续发块 | 不足以撤销 |
| renderer HTTP 流：随后 `webContents.stop()` / `destroy()` | 本次该响应流停止，socket 关闭 | 仅证明此响应流；不能推广到 WebSocket |
| 已建立 renderer WebSocket：关门闩 + `closeAllConnections()` | 业务数据帧持续到达服务端 | 不足以撤销 |
| 已建立 WebSocket：再调用 `webContents.stop()` | 业务数据帧仍持续到达 | `stop()` 不能作为页面所有网络活动的停止保证 |
| 已建立 WebSocket：`destroy()` | 业务帧停止、完成关闭握手、服务端 socket 关闭 | 本 fixture 可通过销毁对应 renderer 内容停止 WS |
| `webContents.close({ waitForBeforeUnload: false })` | 隐藏窗口销毁，WS 业务帧停止，连接关闭 | 本 fixture 无须等待 beforeunload 即可关闭 |
| `enableNetworkEmulation({ offline: true })` + `closeAllConnections()` | renderer 响应流、主进程响应流、既有 WS 全部继续 | **offline 仿真也不能替代活动请求撤销** |

WebSocket fixture 实现了关闭握手，并只统计文本/二进制业务帧的 payload 字节；关闭控制帧不计为业务流量。

### 在途上传与缓冲区边界

上传是一个 **16 MiB 合成 POST**。服务端逐块读取并施加回压，确保撤销时请求体尚未传完。最初的 2 MiB 对照在回环地址上传得太快，已被替换；不能把“关闭前已完成”的结果算作在途取消证据。

- `webContents.close({ waitForBeforeUnload: false })`：调用前服务端收到 **131072** 字节，350 ms 后 **524288**，600 ms 后 **557056**，请求连接关闭；远小于 16 MiB，上传被截断。
- `offline:true + closeAllConnections()`：调用前 **262144** 字节，350 ms 后 **655360**，600 ms 后 **917504**，上传仍未关闭。

关闭 renderer 能撤销这个上传，但不能保证调用瞬间“此后服务端零新增字节”：操作系统或传输层已经排队的数据仍可能被收到。这里统计的是服务端实际读取的数据，并不反向推断每个字节何时离开客户端。严格模式不能把 API 返回时刻当作物理网络原子截断时刻。

## 4. ServiceWorker 后台活动

Electron 43.3.0 的公开 `ServiceWorkers` / `ServiceWorkerMain` 类型没有停止任意 worker 的 `stop` 方法。本实验未调用私有 API。

在 SW 的持续 `event.waitUntil` 事件中启动以下活动，再关闭请求门闩：

1. 每 70 ms 一个带合成 Cookie 的短 fetch；
2. 一个持续响应流；
3. 一个每 40 ms 发送合成业务帧的 WebSocket。

执行 `session.clearStorageData({ storages: ["serviceworkers"] })` 再执行 `closeAllConnections()`：

- 活动 worker 数从 **1 → 0**。
- WS 业务 payload 保持 **132** 字节；流保持 **5** 块；短请求保持 **3** 次，350 ms 与 600 ms 两次观察均未增加。
- WS 和响应流的服务端连接均关闭。
- 合成 Cookie 仍存在；未清 Cookie、localStorage 等其他存储。

本 fixture 中该组合有效，但这是**注销并清除该 session 的 ServiceWorker 注册**，不是无副作用的暂停。恢复后平台可能重新安装 worker，离线能力或后台任务可能受影响。不能仅凭 Cookie 保留就宣称平台全部行为保持不变；六个平台还需独立回归。

## 5. 本机 controller 只读观察

`127.0.0.1:9790` 可读。本次只读取 `/version`、`/configs`、`/rules` 的有限字段，无 PATCH/PUT/DELETE：

- mihomo Meta，版本 `424c2ef`。
- 当前 **rule** 模式，TUN 开启，gVisor，`auto-route: true`。
- `find-process-mode: strict`；规则总数 **3311**，含 3 条 ProcessName 类型。

这些仅是当时配置状态。**没有从实际外部 `/connections` 归因四条路径，未证明规则命中与大陆出口。** JSON 中 Node launcher、Electron main、renderer、Network Service 的 PID 仅是本地进程身份，不是 mihomo 的 `process` / `processPath` 实测。开发版四路径与打包版身份都仍属未验证。

## 6. 阶段 3 的约束与未验收项

基于本次证据，候选撤销流程需要至少覆盖：先同步关门闩并使旧决策代际失效；停止新调度；abort 已登记的主进程 fetch；关闭对应账号 WebContents 且不等待 beforeunload；处理既有 ServiceWorker；最后清连接池。`closeAllConnections()` 和 offline 仿真都不能承担核心撤销职责。

以上仍是候选实现依据，**阶段 3 不应因此自动启用**。当前未验证：

- HTTPS、TLS/SNI，HTTP/2、QUIC/HTTP3、IPv6、WebRTC；
- 真正的平台分区、验证码、API、CDN、重定向，以及真实 multipart 上传；
- 操作系统休眠后恢复、SW Background Sync 等后台触发场景；
- mihomo 真实模式切换、规则变更、进程身份匹配和四条实际出网路径；
- 打包版的进程名/路径；匿名出口归属与每个目标的可信路由绑定；
- “证明后到请求发送前”发生 TUN/路由变化时的零泄漏保证。

这次实验验证的是 Electron 本机可观察的行为边界。路由证据、实际调度器与六平台联动、撤销期间的竞态，都必须另行验收。仅凭应用自己的 `BlockedRequest` 日志不能证明境外零业务流量。
