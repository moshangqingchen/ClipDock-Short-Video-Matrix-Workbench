# ProductionProofSource：当前规则只读预检

本机真实内核配置下，B 站 API 的域名规则可以解释为 DIRECT，但两个出口回显目标在更早的 IP-CIDR 规则处不可解释。**生产 `ProductionProofSource` 在调用路径输入、匿名 TLS 或出口探针之前返回 `RULE_UNVERIFIABLE`。** 本次没有签发许可。

最终源码冻结后复跑时间：**2026-09-07 19:12:36.791–19:12:36.927 UTC**，Electron 43.3.0 / Chromium 150.0.7871.212。14 个 bundle 输入源码在运行前后及收尾复核时均一致。`production-proof-source.ts` 哈希为 `762e9e95ece22a3c56c10b61582fb1e787e18348ccb37fb0ed6a9ecd8aecbddb`，`route-applicability.ts` 为 `d9aafa16da2dd840c0758f37b905aa0f808ee8ce425d2dce9d00b479b617c096`。

复跑脚本：[electron-production-source-preflight.mjs](../scripts/electron-production-source-preflight.mjs)。执行时间、Electron/Chromium 版本、完整断言和 bundle 输入源码哈希见 [结果 JSON](./network-production-source-preflight.results.json)。该脚本会核对运行起止源码哈希，任何变化使进程返回失败。

## 当前观察

| 项目 | 结果 |
|---|---|
| 内核 | `424c2ef`，`rule + TUN`。 |
| 控制状态 | 运行前、source 内真实读取、运行后的 fingerprint 均为 `5cc197058efc435fabbd518ff97564995e80b4af5a09f8961b989ce627db14ee`。 |
| 内建 DIRECT 元数据 | `kind:direct`、`dialer:none`；只记录这两个字段，没有把它们当出口证明。 |
| `api.bilibili.com:443` | `Domain → DIRECT`，下标 16。 |
| `myip.ipip.net:443` | 在下标 46 的 `IPCIDR` 规则处返回 unknown；未跳过该规则。 |
| `api6.ipify.org:443` | 同样在下标 46 的 `IPCIDR` 规则处返回 unknown。 |
| Source 结果 | `unavailable / RULE_UNVERIFIABLE`。 |
| Source 内依赖调用次数 | controller 1；inputs、conformance.read、bindSamples、TLS、egress 全部 **0**。 |

3 条断言：不返回 evidence；未进入匿名探针/路径适用性核对；当业务规则可解释而回显规则不可解释时，在路径输入之前拒绝。全部通过。脚本总共进行运行前、source 内、运行后三轮 `ClashReader.read()`，均为固定字面 loopback 控制器的只读批次。

## 隔离和测试替身

运行实际生产 `ProductionProofSource`、`ClashReader` 和有序规则解释器；控制地址固定为 `http://127.0.0.1:9790`，秘密 getter 固定返回空，不读取账号库或凭据库，不尝试其他控制器。

为越过目录前置核对，脚本只在隔离子进程创建 `bilibili / check-status / activePageOrigin:null` 的**测试专用 reviewed scope**，目标为 `api.bilibili.com:443` 的 IPv4 与 IPv6。其 account/context 字符串仅是 fixture 标识，没有创建账号或对应 Session。生产目录的 `flowReviewed` 仍为 false，未改正式审核记录、主进程 bootstrap、enforcement 或 mihomo 配置。

后续 inputs、conformance、TLS、egress 全部是有计数的拒绝式替身：若被调用只返回 unavailable/null，不能返回证明。没有实例化匿名探针、账号会话或许可签发器；没有公开站点 HTTP 请求、Cookie、Token 或真实业务探测。Electron 使用一次性的 `userData/sessionData`，不创建窗口，Chromium 主机解析全部拒绝。控制器本身使用生产 `ClashReader` 的 Node loopback HTTP 边界。

若后续真实配置变化使回显规则可解释，复跑结果会如实显示进入 inputs 替身后停止，而不会假称已进入或完成真实路径、TLS、出口取证。

## 结论边界

该结果验证的是**当前真实规则的生产前置拒绝行为**。回显目标必须和业务目标一起通过规则核对，业务 host 的 DIRECT 不能替代回显 host 的资格。

`IPCIDR` unknown 表示当前解释器缺少适用于这次规则上下文的证据，不能据此断言目标实际走代理或实际无法直连。控制器 fingerprint 稳定也不是原子配置锁、DNS 最终解析、实际进程/Socket 归因或大陆出口证明。本次没有修改规则来让预检变绿。
