# 当前 rule-entry DstIP 的有限核查

结论：当前已选配置可以提供规则参数和匹配前处理的政策事实，不能单凭 fake-IP 开启就签发 `destination.stage = unresolved`。本轮没有改生产模块、配置或审核标志，也没有平台/出口 HTTP、`/dns/query` 或账号请求。

## 本轮当前事实

运行 `node scripts/electron-rule-destination-policy-snapshot.mjs`，2026-09-07 21:02:51 UTC，隔离 Electron 43.3.0。真实 `SelectedClientConfig` 选择及候选读取成功，随后使用同一生产数据 decoder 在内存中提取允许字段；密文摘要和四项政策摘要均与该候选一致。一次 ClashReader 读取/四个本机 GET，15 项检查通过，所有构建源摘要结束时一致。报告不含 decoder 值、完整 YAML、代理名称或 DNS 上游 URL。

控制器仍为内核 `424c2ef`、rule + TUN、3341 条规则；fingerprint 为 `5cc197058efc435fabbd518ff97564995e80b4af5a09f8961b989ce627db14ee`。政策摘要为 `2da73a204d11a649bf8295f1892e3047c82b424c66b576f5e665aa7656ffb2b9`。

| 项目 | 当前源事实 | 可得结论的限度 |
| --- | --- | --- |
| hosts | 1 项；三个目标没有本脚本识别的简单域名匹配 | 没有审核内核完整 matcher、系统 hosts 和运行期映射，不能把脚本的空匹配数组当“所有来源均无覆盖” |
| DNS | enable/use-hosts/respect-rules=true；ipv6=false；fake-ip；范围198.18.0.0/16 | 不能证明具体 Chromium 请求使用了当前内核的 fake-IP 答案 |
| DNS 省略项 | use-system-hosts、fake-ip-filter-mode 缺失 | 保留缺失事实；未把上游默认值写成当前二进制的实测值 |
| fake-IP filter | 15项；三个目标无本脚本的简单模式匹配 | 这是结构核查；未批准任意 pattern/默认 mode 的完整解释器 |
| DNS 上游 | nameserver 5项、nameserver-policy 15项、fallback 4项、default-nameserver 2项 | 未披露地址；存在多路径，不能拿一次内核 DNS query 替代实际传输解析行为 |
| sniffer | enable/force-dns-mapping/override-destination/parse-pure-ip 均true | 开启不等于每条连接嗅探成功 |
| TLS sniffer | 443/8443；该协议的 override-destination=true | 成功和失败/跳过分支必须都处理 |
| sniffer 范围 | force-domain 缺失；skip-domain 2项，其中1项不属于本脚本简单域名语法；skip-src/dst-address 缺失 | 不能凭无简单匹配保证不跳过 |
| TUN | gVisor、auto-route/auto-detect-interface=true；DNS hijack列表1项；strict-route缺失 | TUN 不等于固定解析来源或固定rule-entry DstIP |

索引为从0开始：

- `api.bilibili.com` 在 DOMAIN index16 已为 DIRECT，之前没有 IP 规则。该目标本身不需要为这些前置 IP 规则建立 DstIP 阶段。
- `myip.ipip.net` 没有独立 DOMAIN；第一个匹配域名的规则是 DOMAIN-SUFFIX index2971、DIRECT。之前有 **148条 IP-CIDR，全部带 no-resolve，其中21条DIRECT、127条非DIRECT**，另有3条 PROCESS-NAME。最初12条是 index46–57、DIRECT，但不代表后续前缀也都DIRECT。
- `api6.ipify.org` 没有匹配域名规则，不能因此推定它落入DIRECT；本轮没有扩大IPv6范围或改换出口端点。

这修正了“只需通过最前面12条”的过窄描述。报告只列这12条、后续汇总和首条非DIRECT反例；此前较宽的只读样本保留为带时间后缀的历史文件，不作为资格输入。

## 官方语义与本机证据分开

本轮重新读取的官方固定提交为 `ac017cdd246ce8bd547653d927e7bf77d7ee73d5`，读取日期为2026-09-08（UTC+8）。它用于解释冻结观察模型，**未证明本机 `424c2ef` 二进制与这个提交一致**。

TCP 先做 `fixMetadata`、`preHandleMetadata`，再嗅探，然后 `resolveMetadata` 与有序匹配。确认存在的 fake-IP 映射会清除 DstIP；缺失映射可能中止，或由嗅探补救。进入规则前的 hosts IP 记录还可再次填入地址。[官方 tunnel](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/tunnel/tunnel.go)

TLS 嗅探成功且允许覆盖时清除 DstIP；不适用、失败、skip-domain 或失败缓存分支不能一概当成功。`DNSMode=normal` 本身不区分这些入口状态。[官方 sniffer](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/component/sniffer/dispatcher.go)

no-resolve 只阻止该 IP 规则主动解析；如果已有有效 DstIP，仍然按 CIDR 匹配。因此它不是“永远跳过该规则”的标记。[官方 IPCIDR](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/rules/common/ipcidr.go)

