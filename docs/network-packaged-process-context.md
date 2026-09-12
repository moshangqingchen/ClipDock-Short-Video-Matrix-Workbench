# 打包验收入口的进程归因

执行时间：2026-09-07T15:09:40.532Z。脚本：node scripts/electron-packaged-process-context.mjs。

**本次创建真实 electron-builder 验收包，不是手动重命名 electron.exe。** 使用项目相同 productName/appId、Electron 43.3.0、x64、asar 与 signAndEditExecutable 设置；包含本轮编译的 main/preload/renderer 资源。临时 package.main 指向固定匿名验收脚本，正式主进程入口未执行，生产源文件没有植入实验开关或任意 eval 接口。

开发版与打包版使用同一验收脚本，仅访问公开端点 https://myip.ipip.net/json；分别使用新建隐藏窗口、临时 userData/sessionData、无登录态分区。请求 credentials:omit，Cookie/Authorization/proxy Authorization 被移除，响应 Set-Cookie 被移除；没有真实账号或公网凭据。Clash 控制器只读。

| 通路 | 开发版内核记录进程 | 打包版内核记录进程 | 归因 |
|---|---|---|---|
| page-fetch / isolated account-shaped partition | electron.exe | 短视频矩阵工作台.exe | 已匹配 |
| session-fetch / isolated account-shaped partition | electron.exe | 短视频矩阵工作台.exe | 已匹配 |
| anonymous-diagnostic-session / separate Chromium session | electron.exe | 短视频矩阵工作台.exe | 已匹配 |
| node-https / Electron main process | electron.exe | 短视频矩阵工作台.exe | 已匹配 |

归因依据是本次新增连接 ID、精确目标 host:443、Node socket 或 Chromium NetLog 独立记录的源端口；不能拿另一进程的 DIRECT 连接替代。具体连接与源码/包哈希见 [network-packaged-process-context.results.json](./network-packaged-process-context.results.json)。

证据边界：这是验收入口打包进程的实测，**仍不是正式 ClipDock 入口及最终安装路径的验收**。本次没有启动真实账号，也没有替各平台登录/API/CDN、IPv6/QUIC 签发证明；目标、地址族、安装路径、内核规则或运行上下文改变必须重新确认。不能只把进程 basename 相同当作路径等价。

打包目录与两份临时数据目录均位于本仓库新建的独立 .compare 子目录。electron-builder 的输出只指向该目录；未构建或执行安装器，没有启动正式产品入口，`release` 和已安装程序不在本次写入路径中。

清理最终状态：`temporaryDirectoryRemoved=false`。残留精确路径为 `D:\project development\短视频平台管理\docs\.compare\packaged-context-TrkTkL`。开发版、打包版探针子进程退出码均为 0；之后按该精确路径检查进程命令行，未发现仍活动的相关进程。此检查不能证明没有系统级文件句柄。

首次 Node 清理异常仅留下统一提示，脚本未保存底层错误码，不能据此确认原因一定是目录锁。随后对这个已核对目录的 PowerShell 递归清理被自动审批拒绝，工具返回原文 `blocked by policy`，没有提供更具体理由。拒绝后没有绕过策略或继续进行清理写操作；残留目录保留，进程证据本身不受影响。
