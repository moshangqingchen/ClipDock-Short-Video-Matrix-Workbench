# 安装版独立启动

从工具终端直接 `Start-Process`、Node `spawn({ detached: true })` 启动 Windows 应用，不能证明它脱离了调用者的 Windows Job。Job 默认会包含子进程；若宿主在退出时终止 Job，应用也可能退出。

`scripts/start-installed-workbench.ps1` 通过当前 Windows 桌面 Explorer 的 COM 对象启动一个短命隐藏 helper。helper 在启动应用前验证父进程是 Explorer、自身不属于任何 Job，并且 `GetCurrentPackageFullName` 返回 `APPMODEL_ERROR_NO_PACKAGE`（15700）。验证后清除 `SV_WORKBENCH_*`、`ELECTRON_*`、`NODE_OPTIONS`、`NODE_PATH` 和 `VITE_DEV_SERVER_URL` 等开发环境覆盖。helper 随后退出，不保留后台服务、计划任务或注册表设置。

```powershell
# 仅验证独立启动环境，不启动工作台，也不访问账号数据库。
pwsh -NoProfile -File .\scripts\start-installed-workbench.ps1 -Probe

# 软件正常退出后，独立启动现有安装版。
pwsh -NoProfile -File .\scripts\start-installed-workbench.ps1 `
  -ExecutablePath 'D:\SJdownloads\创作平台\短视频矩阵工作台.exe'

# 从独立、无包身份进程查看路径元数据，不打开数据库内容。
& .\scripts\start-installed-workbench.ps1 -Probe -InspectPath @(
  'C:\Users\Administrator\AppData\Roaming\short-video-matrix-workbench\workbench.db',
  'C:\Users\Administrator\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\short-video-matrix-workbench\workbench.db'
)

# 在相同独立环境中执行一次已准备好的本地脚本。
# 示例路径需替换为实际存在的脚本；参数通过 JSON 传递，不拼进命令文本。
& .\scripts\start-installed-workbench.ps1 `
  -ScriptPath 'D:\path\to\one-time-repair.ps1' `
  -ScriptParameters @{ Example = 'value' } -WaitSeconds 600

# 如需指定已安装的 PowerShell 7，可传入实际发现的完整路径。
& .\scripts\start-installed-workbench.ps1 -Probe `
  -PowerShellPath (Get-Command pwsh.exe).Source
```

启动器优先使用当前 PowerShell 7 进程的实际执行文件路径，其次使用 `Get-Command pwsh.exe` 发现的本地路径，也支持 `-PowerShellPath` 显式指定；使用前检查执行文件名、Windows 文件头及版本，不假设全局安装目录。`Script` 模式必须使用 PowerShell 7；因此 UTF-8 无 BOM 中文脚本及 `[IO.Path]::GetRelativePath` 等现代 .NET API 可以直接使用。脚本仍通过原始文件路径执行，保留 `$PSScriptRoot` 和 `$PSCommandPath`，不会把内容转换成失去来源路径的脚本块。JSON 会报告 `HelperPowerShellVersion` 和 `HelperExecutable`。

外层启动器兼容系统 `powershell.exe`，但一次性脚本模式仍需能发现或显式指定 PowerShell 7；只有应用启动及 `Probe` 模式可回退到系统 PowerShell 5.1。如果已有工作台进程，应用启动模式会拒绝再次启动，不强制结束应用。一次性脚本模式执行传入脚本，不自动启动或停止工作台；需由修复脚本本身检查备份、软件退出状态及目标路径。传入脚本使用绝对路径访问文件，以 `throw` 报告失败，输出通过结果中的 `ScriptOutput` 返回。如果等待超时，helper 可能仍在执行；应查看异常给出的报告路径，不可盲目重复数据修复。

启动后的 JSON 会报告实际父进程、Job 状态、包身份和应用 PID。`ApplicationInJob` 只表示应用当前属于某个 Job，不能据此认定它属于 Codex 的 Job。libuv 在 Windows 上首次创建非 detached 子进程时，会创建自己的全局 Job 并把调用进程自身加入；因此 Electron/Node 应用启动子进程后出现 `ApplicationInJob=true` 是允许的状态。

