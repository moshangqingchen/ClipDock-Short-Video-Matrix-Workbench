# 主进程匿名出口采样模块

实现：`src/main/network/anonymous-egress-probe.ts`。没有修改用户网络配置，没有在公网回显端点采样，也没有据此签发生产许可。本模块 **50 项**模拟测试通过，与 TLS 探针合计 **81 项**。这些测试验证模块契约，不替代 Electron 实机传输验收。

## 接口与观测含义

`new AnonymousEgressProbe(options?)` 仅构造；首次 `probe("ipip" | "ipify-ipv6", signal)` 才创建独立、非持久 Chromium Session。方法不接受账号 Session、任意 URL、Cookie、请求头或代理配置。`invalidate()` 同步撤销已有采样，返回清理 Promise；`dispose()` 同时禁止新采样。

固定 GET 目标为 `https://myip.ipip.net/`、`https://api6.ipify.org/`，随后仅对解析出的规范 IP 请求 `https://ipwho.is/<IP>`。调用方必须先核对当前目标通路，再决定是否调用。模块不会自行根据可达性放行，也不会修改 mihomo。

成功对象仅供主进程内存使用，包含规范 IP、`reportedAddressFamily`、地理查询的 `countryCode`、辅助 ASN、独立 `transportContextId`，以及两次 HTTPS 响应各自的单调时间。`observedAtMono` 是回显正文完成时刻，等待地理查询及清理不会延长出口样本年龄；`completedAtMono` 是地理查询正文完成时刻，清理仍须完成但不改写采样时间。

成功对象的 `factoryId` 固定为导出的 `ANONYMOUS_EGRESS_FACTORY_ID`（`clipdock-anonymous-egress-v1`）。TLS 探针对应 `ANONYMOUS_TLS_FACTORY_ID`（`clipdock-anonymous-tls-v1`）。它们标识真实生产模块的契约，供外层 conformance 记录引用；不会把独立的 `transportContextId` 改成账号 context，也不表示二者路径兼容性已经验收。

`reportedAddressFamily` **只是响应正文中 IP 的族**。它不是 Chromium socket 的实际地址族，也不证明 DIRECT、物理接口、账号进程归属或出口样本对业务目标的适用性。国家来自地理库，必须与回显 IP 精确对应；IPIP 文本地区与 ASN 注册地不替代国家判定。没有成功地理查询就没有可用观测。原始对象不得进入 IPC、日志、渲染层、备份或持久化。

## 传输、撤销与有限资源

默认最多 2 个 Session（配置上限 4）；每响应最多 32 KiB，整个采样默认 12 秒（配置上限 15 秒），清理等待最多 2 秒。没有后台采样定时器或自动重试。

Session 设置 `mode: "direct"` 后立即 `closeAllConnections()`；此举不会绕过 TUN。请求采用 `GET`、`credentials: "omit"`、手动重定向与禁用缓存。守卫只允许当前固定 URL 和该 Session 的当前请求 ID，剥离 Cookie、Authorization、Proxy-Authorization、Referer 与响应 Set-Cookie；禁用 NTLM 域白名单并清理 HTTP auth cache。只有匹配请求的响应钩子确认非缓存、状态 200，且正常 Chromium HTTPS 校验成功，才继续读取。缺失钩子、重定向、认证响应、字节超限及无效正文都拒绝。

撤销先关闭请求许可并 abort，再尝试断开连接、清理认证及存储；每项清理独立尝试。迟到响应不得启动下一次地理请求或返回成功。绝对单调截止时间在运行中和返回前检查，不能因为到期定时器尚未调度而返回超时成功。

清理失败、清理超时或忽略 abort 的未决工作，使槽位永久停用，并继续占用原有池额度；不会不断创建替代 Session。Electron 没有此处可用的 Session 销毁 API，因此这不是“销毁所有会话对象”。应在主进程复用同一个长期实例，不通过不断重建实例恢复失败池。仍未结束的旧工作可能保留有界证书拒选守卫，待其实际结束后移除；这是有限停用状态，不应被描述为所有底层资源均已回收。

## 客户端证书的明确边界

不能只凭 `credentials: "omit"` 声称已排除客户端证书。Electron 的应用级 `select-client-certificate` 事件在没有 `preventDefault()` 时会默认选择证书；主进程请求又可能没有 WebContents，因而事件没有足够的 Session 归属信息。[Electron 官方说明](https://www.electronjs.org/docs/latest/api/app#event-select-client-certificate)

本模块把上述精确回显 URL，以及正在查询的规范 IP 地理 URL，作为**匿名诊断保留目的地**。`anonymous-session-privacy.ts` 与 TLS 探针共享单一监听器；TLS 探针仅登记当前公开 `/robots.txt` URL。匹配时 `preventDefault()`、空参数 `callback()` 拒选，并撤销匹配采样。多个实例和两种工厂共享监听器，避免对同一事件重复回调。有 WebContents 时必须匹配私有 Session，账号 WebContents 不处理。

**无 WebContents 的同 URL 事件无法可靠归属。** 拒选策略可能同时影响其他主进程对同一保留 URL 的请求，包括误用该目的地的账号 `session.fetch`；因此不能声称它“绝不影响任何账号主进程请求”。仅 abort 自己然后放过全局事件可能触发默认选证，本实现没有采用这种处理。其他 URL 不处理；业务调用方不应把这些保留目的地用于需要客户端证书的业务。此边界尚未以真实客户端证书握手实验验收。

## 本轮反例检查

- 模拟事件循环跨越截止时间、定时器尚未执行：地理查询或清理完成后均拒绝超时成功。
- 两个独立 Session 同时请求同一回显 URL：不能借另一 Session 的 200 响应钩子补齐缺失证据。
- 多实例及无 WebContents 同 URL 证书事件：仅回调一次，并撤销所有匹配采样；明确保留归属歧义。
- 失败与挂起槽位保持有限占用；不通过新建 Session 绕过清理失败。

本模块提供原始匿名观测。真实地址族、DIRECT 路由与业务适用性仍由外层证据来源分别核实，不能由本模块输出推定。

TLS 探针已同步补齐单调截止时间、NTLM/auth cache、客户端证书拒选与有界失败清理，源码发生变化。此前依赖旧源码哈希的 H1/H2 或路径符合性报告不能自动视为当前版本已验收；本轮没有重写旧报告来声称实验已通过。

追加（2026-09-08）：出口工厂增加仅主进程可用的观察钩子，分别覆盖 echo 与 geo 的 beforeSend、实际响应头和 cleanup。上下文只含固定来源、origin、独立 context、信号与私有 NetLog 能力，不提供 Response、正文、请求头、完整地址或 Session。geo 等待 echo 的观察清理后才进入；所有钩子共享原 12 秒默认/15 秒上限，未延长请求持有时间。`whenIdle()` 包含实际观察清理及外层任务，超时不能提前释放未结束槽位。新增回归后本模块 79 项测试通过，当前工厂的本机有限入口对照见[18 项实验](./network-factory-context-smoke.md)。观察钩子本身不产生路径或地址族证明。
