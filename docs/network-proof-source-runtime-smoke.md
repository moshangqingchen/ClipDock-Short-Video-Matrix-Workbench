# 生产来源运行时：隔离只读实测

最新复验为 2026-09-08 北京时间 09:17:19.331—09:17:19.656（UTC 01:17:19.331—01:17:19.656），Electron **43.3.0 / Chromium 150.0.7871.212 / Windows**。实际运行 **19/19 检查通过**，新增启动前、无资格及销毁后的地址族投影拒绝检查；子进程退出码 0。此前成功与复验均已按原时间另存，未改写为当前源码实验。

这次加载真实 `ProductionProofRuntime` 及其默认 `createProductionProofComponents`，使用隔离临时 userData/sessionData，没有窗口、账号或业务分区。它验证来源运行时的只读启动、observe 拒绝采样和释放，不是完整 `main/index.ts` 的窗口启动，也不是实际出口/路径 qualification。

## 执行与隔离

```text
node --check scripts/electron-proof-source-runtime-smoke.mjs
node scripts/electron-proof-source-runtime-smoke.mjs --build-only
node scripts/electron-proof-source-runtime-smoke.mjs
```

首次执行前的语法及仅构建检查通过，捕获当时 28 个实际源码输入。05:58 复验加载新增政策投影、DNS 分类和系统 hosts reader，捕获 31 个实际源码输入；06:33 本轮在来源续读和控制器变化即时撤销补丁后再次执行一个实际子进程，仍捕获 31 个输入。observe 不启动严格模式续读计时器，因此本实测不代替另列的严格模式续读回归。

实验显式选择既有猫猫云 5.5.6 的 `resources` 目录，不修改应用默认选择或用户配置，不自动搜索。控制器为 `http://127.0.0.1:9790`，当前无需认证，因此 `getSecret` 返回 null。运行时固定 observe，`readVersion` 返回 null，没有提供 Gate、资格 provider 或旧报告输入。

子进程阶段，Node HTTP 只允许该字面 loopback 地址的四个固定 GET：`/configs`、`/rules`、`/version`、`/proxies/DIRECT`，同时拒绝认证/Cookie 头。其它 HTTP、HTTPS、DNS、全局 fetch、Electron 请求、Session 创建及 JS 启动子命令均拒绝并计数；默认 Session 请求也取消。父进程的构建和启动 Electron 不受这些子进程拦截器影响。

`SelectedClientConfig.read` 与 `ClashReader.read` 的包装仅记录允许字段和调用次数，保留实际调用、参数和返回值；没有替换 decoder、请求结果、证据或资格。原始配置、响应正文、秘密、代理名称与上游地址未写入报告。解码仍使用固定版本生产数据解析器，不执行客户端 JavaScript。

## 实际结果

| 检查                                                    | 结果                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| 构造运行时、start 前 refresh                            | 零来源/控制器读取、零匿名 Session；refresh 为 false            |
| start 与紧随的 refresh                                  | 合并成一次真实来源读取；refresh 为 true                        |
| 控制器读取                                              | 1 个 ClashReader 批次，4 个固定 GET，各端点一次                |
| 当前源                                                  | `local-config-candidate`，3341 条规则与实时控制器同源一致      |
| 内核                                                    | `424c2ef`，rule + TUN                                          |
| 候选资格                                                | `runtimeConfigurationProven=false`；没有创建通路 qualification |
| observe collect                                         | `unavailable / EGRESS_UNVERIFIED`；零版本读取、零额外 I/O      |
| Session / DNS / 公网 HTTP(S) / Electron 请求 / 命令尝试 | 所有受控计数均为 0                                             |
| dispose                                                 | 幂等、完成，约 0.53ms；此后 start/refresh 不产生读取           |
| 配置文件                                                | 前后密文字节摘要相同                                           |
| 源码                                                    | 实际构建输入 41 个，结束复核全部一致                           |

当前控制器 fingerprint 为 `5cc197058efc435fabbd518ff97564995e80b4af5a09f8961b989ce627db14ee`。来源仍为候选，不能因 fingerprint 相同给历史观测续时。

运行时源码摘要：`332f78698fae98ce642d43c550aac912a15051f2ba61ee5ccfe1082b0b0a4511`；默认组件摘要：`1a746f8f2b0c27ddca75a2c08e5c8a22d864249d6b50446ab52be7c44c23d923`。其余摘要与全部断言见 [机器结果](./network-proof-source-runtime-smoke.results.json)。observe 未调用路径输入，因此本实验不声称执行了 DNS 分类或系统 hosts 读取；两者另有模块测试及只读文件实验。相同脚本的显式准备拒绝分支另有 [25 项隔离实验](./network-proof-preparation-unavailable-smoke.md)，没有把两个分支的检查数量合为一次运行。

## 结论的限度

这次真实启动证明已选来源可由新运行时读取，observe 不会进入签发流程，读取结束后资源可以释放。dispose 发生在本轮读取完成后；没有把它写成真实 Windows 阻塞命令或慢文件读取中的取消实验。

零尝试计数只描述上述受控应用调用边界，未进行 OS 抓包，不能称为代理或整机物理零公网。没有验证业务与匿名工厂的 DNS/地址族/出口等价，没有发送 B 站登录 API、真实 Cookie 或扫码内容，也没有应用尚未授权的两条诊断 DIRECT 规则。`permissionIssued=false`、`pathQualificationCreated=false` 保持不变。
