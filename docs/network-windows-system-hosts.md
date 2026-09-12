# 系统 hosts：精确目标只读输入

`WindowsSystemHostsReader` 已实现。生产默认仅读取 `SystemRoot\System32\drivers\etc\hosts`，不搜索其它配置，不读取 DNS，不创建 Session，也不修改文件。`SystemRoot` 必须是有效本机 Windows 绝对路径；UNC、设备路径、ADS、歧义目录、符号链接或 canonical 路径变化均拒绝。显式测试路径的结果标为 `explicit-test-hosts-file`，不能冒充生产系统文件。

```ts
const reader = new WindowsSystemHostsReader();
const observation = await reader.read(["api.bilibili.com", "myip.ipip.net", "api6.ipify.org"], signal);
reader.dispose();
await reader.whenIdle();
```

成功类型为 `WindowsSystemHostsObservation`；包含固定 source、目标 scopeHash、原始文件 fileHash、文件身份摘要、真实单调起止时间，以及每个精确目标的 IPv4/IPv6 数组。结果不含整个文件、无关别名、注释或路径。没有 hosts 的 DNS TTL，读取器不虚构期限；同轮输入可继续使用既有上限。

scopeHash 是规范化、去重、排序后的目标数组 JSON 的 SHA-256。fileHash 是原始字节摘要；fileIdentity 绑定 canonical 路径及实际 dev/ino/size/mtimeNs/ctimeNs，只返回散列。两次独立文件读取的字节及身份必须一致，每次读取内也核对打开前、文件句柄与读取后的身份。

解析器支持 UTF-8/ASCII、可选 UTF-8 BOM、空格/制表符、换行、`#` 注释、每行一个 IP 和多个 ASCII 别名。域名大小写与单个末尾点规范化，IPv6 地址按文本规范化；多个映射全部保留，不能挑选一个。目标输入可规范化为 IDN 的 ASCII 域名，但文件中的未审核 Unicode 别名仍拒绝。

最大 64 个原始目标、1 MiB 文件、32768 行、单行 8192 字节、每行 256 别名、每目标 128 地址。未知语法、坏编码、超限、缺文件、不可读或变化返回 unavailable；即使异常行与目标无关也不猜目标缺席。只有完整文件在支持语法内，空数组才代表这个文件没有该精确目标的条目。

取消/超时立即返回不可用；原始文件操作仍占有当前实例的槽位，`whenIdle()` 等待真实工作和公开结果都结束。相同目标范围合并，不同范围 busy；dispose 后不再读取。该行为有延迟文件操作回归，不靠固定睡眠释放槽位。

## 本机只读结果

2026-09-08 北京时间 05:56:15.999（UTC 2026-09-07 21:56:15.999），Node 24.15.0 / Windows，以当前源码内存 bundle 调用默认读取器，**11 项断言通过**。只读打开实际系统 hosts 两次，耗时约 6.2ms；HTTP、HTTPS、TCP、DNS 与 fetch 入口被禁止并计数，网络尝试为 0。

| 精确目标 | 当前系统文件 IPv4 条目 | IPv6 条目 |
|---|---:|---:|
| api.bilibili.com | 0 | 0 |
| myip.ipip.net | 0 | 0 |
| api6.ipify.org | 0 | 0 |

两遍文件字节和身份一致；dispose/whenIdle 完成，之后读取被拒绝。当前源码摘要 `7683ff6b78a90f5024042641feb8d4d450119e4072a732e25be4928a09fc32e9` 在结束时未变化。详细脱敏结果见 [JSON](./network-windows-system-hosts-live.results.json)，不保存实际文件内容。

这补上了“当前系统 hosts 文件对这三个目标没有覆盖”的事实，**不证明 Windows、Chromium 或 mihomo 实际使用这个文件**，不填 `use-system-hosts` 的缺省值，不把 DNS 答案变成规则入口 DstIP，也未生成通路资格或许可。新一轮仍须重新核对当前文件。

41 项单元测试通过，覆盖正反向解析、双族、多别名、目标规范化、未知语法、文件变化、路径/资源边界及真实工作取消后 drain。仅修改新读取器及其测试；同轮生产接线由独立变更完成。
