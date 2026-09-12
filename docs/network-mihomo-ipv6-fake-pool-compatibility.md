# 当前内核 IPv6 fake-IP 缺省的本机兼容核对

结论：当前已选客户端的同一内核文件，在本次 8 组合合成实验中符合“省略 `fake-ip-range6` 不生成 IPv6 fake-IP；显式配置池且 IPv6 开关允许时生成池内地址”的有限模型。可据此审核**该文件摘要对应构建**的缺省池兼容支持。它不是 Chromium 实际解析、业务地址族、DIRECT、出口地域或放行资格的验收。

原始结果：[JSON](network-mihomo-ipv6-fake-pool-compatibility.results.json)；可复跑脚本：[脚本](../scripts/mihomo-ipv6-fake-pool-compatibility.mjs)。上述 8 组合实验本身没有修改分类器、主入口、用户 mihomo 配置或系统网络设置；后续有限生产接线单独记录如下。

## 实验对象与隔离

- 使用已选猫猫云 5.5.6 资源中的同一 `mihomo-windows-386.exe`，不是下载的另一版本。控制器及 CLI 报告版本为 `424c2ef`。
- 文件 SHA-256 前后均为 `d354a6b31e89db289a46fffd8913c2da4ee1e2218882d75cacc49c41b425dde9`。先前只读构建信息为 `424c2ef12678a29eb6f69d21a0cf7e38f482645b`、`vcs.modified=true`；本实验补该构建的窄行为证据，不将它改称官方源码一致构建。
- 每组合使用全新独立 `-d/-f`，先执行 `-t` 通过再启动。子进程隐藏启动，仅终止自己的进程句柄；没有安装服务、改系统 DNS/代理或触碰正在运行的客户端控制器。
- TUN、所有代理监听、LAN、订阅/provider、NTP、地理库更新和外部 UI 均关闭；规则只有 `MATCH,REJECT`。DNS、控制器、本机合成上游及下载拒绝端均只绑定 `127.0.0.1` 随机高端口。
- 所有 nameserver/bootstrap/direct/proxy DNS 来源指向本机合成 UDP/TCP 服务；所有地理库/UI 下载地址显式指向本机拒绝端。发生下载需求或未知 DNS 问题会停止实验，不允许通过补充公网访问继续。
- 只查询脚本固定的 `.clipdock.test` 合成域。上游固定返回文档专用地址 `192.0.2.123`、`2001:db8::123`，不会连接这些地址。无账号分区、Cookie、Token、订阅或真实平台 API。
- 没有使用系统级抓包或修改防火墙；“零公网测试请求”描述配置、脚本和受控端点范围，不能扩写成已证明进程物理零外包。

## 8 组合的实际响应

普通域经过 fake-IP；排除域是 `fake-ip-filter` 中的一个确切合成域，继续走本机上游。“空”均为 `NOERROR`、无 AAAA answer，非超时。每组合额外查询普通域 A 和控制器 `/dns/query` 的独立合成域 AAAA。

| range6 | 全局 ipv6 | DNS ipv6 | 监听器普通域 AAAA | 监听器排除域 AAAA | 控制器 AAAA |
|---|---|---|---|---|---|
| 缺省 | true | true | 空 | 合成 `2001:db8::123` | 合成 `2001:db8::123` |
| 缺省 | true | false | 空 | 空 | 合成 `2001:db8::123` |
| 缺省 | false | true | 空 | 空 | 合成 `2001:db8::123` |
| 缺省 | false | false | 空 | 空 | 合成 `2001:db8::123` |
| 显式 ULA 池 | true | true | `fd66:1234:5678::4`，TTL 1 | 合成 `2001:db8::123` | 合成 `2001:db8::123` |
| 显式 ULA 池 | true | false | 空 | 空 | 合成 `2001:db8::123` |
| 显式 ULA 池 | false | true | 空 | 空 | 合成 `2001:db8::123` |
| 显式 ULA 池 | false | false | 空 | 空 | 合成 `2001:db8::123` |

显式池为 `fd66:1234:5678::1/64`。8 组合普通域 A 均返回 fake IPv4 `198.18.0.4`、TTL 1，证明 fake-IP 模式实际运行。合成真实答案 TTL 均为 30，没有改写 TTL 延长实验有效期。

阳性对照排除了“这个构建根本不支持 IPv6 fake-IP”或“实验环境所有 AAAA 都被挡住”的解释。未配置池时的普通域空回答、排除域真实回答，与显式池返回假地址共同支持缺省无 IPv6 fake 池这一有限兼容结论。

## 计数与清理

