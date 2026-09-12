# Windows 网络配置指纹观察器

实现文件：`src/main/network/windows-network-fingerprint.ts`。模块与测试完成后，已在 `index.ts` 接入启动、挂起/恢复、退出生命周期，在 `runtime.ts` 接入独立的 `networkReadiness` 检查。正式入口仍使用观察模式，未启用真实账号严格拦截。

## 边界与接入

`WindowsNetworkFingerprintReader.read()` 返回 `{ available, hash }`：成功仅有 SHA-256 指纹，失败固定为 `{ available: false, hash: null }`。接口名称、地址、路由下一跳、DNS 地址和原始错误仅在主进程读取期间存在，不能进入 IPC、日志或持久化。`available` 仅表示本次 OS 配置读取成功，不能作为 DIRECT 或大陆出口证明。

`WindowsNetworkFingerprintWatcher({ onChange, reader?, pollMs?, debounceMs? })` 提供 `start()`、`stop()`、`getSnapshot()`：

- `start()` 立即投影不可用；至少两次一致读取且超过去抖时间后，才投影稳定指纹。
- 已发布指纹变化或读取失败时，在收到结果的同一轮同步调用 `onChange({ available: false, hash: null })`。去抖只用于恢复，不能延迟撤销。
- 恢复时发布新的稳定指纹；持续相同的结果不重复发布。
- `stop()` 清除定时器、撤销可用状态；旧读取完成不能发布结果。停止后重新启动，也不会与尚未退出的旧读取重叠。

主进程已订阅 `onChange`：任何状态转换均撤销当前 generation、废弃旧许可，并使观察器重新采样；严格分支同时闭闩和清理在途任务。Runtime 的独立 `networkReadiness` 在不可用的整个期间拒绝业务检查和旧 lease 提交，且不接受仅凭控制器可读恢复环境。严格模式未配置该检查也默认拒绝。稳定后仍须重新运行匿名证据流程；后续生产签发器还需把稳定 hash 纳入路径证据。**新指纹只允许重新取证，不能自动允许国内业务。** 内核配置/规则版本变化仍由原有 observer 负责，二者不能互相替代。网络轴保持内存态，重启仍从 checking 开始。

## 读取内容与开销

固定使用 Windows 自带 PowerShell 的只读 `Get-NetRoute -PolicyStore ActiveStore`、`Get-NetIPInterface -PolicyStore ActiveStore`、`Get-DnsClientServerAddress`。不接受用户命令或追加参数；`execFile` 禁用 shell，隐藏窗口，5 秒超时，每个捕获流最多 256 KiB。返回非零、超时、输出超限、缺字段或 JSON 不合格均不可用，原始标准错误不会外传。

哈希覆盖：

- ActiveStore 中全部 IPv4 / IPv6 路由，包括默认、具体 host 和子网路由：接口索引、目标、下一跳、metric、协议与状态。不能只读默认路由，否则新加一条目标 `/32` 或 `/128` 路由就可能绕过指纹失效。
- IP 接口：索引、地址族、名称、连接状态、DHCP、forwarding、自动 metric、metric、MTU。
- DNS：接口索引、地址族、按优先顺序排列的服务器地址。
- `os.networkInterfaces()` 的接口名称、地址族、本机地址、netmask、internal、IPv6 scope id。

路由目标必须是有效 IP 加合法前缀长度（IPv4 为 0–32，IPv6 为 0–128），与条目的地址族一致；带 zone、异常格式或跨地址族目标均使整次读取不可用。路由条目最多 1,024 条；超出条目数或 256 KiB 输出上限均失败关闭，不截断后签发指纹。

对条目排序后取摘要，保留单条 DNS 服务器列表的优先顺序。排除剩余租期、计数器、时间戳等会自行变化的字段。读取 PowerShell 前后各采样一次本机地址；若地址在此期间改变，整次结果不可用。

默认采样间隔为一次读取**完成后** 5 秒，恢复去抖 1 秒且至少两次一致采样。读取器和观察器都不重叠发起读取。数值仍是待阶段 2 开销实测冻结的默认值，改变数值不能改变先撤销、后重新取证的模型。

## 验证结果

2026-09-07 将覆盖范围扩大为完整 ActiveStore 后，进行了新版本的一次 Windows 实机只读采样，运行当前生产模块的内存 esbuild bundle；未生成临时可执行文件或配置文件，输出仅为：

```json
{"available":true,"hash":"306428bfbe068dcda645430de5215ba189e19fdd6fd82307932f99d49fe7977a"}
```

包括 Node 启动及内存编译的命令总耗时约 1.3 秒；这不是持续负载或更改网络的实验。未改动用户网络，未发真实账号请求，未重试之前被拒绝的目录清理。

验证通过：

- `npx vitest run src/main/network/windows-network-fingerprint.test.ts`：30 项。
- `npx tsc -p tsconfig.electron.json --noEmit`。
- 仅新增两个 TypeScript 文件的 ESLint 检查。

测试覆盖字段/行排序稳定性，默认路由、接口、DNS 优先级、本机地址变化，默认路由不变但具体 IPv4 / IPv6 host 或子网路由新增、修改、删除时哈希改变，IP/prefix 格式及地址族校验，读取期间地址改变，异常/超限/损坏数据不外传，固定隐藏命令的限制，并覆盖恢复去抖、失联撤销、单次成功不恢复、停止重启忽略旧结果和读取不重叠。

## 限制

这是**轮询式配置失效信号**，不是 OS 路由锁。外部配置更改到下一次采样完成之间仍存在窗口；三个 PowerShell 查询也不是原子快照。单次成功不证明配置在随后的业务发包瞬间仍未改变。

本模块读取 ActiveStore 全部路由和上述接口/DNS 配置，不覆盖 DNS 缓存、NRPT/DoH 全部策略、mihomo 规则、出口地理位置或进程链路身份。不能以此声称“所有网络变更必定实时发现”或“物理零包”。原有目标、传输上下文、generation、短有效期及请求级门闩继续有效。
