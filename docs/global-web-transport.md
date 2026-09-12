# 国外独立网页登录：代理通路与 Chrome 隔离实验

2026-09-08 更新：网页基础设施已经接入正式入口。独立 Chrome 账号目录、主进程网页代理 relay、目标级匿名预检、状态 IPC 和国内／国外同构侧边栏均已连接；真实 Google、TikTok、X 登录及正式 mihomo 网页许可仍未验收。下方 19:58 内容是接线前的历史实验记录。

## 完成的代码

- `src/main/network/global-web-tunnel.ts`：主进程不解密 TLS 的 CONNECT 通路。只连接明确的本机代理端点，要求独立目标策略；实际 socket 元组传给授权器，通过后才交出浏览器数据流。每次读写检查许可，短期续证绑定同一连接，过期／撤销立即断开，不回落直连。迟到授权不得恢复已撤销连接，退出等待真实取证工作和 socket 关闭。
- `src/main/network/global-web-relay.ts`：每个未来独立网页环境使用一个仅监听 `127.0.0.1` 的主进程代理入口。只接收审核目标的 HTTPS CONNECT，目标端口固定 443；普通 HTTP、非目标主机、IP 目标、携带正文或过早数据、错误 Host、超大请求头均拒绝。CONNECT 200 在上游实际许可通过后发送。该入口不解释本地 RPC、不读取页面 Cookie，也不接收渲染层提供的代理目标。
- 两个模块保留有界连接、请求超时、取消与清理；API 现有主机白名单、传输和授权器未扩大。

这两个模块的生产消费者、网页专用目标目录与取证器、Chrome 账号进程管理和 IPC 已由 `global-web-service.ts`、`global-browser-*` 及 `global-web` IPC 接入。当前仍没有使用真实账号目录或真实凭据做平台登录验收。

## 接线后验证摘要（21:18）

生产入口已通过受控生命周期检查：`checking → opening → open → closing → dormant` 的状态转换、代理撤销后的连接清理和窗口退出均通过，外部连接数为 0（[生命周期结果](.compare/global-web-lifecycle-20260908T125149357Z.results.json)）。浏览器隔离实验也已更新为有正对照的 WebRTC 结果（限制组 UDP 0、对照组 UDP 8），并观察到带合成 Cookie 的在途请求在撤销后关闭、代理关闭后不回落直连（[浏览器结果](.compare/global-web-browser-20260908T123925885Z.results.json)）。这些仍是受控样本，不代表真实平台登录、真实账号 Cookie 或物理网络零包保证；当前 mihomo 下 X／TikTok 的一次连续续证失败继续按 fail-closed 处理。

## 已验证（19:58 接线前实验）

**51 项相关测试通过，typecheck、全仓 lint 通过。** 包括真实本机 HTTP CONNECT、端到端 TLS、合成 Cookie、许可前零应用数据、过期／撤销、同连接续证、迟到许可拒绝、在途清理、并发占位、代理拒绝和本地入口范围。首次 32 项测试有 10 项等待接收端关闭超时：Node CONNECT 接收端保留了可写半连接。修正测试代理在收到 FIN 后关闭该半连接后，32 项通过；随后代理入口及组合 TLS 测试合计 51 项通过。没有扩大生产网络许可来使测试通过。

安装的 Chrome 文件版本为 **152.0.7977.76**，页面 UA 降精度显示 `Chrome/152.0.0.0`。使用独立临时目录、主进程新增的两个真实模块、本机合成 TLS 接收端，完成以下观察：

| 实验 | 接收端／浏览器观察 |
| --- | --- |
| A 目录首次打开 | 初始无 Cookie；收到仅用于测试的 Cookie 后，页内请求携带该 Cookie |
| B 目录首次打开 | 初始无 Cookie，没有 A 的 Cookie |
| 重开 A 目录 | A 的 Cookie 保留，没有 B 的 Cookie |
| 在途撤销 | 本机请求携带合成 Cookie；撤销后接收端观察到连接关闭，后续接收请求数为 0 |
| 代理入口关闭 | Chrome 显示 `ERR_PROXY_CONNECTION_FAILED`，独立本机 HTTP 直连接收端请求数为 0 |
| WebRTC STUN 对照 | 对照组与限制组均为 0，**不足以证明限制参数有效，未通过资格判定** |

首轮结果：[19:54 原始结果](.compare/global-web-browser-20260908T115454016Z.results.json)。该轮 WebRTC 使用浏览器虚拟计时；改为本机服务端等待 2 秒真实时间后重测，仍没有正对照流量：[19:57 原始结果](.compare/global-web-browser-20260908T115741774Z.results.json)。后者运行约 13.7 秒；`passed` 只表示隔离、HTTPS 撤销和关闭代理不回落这组断言通过，`productionWebsiteReady=false`，不代表全部网络实验或国际网站验收通过。探测结束后未发现带本实验目录参数的残留 Chrome 进程。

运行脚本为 `scripts/global-web-browser-probe.mjs --run-once`。所有测试页面、Cookie、代理和接收端均为受控本机样本。测试使用单个合成证书的 SPKI 例外，没有安装系统根证书；该参数只存在于实验脚本，不能进入正式浏览器启动参数。没有操作系统代理／TUN 切换，没有使用真实账号、官方 Token 或真实平台上传。

## 接线前的待完成清单（19:58 历史）

1. 给网页建立独立的目标策略和取证范围。现有 `ProxyTunnelReader`、`ProxyTunnelAuthorizer`、`verifyProxyTunnelEvidence` 都限定 API 目标；不能只改 CONNECT 层就跳过这三处，也不能将 API 默认白名单扩大。网页来源应复用实时代理出口资格，并独立处理网页连接的并发与同连接续证，不让活跃网页阻塞 API 队列或匿名续证。
2. 完成标准 Chrome 的实际账号目录和进程生命周期。只使用工作台拥有的目录；重复打开、网络撤销、进程退出、应用退出和新代理端口都要处理。不要复用日常浏览器目录，不把 headless 实验参数或证书例外带到人工登录。
3. 补齐有正对照的 WebRTC 实验，以及 DNS、IPv6、QUIC、后台页／service worker 和交互窗口生命周期。当前 0／0 STUN 样本不能算限制有效。用户真实网络与系统配置继续保持。
4. 在上述边界成立后，接入国外账号的“打开官网”与“等待代理”状态、实际网页登录域名兼容验证。网页登录状态与 API 授权分别显示；不依据 API 授权判定网页已登录。

当时没有打新包，因为正式入口尚未消费新增模块；原分类版本仍可使用。随后已接入网页入口，当前状态以本文“接线后验证摘要”和 `global-web-entry.md` 的最新更新为准。

## 使用的原始文档

[Chromium 用户目录](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)说明独立目录与 Cookie 存储关系；[Chromium 代理说明](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md)说明手动代理、隐式 localhost 绕过以及 `<-loopback>`；[Chromium 网络参数源码](https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/network_switches.cc)定义 DNS 映射和仅实验使用的证书公钥例外。这些文档不能替代当前浏览器与操作系统上的受控验收。
