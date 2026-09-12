# 三平台无视图状态探测：修复前失败与修复后复验

**修复后，同一脚本的 18 个案例全部保留原认证状态和验证时间，在线事件为 0。** 原先 18 个失败案例及 9 次假上线事件仍保存在独立历史结果中，没有覆盖成“从来通过”。此次复验只证明这三个未知回应分支的字段保留行为，不批准三平台目录、真实平台响应合同或大陆出口。

## 修复后复验：2026-09-07 22:28 UTC

- 执行时间：2026-09-07 22:28:24.882–22:28:25.860 UTC（北京时间 2026-09-08 06:28），由根任务顺序运行。
- [新脱敏结果](./network-cn-check-status-observation.results.json) SHA-256：`015fa54158ffb76fe2830fa3af78003cd141e3ff95c37d4973122542bd3f5be6`。
- Electron 43.3.0 / Chromium 150.0.7871.212；原脚本未改，其摘要仍为 `e7e6000f62e18ace99e67ae5acab04d6fd0d617d664070a67feceb77567b3d70`。
- 新探测器摘要：`d9e54c76943548c5ae1dbdf468d27dcc7f906aa17b0de5ec712b16df09d2cdbc`。36 个编译源码摘要结束核对未变；本次复核再次逐个计算当前文件摘要，36 项均与新 JSON 相符。
- 阶段 completed、子进程 exit code 0、无 failure、Session 清理完成。独立核对全部 18 个唯一组合：三平台 × 204/HTML/403 × 原 offline/online，无缺失或重复。

| 后验项目 | 修复后实际结果 |
|---|---:|
| 隔离、闭闩及请求数量检查 | 23/23 通过 |
| 直接比较原始 status、lastCheckedAt、lastOnlineAt | 18/18 完全保持 |
| 状态变化 / lastCheckedAt 刷新 / lastOnlineAt 刷新 | 0 / 0 / 0 |
| 每案例 onlineEventEmitted / 总 onlineEvents | 全部 false / 0 |
| unexpectedAuthenticationCases | 0 |
| Session.fetch / 内部 net.request / 接收端请求 | 18 / 18 / 18 |
| 合成 Cookie 请求 / 非预期目标 / Authorization 请求 | 18 / 0 / 0 |
| Node 出站尝试 / defaultSession 请求 / 视图动作 | 0 / 0 / 0 |

在线事件是单独核对项：脚本的 `preservationExpectationPassed` 只比较三个认证字段，不包含事件。本次并非仅依据 exit 0、该布尔值或汇总失败数作结论，而是重新比较原始 before/after，并同时检查逐案例事件与总事件数。

视频号的 6 次请求现在均为 POST、`Content-Type: application/json`、正文 2 字节且为 `{}`。这修正了旧基线中实际发出的 `text/plain;charset=UTF-8`。本轮仍有 18 个 Response.url 缺失，因此没有证明 Session.fetch 的最终目标事实已补齐，也没有验收重定向边界。

三个未知回应分支现在都不刷新真正验证时间，不从 offline 升级 online，也不发 `account-online`。未知 JSON、有效成功响应、401、重定向、默认节流、撤销与页内签名并未因此被本脚本覆盖；正式审核状态、真实账号兼容和实际出口仍是独立事项。

## 修复前失败基线：2026-09-07 22:17 UTC（保留）

当时抖音、百家号、视频号的无视图检查均复现了未知回应改写认证结论的问题。在合成 Cookie 存在时，204 空响应、200 HTML 挑战、403 空响应这三个分支，分别从 offline 和 online 开始，共 18 个案例全部改写 `lastCheckedAt`、`lastOnlineAt`；9 个旧 offline 案例全部变为 online 并发出 `account-online`。

以下为原失败观察，不能读作修复后现状。采样当时没有修改生产代码、正式审核标记、用户配置或原 B 站脚本/报告。

### 失败基线记录

- 时间：2026-09-07 22:17:32.111–22:17:33.093 UTC（北京时间 2026-09-08 06:17）。
- Electron 43.3.0 / Chromium 150.0.7871.212，开发版，隐藏独立进程，无窗口。
- 脚本：[electron-cn-check-status-observation.mjs](../scripts/electron-cn-check-status-observation.mjs)。失败基线：[归档脱敏 JSON](./network-cn-check-status-observation.history-1788820105941.results.json)。
- JSON SHA-256：`eebe0edd3752a0f3ce2fb57fd9d961e0b5036a35005f1024d0bda2338ba136f7`。
- 36 个实际 bundle 源文件在编译时读取同一份字节并计算摘要；结束核对全部未变。探测器摘要 `6f7eee99bbfc26fba3983836616db490ad7f5044287d9ccbe351ccab0923e43a`，主进程 fetch 包装器 `033097b9134f6472045dcfaa9732b09229b12c749b869edcaea2cd52c39d7685`，账号服务 `ace00fd56ef1a359a0ae4cdf84be898545a653477ac080dffab6d8f4217a5875`。
- 最终子进程正常退出，exit code 0，阶段为 completed，Session 清理完成。**0 表示观察程序正常完成；认证保留期望仍为 18/18 失败。**

### 基线隔离与计数

临时 userData/sessionData、内存数据库和随机假账号均独立；生产 `configureAccountSession` 创建的 persist 分区仅存在于临时目录，未打开任何已有账号。三个源码固定 hostname 只在该 Electron 的 host-resolver-rules 中映射到 127.0.0.1，其他名称不可解析；没有改系统 hosts、DNS 或 mihomo。

