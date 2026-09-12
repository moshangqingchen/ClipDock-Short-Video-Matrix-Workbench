# 匿名 TLS 采样器：实施与实测

实现为 `src/main/network/anonymous-proof-probe.ts`。这是证明来源的一项输入，尚未接入正式应用的证明签发流程；不替代 DIRECT、出口、DNS、地址族或进程路径证据。

## 实际行为

- 主进程创建非持久化 Chromium Session 池，默认最多 2 个、支持上限 4 个。接口只收已选定目标的 host/port，固定请求其 `/robots.txt`，不接受账号 Session、任意路径、query 或凭据。
- 首次使用先等待 `setProxy({mode: "direct"})`，紧接着等待 `closeAllConnections()`。这不绕过 TUN。
- 请求使用 `credentials: "omit"`、`cache: "no-store"`、手动重定向；请求钩子只允许当前精确 URL 的 GET，删除凭据头及响应 Set-Cookie，结束后清理匿名 Cookie 存储。
- 只有收到属于本轮请求的响应事件、有效状态码且 `fromCache === false` 时才输出 TLS 观察。3xx/4xx 只说明该 TLS 端点回复，不代表业务可用；不跟随重定向、不解析正文。
- 输出仅包含目标、匿名传输上下文 ID、单调时间、状态码、缓存标志与无凭据声明。没有物理远端、地址族、DIRECT 或公网来源 IP 的推断。
- 取消、过期、撤销及销毁后的旧结果都不可用。撤销后先等连接清理再复用；清理失败的槽位保持不可用。Session 创建后即计入池，钩子安装失败也不会无限创建新分区。

## Electron 43 / Windows 实测

`scripts/electron-network-runtime-smoke.mjs` 与 `--http2` 直接加载该生产模块。仅访问本机 TLS 受控接收端，使用临时 userData/sessionData，不读取真实账号。

实测覆盖：不可信证书拒绝且 HTTP 接收端零到达；受控证书仅给测试中的下一匿名 Session 按主机及证书指纹固定信任；实际匿名请求无 Cookie/Authorization/Proxy-Authorization；响应 Cookie 未保留；输出不含出口/地址族结论；销毁后不再发请求。测试没有全局关闭证书校验。

当前源码哈希和实际检查结果分别记录在 `network-runtime-smoke.results.json` 与 `network-runtime-http2-smoke.results.json`。这组实验验证采样器的隔离和事件行为，不能作为任何国内平台的真实网络许可。
