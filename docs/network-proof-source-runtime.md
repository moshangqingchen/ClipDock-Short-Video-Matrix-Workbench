# 证明来源的主入口生命周期

日期：2026-09-08。实施记录，不替换冻结规格。

主入口现已安装稳定的 `ProductionProofRuntime` 门面，连接明确选择的客户端配置、组合来源和已有协调器。正式运行策略仍为 observe；门面直接拒绝输出可被协调器接收的证据。默认组件已有显式准备通路，但主入口尚未提供真实路径审查和准备窗口；DNS 地址类别也未从候选地址推断为真实出站，因此仍不能宣称严格分流已上线。

## 明确选择来源

网络公共设置新增可选的 `selectedClientResourcesPath`。旧的两个字段保持兼容；省略代表尚未选择，null 表示清除。设置页使用现有保存入口填写、清除当前支持的猫猫云 5.5.6 resources 目录。

共享 schema 只检查本机 Windows 绝对路径等基本形状；实际规范路径、原生 ASAR、版本及加载来源检查仍由 `SelectedClientConfig` 完成。不扫描安装目录、不切换到其它客户端、不自动修改代理规则。目录保存在独立的 network-public 设置项，仍不进入业务备份；秘密继续走凭据库。

## 生命周期顺序

| 触发                   | 行为                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| 构造                   | 不读文件、不读控制器、不创建匿名 Session。                                          |
| 启动                   | 若有明确目录，只读检查该来源。没有选择则没有来源 I/O。                              |
| 修改目录、控制器或秘密 | 主入口先撤销 Gate；旧来源失效，取消并等待真实底层工作；只为最后一次设置创建新来源。 |
| 来源过期或失联         | 通知主入口撤销，丢弃旧来源；不得用迟到结果恢复。                                    |
| 挂起／恢复             | 挂起停止来源并撤销；恢复重新检查，保留原网络观察与内核生命周期检查。                |
| 手动刷新               | 与已有网络刷新一起只读检查所选来源，不启用业务拦截或强制放行。                      |
| 退出                   | 协调器先撤销，再关闭来源；等待旧文件、PowerShell、控制器和匿名清理工作结束。        |

观察模式下，来源过期后的再次检查由手动刷新、设置变化或恢复触发，没有自动来源续读。严格分支由已有协调器驱动业务采样，组合组件另外按真实候选的原始截止时间合并续读来源，避免来源先过期而清掉第一轮恢复结果。维护不计作业务采样；首期采样并发仍为 1。[恢复时序修复](./network-proof-source-renewal.md)

## 接线与边界

`production-proof-components.ts` 管理一个应用生命周期的匿名 TLS/出口池。换配置不会重新创建池来绕过失败槽位。每个配置来源拥有独立、串行的 Clash reader，不与 observer 共用早发读数后重写采样时间。

实际组合为 SelectedClientConfig → PathInputReader → PathConformanceAdapter → ProductionProofSource。选择发生在实际输入轮之前；缺少真实 `RetainedPathQualification` 时，在 DNS、查路与公开 HTTP 前返回不可用。没有从报告 JSON、renderer 或备份加载资格。

`createConservativeRuleContexts` 只生成当前来源关联的 TCP + unknown 匹配阶段。早期 DOMAIN 可以在不依赖目的 IP 时结束；myip 的前置 IP/进程分支仍不可验证。DNS 答案不变成规则阶段 DstIP；真实解析、地址族与路径事实仍需补齐。

`whenIdle()` 已补到 SelectedClientConfig、EffectiveConfigSource、PathInputReader、WindowsControllerOwnerReader 和 PathConformanceAdapter。公开取消可以立即完成，但换实例必须等待原真实工作；Selected 保留旧的嵌套来源进行等待。清理失败保持关闭，不能靠重新保存设置恢复。

2026-09-08 补充接线：当前源增加有限的 DNS、hosts、sniffer 明细投影。DNS 分类每次读取当前 selection/candidate/版本，已过期或撤销时返回 unknown；只对显式 fake-IP 范围进行候选分类，`real` 不是物理连接、单族约束或大陆出口。生产 PathInputReader 同时装入系统 hosts reader，前后核对文件并绑定关联和保留资格依赖；来源退出也等待其真实读取结束。没有新增网络配置写入或默认资格。

## 验证

生命周期与组件的当前回归覆盖迟到、设置变化、同步回调重入、旧实例退出等待、匿名池复用、缺资格不调用诊断及 observe 拒绝签发。组件追加当前 selection 分类和撤销检查，并将真实 hosts 清理槽位纳入退出等待。真实 SQLite 设置与 React 表单测试覆盖保存和清除。2026-09-08 09:16 全项目 83 个文件、2710 项通过；类型检查和 lint 通过。

[隔离 Electron 只读实测](./network-proof-source-runtime-smoke.md) 当前 19 项通过：真实默认组件取得当前 3341 条规则的来源候选，仅 4 个本机 GET；observe collect 拒绝，Session、DNS、公开请求尝试均为 0，退出与源码稳定检查通过。这是来源生命周期验收，不能替代真实出口或账号流程验收。

## 显式准备入口与撤审

`ProductionProofRuntime.prepareQualification(signal)` 现已接入默认组件的真实 `PathQualificationLifecycle` → `ObservedPathQualificationProducer` → `AnonymousPhysicalRouteCollector`。它只在主进程明确提供 `preparation.readReview`、实际空闲窗口和严格策略时可进入；observe、缺审查、错误审查、非空闲或已取消均拒绝。构造、start、refresh、collect 不隐式触发准备，没有新增 IPC 或设置开关。

准备与随后采样使用同一来源实例、reader 和匿名池。外围操作与底层读取分别计数，底层清理不会等待包住自己的准备操作；更换设置和退出仍等两者真正结束。清理失败保持停用，不通过新建实例解除。

同步 getter 每次检查原始资格与当前内存审查的内容、身份和期限。开始采样、旧适配器排空之后和采样返回之后均复核；撤审先通知拥有者闭闩，再撤销本地来源，迟到证据不能返回。只保留相同 evidenceId 但修改审查内容也视为失效。

[隔离准备拒绝实验](./network-proof-preparation-unavailable-smoke.md) 使用当前默认组件，25 项通过；实际来源读取仍只有 4 个本机 GET，未创建 Session 或发出 DNS/公开请求。该实验验证缺条件时拒绝，不是正向资格或真实账号验收。

09:17 追加[地址族同步投影](./network-family-projection.md)：Runtime 默认操作范围和每次请求通过同一已验证来源取得精确 origin 的族集合。单族合法证明不再被固定双族范围卡住；缺证明、过期、撤审、来源变化或切族均拒绝。投影不隐式采样，主入口 observe 保留双族未知模型，strict 才消费准备后的原资格。

## 启动空闲窗口的接入条件

观察器新增 `pauseDiagnostics()`：暂停并等待匿名诊断真实请求、正文和连接清理，保留控制器轮询；嵌套句柄只在最后一次释放时解除暂停，不立即追加探测。原生暂停和 snapshot 回调同步重入共用已登记的清理屏障。诊断与观察器 41 项回归通过。

正式 bootstrap 仍没有可用的完整路径审查，因此现在不暂停观察模式的账号业务，也不调用准备。具备真实审查后的接点是首次配置账号 Session 和加载壳之前：保留 Windows/内核/控制器版本监测，暂停匿名诊断，保持业务入口未开放，再显式准备。准备及清理结束后才释放启动窗口。现有页面隐藏、停止加载或停调度都不能当作已无账号流量；无需为当前不可用的入口再建长期全应用暂停模块。
