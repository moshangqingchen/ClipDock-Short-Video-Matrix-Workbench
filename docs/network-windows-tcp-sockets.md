# Windows TCP 表与控制窗相关器

新增 `src/main/network/windows-tcp-sockets.ts` 与测试，未改动 `connection-evidence.ts`、Runtime 或启动接线。本模块没有 NetLog、常驻助手、renderer IPC、持久化或网络设置写入。

## 读取 API

```ts
const reader = new WindowsTcpSocketReader({
  ownerPids: selectedOwnerPids,
  remotes: [{ address: resolvedTargetIp, port: 443 }],
});
const before = await reader.read();
// 由调用方执行受控匿名请求。
const after = await reader.read();
```

每个 reader 只用于一个独立控制窗。scope 必须提供 1–32 个不重复正整数 PID、1–32 个不重复的明确 IP/port，拒绝域名、IPv6 zone、未指定地址、越界端口、字符串 PID/port 和额外字段。IPv6 规范化后再做范围判断。

固定 PowerShell 程序通过 stdin 接收已验证的 JSON 数据；PID、地址和端口不插入脚本，不接受调用方命令。在 TCP 表读取前后，各对选中 PID 使用 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`、`GetProcessTimes` 和 `QueryFullProcessImageNameW` 获取精确创建 ticks 与可执行路径，并核对进程仍在运行、最终关闭句柄。它不使用 SeDebugPrivilege、不提权、不改变进程权限、不创建常驻助手。`Get-NetTCPConnection` 只投影所选 owner 与远端集合匹配的行。PowerShell 隐藏窗口、禁用 shell、6 秒超时、每个捕获流最多 384 KiB；结果最多 1,024 条，超限整次失败，不截断。

成功结果仅用于主进程内存：

- 采样的 `startedAtMono`、`completedAtMono`，以及规范化 scope 的 hash。
- 每个 owner 的 PID、100ns tick 格式的进程创建时间、`executablePathIdentity`。
- 每条 TCP 行的 `sourceAddress`、`sourcePort`、`remoteAddress`、`remotePort`、`ownerPid`、状态。

`sourceAddress` 必须保留，不能仅凭 source port 对接内核连接。`executablePathIdentity` 是规范化可执行路径的 SHA-256，**不是文件内容 hash、二进制证明或签名证明**。路径原文在解析时转为 hash，不外传。快照与嵌套条目冻结，不能在捕获后改变归属。

读前与读后所有 PID 的创建时间、路径身份必须一致，owner 集合必须完整且无多余项。首个成功读取固定 owner 身份；后续即使读前/读后互相一致，只要与已固定身份不同仍失败。这覆盖读取期间退出/重启，以及两个采样间 PID 被重用的情况。首次读取之前的 PID 身份仍需调用方从当前受控进程集合确定，数值 PID 本身不是历史身份凭证。

任何读取失败、进程缺失、身份变化、路径不可读、异常字段、未知状态、越界行、重复 tuple、超时或输出超限均返回 `available: false`，只附单调起止，不附原始错误或部分行。此后该 reader 永久不可用；必须废弃这次控制窗，重新建立隔离条件和 reader。并发读取共享一个 pending 操作，不启动重叠采样。

## 纯相关器的条件

`correlateControlledTcpSocket(window, cdpResponse, before, after, nowMono, maxWindowMs?)` 只产生候选结果。调用方必须真实控制并明确确认：

- 已列全这次网络请求可能使用的 owner 进程。
- 整个 owner 范围的其它网络流量都已静默，不能只关闭单个 Session 的页面。
- 请求前已排空连接池，基线在排空之后取得。
- 控制窗只有本次请求，没有其它并发请求或预连接。

这些条件不能从 TCP 表唯一性推导。普通多账号运行中的 Network Service 可能同时服务其它 Session；若不能建立上述条件，调用方必须传 false，相关器拒绝。接口中的布尔量是调用方承担的前提，不是本模块替调用方验证过的事实。

相关器核对控制窗与请求、响应、前后采样的单调顺序，scope 和 owner 身份一致；默认完整窗 15 秒，上限 30 秒。拒绝 CDP 的连接复用、磁盘/预取缓存、`requestServedFromCache`、Service Worker、缺少明确 false 标记及 QUIC/HTTP3。只接受 TCP 对应的 HTTP/1.x 或 h2，且远端 IP/port 一致。

基线已有这个远端的任何行则拒绝；之后必须恰好出现一条 Established 候选，两个候选一律拒绝，不能挑看起来更像的一条。成功结果保留完整 source/remote tuple 和 owner，并明确：

```ts
{
  matched: true,
  basis: "caller-controlled-cold-window",
  sessionOwnershipProven: false,
  // contextId, generation, owner, socket
}
```

**唯一 TCP 行本身不能证明 Session 归属。** 该候选不能直接签发 DirectProof；后续仍需独立验证调用方控制窗、真实 Session/进程上下文、同 generation 的内核连接、目标路由、TLS/DNS/出口证据。本模块不产生 DIRECT、出口或 Session 许可结论。

## 实测与测试

2026-09-07 使用生产读取模块的内存 esbuild bundle，创建仅监听 `127.0.0.1` 的临时 TCP 服务；先采空基线，再由当前 Node 进程建立一个连接，读取后表并与客户端实际 socket 及服务端观察交叉核对。整个命令约 2.4 秒；没有公网请求、账号或 Cookie，结束关闭客户端及服务端连接，没有文件清理操作。

实际结果均为 true：

- 基线、后表均可读，基线为空，后表恰好一个所选行。
- `sourceAddress`、`sourcePort` 与客户端真实 socket 相同，服务端观察到相同源端口。
- owner PID 与当前进程相同，创建时间前后稳定，路径身份与 `process.execPath` 的规范化路径摘要相同。
- 单调采样时间顺序正确。

这次实机验证的是 Windows 表读取与真实 Node socket 的对应，不是 Electron CDP/Session 归属验收；`sessionOwnershipProven` 保持 false。未使用合成 CDP 数据冒充实机证据。

验证：42 项定向 Vitest 通过，Electron TypeScript 检查通过，新增两文件 ESLint 通过。测试包含输入/输出限制、PID 重用、进程退出或路径变化、保留源地址、唯一表行无控制窗仍拒绝、缓存/SW/复用、多候选、基线污染、时间顺序与失效锁定。

TCP 表读取仍不是原子事务；前后身份检查不能锁定中间每一刻的网络活动，也不能替代调用方隔离或外部路由变更的撤销机制。不得把这些边界写成“物理零包”。

## 2026-09-08：实际内核 owner 读取修复

[真实匿名工厂调查](./network-anonymous-factory-path.md)中 TCP reader 返回不可用。随后只读确认运行内核 PID 43828 的 `Get-Process.StartTime` 存在但 `.Path` 为空；原固定脚本将空路径交给 schema 后整次拒绝。现有 controller owner reader 的限权 Win32 方法能读到同一进程的路径，因此将相同的原生读取方式移植到 TCP 固定脚本，保持 selected PID 范围和前后身份验证。原生接口也取不到路径时仍返回不可用，不填空 hash、不回落到进程名。

新增空/null 路径拒绝、原生 ticks/path 结果与空 TCP 表、固定脚本限权边界测试，定向 45 项通过。另在当前机器进行[无公网只读回归](./network-windows-tcp-native-owner.results.json)：scope 为本次 Node PID 与实际内核 PID，远端仅 `127.0.0.1:9790`；读取成功，内核 PID/精确创建 ticks/路径 hash 与独立 controller owner reader 一致。返回 **0 条 socket**，只证明读取已恢复，不证明任何 Session 或出网归因。此前公网调查保留失败状态，没有自动重发。
