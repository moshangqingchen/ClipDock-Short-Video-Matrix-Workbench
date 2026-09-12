# 互斥策略：本机 Electron 集成验收

2026-09-08 12:10:23 CST，根任务单次执行 [electron-exclusive-runtime-smoke.mjs](../scripts/electron-exclusive-runtime-smoke.mjs)，Electron 43.3.0 / Chromium 150.0.7871.212 的受控验收 **25／25 通过**。[原始结果](./network-exclusive-runtime-smoke.20260908T041022552Z.results.json)独立保存，未改写旧实验。脚本默认只打包当前生产模块并做本机辅助检查，实际执行须显式 `--run-once`。

本机接收端实际收到 7 次请求，均来自 loopback，均只带本轮合成 Cookie：允许后的主进程 fetch、测试页面、页内 fetch、XHR、两条在途响应流及恢复后的主进程 fetch 各一次。未知状态、第一次关闭检查、开启代理后的 gated fetch 和原始 Session.fetch 均零到达。两条流各发送 2 个块后关闭，清理完成后观察期间计数没有继续增长；两个业务读取 Promise 均返回网络休眠。开启代理同时撤销原租约，实际页面执行 stop 后销毁，旧 DIRECT 观察无法重新开闩。

恢复的第一轮仍闭闩，第二轮才重新取得测试国内资格，沿用原测试 Cookie。实际 `AccountService` 闭闩检查保留登录状态与真正验证时间，账号写入、account-online 事件、通知均为 0。全过程代理读取 9 次、合成 CN 读取 4 次、`closeAllConnections` 9 次、页面 stop 1 次；越界请求为 0。退出时真实在途 Promise、窗口与 WebContents 均为 0，清理成功，子进程正常退出且未触发 watchdog；27 个生产输入摘要前后一致，原始临时数据已删除。

本轮证明互斥状态机与真实 Chromium 请求守卫、在途撤销、恢复流程的受控接线成立。**代理状态、CN 结果与 OS 网络摘要是合成输入，不能代替当前 Windows 真正关闭系统代理／TUN后的恢复验收**；当前实际 TUN 仍开。未测试真实扫码、完整调度器任务、上传或国际 API，不产生真实出口资格或账号许可。

结果 SHA-256：`9a18693c40ea78e088140ece6aa7696492ebbd0190d5c69caefaefe5913ce996`；脚本：`5622cd92979f3ee05127978b10ad533ffa42fba04d17a735e4957a513b8dad54`；打包产物：`68b72f040edce146c5c0e81669ef1ece8e312496183f86d1646df4c391dd438c`。

验收直接使用生产 `ExclusiveNetworkSwitch`、`NetworkRuntime`、Session 请求守卫、`gatedSessionFetch`、`pageFetch` 与 `closeAccountView`。仅使用新建临时 Electron 数据目录、非持久测试分区、隐藏测试窗口、本机 TLS 接收端和合成 Cookie。代理启用状态、OS 网络摘要及 CN 诊断结果均为测试注入，不修改实际系统代理、TUN、mihomo 配置或证书存储，不访问真实平台。局部证书信任只匹配本机测试 host 与本轮证书指纹；不关闭全局 TLS 校验。

检查未知状态闭闩、两次稳定关闭代理后允许真实 main/page/XHR 请求、开启代理后同步撤销 lease 并关闭两条正在读取的响应流、旧 DIRECT 观察不能重新开闩、关闭后仍需两次恢复。实际 `AccountService` 的休眠及闭闩 `checkStatus` 配合内存合成账号仓库验证登录状态／验证时间不写回、不发 online 事件；它不是平台登录探针验收。此轮不新增上传试验，不把两条响应流取消当作所有上传协议覆盖。

测试只将 warmup 间隔改为 50 ms，并将自动轮询改为 60 秒以便显式控制每轮；其它生产时效不延长。请求主体、`Session.fetch` 和页内 fetch 不替换响应；Session close 与页面 stop 仅透明计数后调用原方法。没有使用旧 ProofCoordinator 伪造 DIRECT 许可，也不生成真实路径资格。

每次实际执行写独立时间戳 JSON，包含限定接收计数、固定检查名称、清理结果及打包来源摘要；失败同样保留。原始 Cookie、证书私钥、完整请求 query 与外部秘密不入报告。清理只针对脚本自建的确切临时目录和子进程，源码变动或清理失败不能记录通过。
