# 同源规则参数与目的 IP 阶段：本轮实现边界

日期：2026-09-08。记录规则解释基础、配置候选字段与同轮上下文接线；没有修改 mihomo 配置、执行两条诊断规则补丁或启用生产许可。规则模块验证本身不发公开请求；本日另行执行的两次匿名出口请求见独立实测报告。

## 已实现

`EffectiveConfigSource` 在本来的文件前后核对、当前控制器全部有序规则比较中，保留 `ruleParameters`：每条规则的实际尾部参数数组，包含明确空数组、`no-resolve`、`src`、重复和未知参数。数组及行均冻结，原 `sourceRuleOptionsFingerprint` 继续覆盖整个参数数组。旧输入缺字段保持缺失，不能补成空数组。`KernelRule` 的 live 三字段及其指纹语义不变，候选仍为 `runtimeConfigurationProven: false`。

`evaluateRules(mode, rules, context, sourceParameters?)` 的第 4 参数为：

```ts
{
  rules: candidate.rules,
  parameters: candidate.ruleParameters,
  parametersFingerprint: candidate.sourceRuleOptionsFingerprint,
}
```

调用方须先取得当前同源配置关联，确认其来源、内核、文件、规则版本和短有效期适用于本轮。解释器再核整个规则序列的长度、顺序、规范化三字段，以及参数数组和已有哈希的一致性。哈希只能发现副本改写，不能独自证明文件已经加载；同时更改数组和哈希也不会凭空产生来源关联。没有关联时不能把任意磁盘文件的参数带进来。

`RuleContext.destination` 表示 **进入有序规则匹配时的 `metadata.DstIP`**，在 hosts、fake-IP 映射、sniffer 改写之后：

| 阶段 | 目的 CIDR 的处理 |
|---|---|
| `resolved`，带实际地址 | 无论是否 `no-resolve`，均按该地址与前缀匹配。IPv4/IPv6 分族；`IP-CIDR6` 与 `IP-CIDR` 是规则类型别名，不强制地址族。 |
| 明确 `unresolved`，且只有一个 `no-resolve` | 当前 CIDR 不触发解析、不匹配，继续下一条。 |
| 明确 `unresolved`，参数明确为空 | 此规则可能触发内核解析，本子集无法决定后续地址，返回 `unknown`。 |
| 阶段缺失/未知，参数缺失/失配，非法地址或前缀 | `unknown`，不跳过。 |

`src`、重复 `no-resolve`、未知修饰符仍不支持。具有区域标记的 IPv6 地址也保持不可解释；不会剥去一个未知 zone 后猜匹配。未知的前置 GEOIP/GEOSITE/RULE-SET 等规则仍停止解释，不另带地理数据库。已有 `processName`/`processPath` 上下文可继续使用；遇到相关规则才需要该真实输入。

这些语义依据 [mihomo 规则文档](https://wiki.metacubex.one/en/config/rules/)与其 [IPCIDR 实现](https://github.com/MetaCubeX/mihomo/blob/Meta/rules/common/ipcidr.go)。映射和 sniffer 可改变 DstIP，不能把 `/dns/query` 返回的地址直接称为该匹配阶段；参考 [tunnel 处理](https://github.com/MetaCubeX/mihomo/blob/Meta/tunnel/tunnel.go)与 [sniffer 处理](https://github.com/MetaCubeX/mihomo/blob/Meta/component/sniffer/dispatcher.go)。

## 同轮上下文接线

`CurrentRuleContext` 绑定实际目标、操作上下文、传输配置、同轮输入、原配置关联、generation、内核、匹配阶段分支和期限。`CurrentRuleContextSet` 在复制数据时保留原主进程关联对象，不能把 JSON 或 structuredClone 副本重新当作有效关联。实际 HTTPS/TCP 调用还必须与上下文的 TCP 类型相符。

各生产组合点共用同一个解释器；没有上下文集合的既有简单规则路径继续保持原有保守行为。一旦提供集合，缺失、重复、错配或不可用都拒绝，不再退到简单解释器。

| 调用点 | 当前行为 |
|---|---|
| `ProductionProofSource` 的前置规则检查 | 模式/版本/真实出站和明确的非 DIRECT 仍提前拒绝。依赖目的阶段的 unknown 可继续只读 PathInputs，随后取得已关联参数与上下文，必须在匿名 HTTP 前完成全部规则检查。样本绑定等待后重验原集合的所有传输配置。 |
| `PathConformanceAdapter.current` | `readRuleContexts` 接收本轮输入与原配置关联；业务目标同时检查账号、匿名 TLS 两种传输，回显目标检查出口工厂。显式返回 null 直接拒绝。此接口没有默认制造真实匹配阶段。 |
| `verifyRouteApplicability` | 目标和回显目标分别使用同轮集合及各自传输，核对相同真实 DIRECT 终点；上下文最短期限进入路径证据。 |
| `live-rule-evidence` 的最终复算 | 使用同一集合再算账号目标，保留所有分支的规则索引和实际策略。顶层单个索引只是兼容代表项。最终期限不能超过任何所用上下文。 |
| `NetworkObserver` 的观察结果 | 没有取得上述实际事实，继续保持不可验证；观察灯不借测试集合变绿。 |

匹配阶段可以来自已验收传输行为对当前配置和上下文的适用结论；本改动不要求每个目标每轮重采 socket，也没有增加新的身份资格体系。若实际可能出现多个目的地址/阶段，上层须覆盖全部可能分支，不能挑一条会命中 DIRECT 的 DNS 答案。

真实配置的最新只读核对见 [规则入口调查](./network-rule-entry-policy-audit.md)：myip 的域名 DIRECT 规则之前实际有 148 条 IP 规则，不只前 12 条。sniffer 成功与失败路径会留下不同目的状态，当前事实不能把所有分支缩成“尚未解析”。新的接线解决信息丢失，并没有替这项真实事实补值。

## 验证与实际限制

两文件定向回归 **104 项通过**（规则 66、配置来源 38），Electron TypeScript 与四文件 ESLint 通过。测试使用合成地址和临时合成配置，覆盖前缀边界、两族/映射地址、规则与参数失配、哈希失配、修饰符变化触发 SOURCE_CHANGED，以及文件参数传入真实解释器。

追加跨层回归先复现了五个失败：TLS/出口上下文短期限丢失、样本绑定等待期间这两类上下文到期仍签发，以及 TCP 请求接受 UDP 上下文。对应修复传递最短期限、在等待后检查原集合，并强制实际传输类型匹配。正向合成例保留了两个不同规则索引均为 DIRECT 的完整分支，而非只保留第一条。

按此前实际规则形状建立的合成回归显示：已知目的地址和进程分支均可解释时，`myip.ipip.net` 可以到达其既有 DOMAIN-SUFFIX DIRECT；`api6.ipify.org` 若进入匹配时已有 IPv6，会命中 `::/0,REJECT,no-resolve`；若地址明确尚未解析，则仍会在后续未支持的 GEOIP 处停止。**这不是今天 api6 的真实路径证明，也没有把它判成 DIRECT。**
