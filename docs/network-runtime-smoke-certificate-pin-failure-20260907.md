# 生产网络模块集成实测

执行时间：2026-09-07T18:52:43.924Z。运行时：Electron 43.3.0 / Chromium 150.0.7871.212 / win32。

本脚本直接打包并加载当前生产 NetworkRuntime、EgressGate、Session 请求钩子、gatedSessionFetch、pageFetch 与 closeAccountView。入口：node scripts/electron-network-runtime-smoke.mjs。

**只使用隔离 userData/sessionData、临时分区、本机 TLS 接收端和合成 Cookie。没有打开真实账号，没有访问公网，没有修改 mihomo 或系统证书存储。** TLS 证书仅由该测试 Session 按主机名及生成证书指纹匹配；没有全局忽略证书校验。

| 生产模块检查 | 结果 |
|---|---|
| anonymous TLS probe rejects an untrusted certificate | 通过 |
| untrusted anonymous probe has zero HTTP receiver arrivals | 通过 |
| anonymous probe observes a fresh pinned fixture response | 失败 |

受控接收端统计与模块源码哈希见 [结果](./network-runtime-smoke.results.json)。初始化顺序：。

许可明确由测试依赖注入：临时域名映射到 127.0.0.1，模型的 DIRECT/CN 等证据是测试数据，不能当作真实出口证明。只把 warmup 间隔缩短至 50ms，使用 30s 许可和 60s 控制器时效供隔离测试；这些数值不是产品默认值的验收结论。

本次覆盖 HTTPS 新请求、受控流式响应、主进程撤销与实际页面销毁。它不证明 HTTP/2、QUIC 或真实上传。两种本地实验都不证明外部网络、平台登录完整性、打包版路由等价性或外部 TUN 改路由竞态。审计零记录也不能替代接收端零到达证据。

本次失败阶段：anonymous-proof-probe:anonymous probe observes a fresh pinned fixture response。