所查上游默认 use-system-hosts=true、fake-IP filter blacklist，但这两个当前配置缺项不能直接变成本机已验收政策。可以后续按声明的受支持内核模型审核默认规则，或读取目标相关系统 hosts 来覆盖开关两种分支。[官方默认配置](https://github.com/MetaCubeX/mihomo/blob/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/config/config.go)

## 可执行的有限范围

第一版只做 Bili 无视图 check-status 所需的 HTTPS/TCP 工厂与其 IPv4 echo；范围不扩大到全平台、上传、网页或IPv6。新增主进程“进入规则时的可能状态集合”生产者即可，不需要再次扩大总方案：

```ts
type RuleEntryCoverage = {
  source: "current-rule-entry-destinations";
  target: ProofTarget;
  contextId: string;
  transportProfileId: string;
  generation: number;
  rulesVersion: string;
  kernelEpoch: string;
  effectivePathPolicyVersion: string;
  hostAtMatch: string;
  possibleDestinations: readonly RuleDestination[];
  sourceEvidenceIds: readonly string[];
  expiresAtMono: number;
};
```

这是建议接口，本轮没有增加可被任意调用者置真的 flag。生产者须依赖当前配置关联，以及对当前传输仍适用的受控路径记录；其集合必须覆盖全部可能分支。

| 已有实际前提 | 匹配前还需覆盖 | 允许输出 |
| --- | --- | --- |
| 当前工厂请求确定以该目标的有效 fake-IP 映射进入；完整目标hosts核对无覆盖；Host/SNI保持目标 | 嗅探跳过/失败保留已清空地址；成功仍清空 | 可以在这些前提全部成立后输出 `{unresolved}`，不能只从DNS模式推出 |
| 已证实当前真实地址集合进入；Host/SNI保持目标；完整hosts核对无覆盖 | 嗅探成功清空；失败/跳过保留该地址 | `{unresolved, resolved(ip1), …}`；每个地址都需规则匹配 |
| hosts可给多个IP，或域名别名 | 再次hosts填充、所有地址与别名之后的规则 | 必须完整展开；首期不支持的别名/语法返回未知 |
| 入口解析来源、缓存、fake-IP映射、sniffer重写目标等任一不明 | 存在未封闭分支 | 保留unknown，拒绝，不能拿`/dns/query`填空 |

随后将当前配置 `ruleParameters`、**当前真实进程归属**和每个可能 DstIP 送入现有 `evaluateRules`。只有所有分支都产生已核对的 builtin DIRECT 才可继续；单个 unknown/非DIRECT即拒绝。若分支命中不同索引，当前单一 `ruleIndex` 证据不能随便选一条，需保留分支集合或先限制到共同索引的范围。

当前代码的最小接入顺序是：控制器 mode/版本/builtin元数据 → 只读 PathInputReader 和当前配置关联 → 目标政策与阶段集合 → 全分支有序规则 → conformance与匿名TLS/出口采样。`ProductionProofSource` 现在在读取inputs之前就要求所有目标的无上下文规则可解释；这道检查需要拆为上述前后两部分，仍禁止在规则未通过前发匿名HTTP或账号请求。`PathConformance`、`route-applicability`、`createLiveRuleEvidence` 也须消费同一阶段依据，不能在后段重新用缺省unknown或另一个未经绑定的解释结果。

## 当前仍缺什么

1. main-only `EffectiveSourcePolicy` 现在主要保存摘要与少量开关；需要目标相关的 hosts/fake-filter/sniffer 范围投影，并绑定同一源摘要、kernel epoch和真实观察时间。本文脚本投影仅为候选，尚无生产解释器。
2. 现有传输资料说明可能路径，但旧报告、单个 remoteDestination、`dnsMode=normal` 或一次 DNS answer 不能证明下一条请求的rule-entry阶段。还缺当前工厂DNS/缓存与内核入口关系的完整适用条件，以及sniffer失败/跳过的反例覆盖。
3. myip 在unresolved分支仍会遇到 PROCESS-NAME index2063；需已有受控进程归属证据，不能凭主进程名称或另一诊断进程替代。
4. 核对系统hosts和缺省政策，或明确把受支持范围收窄到无需猜测这些字段的当前路径条件。没有必要把所有六平台所有host同一期核完。

当前规则在**合成条件**下的反例已由真实生产 `evaluateRules` 本地执行，未发网络包：unknown→index46拒绝；unresolved但缺进程→index2063拒绝；unresolved且给定合成不匹配进程→index2971 DIRECT；resolved为`101.227.200.11`→index1435非DIRECT。它说明为什么未知分支不能删除，绝不是宣称这个反例地址为myip实际解析结果。

机器结果：`network-rule-destination-policy-live.results.json`。当前 `ruleEntryStageProven=false`、`permissionIssued=false` 保持不变。

05:20 实现补记：上文调查时列出的跨层接线已经通过 `CurrentRuleContextSet` 完成，详见 [同轮规则上下文](./network-rule-destination-context.md)。全部分支索引、源参数、TCP 限定和最短期限可贯穿最终证据；主进程实际阶段生产者仍未完成。本补记不改变该次只读调查的原始事实或将未知阶段提升为已证明。
