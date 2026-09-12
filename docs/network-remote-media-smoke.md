# 远程媒体缓存：生产模块 Electron 本机实测

执行时间：2026-09-07T18:01:07.695Z。Electron 43.3.0 / Chromium 150.0.7871.212 / win32。

运行 `node scripts/electron-remote-media-smoke.mjs`。直接 bundle 当前 RemoteMediaService、download/format、AssetService 原生协议及 business-access；源码与 bundle 哈希见结果。无真实账号、无公网请求、无 mihomo 修改。临时 userData/sessionData、内存分区、127.0.0.1 TLS 接收端及合成 Cookie/Basic 凭据；证书只在该 Session 按域名及指纹精确放行，没有全局证书忽略或信任存储修改。

| 实际验证 | 结果 |
|---|---|
| 闭闩媒体不调用 Session 网络 | 通过 |
| 生产 nativeImage 成功生成本地 PNG | 通过 |
| 同 Session 普通请求与媒体下载实际并发 | 通过 |
| 普通 include 收到原合成 Cookie | 通过 |
| 媒体 omit 未发送 Cookie Authorization 或 Referer | 通过 |
| 媒体响应 Set-Cookie 未写入账号分区 | 通过 |
| 媒体 omit 未清掉普通业务 Cookie | 通过 |
| 生产 sv-asset 协议返回可解码 PNG | 通过 |
| 原生协议缓存 miss 404 且无网络回退 | 通过 |
| 原生协议拒绝 query 且无网络回退 | 通过 |
| 实际已填充缓存 manifest 不含远程 URL query 或凭据 | 通过 |
| redirect:error 拒绝第二跳且不缓存 | 通过 |
| 普通分区已实际建立并复用 Basic 认证缓存 | 通过 |
| 媒体 omit 不复用同 realm Basic 缓存或弹认证 | 通过 |
| 租约撤销中止流且不提交缓存 | 通过 |
| 撤销后新增媒体任务零到达 | 通过 |
| suspendAccount 中止流且不提交缓存 | 通过 |
| 持久缓存不包含远程 URL query 或凭据 | 通过 |
| 所有接收请求仅来自 loopback | 通过 |
| 全部媒体路由均无 Cookie 或认证头 | 通过 |
| 无非 fixture 网络尝试 | 通过 |
| 任务全部释放生产业务租约 | 通过 |

同一账号 Session 的普通 include 与媒体 omit 确认在接收端并发重叠；请求钩子只限制本机目标，不改 Cookie、Authorization 或响应 Set-Cookie。服务器逐路由记录凭据是否存在，不落原凭据。正常 PNG 经真实 nativeImage 解码/转 PNG 后写缓存，sv-asset://remote/UUID 由生产 AssetService 分派。缓存未命中没有下载回退。

许可由严格范围的测试适配器注入，使用生产 beginBusinessOperation；只允许这个合成账号和本机 TLS origin。它验证缓存的租约消费/撤销，不签发真实 DirectProof，不证明 OS/mihomo 路径、真实平台图床目录或正式打包兼容性。初始化完成顺序为 setProxy(direct) → closeAllConnections。没有声称绕过 TUN。

Basic 认证覆盖：隐藏窗口通过合成 Basic challenge 建立该分区认证缓存；随后普通 session.fetch 实际收到 Authorization，而同一 realm 的媒体请求没有 Authorization、没有触发凭据重试/认证提示，收到 401 后显示不可用。 不代表已覆盖 NTLM/Negotiate、客户端证书、代理认证或所有 Chromium 认证机制。

流式撤销分别覆盖纯租约撤销与 suspendAccount：接收端已开始响应后撤销，下载停止且无新增缓存/临时文件；确认撤销后给接收端留出观察时间，再检查无晚到提交。不会把撤销前已收到的合成字节描述成零包。

初期观察：首轮测试错误读取 Electron Certificate 上不存在的 fingerprint256，所有 TLS 请求被测试 pin 拒绝；已改成从 certificate.data 计算 X509 指纹，[原结果](./network-remote-media-smoke-initial-observation.results.json)保留。修正后另有一次媒体未到达、普通请求成功的观察，当时尚未记录 fetch 错误码，原因不能追认；后续增加只记录固定错误码的透明观察，并在当前源码完成后复核。最终通过只代表该次受控检查，不把早期失败改写为通过。

[脱敏结果](./network-remote-media-smoke.results.json)。源码在完成时仍一致；本轮临时目录已清理。
