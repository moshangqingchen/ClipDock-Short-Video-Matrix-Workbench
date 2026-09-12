# 当前内核 DIRECT 地址族的本机对照

2026-09-08 北京时间 08:47:37–08:47:48，完成同一精确内核文件的 **3 份独立合成配置 × 5 种输入**。7 项实验有效性检查全部通过。当前构建的内置 DIRECT 配合全局 `ipv6: false` 时，四种 IPv6 输入均未与受控接收端建立 TCP；开启全局 IPv6 后，四种输入均实际到达 IPv6 接收端。独立命名 `type: direct, ip-version: ipv4` 在全局 IPv6 开启时也未建立这些 IPv6 连接。

这补充的是**经过本机 SOCKS 入站、配置指向 DIRECT 的内核 TCP 通路行为**。没有定位拒绝必定发生在 `Direct.DialContext` 内部，也可能发生在入站或 metadata 处理；不是 Chromium/TUN 全路径单族资格，没有设置 `familyConstraint` 或签发许可。

- [独立结果 JSON](network-mihomo-direct-family-compatibility.20260908T004737769Z.results.json)
- [可复跑脚本](../scripts/mihomo-direct-family-compatibility.mjs)
- [前序 DNS fake-IP 池实验](network-mihomo-ipv6-fake-pool-compatibility.md)

## 固定对象与隔离

使用已有猫猫云客户端资源中的 `mihomo-windows-386.exe`，CLI/三个独立控制器均报告 `424c2ef`，CLI 为 Go 1.20.14、`with_gvisor`。文件 SHA-256 前后均为：

`d354a6b31e89db289a46fffd8913c2da4ee1e2218882d75cacc49c41b425dde9`

本轮脚本 SHA-256 为 `80a53bec8d33ef1d30b0254cd9c6c7b3af82289618bc11687797012cc738790d`。没有复制或读取正在使用的配置；从零创建三份配置，独立 `-d/-f` 并分别通过 `-t`。没有连接真实控制器、账号、订阅、真实平台或公网回显服务。

所有客户端连接和 DNS 答案只使用 `127.0.0.1`、`::1`。合成域为脚本固定的 `.clipdock.test` 名称。规则仅把这些精确域和 loopback CIDR 指向被测 DIRECT，其他目的地 `REJECT`。TUN、sniffer、进程规则、NTP、provider、隧道、自动地理库更新均关闭；DNS 来源全部指向本机合成 UDP/TCP 服务，地理库/UI 下载地址全部指向本机拒绝端。未知 DNS 或下载请求将中止实验。

三个配置的 `dns.ipv6` 都显式为 `true`，保持该变量相同以比较**全局开关**；`enhanced-mode: fake-ip`、`use-hosts: true`、`use-system-hosts: false`。SOCKS DOMAIN 直接交给内核处理，没有先调用 DNS 监听器。这不是用户当前 DNS 配置的完整克隆，也没有验证 DNS 监听器到 Chromium 的路径。

| 配置       | 全局 IPv6 | 出站                             | 本机 SOCKS | 独立控制器 | DNS 监听 |
| ---------- | --------- | -------------------------------- | ---------- | ---------- | -------- |
| builtin-g0 | false     | 内置 DIRECT                      | 49379      | 49378      | 49377    |
| builtin-g1 | true      | 内置 DIRECT                      | 56836      | 56835      | 56834    |
| named4-g1  | true      | `type: direct, ip-version: ipv4` | 56852      | 56851      | 56850    |

所有上述监听均绑定 `127.0.0.1`。命名 direct 未指定接口，仅检验显式地址族字段，**不是备用方案 B 的接口绑定验收或上线**。

## 接收端、阳性控制与实际结果

先在 `[::1]:49372` 成功监听并直接连接，接收端读取本轮合成随机标记、返回匹配响应，实际地址族为 IPv6。IPv4 接收端为 `127.0.0.1:49374`。同一个 IPv6 接收端端口上的 `127.0.0.1:49372` 在正式分支前经真实连接确认 `ECONNREFUSED`，用作双栈故障控制。

每个分支只做一次 SOCKS5 CONNECT；DOMAIN 与显式 IPv6 literal 分开记录。成功必须在接收端收到匹配标记并由客户端收到匹配响应；仅 SOCKS 回复成功不算连接成功。

