# 主进程匿名代理出口工厂

2026-09-08：`src/main/api/proxy-egress-probe.ts` 的匿名准备顺序现为 CONNECT → 默认验证 TLS → 同连接证据核验一次 → 固定 GET。顺序修订先完成本机受控测试，15:30 又执行一次修复后真实匿名样本；其结果及源码一致性失败边界见下文。没有改动系统代理/TUN。

```ts
new ProxyEgressProbe({
  proxy: { host: "127.0.0.1", port: 10090 },
  controller: { host: "127.0.0.1", port: 9790 },
  readVersion: () => ({ generation, revision }), // 失联时返回 null
  reader, // Pick<ProxyTunnelReader, "readAnonymousTunnel" | "whenIdle">
  allowedCountries, // 主进程显式政策，无默认“海外”推断
  timeoutMs: 15_000,
  evidenceTtlMs: 15_000,
});
```

`probe(signal?)` 返回 `ProxyEgressSample | null`；`invalidate()` 同步撤销本轮；`whenIdle()` / `dispose()` 等待实际读器及 Node 连接关闭。一个实例最多一轮；取消的公共结果可以先返回，真实工作未结束时不允许另起一轮。清理失败使实例保持关闭。

生产地址固定为 `https://www.cloudflare.com/cdn-cgi/trace`。只有字面 loopback mixed/controller 端点可配置，不接收 URL、header、账号、代理密码、Cookie、Token、TLS 信任或 transport 替身。一次匿名 CONNECT、默认 CA/SNI 验证、一次固定 GET；没有重定向、重试、直连回退、账号 Session 或业务 ProxyTransport。总请求期限最多 15 秒，正文最多 16 KiB，只接受完整的 200 text/plain 响应及已知 trace 字段。测试通过单独测试进程的默认 CA 信任合成证书，生产接口没有证书放宽选项。

匿名 TLS 不携带 Cookie、Token 或业务请求；握手使用默认 CA/SNI 验证。在 TLS 成功后、创建 HTTP 请求前，使用同一活跃 CONNECT socket 的原始 context 读取一次控制器证据，并调用生产 `verifyProxyTunnelEvidence`：精确源/入站四元组、目标、非 DIRECT/REJECT 链、节点策略摘要、前后控制器摘要、控制器与实际代理连接的内核归属、当前 generation/revision 和原单调时间。读器真正 drain 后再次核时，证据失效或读取期间配置变化均不发 GET，不将清理完成时间写回证据。该顺序避免一次匿名采样重复进行 Windows 归属查询；总期限仍为 15 秒。业务 `ProxyTransport` 的 TLS 前门闩完全不变。

成功结果只保存在主进程内存：`sampleId / ip / countryCode / observedAtMono / expiresAtMono / chainFingerprint / controllerFingerprint / kernelOwner / generation / revision`。`observedAtMono` 为实际正文完成时刻；截止为本次证据原截止与正文期限的最小值。结果没有业务许可、平台授权或 renderer 绿灯含义，消费者仍需关联后续业务连接自己的证据。

出口只取唯一、合法的 `ip` 与 `loc`，不拿 `colo` 当国家；未知/重复字段、保留国家代码、缺字段、国家不在显式允许集合时返回 null。CN 不会因某次失败被推断为海外；若主进程政策显式允许 CN，解析器如实返回 CN。

官方依据：Cloudflare 的 [Privacy Proxy 接入文档](https://developers.cloudflare.com/privacy-proxy/get-started/) 明确用 trace 的 `ip` 检查代理出口，并用 `loc` 核对所选地区；[trace 端点说明](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/) 确认该端点由 Cloudflare 管理。[IP 地理定位说明](https://developers.cloudflare.com/network/ip-geolocation/) 同时说明不同供应商的地理分类可能不同。因此这里记录 Cloudflare 对出口 IP 的分类，不宣称物理所在地或 ASN 判断。

历史验证：旧版两次核验工厂的 46 项测试于 14:58 CST 通过。当时初跑发现 TLS 接管后从旧 CONNECT/raw socket 抢先销毁会造成 Windows Node worker 退出；已改为由 TLS 外层关闭并保留真实回归，合成代理半开连接的测试清理也已修正。后续全量的间歇 worker 退出未再复现、原因未确认，不能据此声称已修复所有 native 退出。

旧版唯一一次真实匿名实验见 [2026-09-08 15:07 原始结果](global-proxy-egress.20260908T070709469Z.results.json)：在原 TLS 前读器返回 null，未进入 TLS/GET；结果与原源码摘要保留，不改写成新版实测。

本次修订的 46 项受控测试于 15:24 CST 通过。真实本机 Node CONNECT/TLS/HTTP 验证：只在 TLS 已授权、HTTP 尚未发送时读一次证据；DIRECT、缺失/冲突连接、错误目标/归属或前后配置变化均保持零 HTTP；证书失败为零证据读取、零 HTTP；TLS 后拒绝仍等待真实 wrapper 关闭。无凭据与 Set-Cookie 不复用、响应上限、无重定向/重试、原期限、取消与迟到清理继续通过。该结果不等同新版真实代理出口验收。

15:30 [修复后的一次匿名样本](global-proxy-egress.20260908T073031548Z.results.json)实际取得 JP／IPv6，TLS 后唯一一次证据读取通过，mixed 归属为 `windows-proxy-accepted`，资源清理完成。采样约 4.34 秒，剩余原有效期约 10.89 秒。运行中 authorizer 注释更新使源码稳定检查失败、外层脚本退出 1；不把整轮登记为通过，不改写失败标记。样本没有账号、Session、平台 HTTP 或配置修改，也不代表真实 OAuth 验收；[完整边界](global-proxy-tunnel.md)单独记录。
