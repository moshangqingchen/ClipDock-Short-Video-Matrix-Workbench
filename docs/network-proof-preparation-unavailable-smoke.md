# 路径准备入口：隔离拒绝实验

2026-09-08，Windows / Electron 43.3.0 / Chromium 150.0.7871.212。09:17 当前源码复验 **25/25 通过**，新增启动前、无资格及销毁后的地址族投影拒绝检查。详细时间与源码摘要保存在[机器结果](./network-proof-preparation-unavailable-smoke.results.json)。此前结果按原执行时间另存，没有改写成当前源码的测试。

执行：`node scripts/electron-proof-source-runtime-smoke.mjs --preparation-unavailable`。

实验加载真实 `ProductionProofRuntime` 和默认组件，包括实际资格生命周期与组合器。运行在独立临时 userData/sessionData；没有窗口、WebContents、账号或业务分区。仅这个隔离进程选择严格分支，正式应用仍 observe。

| 检查                                                         | 实际结果                                         |
| ------------------------------------------------------------ | ------------------------------------------------ |
| 显式准备但没有内存审查                                       | 返回 false，未进入匿名采样                       |
| 空闲条件为 false                                             | 返回 false                                       |
| 审查格式错误                                                 | 返回 false，在采样前拒绝                         |
| 调用信号已取消                                               | 返回 false                                       |
| 随后 collect                                                 | unavailable，不隐式重试准备                      |
| 来源                                                         | 1 次真实选定来源读取，3341 条规则与当前内核一致  |
| 控制器                                                       | 4 个固定本机 GET，各一次；没有 DELETE 或配置写入 |
| Session、DNS、Electron 请求、公开 HTTP(S)、fetch、子命令尝试 | 全部为 0                                         |
| 清理                                                         | dispose 完成且幂等；之后没有新读取               |
| 当前配置、实际构建输入源码                                   | 前后摘要稳定                                     |

来源来自明确选择的既有猫猫云目录；配置只在内存解码，不执行客户端代码，不落秘密或原配置。控制器只允许 `127.0.0.1:9790` 的 `/configs`、`/rules`、`/version`、`/proxies/DIRECT`。其它 Session、DNS 和请求入口用计数后拒绝的拦截器封住，所以这是拒绝路径的实际集成实验，不能作为真实匿名传输或物理零包证据。

没有提供正向审查、历史 qualification 或测试 Gate 许可。`permissionIssued=false`、`pathQualificationCreated=false`。真实路径、全部可能地址族、出口和平台登录流程仍需各自验收。
