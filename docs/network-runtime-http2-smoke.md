# 生产网络模块集成实测：HTTP/2

执行时间：2026-09-08T01:17:33.424Z。运行时：Electron 43.3.0 / Chromium 150.0.7871.212 / win32。

本脚本直接打包并加载当前生产 NetworkRuntime、EgressGate、Session 请求钩子、gatedSessionFetch、pageFetch 与 closeAccountView。入口：node scripts/electron-network-runtime-smoke.mjs --http2。

**只使用隔离 userData/sessionData、临时分区、本机 TLS 接收端和合成 Cookie。没有打开真实账号，没有访问公网，没有修改 mihomo 或系统证书存储。** 未配置 fixture 信任时先验证匿名探针拒绝自签证书。正向匿名测试仅在隔离子进程包装该私有测试 Session.fetch：生产初始化完成后，核对本机 host/port 与 /robots.txt 完整 URL，安装本轮证书指纹 pin，再委托原始 Chromium fetch；其余 URL 拒绝。业务与壳 fixture 仍仅使用各自 Session 的指纹 pin。没有 ignore-certificate-errors 等开关；正向 fixture 信任覆盖不代表公网默认信任已实测。

| 生产模块检查 | 结果 |
|---|---|
| anonymous TLS probe rejects an untrusted certificate | 通过 |
| untrusted anonymous probe has zero HTTP receiver arrivals | 通过 |
| anonymous probe observes a fresh pinned fixture response | 通过 |
| anonymous receiver sees no credential headers | 通过 |
| anonymous response Cookie is not retained | 通过 |
| anonymous fixture trust is exact, exercised and removed after the sample | 通过 |
| TLS observation makes no exit or address-family claim | 通过 |
| disposed anonymous sampler cannot send another request | 通过 |
| direct initialization awaits setProxy then closeAllConnections | 通过 |
| startup remains closed after initialization | 通过 |
| strict shell refuses signed remote image requests | 通过 |
| strict shell request has zero receiver arrivals | 通过 |
| observation preserves shell request behavior on the same transport | 通过 |
| closed gatedSessionFetch rejects before business send | 通过 |
| closed gatedSessionFetch does not call session.fetch | 通过 |
| closed raw session.fetch is cancelled by production Session hook | 通过 |
| closed renderer fetch is cancelled | 通过 |
| closed renderer XHR is cancelled | 通过 |
| closed requests have zero receiver arrivals | 通过 |
| production hook cancelled each raw closed request | 通过 |
| coordinator construction does not sample or restore permission | 通过 |
| one injected coordinator round does not grant permission | 通过 |
| two fresh test evidence rounds grant exact fixture target | 通过 |
| granted production gatedSessionFetch reaches local TLS receiver | 通过 |
| granted main request carries only the synthetic test Cookie | 通过 |
| granted production pageFetch reaches receiver | 通过 |
| granted renderer XHR reaches receiver | 通过 |
| single-task cancellation settles production pageFetch | 通过 |
| single-task cancellation closes its receiver stream | 通过 |
| single-task cancellation preserves the view and account permission | 通过 |
| both in-flight streams carried synthetic Cookie | 通过 |
| HTTP/2 fixture negotiates h2 for every received request | 通过 |
| parallel renderer response streams share one HTTP/2 connection | 通过 |
| synthetic HTTP/2 upload carries only the test Cookie before revocation | 通过 |
| revoke closes authority synchronously | 通过 |
| stopped coordinator has no active source scheduling | 通过 |
| in-flight gatedSessionFetch aborts with dormant outcome | 通过 |
| in-flight pageFetch aborts with dormant outcome | 通过 |
| production closeAccountView completes actual destruction | 通过 |
| revocation closes every tested multiplexed response stream | 通过 |
| HTTP/2 upload stops without completing its declared fixture body | 通过 |
| HTTP/2 receiver upload bytes remain stable after confirmed destruction | 通过 |
| receiver sees both in-flight responses closed | 通过 |
| suspend callbacks only observe already closed authority | 通过 |
| revoked raw session.fetch stays cancelled | 通过 |
| revoked gatedSessionFetch stays rejected | 通过 |
| new renderer remains closed after old view destruction | 通过 |
| all post-revoke paths have zero receiver arrivals | 通过 |
| all received traffic came from loopback | 通过 |
| production request hook recorded closed paths | 通过 |

受控接收端统计与模块源码哈希见 [结果](./network-runtime-http2-smoke.results.json)。初始化顺序：setProxy:direct:start → setProxy:direct:done → closeAllConnections:start → closeAllConnections:done。

许可明确由测试依赖注入：临时域名映射到 127.0.0.1，模型的 DIRECT/CN 等证据是测试数据，不能当作真实出口证明。只把 warmup 间隔缩短至 50ms，使用 30s 许可和 60s 控制器时效供隔离测试；这些数值不是产品默认值的验收结论。

本次服务器仅接受 ALPN h2，接收端逐请求核对 HTTP/2；额外覆盖同一 H2 会话上的多路页面响应和合成流式上传。上传在撤销前后的接收字节数分别记录，不能把停止后已排队字节描述成零窗口。它不证明 QUIC、平台真实上传或 ServiceWorker 恢复兼容性。 本轮合成上传预定 8388608 字节，撤销前收到 245733 字节，确认销毁后累计 262144 字节；RST code=8，aborted=true。读取端的 end 事件与完整接收分开统计。两种本地实验都不证明外部网络、平台登录完整性、打包版路由等价性或外部 TUN 改路由竞态。审计零记录也不能替代接收端零到达证据。

首次实验误将 readable end 事件当成完整上传，导致一项断言失败；[原始观察](./network-runtime-http2-initial-observation.results.json)已保留。现同时核对预定字节数、实际字节数、aborted、RST 和销毁后字节稳定性，未把第一次失败改写成通过。

本轮旧 fixture 的 Session pin 被生产探针恢复默认验证所覆盖，正向匿名检查失败；[失败记录](./network-runtime-http2-smoke-certificate-pin-failure-20260907.results.json)已独立保存。随后仅修正隔离测试的本机信任设置，生产证书验证没有放宽。

隔离 app certificate-error 替代尝试中，该次 main-process fetch 未触发监听器，正向检查仍失败；[该次记录](./network-runtime-http2-smoke-certificate-app-event-failure-20260907.results.json)保留。这里只报告该次未触发，不推断 Electron 永久不支持。
