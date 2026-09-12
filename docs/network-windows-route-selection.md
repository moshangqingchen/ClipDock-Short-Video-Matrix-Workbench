# Windows 当前路由选择读取器

实现：`src/main/network/windows-route-selection.ts`。模块是主进程内部的只读输入来源，没有 IPC、日志、持久化、用户网络修改或后台助手 exe。

## API

```ts
const reader = new WindowsRouteSelectionReader({ addresses: verifiedLiteralIps });
const snapshot = await reader.read(signal);
reader.dispose();
```

每实例固定一个 1–16 个 IP 的范围，不接收域名、URL、命令或代理设置。输入先规范化并去重验证；重复、越界、unspecified、组播、IPv4-mapped IPv6 及需要接口 scope 的链路本地目标均拒绝。IPv6 zone 输入不受支持，不猜接口。

普通查询成功返回单调开始/完成时间、scopeHash、selectionHash 和实际 `selections`，标记 `basis: "windows-best-route-query"`、`socketObserved: false`。每条记录保留：

- 规范化目标、源地址、地址族、来源状态和 SkipAsSource。
- 接口 index、规范化 GUID 及其摘要、hardwareInterface、adapterStatus/Up、IP 接口 Connected 状态。
- 路由前缀、下一跳、route metric、interface metric 和 route state。

原始源地址、下一跳、GUID 只在主进程内存中使用，不得把整个对象送 renderer、备份或写入审计。摘要也不是可执行文件身份、DIRECT 或出口地理证明。

`available` 仅代表这次实际查路及必要身份记录可读、两遍一致。硬件接口、Up、Preferred 等事实原样保留，由路径验证器决定是否属于支持范围；不在读取器里把“Up 的硬件网卡”升级为大陆出口。

## 固定命令与校验

固定 Windows PowerShell 程序执行 `Get-NetAdapter -IncludeHidden`、`Get-NetIPInterface -PolicyStore ActiveStore`，逐目标调用 `Find-NetRoute`。所有输入仅用 stdin JSON 传入，绝不拼入脚本或 shell 参数。隐藏窗口、禁用 shell、最长 10 秒、每个捕获流上限 384 KiB。

每遍要求 Find-NetRoute 恰好返回一个源地址对象和一个路由对象，二者接口/族一致，并唯一对应当前适配器与 IP 接口。两遍结果进行完整规范化比较，地址、GUID、下一跳、metric、路由或接口事实改变均返回不可用。比较不构成与外部网络修改原子执行的承诺。

响应严格校验字段、枚举、数量、范围及来源集合。目标必须恰好全部返回一次；路由前缀必须是同族的真实网络前缀，且覆盖对应目标。IPv6 下一跳若带 zone，只有它是链路本地并与当前接口 index 相符时才接受。无效 GUID、未知字段、截断、缺少必要记录和原始子进程错误不会产生部分成功结果。

**真实缺项例外明确建模：** 当前 Windows TUN IPv4 的 `Get-NetIPInterface.InterfaceMetric` 返回 null，而普通物理接口返回 20。输出因此采用 `interfaceMetric: number | null`。它不是把缺项补成默认 0；null 与 0 的变化会使本轮前后比较失败。`routeMetric`、实际 source、接口/GUID 等必要查路记录仍须存在。若某个后续算法确实需要 interface metric 才能判断路径，应拒绝其无法解释的推断，不能因此否定已由 Find-NetRoute 返回的查路事实。

## 并发与取消

同一实例的并发读取共享一个批次。加入该批次的任一 AbortSignal 取消，会取消整个共享批次，终止本模块启动的 PowerShell 子进程；所有等待者取得固定的 `READ_CANCELLED`，不外传调用方的原始 reason。

超时返回 `READ_TIMEOUT`。若注入的测试 runner 忽略取消，槽位仍保留到该 runner 结束，不能因提前返回超时而启动重叠工作。晚到结果不会改为成功。正常批次结束后清理旧信号订阅；下一次读取重新查询，不缓存上次路由。

`dispose()` 是终态，取消在途并禁止后续读取。读取失败可在下一独立批次重试；是否因此撤销网络 generation 由主进程调用方统一执行，不持久化或恢复旧路由资格。

## 当前真实验证

