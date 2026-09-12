# 同轮通路输入读取

本模块为阶段 2 的生产输入组合器，不是业务许可签发器。`PathInputReader` 汇总当前配置候选、控制器监听进程生命周期、Windows 网络指纹、内核 DNS 答案与实际查路记录；正式应用仍为观察模式。

## 读取顺序和边界

1. 同轮读取配置、内核 owner、Windows 网络观测；生产组合同时读取声明目标的 Windows 系统 hosts 文件。独立工作全部结算后才释放批次。
2. 对声明的目标 host 批量查询当前内核 A/AAAA，保留原答案 TTL、CNAME、地址类别和缺项。
3. 合并重复地址，最多 128 个，每 16 个一批查实际 Windows 路由。查询得到的虚拟接口不会被改写成物理接口。
4. 先完成末次配置、owner、网络与系统 hosts 检查，再读末次 DNS。DNS reader 自身仍在查询前后核对控制器；返回时再次核对 Gate 版本。版本、地址集、文件内容/身份或来源身份不一致即拒绝。检查各模块实际读取的时间，拒绝借用在途旧读取来刷新时间。
5. 截止时间不晚于参与核对的配置候选、最后一轮 DNS 的真实截止时间，以及 hosts 原始读取时间加既有许可上限。过期结果返回 `INPUT_EXPIRED`，不签发许可。

默认总时限 15 秒。相同目标与版本合并读取；不同范围在当前批次结束前返回忙。取消结果可立即返回，但底层仍在运行的 provider 占用真实槽位；Windows 路由 reader 的 `whenIdle()` 用于等取消后的命令实际退出，避免下一轮另建 reader 与旧命令叠加。

`state: observed` 仅表示取得了这轮输入：`EffectiveConfigCandidate.runtimeConfigurationProven` 和 `KernelDnsCandidates.chromiumResolutionProven` 仍为 false。它不证明最终 Chromium DNS、TUN 后的真实物理出口、实际 socket 地址族、账号传输适用性或大陆出口，也不代替六平台目录审核。原始 IP 和路径记录仅在主进程内存，不提供 IPC 或备份接口。

生产组合必装系统 hosts reader；不可读返回 `SYSTEM_HOSTS_UNAVAILABLE`，不以空映射代替。输入同时保留前后文件指纹、文件身份、解析子集和精确目标映射；配置关联绑定这些内容，保留资格另核对文件依赖变化。旧实验中没有 hosts 字段的记录保持缺失，不能与新增系统文件依赖的轮次互换。文件里没有映射不证明解析器实际使用该文件，也不填充 mihomo 的 `use-system-hosts` 默认值。

## 当前机器的实际结果

运行 `node docs/.compare/path-input-live-read.mjs`，只读已授权配置与固定本机控制器，范围为 `www.bilibili.com`、`creator.bilibili.com` 的两种地址族。没有账号请求、公开 HTTP(S) 请求、重载或配置修改；DNS 查询可能由运行内核继续访问其配置的解析器。

首次完整读取耗时约 5.6 秒。3341 条规则的配置摘要、内核生命周期和网络摘要前后一致；8 个不同目标地址的 Windows 查询中，IPv4 选择虚拟接口 59，IPv6 选择物理接口 12。这个结果不能互相替代地址族或出口证明。

部分真实 DNS 答案 TTL 为 1 秒。末次 DNS 之后的 owner 核对约 1.9 秒，因此汇总时返回 **`INPUT_EXPIRED`**。没有把 1 秒改成 15 秒，也没有因为规则可解释到 DIRECT 就放行。

该结果定位了采样合并与开销问题。后续可以调整采样顺序、合并粒度及出发默认值，但不能延长内核答案本身的真实 TTL，不能把过期 DNS 或已开始的旧读取重新盖时间戳。当前尚未取得真实账号许可。

修正读取时间与取消等待后复验，耗时约 5.43 秒，本轮返回 `observed`：初读仍为 1 秒 TTL，末读时运行内核实际刷新了相同地址集的答案，TTL 为 54–248 秒，模块仍按 15 秒候选上限截断。这个变化来自重新查询内核，不是调高 TTL 或忽略过期。两个 host 仍保留 `ADDRESS_CLASS_UNKNOWN`，加载和 Chromium DNS 证明仍为 false，因此没有发放账号许可。

首次过期测量保留在 `network-path-input-initial-observation.results.json`。复验的脱敏摘要、时序和源码哈希见 `network-path-input-live.results.json`，以文件执行时间及 `sourcesStillCurrentAtCompletion` 为准。不能把一次缓存刷新后成功读取解释为短 TTL 场景已经完成扫码兼容性验收。

2026-09-08 补上读取顺序回归：在 1 秒 DNS TTL、1.5 秒末次 owner 检查的受控时序中，旧顺序实际失败；新顺序在系统检查完成后重新查询 DNS，可保留新答案自身的 1 秒有效期。没有延长首读答案或改写时间。末次查询跨控制器版本、Gate 变化、地址集变化、查询本身耗尽 TTL、配置到期和借用旧读取仍拒绝。此项是模块时序验证，以上旧实机报告的执行时间保持不变。