启动来源验收要求：实际已有 Explorer 创建 helper，helper 通过 `ProcessStartInfo.UseShellExecute=false` 直接创建应用，应用实际父 PID 与 helper 一致，而且 helper 在创建前后都不属于任何 Job。这样创建时不会从 helper 继承调用终端的 Job。JSON 的 `IndependentLaunchVerified` 和 `IndependentLaunchEvidence` 报告这些检查结果。外层还用 `QueryInformationJobObject(NULL, JobObjectBasicProcessIdList)` 记录 `CallerJobSnapshot`；若名单包含应用 PID，则返回失败，不自动结束应用。此 API 仅覆盖调用者最近一层 Job 及其子 Job，名单里没有应用不能单独排除更外层 Job，不能替代上述实际启动来源验证。

`GetCurrentPackageFullName` 返回 15700 只表示该 API 未报告包身份，不能单独证明文件访问未被虚拟化；本次审计中，部分 Codex 工具子进程也会返回 15700。最终验收必须同时核实上述独立启动来源，以及运行中工作台自身看到的数据库文件、账号记录和 UI。仅从 Codex 终端读取同名 Roaming 路径或只看包身份结果，不能证明数据恢复成功。普通用户也可以直接使用桌面快捷方式启动安装版。

## 本机验证（2026-09-12）

在调用终端故意设置 `SV_WORKBENCH_DATA_DIR=DO-NOT-USE-launch-probe`、`ELECTRON_RUN_AS_NODE=1`、`SV_WORKBENCH_SMOKE=1` 后执行 `-Probe`，结果：

- `Success: true`，`Probe: true`。
- helper PID 26208，父进程为桌面 `C:\WINDOWS\Explorer.EXE`（PID 9008）。
- `HelperInJob: false`，未继承调用终端的 Job 生命周期。
- `DataDirectoryOverridePresent: false`、`ElectronRunAsNodePresent: false`；调用终端覆盖未进入 Explorer 启动环境。
- 系统 PowerShell 5.1 复测也通过（helper PID 23232）；两个 helper 均已自行退出，临时报告均已清理。
- 本次验证未启动/停止真实工作台，也未打开账号数据库。

包身份和独立脚本验证：

- helper PID 95088，`PackageIdentityStatus: 15700`、`HasPackageIdentity: false`，父进程为 Explorer、自身不属于 Job。
- 同一次独立检查中，真实 Roaming 的 `workbench.db` 为 286720 字节，显式 Codex `LocalCache\Roaming` 的数据库为 3735552 字节，证实两处文件不同。仅读取文件元数据，未修改文件。
- 一次性无害脚本在 helper PID 101604 内完成，中文、引号、美元符号和反引号参数原样传入，返回结构化 `ScriptOutput`。未执行账号迁移或其他真实数据操作。

PowerShell 7 / UTF-8 无 BOM / 子进程生命周期补充验证：

- 实际 helper 执行文件为 `C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`，版本 7.6.5（文件版本 7.6.5.500）。
- 写入 UTF-8 无 BOM 的 `中文脚本.ps1` 后独立执行成功，中文文本、`$PSScriptRoot`、`$PSCommandPath` 及 `[IO.Path]::GetRelativePath` 结果正确。
- helper PID 114360 的父进程为 Explorer PID 9008，无 Job、无包身份；脚本启动的无害隐藏子进程 PID 106096 也不属于 Job。
- 在下一次独立工具调用中确认：原调用终端 PID 114344 和 helper PID 114360 都已退出，子进程 PID 106096 仍然存活。子进程 12 秒后写入预期完成标记并自行退出，所有探针文件已清理。

## Windows 官方依据

- [Microsoft：通过现有 Explorer 的桌面自动化对象启动应用](https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643)
- [Shell.ShellExecute 参数，包括隐藏窗口值 0](https://learn.microsoft.com/en-us/windows/win32/shell/shell-shellexecute)
- [Windows Job 对子进程的默认继承与终止行为](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [IsProcessInJob：传入空 Job 句柄检查是否属于任何 Job](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob)
- [GetCurrentPackageFullName：无包身份时返回 APPMODEL_ERROR_NO_PACKAGE](https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getcurrentpackagefullname)
- [QueryInformationJobObject：空句柄查询调用者最近一层 Job](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- [JobObjectBasicProcessIdList：列表包含所查询 Job 及其子 Job](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)
- [libuv Windows 进程实现：全局 Job 初始化会把当前进程自身加入](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)
