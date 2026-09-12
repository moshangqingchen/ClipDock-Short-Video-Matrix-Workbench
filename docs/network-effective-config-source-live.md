# 新配置来源模块：当前真实配置只读验收

采样为 2026-09-07T17:05:56.912Z 至 17:05:58.335Z（北京时间 2026-09-08 01:05）。[脱敏结果](./network-effective-config-source-live.results.json)由本次运行直接产生，未复用历史报告作为输入。

本次脚本在内存编译当前生产 `EffectiveConfigSource`、`ClashReader` 和 `evaluateRules`，以既有、明确选择的客户端解码器读取当前加密文件。来源模块启动状态为 `checking`，本轮实际返回 **`candidate`**。没有修改配置、重载内核、写入解密配置或密钥，也没有公网、账号或带登录凭据的请求；控制器只读请求均为固定 loopback 地址。

| 本轮检查 | 实际结果 |
|---|---|
| 文件读前/读后密文字节稳定 | true |
| 控制器前/中/后可见摘要一致 | true |
| 模式、TUN、mixed 端口 | rule、true、10090 |
| 源文件与运行规则完整有序核对 | 3341 条全部一致 |
| 共同显式配置字段 | 20 个 JSON Pointer 路径，覆盖 11 个顶层字段 |
| 初始 30 个候选 host 的规则决策 | 30 DIRECT，0 unknown，0 proxy |
| 控制器采样处于文件检查窗内 | true |
| source 本轮读取耗时 | 约 34.6 ms |
| 候选 TTL | 约 15 秒；验收结束后实例已 dispose |

当前密文摘要为 `066c3bd42d095c7614d42396a603eb3f989d0b2f1d19b12e0fcde9f6125d3a58`。结果中的路径身份仅为路径字符串摘要，不是可执行文件或内容身份。

本次解析仍保留 `dns.use-system-hosts` 缺项，未补默认。DNS 为 fake-ip、dns.ipv6=false，top-level ipv6=false；DIRECT 实际元数据显示 kind=direct、dialer=none、接口字段显式为空，ip-version 缺项。这些是当前配置来源及可见策略的读数，不能据此单独断言实际 IPv6 不出网或已证明大陆出口。

30 个 host 是**初始候选/已核对规则 host**，不是审核完成的全部登录、验证码、CDN、采集和上传目录。本次 `candidateIsPermission=false`、`runtimeConfigurationProven=false`、`completeBusinessCatalogReviewed=false`；没有打开严格门闩或签发账号许可。候选还需按当前加载来源、内核/OS 代际、目标与传输上下文、匿名路径符合性组合使用，磁盘解析结果没有被称为内核完整生效配置。

一次性脚本位于 `docs/.compare/effective-config-source-live-read.mjs`。它引用已有内存解码协议助手，未改动合并脚本；报告只是本次验收记录，应用重启后仍须从 checking 开始重新读取。
