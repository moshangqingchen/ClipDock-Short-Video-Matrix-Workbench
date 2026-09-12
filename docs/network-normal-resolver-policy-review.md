# 当前普通解析政策的有限只读审核

**六个未支持条目均不匹配本轮三个目标，但这不等于整体 DNS 路径已获证明。** 当前投影未保留这些条目的可解释结构，统一返回 unknown 比这三个目标所需的负匹配更保守；过滤模式缺项、实际 Windows/Chromium 解析选择仍需另行保留边界。

本轮结果见 [脱敏 JSON](./network-normal-resolver-policy-review.results.json)。只读源取样为 **2026-09-08T01:11:47.954Z**，Windows DNS/路由库存为 **01:12:15.4639010Z**，IPv6 site-local 类别复核为 **01:12:32.8387888Z**，均为 UTC。

## 取样来源和边界

当前猫猫云 **5.5.6** 的 package/main 与受支持选择器档案吻合；复用当前显式解码器，仅在内存解析配置。加密配置 SHA-256 为 `066c3bd42d095c7614d42396a603eb3f989d0b2f1d19b12e0fcde9f6125d3a58`，读取前后原字节一致。未保存解密内容、密钥或原 DNS 地址。

**本轮没有读取 Controller、内核 owner 或内核二进制摘要，也没有建立新的运行配置关联。** JSON 相应字段为未采集，不从旧报告补入“当前版本”。下面的开关值属于本轮已选文件投影；不能单凭磁盘值宣称隐藏运行配置已一致。

## 六项负匹配

| 原条目 | 有限语义 | 对三个目标的结果 |
| --- | --- | --- |
| `+.stun.*.*` | 后缀结构内必须有 `stun` 标签 | 均不匹配 |
| `+.stun.*.*.*` | 后缀结构内必须有 `stun` 标签 | 均不匹配 |
| `+.stun.*.*.*.*` | 后缀结构内必须有 `stun` 标签 | 均不匹配 |
| `xbox.*.*.microsoft.com` | 固定 `microsoft.com` 后缀和 `xbox` 标签 | 均不匹配 |
| `*.*.xboxlive.com` | 固定 `xboxlive.com` 后缀 | 均不匹配 |
| `Mijia Cloud` | 无通配符的字面项 | 不等于任何目标 |

三个目标为 `api.bilibili.com`、`myip.ipip.net`、`api6.ipify.org`。现有投影保留的 fake-IP 过滤项共 10 个，对它们也均为零匹配；hosts 为完整、零匹配。

依据是官方整段标签语法：`*` 可处于中间但匹配一个标签，`+.` 表示包括根的多层后缀；不能把这些字符串当任意正则。固定源码的域名 trie 按标签比较，字面 `Mijia Cloud` 不会变成任意域匹配。[官方语法](https://wiki.metacubex.one/en/handbook/syntax/#domain-wildcards)、[固定官方 trie 源码](https://raw.githubusercontent.com/MetaCubeX/mihomo/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/component/trie/domain.go)。本轮未对当前内核二进制另做这些模式的实验，不把官方源码身份冒充安装文件身份。

这个结论只比较上述规范目标字符串；不证明未来任意 SNI、别名或重定向域也不匹配。skip-domain 是嗅探域政策，负匹配尤其不能被改写成“该流没有嗅探”。[官方 sniff 文档](https://wiki.metacubex.one/en/config/sniff/)

当前 `fake-ip-filter-mode` **缺项**，`force-domain` 也缺项，保留 missing，不补默认。即使补齐五条通配结构，当前 `querySourcePolicyTarget` 仍会因过滤模式未知返回 unknown。生产源码搜索还显示该查询函数目前没有定义文件之外的调用点：这是政策审核覆盖不足，不能声称已经定位一个因六项条目而直接闭锁的 Gate 分支。

## 当前 DNS 库存不能代表实际解析通路

固定只读 Windows 查询取得 10 个 connected IP 接口行，相关 DNS 库存如下。仅保留地址族、接口类别和地址类别，原地址未入报告。

| 接口 | 类别 | DNS 库存与本轮路由 |
| --- | --- | --- |
| 59 | 非物理、Up | 1 个 IPv4 DNS；路由仍为接口 59；metric 缺项，未补成 0 |
| 12 | 物理、Up | 1 个私网 IPv4 DNS；其路由为物理接口 12 |
| 12 | 物理、Up | 2 条相同 link-local IPv6 DNS 地址记录；其路由为物理接口 12 |
| 1、51、75 | 回环/非物理 | 各 3 个 site-local IPv6 DNS 条目；没有据此认定实际使用 |

源文件投影为 TUN 开启、auto-route 开启；只有一个 IPv4 通配目标 53 端口的 dns-hijack 条目，未显式指定传输协议。官方文档规定这种写法默认 UDP，且说明 Windows 对局域网 DNS 的自动劫持有边界；它不是 TCP、IPv6 或所有系统解析的覆盖证明。[官方 TUN 文档](https://wiki.metacubex.one/en/config/inbound/tun/)

本轮未观察 DNS 包、实际 Chromium resolver 选择，也未做 OS 库存前后稳态核对。物理 IPv4/IPv6 路径仍存在于库存，不能仅凭 TUN 开启认定所有解析都进入内核；同样不能仅凭库存认定已发生绕行。

## 最小下一步

1. 如继续实现，只补有限整标签通配及安全字面项的目标级比较，保留未知规则/provider/截断仍 unknown。无须修改用户网络规则，也无须扩展通用解释器。过滤模式缺项仍单独处理，不借“零匹配”偷偷补默认。
2. 复用已有正常匿名工厂的实际解析/请求映射能力，在当前来源、OS、系统 hosts 与工厂上下文内保留一次实际解析路径观察。应区分 Chromium 实际 fake 目的、对应自身 flow、同轮内核真实候选和原时间窗口；不拿独立 `resolveHost` 或旧 JSON 自动发新资格，不要求每目标每轮新 socket。
3. 六项负匹配可以进入有限政策审核材料；仍不能直接变成 resolver equivalence、业务单族、DIRECT 或大陆出口结论。

本轮业务/匿名公网探针、Controller 请求/DELETE、OS/mihomo 配置写入均为 **0**；只读取了官方技术文档。本次仅新增这份说明及脱敏结果，没有修改生产代码、启用严格模式或签发许可。
