# 当前 mixed 端口的匿名 CONNECT 登记时序

2026-09-08 13:51:21–13:51:22 CST 单次执行，原始脱敏结果为 [时间戳 JSON](./global-proxy-context.20260908T055121301Z.results.json)。**这个目标在 TLS 开始前已可查到自己的唯一代理连接；本次没有发现必须调整生产 `authorizeTunnel` 与 TLS 顺序的依据。**

隔离 Electron 43.3.0 / Node 24.18.1，无窗口、账号或账号 Session。只读核对当前 `127.0.0.1:9790` 控制器后，经 `127.0.0.1:10090` 发一次 `oauth2.googleapis.com:443` CONNECT，再做一次默认 CA/主机名验证的匿名 TLS 握手。没有向平台发送 HTTP 请求、Cookie、Token 或客户端证书；没有切换系统代理/TUN、修改配置或关闭其他连接。

| 阶段                         | 原始单调时间（ms） | 本次源地址/端口 + 目标 + TCP 匹配      |
| ---------------------------- | ------------------ | -------------------------------------- |
| TCP 已建立、尚未发送 CONNECT | 275.3466–281.4530  | 0 条                                   |
| CONNECT 完成、尚未启动 TLS   | 283.1580–286.5404  | 唯一 1 条，`type=HTTPS`，`network=tcp` |
| TLS 握手后                   | 600.9462–603.4811  | 仍是同一条唯一记录                     |

CONNECT 完成时刻为 282.9198 ms；TLS 286.8826–600.4692 ms，约 314 ms，证书校验通过，TLS 1.3、ALPN `http/1.1`。两次已登记记录均显示 `electron.exe`、链长度 2、不含 `DIRECT`/`REJECT`，没有 sniffHost。记录 ID 摘要为 `d4c2e619eae46a6c3de6e7a631d6f5b9e0819fc249a6b253af0666c7a21d6b79`；本机源端口为 55109，四元组摘要为 `3cfd6fdc495ee79890e18a93ff197a5bc9228e1f9425aaad87bac6270dd23503`。完整地址和代理节点名称不入报告。

真实配置前后均为 `rule`、TUN 开启、内核版本 `424c2ef`、mixed 端口 10090；可见配置指纹前后一致：`7673abd51fa0cde637d55f27a481f62af933e155ff44e9c7e3f586037052fa05`。计数为 2 次生产控制器配置读取批次、3 次本机 `/connections` GET、1 次 CONNECT、1 次 TLS、0 次平台 HTTP；没有失败、重试或 watchdog 强退。

脚本使用自身创建的 Node socket 四元组和生产连接解析器确认归属，额外只投影自己记录的链标志与进程 basename；没有把原控制器连接列表落盘。自身 socket 均观察到 close，剩余 socket/request/window/WebContents 均为 0，临时目录已移除。生产 `ClashReader.read()` 批次的原生 HTTP close 不是该读器的可观测合同，JSON 如实保留 `controllerBatchNativeCloseObserved=false`。

范围仅为当前配置、这个目标和这次隔离 Electron 主进程 Node CONNECT/TLS。脚本没有调用带业务请求的 `ProxyTransport.request()`，没有核验海外出口地理位置或 API 权限，也没有签发许可。可据此继续实现生产的**当前精确连接**校验；不能缓存本结果替代下一次连接核对，不能推广为任意目标/配置都不需要 SNI。

执行前 `node --check`、默认 build-only 及 3 项本地归属/脱敏/链标志检查通过，零网络。执行后 9 个生产源文件摘要保持一致。

- 脚本 SHA-256：`85654027b3c6b0631a80edb588fc8ad9bdabc4f2abc2f2a70d556bbe4cfc2a19`
- 原 JSON SHA-256：`68d8b8040d687925fa840334e8618a575f0f2c7824d16e1bf7f291a1731a258c`

本轮未改生产模块，也未进行第二次探测。
