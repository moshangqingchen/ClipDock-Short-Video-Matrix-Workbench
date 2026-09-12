# 控制器监听 owner：生产只读输入

`WindowsControllerOwnerReader({controllerUrl}).read(signal?)` 仅接受现有 ClashReader 同范围的 `http://127.0.0.1[:port]/` 或 `http://[::1][:port]/`，拒绝 DNS、userinfo、query、fragment 和额外路径。返回主进程内存快照；不接 IPC、不持久化运行许可。

固定隐藏 PowerShell 经 stdin 接收地址和端口，两次核对实际 Listen 行及 owner。每次读取用同一 `PROCESS_QUERY_LIMITED_INFORMATION` 进程句柄取得精确创建 FILETIME 和可选路径；所有句柄均关闭，不提权、不启 SeDebug、不修改内核或 OS。6 秒上限、96 KiB 输出上限、最多 64 个监听候选，单飞；取消或超时后晚到结果无效，底层未结束时不重叠启动。API 依据为 [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) 和 [QueryFullProcessImageNameW](https://learn.microsoft.com/es-mx/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew)。

IPv4 只由精确监听或 `0.0.0.0` 证明覆盖；IPv6 只由精确监听或 `::` 证明覆盖。单独 `::` 不猜成 IPv4 dual-stack。IPv4 已有覆盖时，同 PID 的 `::` 只记录为跨族未验证候选；候选出现不同 owner、无关 owner、重复监听、未知字段或前后变化则不可用。

`kernelEpoch` 来自实际 PID、精确创建时间、可选路径摘要和监听范围。路径摘要是规范化路径 hash，不是二进制 hash。路径不可读明确为 `null`；PID/birth/监听稳定仍可提供生命周期，后续确实依赖 PROCESS-PATH 的分支须另行拒绝未知路径。可见性或监听范围变化也会改变 epoch。此结果只证明观察到的监听 owner，不能独立证明该进程内容、HTTP 响应归属、已加载配置或业务出口。调用方应在自己的同轮读取前后比较，变化或读取失败撤销 generation；不要从本报告恢复许可。

**实际结果：**2026-09-07T18:15:41.315Z，仅查询当前 `127.0.0.1:9790`，没有 HTTP 请求或账号请求。返回 available，唯一 PID `43828`，创建 ticks `639243539457234678`，路径摘要可读，IPv4 精确监听；两次观察一致，耗时 2144 ms，源码结束仍一致。见[脱敏结果](./network-windows-controller-owner.results.json)。首次 Get-Process/Win32_Process 路径为空的[不可用结果](./network-windows-controller-owner-initial-observation.results.json)保留；没有补猜历史路径。随后固定有限权限 API 的实际读取成功。

验证：77 项针对性单元测试、Electron TypeScript 与目标 ESLint。复读脚本为 `node docs/.compare/windows-controller-owner-live-read.mjs`，编译仅在内存；结果不含原始可执行文件路径。