- 8/8 配置解析成功、8/8 响应组合完整；24 次监听器 DNS 请求，8 次控制器 DNS 查询。
- 控制器启动就绪尝试 16 次；合成上游收到 UDP 10 次、TCP 0 次，分别对应 8 次控制器查询和 2 次 IPv6 两开关开启时的排除域查询。
- 未知上游问题 0，下载拒绝端请求 0，实验主动公网请求 0。
- CLI 帮助/版本 2 个、配置检查 8 个、实际内核 8 个，共 18 个自己的子进程均结束；本机服务器已关闭，核验绝对路径后删除了本轮独立临时目录。
- JSON 保存了实际起止时间、各端点、合成配置、响应、子进程终态和脚本/内核摘要。没有原客户端配置正文或秘密。

## 可实现的最小支持及边界

允许将本结果作为代码审核依据，为这个受支持构建声明：当前有效策略明确为 fake-IP 且 `fake-ip-range6` **确实缺项**时，不虚构默认 CIDR，可按“该模型未启用 IPv6 fake 池”分类普通、非特殊 IPv6 为 `real` **候选**。字段为未知、非法、不能读取或内核兼容身份不匹配时仍为 `unknown`；ULA、链路本地、映射地址及其他现有特殊地址拒绝逻辑保持。

正式运行时仍须从当前选定来源、当前内核身份和当前配置取得匹配事实。此 JSON 是一次审核记录，不能直接加载它给当前会话签许可。其他内核或缺省配置模型不能自动继承。

本次没有账号/Chromium 业务流量，也没有 TUN 入站。全局或 DNS `ipv6=false` 仅在本实验中导致监听器 AAAA 空回答；控制器仍返回 AAAA，**不推出工作台仅走 IPv4**。原有目标/地址族、DNS 时效、实际解析路径、规则、路由及出口检查均不放宽。

## 已接入的当前兼容记录（2026-09-08）

生产代码将已核对的精确二进制摘要和版本写成 `KERNEL_COMPATIBILITY_PROFILE`，没有把本 JSON 当配置或许可加载。[SelectedClientConfig](./network-selected-client-config.md) 只读核对固定 `resources/extra/mihomo-windows-386.exe`，将文件/路径摘要纳入 artifact identity；当前控制器版本通过本轮实际 `readController` 取得。只有原来源读取前后的 artifact 一致、该 SHA-256 与 `424c2ef` 均精确匹配时，才通过 `createSelectedKernelCompatibility(...)` 生成 `KnownSelectedLoaderContract.kernelCompatibility`。

附件是主进程只读记录，绑定本次 selection、source generation、来源/解码/文件/政策/控制器身份，保留原控制器时间和候选过期时间；`hasCurrentMissingIpv6FakePoolCompatibility(...)` 每次重新核对当前输入与期限。复核不会刷新原日期或延长 TTL，旧 loader 引用也不会被改写为新附件。文件变化撤销旧来源；版本不符、记录缺失或到期时兼容分支不可用。最初缺失或未知二进制只使兼容保持未知，不阻断原有配置候选读取。

`classifyCurrentKernelDnsAddress(...)` 仅在 `fakeIpRange6.state === "missing"` 且上述记录有效时，允许现有特殊地址排除后普通 `2000::/3` 地址成为 `real` 候选。`null`、空串、类型非法和未知范围仍为 `unknown`，显式范围保留原有 CIDR 行为。该接线不证明实际业务用了 AAAA、不约束业务单族、不证明 DIRECT 或中国大陆出口，也不改变 `runtimeConfigurationProven: false` 或启用严格模式。

## 官方语义参考

官方 [2025-10-28 的 IPv6 fake-IP 支持提交](https://github.com/MetaCubeX/mihomo/commit/c8af92a01f9d4a4726d64810f474462715790782)以及已冻结的 [ac017cdd 配置实现](https://raw.githubusercontent.com/MetaCubeX/mihomo/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/config/config.go)均没有为 `FakeIPRange6` 设置非空默认值，仅合法显式前缀才建立 IPv6 池。[官方 DNS 文档](https://wiki.metacubex.one/config/dns/)中的 ULA CIDR 是示例，不是本项目自行填入的默认值。

[固定版本控制器实现](https://raw.githubusercontent.com/MetaCubeX/mihomo/ac017cdd246ce8bd547653d927e7bf77d7ee73d5/hub/route/dns.go)直接调用解析器，与 DNS 监听器处理链区分；本实验实测了这种差异。因实际构建带本地修改，上述源码只提供解释，最终兼容范围受本次固定文件、合成配置和实际观测限制。