[本轮脱敏结果](./network-windows-route-selection.results.json)来自一次性脚本 `docs/.compare/windows-route-selection-live-read.mjs`，在内存编译当前生产模块。2026-09-08 01:38（北京时间）最终版本重新从本机控制器查 B 站 A/AAAA 各取一个当前 IP，然后只做 OS 路由查询；没有向这两个 IP 发 HTTP、建立测试 socket、使用账号凭据或修改配置。

| 事实 | 最终版本实测 |
|---|---|
| 两遍查路 | available=true，约 2146 ms |
| IPv4 选择 | index 59，非物理，Up，interfaceMetric=null |
| IPv6 选择 | index 12，物理，Up，interfaceMetric=20 |
| 生产 OS 指纹前后 | 可读且稳定 |
| DIRECT、大陆出口、socket 或许可结论 | 均未产生 |

加上缺项原值检查后的中间版本曾拒绝 index 59；只读调查确认是 CIM interfaceMetric 缺项，随后改为明确 nullable 记录并重新验证。没有把失败样本改写成成功，也没有以强制类型转换掩盖缺项。之前脚本中 `[int]` 转换得到的 TUN metric=0 不能继续称为该字段的显式 API 值。

验证：70 项定向测试、两文件 ESLint、Electron TypeScript 检查全部通过。测试覆盖同 scope 单飞、取消/超时/晚到结果、旧信号清理、GUID 与路由变化、族/前缀一致性、缺项、未知字段、重复/缺少目标及固定命令边界。本轮没有再次运行整仓测试。

## 接入边界

Windows 的 Find-NetRoute 查询的是指定远端的最佳本地源地址与路由；不是某个进程实际发出的 socket，也不会自动代入 mihomo 的接口绑定行为。[Microsoft 文档](https://learn.microsoft.com/en-us/powershell/module/nettcpip/find-netroute?view=windowsserver2025-ps)

调用方应将真实记录与同轮 source、内核/OS generation 及必要的实际拨号符合性关联。TUN 下返回虚拟接口时，不能把它当作 DIRECT 最后一跳；即使 IPv6 返回物理接口，也不能单靠它推断绕过 TUN 或大陆出口。本模块没有新增“每目标、每轮必须 socket”的政策，更没有用纯 hash 伪造实际路径。

## 源地址限定的只读查路

为核对实际内核拨号的物理来源，现可显式提供一个真实本地 IP：

```ts
const reader = new WindowsRouteSelectionReader({
  addresses: [observedSocket.remoteAddress],
  localAddress: observedSocket.sourceAddress,
});
```

这只调用 `Find-NetRoute -LocalIPAddress` 查询该源地址下的最佳路由，不绑定 socket，也不改变系统或 mihomo 配置。返回使用独立的 `basis: "windows-source-route-query"` 并保留规范化 `localAddress`，`socketObserved` 仍为 false。实际 socket 必须来自其它已关联的取证记录；将任意网卡地址作为参数不会制造这条关联。[Microsoft 参数说明](https://learn.microsoft.com/en-us/powershell/module/nettcpip/find-netroute?view=windowsserver2025-ps#-localipaddress)

限定源必须是单一、同族的字面地址，拒绝 ANY、网段、unspecified、映射 IPv4 和需要 scope 的链路本地地址。结果中实际选出的源必须与限定源一致，两遍身份与路线检查保持不变。限定源进入 scopeHash，不能与未限定的查询混用。

`PathInputReader` 显式拒绝将源地址限定结果充当普通 OS 主路径；物理路径关联应同时保留原来的 TUN/普通查路和独立限定查路。单元测试覆盖两者不可互换、源不匹配、族和地址规范化，当前真实只读结果另行记录，不把旧无约束查询报告标为新 API 已验收。

2026-09-08 03:34 的 [新版只读实测](./network-windows-source-route.results.json)同时调用这两种生产查询：对本轮内核返回的一个 B 站 API IPv4 候选，普通查询返回 TUN index 59；指定本轮唯一 Preferred 物理 IPv4 候选作为源后，返回物理 index 12，且实际选择的源与参数相符。两种结果各约 1.6 秒，controller/Windows 网络摘要和模块哈希前后稳定。

该源来自实际 OS 地址枚举，**没有观察或声称某个 kernel socket 使用它**。本次仅验证源限定查询能如实返回另一条路线、两类结果有明确区分；仍须与真正关联的内核出站 socket 合并。没有公开 HTTP、账号请求、路由修改或许可。
