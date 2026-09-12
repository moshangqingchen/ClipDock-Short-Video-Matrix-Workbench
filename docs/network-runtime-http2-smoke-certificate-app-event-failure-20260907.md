# 生产网络模块集成实测：HTTP/2

执行时间：2026-09-07T18:56:01.661Z。运行时：Electron 43.3.0 / Chromium 150.0.7871.212 / win32。

本脚本直接打包并加载当前生产 NetworkRuntime、EgressGate、Session 请求钩子、gatedSessionFetch、pageFetch 与 closeAccountView。入口：node scripts/electron-network-runtime-smoke.mjs --http2。

**只使用隔离 userData/sessionData、临时分区、本机 TLS 接收端和合成 Cookie。没有打开真实账号，没有访问公网，没有修改 mihomo 或系统证书存储。** 未配置 fixture 信任时先验证匿名探针拒绝自签证书。正向匿名测试仅在隔离 Electron 子进程通过 app certificate-error 对当前本机 /robots.txt 完整 URL、预期证书错误及本轮证书指纹做白名单，其余全部拒绝；业务与壳 fixture 仍仅使用各自 Session 的指纹 pin。没有 ignore-certificate-errors 等开关；正向 fixture 覆盖不代表公网默认信任已实测。

| 生产模块检查 | 结果 |
|---|---|
| anonymous TLS probe rejects an untrusted certificate | 通过 |
| untrusted anonymous probe has zero HTTP receiver arrivals | 通过 |
| anonymous probe observes a fresh pinned fixture response | 失败 |

受控接收端统计与模块源码哈希见 [结果](./network-runtime-http2-smoke.results.json)。初始化顺序：。

许可明确由测试依赖注入：临时域名映射到 127.0.0.1，模型的 DIRECT/CN 等证据是测试数据，不能当作真实出口证明。只把 warmup 间隔缩短至 50ms，使用 30s 许可和 60s 控制器时效供隔离测试；这些数值不是产品默认值的验收结论。

本次服务器仅接受 ALPN h2，接收端逐请求核对 HTTP/2；额外覆盖同一 H2 会话上的多路页面响应和合成流式上传。上传在撤销前后的接收字节数分别记录，不能把停止后已排队字节描述成零窗口。它不证明 QUIC、平台真实上传或 ServiceWorker 恢复兼容性。两种本地实验都不证明外部网络、平台登录完整性、打包版路由等价性或外部 TUN 改路由竞态。审计零记录也不能替代接收端零到达证据。

首次实验误将 readable end 事件当成完整上传，导致一项断言失败；[原始观察](./network-runtime-http2-initial-observation.results.json)已保留。现同时核对预定字节数、实际字节数、aborted、RST 和销毁后字节稳定性，未把第一次失败改写成通过。

本次失败阶段：anonymous-proof-probe:anonymous probe observes a fresh pinned fixture response。

本轮旧 fixture 的 Session pin 被生产探针恢复默认验证所覆盖，正向匿名检查失败；[失败记录](./network-runtime-http2-smoke-certificate-pin-failure-20260907.results.json)已独立保存。随后仅修正隔离测试的本机信任设置，生产证书验证没有放宽。
