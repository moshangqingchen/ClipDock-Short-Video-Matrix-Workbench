# 阶段 2：有效配置来源的本机只读核对

采样：2026-09-07T16:28:16.121Z 至 2026-09-07T16:28:19.768Z（UTC）；耗时约 3645ms。脱敏结果见 [results.json](./network-stage2-effective-config-source.results.json)。本轮没有修改客户端配置、重载内核、改生产源码或发送账号请求。

## 结论

当前证据允许继续方案 A 的观察信任模型，不因 API 缺少 DNS/hosts 字段而永久阻塞。证据来源是“已知加载事件 + 当前来源文件与运行观察”，不是磁盘文件等同于运行态，更不是完整历史证明。目前仍不能开启 strict 或签发许可。

引用的加载事件见 [已授权规则合并记录](./network-stage2-live-rules.md)及 [当时脱敏结果](./network-stage2-rule-merge-result.json)：2026-09-07 14:09 UTC 分钟内，曾成功 PUT 指定加密 config 路径并验证运行规则与可见配置；精确 apply 时间和当时 kernel PID 未记录，后续只读复验为 2026-09-07T14:12:35.199Z。

## 本轮实际结果

| 检查 | 结果 |
|---|---|
| 活动密文与已加载来源报告一致 | true |
| 本轮前后密文字节一致 | true |
| 磁盘与运行规则逐项同序一致 | true，3341 条 |
| 磁盘/API 共有字段 | 11 个；差异 0 个 |
| 前后可见配置/规则/DIRECT/版本稳定 | true |
| 当前内核创建时间 | 2026-09-07T04:59:05.7234670Z |
| 当前创建早于已知加载分钟、本轮身份稳定 | true / true |

当前 controller owner 为 PID 43828。旧报告未保存当时 PID，创建早于事件只能支持连续性，不能证明它在整个历史区间一直绑定该控制器。CIM 的启动命令行/可执行路径当前可读性分别为 false / false；不因此新增“必须读取启动命令行”的支持门槛。客户端静态启动代码已见 spawn(core, ['-d', BIN_PATH])，这也不能代替实际加载事件。

## 必要路径配置及限定范围

范围仅为 30 个初始候选/已核对规则 host，加匿名回显 myip.ipip.net，共 31 个。**这些不是已审核完整业务目录**；登录、采集、上传等操作目录仍应分别审核。

磁盘 DNS 有 15 条 nameserver-policy，类型计数为 {"suffix":15}；对本次范围匹配 host 数为 0，未解释的 policy key 数为 0。hosts 有 1 条，对此范围匹配 0；未解释 key 数为 0。没有输出 resolver 地址、hosts 原文、代理节点、订阅或秘密。无 rule/proxy providers；显式 type:direct 出站数为 0。

已见 DNS enable=true、ipv6=false、enhanced-mode=fake-ip、use-hosts=true、respect-rules=true。use-system-hosts 缺失，结果用 present:false 保留，**没有补默认值**。sniffer 的 enable、force-dns-mapping、override-destination、parse-pure-ip 均实际为 true，应纳入有效路径判断，不能只核对 DOMAIN 规则。DIRECT API 的 type=Direct、interface 与 dialer-proxy 为空字符串已被实际读到；ip-version 缺项仍未知。

本轮也读取当前 OS hosts 的 hash、可解析条目数和本范围匹配数：available=true，stable=true；其实际是否被内核使用未证明。候选路径 hash 同时保留原配置缺项和 OS hosts 快照，待负向/路径符合性实验解释适用性；不能把该 hash 写成“内核必定使用此 hosts 文件”。

## 摘要及续证边界

所有摘要均在本轮从真实内存数据计算；完整参数只在内存解析，未写明文配置。

- 当前密文：066c3bd42d095c7614d42396a603eb3f989d0b2f1d19b12e0fcde9f6125d3a58
- 必要磁盘路径配置：33888c27e916fb6c05829281223989db2e7094ad023b565259e3bb88e11ef21e
- 可见控制器版本（含稳定 DIRECT 元数据）：70a963f007de4ce19c104778bc336ef2f21beb844f4bb271de6d8acf923fcc4f
- 稳定 DIRECT 元数据：2830662d07f3307e4fc7f12fc974d02449947e48668fca7a1949057b22409ed8
- 候选路径配置 + 当前 OS hosts：339738b7cc282f62cc03fe8ff81731dbdcb5a9e6fba6fe12571b46ffcdc98e3a

这些摘要发现被覆盖输入的变化，不证明隐藏运行配置绝不改变。DIRECT.id 本轮稳定，但没有证据说明它是 reload counter。官方接口支持从 path 或 payload 重载；所以 API 观察、来源文件、内核生命周期及实际路径符合性应共同使用，而不能只看文件 hash。[官方配置 API](https://wiki.metacubex.one/api/#configs)

生产 loader 每次启动必须 checking，建立新的当前轮次，重新验证来源、可见配置/规则/DIRECT、内核生命周期与 OS 代际。**不得从这份旧报告、旧密文 hash 或历史加载记录自动签发许可。** 任一改变、失联或符合性冲突先撤销 generation；稳定后也只是重新取证资格。

支持假设明确为：观察窗口内没有其它控制者实施未被检测到的隐藏配置热替换，当前物理链路属于受支持的大陆上网链路。已接受的外部改配置竞态仍存在；不要求证明隐藏配置永不变，也不宣称物理零包。

后续仍需当前匿名出口与地理证据、DIRECT 物理路由/接口/地址族适用性、IPv6-only/双栈/重试符合性、必要 TLS/SNI 与嗅探行为，以及相应操作目录审核。出口证据可以按有依据的同一直连通路类复用，不能把此范围的配置检查扩展成所有平台或所有资源许可。