| 输入分支          | 合成来源与目的端口               | 内置 DIRECT / global=false | 内置 DIRECT / global=true | named ipv4 / global=true |
| ----------------- | -------------------------------- | -------------------------- | ------------------------- | ------------------------ |
| IPv4 控制         | DNS A=127.0.0.1，AAAA 空；49374  | 实际 IPv4，1 次到达        | 实际 IPv4，1 次到达       | 实际 IPv4，1 次到达      |
| IPv6-only 域名    | DNS A 空，AAAA=::1；49372        | 0 到达，随后关闭           | 实际 IPv6，1 次到达       | 0 到达，随后关闭         |
| 双栈、IPv4 故障   | DNS A=127.0.0.1、AAAA=::1；49372 | 0 到达，约 5 秒后关闭      | 实际 IPv6，1 次到达       | 0 到达，约 5 秒后关闭    |
| hosts 给 IPv6     | 内核 hosts 精确映射 ::1；49372   | 0 到达，连接重置           | 实际 IPv6，1 次到达       | 0 到达，随后关闭         |
| 显式 IPv6 literal | SOCKS ATYP=IPv6、::1；49372      | 0 到达，随后关闭           | 实际 IPv6，1 次到达       | 0 到达，随后关闭         |

本轮 **15 条 SOCKS reply 均为 0**，包括后续没有成功连接的 8 个分支。故结果依据受控接收端和数据往返，不能用 SOCKS reply=0 代替目标可达。

DNS 实际读数与配置差异相符：`builtin-g0` 的三个域名分支各查询 A 一次；`builtin-g1` 各查询 A 和 AAAA；`named4-g1` 各查询 A 一次。hosts 和 literal 分支没有上游查询。合计 12 次 UDP DNS、0 次 TCP DNS，所有答案均在 JSON 中保留；未出现未知请求。接收端总计 8 次到达，其中 1 次为前置 IPv6 能力控制，7 次来自内核测试连接（IPv4 3 次、IPv6 4 次）。

双栈故障分支的 IPv4 端口确实拒绝连接，但内核经过约 5 秒才结束；报告不把它改写为立即拒绝，也没有延长超时直到成功。未抓取 SYN/数据包，“0 到达”仅表示受控 TCP 接收端未接受连接，不是物理零包保证。

## 对方案 A/B 的影响

- A 获得了此前缺少的窄事实：该构建在本轮输入与配置下，全局禁 IPv6 不仅让 DNS 监听器 AAAA 为空，其内核 DIRECT TCP 通路也没有在 IPv4 失败时连接受控 IPv6 端点，包括 hosts 和 literal 分支。开启开关的四个阳性结果排除了“测试机 IPv6 本就不可用”的解释。
- 这不能覆盖不进入内核的 Chromium IPv6。既有强制 AAAA 实验出现过未归属 mihomo 的实际 IPv6；本轮没有 Chromium、TUN 入站或真实接口，因此不推翻该反例。把结果用于 B 站有限路径审核时，仍须与真实正常 DNS fake→real 来源、受支持工厂、当前 hosts/DNS/规则及入口依赖组成适用论证。
- B 的 `ip-version: ipv4` 在该精确文件上的受控行为已有对照，且不依赖全局禁 IPv6。它仍只涵盖本轮内核入口；需要的命名出站、实际接口与域名规则尚未写入用户配置，本报告不代表用户已授权或部署 B。
- 这是保留的有限兼容观察，可供主进程审核引用。它不是当前读数，不能把 JSON 载入恢复品牌对象、填 `possibleAddressFamilies: ["ipv4"]` 或生成 Gate 许可，也不需要据此新增每目标每轮 socket 的要求。

## 完成与清理

15 分支均有终态，7/7 有效性检查通过，脚本退出码 0。1 个 CLI、3 个配置检查、3 个运行内核共 **7 个直接启动的进程均已结束**；运行内核由自己的进程句柄终止，未使用全局 PID 扫描或终止其他进程。残余自有 PID 列表为空，全部自有 socket/服务器关闭，无清理错误。校验临时目录真实路径位于本次指定父目录、无符号链接、且自有进程/socket 已结束后，已删除唯一新建临时目录。

下载拒绝端请求 0，未知 DNS 0，未修改用户配置、系统 DNS/代理、路由或 TUN，未发送公网测试请求。结果保存独立时间戳文件，不覆盖前序报告。脚本已通过 `node --check` 与 Prettier 检查；没有改动生产 core、审核哈希或账号资格。