接收端只监听 127.0.0.1:443，证书只在三个测试 Session 内按 hostname 和本轮证书摘要核准。未启用全局证书忽略。真实 AccountService、login-detector、gatedSessionFetch、NetworkRuntime、EgressGate 和 Session 请求门闩参与；临时目录审核与两轮证据只用于受控 fixture，不进入正式构建审核或生产许可来源。

`session.fetch` 及其底层 `net.request` 只进行透明参数检查和计数：保持原 Session、固定 URL、方法、`credentials:include`，原样返回实际 Response。Node HTTP/HTTPS/global fetch 禁止出站；defaultSession 全部取消。没有改探针响应或认证结果。

| 观察 | 数量 |
|---|---:|
| 实际 Session.fetch / 内部 net.request | 18 / 18 |
| 受控接收端请求 | 18 |
| 仅含预置合成 Cookie 的接收端请求 | 18 |
| 非预期目标 / Authorization 请求 | 0 / 0 |
| Node 出站尝试 / defaultSession 请求 / 视图动作 | 0 / 0 / 0 |
| Response.url 缺失 | 18 |
| 隔离、闭闩及请求数量检查 | 23 项通过 |
| 未确认回应应保留认证字段的期望 | 18 项失败 |

三次闭闩检查均保留账号全部字段，且不调用 fetch、不抵达接收端。计数说明本轮受控请求路径；不声称操作系统、代理或任何其他进程的物理零公网包。没有读取 controller，也没有公网请求或真实平台响应。

### 基线实际响应分支

每个组合分别从 offline、online 开始，两次检查都显式 `skipProbe:false`。实验先设置合成既往认证时间，并等待一个短间隔，便于逐字段比较；实际前后时间保存在 JSON。

| 平台 | HTTP / 合成回应 | 旧 offline | 旧 online | 两个真正验证时间字段 |
|---|---|---|---|---|
| 抖音 | 204 / 空 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 抖音 | 200 / HTML 挑战 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 抖音 | 403 / 空 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 百家号 | 204 / 空 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 百家号 | 200 / HTML 挑战 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 百家号 | 403 / 空 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 视频号 | 204 / 空 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 视频号 | 200 / HTML 挑战 | → online，发在线事件 | 仍 online | 两者均刷新 |
| 视频号 | 403 / 空 | → online，发在线事件 | 仍 online | 两者均刷新 |

例如抖音 204：原 offline，两个时间字段均为 `22:17:32.360Z`；检查后 online，两个字段均变为 `22:17:32.388Z`。本轮只监听在线事件，不接 profile/collect 后续任务，以免混入其他操作。因此没有把“未接后续任务”描述成这些后续任务已验收安全。

视频号六次请求实际均为 POST，`Content-Type: text/plain;charset=UTF-8`，正文 2 字节且确为 `{}`。这与当时生成的页内 POST 显式设置 `application/json` 存在差别。失败基线只能证实主进程发送事实，不据此宣称真实平台一定拒绝哪种内容类型。

### 失败时对应源码与限定结论

下列探测器行号和行为对应失败基线摘要 `6f7eee99…`，不描述修复后探测器。

- `src/main/browser/login-detector.ts:147–168`：三平台使用通用判断。401明确离线；2xx未命中退出正则或带最终 URL 的 HTML 登录页特征，就返回 online。403属于 inconclusive。
- 同文件 `232–278`：不确定结果仍可能依据 Cookie 返回 online；本轮三平台未生成 B 站专用的 unconfirmed 标记。
- `src/main/services/account-service.ts:300–309`：检查在 lease、account epoch 有效后更新状态；只有 unconfirmed 会提前保留原记录。
- `src/main/db/repositories/accounts.ts:118–123`：更新状态会刷新 last_checked_at，在线/即将过期会同时刷新 last_online_at。
- `src/main/network/gated-session-fetch.ts:21–49`：实际使用原 Session.fetch 并读取 Response.url。本轮18个 URL 均为空，不能把这个缺字段当成最终目标证据。

这份失败基线表明，当时三个分支不符合“未知回应不确认、不续验证时间”的约束。修复后的限定复验已在上方单独记录；有限成功响应合同与其他分支仍需各自证据，本文不自行更改合同、移植 B 站字段或提升 flowReviewed。

本轮按定位要求收敛至 204/HTML/403。未知 JSON、有效 fixture 回应、401、同源/跨源重定向、默认节流、撤销中断及页内签名均**未在本轮实测**。没有执行扫码、验证码、平台页面脚本、真实账号读取或资料/作品采集；也未核准任何额外 hostname。

## 首轮失败历史

前两次脚本失败均保留，不能计入业务验收：

1. [首轮结果](./network-cn-check-status-observation.history-1788819361446.results.json)：外层 watchdog 结束子进程，无子进程结果，`CHILD_RESULT_UNAVAILABLE`。没有有效业务观察，也没有可据以断言实际零请求的子进程计数。
2. [第二轮检查点](./network-cn-check-status-observation.history-1788819453158.results.json)：记录到一次 Session.fetch，实验误将其正常内部 Electron net.request 与 Node 请求一并禁止；接收端当时0到达，观察0条，cleanup尚未完成便被外层结束。该脚本干扰不代表生产探针失败。

第三轮前确认旧脚本子进程已退出；移除过宽的 Electron 请求禁用，改为上述透明精确参数检查，并为读取、初始化与清理设固定上限。未修改任何生产依赖。每个分支及接收端阶段都写脱敏检查点，最终才形成完整观察结果。

复跑前仅构建校验：`node scripts/electron-cn-check-status-observation.mjs --build-only`。本机观察：`node scripts/electron-cn-check-status-observation.mjs`；再次运行会先保存既有 JSON 为 history 文件。运行需要本机443可用，若占用则明确失败，不改端口、目标或用户配置来绕过失败。
