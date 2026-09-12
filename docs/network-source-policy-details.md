# 配置来源的有限政策投影

`projectSourcePolicyDetails(raw)` 接收主进程已经解析的配置根对象，生成 `candidate.policy.details`。它补充现有摘要，保留核对目标路径所需的有限 DNS、hosts 和 sniffer 政策；不证明磁盘配置已在内核生效，不生成规则入口阶段、DIRECT 结论或许可。旧候选缺少 `details` 时不能补造它。

标量使用 `missing | unknown | known`：缺字段为 missing，类型或格式不支持为 unknown，仅明确合法值携带 value。`fakeIpRange` 与 `fakeIpRange6` 分别接受 IPv4、IPv6 CIDR，保留合法主机位；`fakeIpFilterMode` 仅识别 blacklist、whitelist、rule。**不补内核默认值。** 官方分别定义两个地址族的范围；rule 模式的过滤列表采用有序规则语法，当前投影不解释该语法。[DNS 配置](https://wiki.metacubex.one/en/config/dns/)

列表均带 `state / entries / complete / unsupportedCount / truncated`。普通列表与 hosts 最多保留 512 项，每项 hosts 地址最多 32 个，每协议端口最多 128 项；端口范围不展开。未知模式、上游 URL、秘密、未知协议和未知选项名称不保留。超限或无法解释的条目使 complete=false。缺列表与显式空列表分开；缺项不表示已确认内核没有对应行为。

域名子集为 exact、`+.`、`*.`：`+.` 包含根域及任意层子域，`*.` 只匹配一层。当前不解释前导点、中间通配符、geosite、rule-set 等其它形式。hosts 只保留合法 IP/地址数组或安全域名别名；不替调用方选择通配优先级，也不解析别名。[域名语法](https://wiki.metacubex.one/en/handbook/syntax/#domain-wildcards)、[hosts](https://wiki.metacubex.one/en/config/dns/hosts/)

sniffer 保留 force/skip-domain、skip-src/dst-address 的合法子集，以及 HTTP/TLS/QUIC 的端口范围和显式 override。协议级 override 缺失仍为 missing，不从全局值自动填充。列表的完整性只是本投影子集是否完整，不能代替各显式标量和实际路径事实的检查。[嗅探配置](https://wiki.metacubex.one/en/config/sniff/)

`querySourcePolicyTarget(details, host)` 返回 hosts、fake-IP 过滤、force/skip-domain 的匹配候选。任何未解释或缺失列表都返回 unknown，不能因为保留下来的条目未匹配就认定“不匹配”；即使有已保留匹配也同时保留不完整性。fake-IP 模式缺失、未知或 rule 时，查询也保持 unknown。结果只在主进程内存使用，不进入 IPC、备份或网络许可。

## 本次零网络只读核对

2026-09-07T21:59:19.440Z，隔离 Electron 43.3.0 使用当前支持的猫猫云客户端 ASAR/profile 选择与内存解码器读取本机配置，再调用本投影。脚本没有调用 `factory.read()`，HTTP/HTTPS/fetch/net 请求入口均被禁止。**没有本轮 Controller 运行态关联，没有生成 candidate 或许可。** 脱敏结果见 [实际摘要](./network-source-policy-details-live.results.json)，复验脚本为 `scripts/electron-source-policy-details-read.mjs`。

| 当前文件观察 | 结果 |
|---|---|
| IPv4 fake-IP 范围 | 显式 `198.18.0.0/16` |
| IPv6 fake-IP 范围、过滤模式 | 均缺失，未补默认 |
| fake-IP 过滤 | 保留 10 项，另 5 项不支持，列表不完整 |
| hosts | 保留 1 项，完整；三个固定目标均无匹配 |
| sniffer skip-domain | 保留 1 项，另 1 项不支持，列表不完整 |
| HTTP/TLS/QUIC | 各保留 2 个端口项；显式 override=true |
| 网络请求尝试 / Controller 读取 / 账号 Session 创建 | 0 / 0 / 0 |
| 当前配置字节、相关源码前后稳定 | 均通过 |

固定目标为 `api.bilibili.com`、`myip.ipip.net`、`api6.ipify.org`。三者 fake-IP 过滤及嗅探域名查询均保持 unknown；不能据此声称目标为 real-IP、绕过嗅探或 DIRECT。没有输出原 hosts、解析器地址、源配置或解码材料，也未修改 mihomo/OS 配置。

回归验证：政策模块 58 项；真实临时 YAML → EffectiveConfigSource candidate 共 41 项，覆盖明确投影、缺项、未知字符串不泄露，以及仅政策改变即撤回旧候选。原控制器秘密、代理密码、节点与解析器地址的禁止输出断言仍保留；合成 hosts IP 仅作为明确的主进程政策数据出现。
