# Chromium QUIC 启动约束与本机对照

2026-09-08 04:07:16–04:07:25（Asia/Shanghai），锁定 Electron **43.3.0** / Chromium **150.0.7871.212** / Windows，未打包运行。[实测结果](./network-quic-constraint-smoke.results.json) **13/13** 通过；启动模块单元测试 **5/5** 通过。

## 生产改动

`src/main/index.ts` 在 imports 后第一个启动动作调用 `configureChromiumTransport(app)`，在 `app.ready` 前添加 `disable-quic`。模块拒绝迟到调用，添加失败或无法读回开关时抛错。

`src/main/network/chromium-transport.ts` 提供：

- `configureChromiumTransport(app)`：配置启动约束。
- `readChromiumTransportState(app)`：只读主进程内存快照，包含 `profileId="clipdock-chromium-tcp-v1"`、`configuredBeforeReady`、当前 `disableQuicSwitchPresent`。快照没有 IPC、数据库或 renderer 持久化。

这是 Chromium HTTPS 的 QUIC 关闭约束，不设置代理，不控制 DNS、IPv4/IPv6、操作系统路由、WebRTC 或其它 UDP 使用者，也不绕过 TUN。开关读回是启动事实；其实际效果由下列锁定版本实验支撑。

## 实验方法

执行 `node scripts/electron-quic-constraint-smoke.mjs`。脚本使用两个独立隐藏 Electron 子进程、临时 userData/sessionData、独立非持久 Session。每个模式的三种入口各有专用端口，同端口同时监听本机 TLS/TCP 和 UDP，避免跨请求归因。

- 对照组添加 `enable-quic`，用 `origin-to-force-quic-on` 指向三个精确测试 origin。
- 约束组保留同样的强制 QUIC 开关，然后调用**真实生产启动模块**添加 `disable-quic`，而非测试手工替代实现。
- 三种入口是沙箱隐藏页面里的 `fetch`、主进程 `session.fetch`、主进程 `net.request`。每次 Session 都执行 `setProxy({mode:"direct"})` 后立即 `closeAllConnections()`；请求使用 `credentials:"omit"`，没有账号、Cookie 或认证头。
- 域名仅映射到 `127.0.0.1`；业务 Session 的请求过滤器只允许该次精确本机 URL，默认 Session 拒绝所有请求。TLS 接收端返回固定小正文及 h3 Alt-Svc。
- TLS 仅由该私有 Session 的精确主机名与本轮证书指纹 pin 信任；没有全局证书忽略开关、系统证书安装或系统网络修改。
- UDP 接收端不实现 QUIC 握手、不回复。它检验实际收到的 QUIC v1/v2 Initial 长头和最小长度，只保存数量和版本，不保存包内容。对照请求到时主动中止是预期行为，不能把它称为完成了 HTTP/3 请求。

## 接收端结果

| 入口 | 对照组 QUIC v1 Initial UDP | 对照组 TCP 请求 | 启动约束后 UDP | 启动约束后 TCP |
|---|---:|---:|---:|---|
| 页内 fetch | 6 | 0 | 0 | 1 次，200，固定正文匹配 |
| session.fetch | 6 | 0 | 0 | 1 次，200，固定正文匹配 |
| net.request | 6 | 0 | 0 | 1 次，200，固定正文匹配 |

全部接收包来自 loopback，全部 HTTP 请求均为精确 URL 的无凭据 GET。约束组调用时 `app.isReady()===false`；两个强制 QUIC 开关仍存在，说明生产关闭开关在本次运行中实际生效。结果包含启动模块、脚本和 bundle 的 SHA-256；模块在实验期间未变更。临时证书、profile 和目录已清理。

## 可用结论与边界

本次具有三个入口各自的阳性 UDP 对照，可以支持这些入口在**该 Electron 构建与启动方式**下的 HTTPS TCP 协议约束。未来升级 Electron、改变启动开关、打包产物或启动流程，需重新核对适用性；不能仅复用字符串 profileId 当验收记录。

该结果没有证明任何公网目标为 DIRECT、实际出口在大陆、DNS 路径等价、仅 IPv4、账号与匿名工厂物理路径等价，未接签发器、未开启 strict。结果中 `quicConstraintValidated=true` 与 `routeOrAddressFamilyQualified=false` 分开记录。

官方依据：[Electron 启动开关时机](https://www.electronjs.org/docs/latest/api/command-line-switches)、[Chromium QUIC 开关定义](https://chromium.googlesource.com/chromium/src/+/58b42322d7fd12e6909e95fe4bf63e29e83000da/components/network_session_configurator/common/network_switch_list.h)。本机实测负责确认仓库实际锁定构建的行为，文档中的开关定义不代替实验。
