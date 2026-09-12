# 最小真实操作范围：B 站无页面状态检查

本轮建议生产证据来源先选 **`bilibili / check-status / activePageOrigin: null`**。当前源码对这个选择只要求 `https://api.bilibili.com:443`，可以独立补证，不必先完成六个平台的扫码、上传与所有 CDN。

本轮已完成这个精确目标的匿名 DNS/规则/TLS 候选采样。**真实业务流程审核仍为 `flowReviewed: false`，没有给账号签发许可，也没有使用账号 Cookie。**

## 与当前代码对照

| 项目 | 当前事实 |
|---|---|
| 真正业务入口 | `AccountService.checkStatus(accountId)`，先声明 `check-status`，闭闩时不发请求；没有视图时通过 `configureAccountSession()` 取该账号 Session。 |
| 请求来源 | B 站 `login.probe` 为 `GET api.bilibili.com/x/web-interface/nav`，`probeFromMain: true`。这是源码中的固定业务地址；本轮没有访问该业务端点。 |
| 传输上下文 | 无页面时由 `login-detector.mainProcessProbe → gatedSessionFetch → 该账号 Session.fetch` 执行。将来认证业务仍使用原 Session；本轮匿名样本使用独立非持久化诊断 Session。 |
| 目录选择 | `resolveOperationCatalog({platformId:'bilibili',operation:'check-status',activePageOrigin:null})` 返回 `executionSupported:true`；固定及必需 origin 都只有 `https://api.bilibili.com:443`。 |
| 其他平台 | 抖音、百家号、视频号当前也允许无页主进程 probe，但并未据此声称其真实认证行为已验收；快手、小红书无页面选择为不支持。首期无需捆绑这些范围。 |
| 既有候选 | `api.bilibili.com` 已在 30 条种子中。`catalog.candidateTargets()` 是诊断种子，不是操作必需集合。B 站 passport、member、www 和验证码候选不进入这个无页选择的 `requiredOrigins`。 |

来源：[平台配置](../src/shared/platforms.ts#L298)、[账号服务](../src/main/services/account-service.ts#L261)、[主进程探测](../src/main/browser/login-detector.ts#L222)、[操作目录解析](../src/main/network/operation-catalog.ts#L277)、[会话请求封装](../src/main/network/gated-session-fetch.ts#L5)。

当前选择身份：

```text
sourceVersion = cn-operation-source-v1:8db2f3856739449e33160976fa7ce25102f3fc9cbf2086cb98aaeb3e1d592074
selectionKey  = cn-operation-selection-v1:52ae5cf4f3cf423f619047b96ca1257443f5017dbf47296a3d4932182c99bc4f
requiredOrigins = [{ protocol: 'https:', host: 'api.bilibili.com', port: 443 }]
```

这两个值只是此次源码选择身份；源码变化后应重新解析，不能硬编码旧值来维持审核。

## 本轮限定实测

执行时间：2026-09-07 18:40:23.950–18:40:24.189 UTC。Electron 43.3.0，Chromium 150.0.7871.212，开发运行态、独立临时资料。未启动工作台、未打开账号/页面、未读取账号 Cookie、未扫码、未发平台业务写入、未修改配置。

只通过生产 `AnonymousProofProbe` 对 `api.bilibili.com` 发起 **一次固定公开 `robots.txt` 请求**，无自定义业务地址或 query，`credentials: omit`、无缓存、禁止跟随重定向；响应正文未读取或记录。此类请求的无凭据头与响应 Cookie 隔离已有受控接收端回归，参见 [匿名探针测试](../src/main/network/anonymous-proof-probe.test.ts) 和 [Electron 受控运行报告](./network-runtime-smoke.md)。本轮没有把公网请求当作受控接收端验证。

| 观察 | 本次结果 | 边界 |
|---|---|---|
| 运行配置 | `rule + TUN`，内核 `424c2ef` | 不代表 DIRECT 实际执行或出口地理位置。 |
| 控制器前后版本 | 同为 `5cc197058efc435fabbd518ff97564995e80b4af5a09f8961b989ce627db14ee` | 可见控制状态摘要相同，不是内核完整配置证明或原子锁。 |
| 当前规则解释 | 有序规则 `Domain → DIRECT`，下标 16 | 只是当前可解释规则结果，未以另一进程历史连接代替实际业务路径。 |
| 主机 TLS | HTTP 200，默认 Chromium 证书验证，`responseFromCache:false`，`credentials:omit` | 仅说明公开轻端点的 TLS 响应；不证明 nav 业务或登录成功。 |
| A/AAAA | 两族均 Status 0、TC false、问题匹配；各 4 个观察地址 | 是内核 DNS 候选，不是 Chromium 最终解析/实际 socket 目的地址。 |
| CNAME | `api.bilibili.com → a.w.bilicdn1.com` | DNS 别名不是新 HTTP origin；没有向别名额外发请求，也不自动追加业务 host。 |
| TTL | 原始回答均为 1 秒；保留查询开始加原 TTL 的单调截止 | 未抬高到 15 秒，过期不能续用；后续轮次必须重新读取。 |
| DNS 结论 | `unverified / ADDRESS_CLASS_UNKNOWN`，`chromiumResolutionProven:false` | 未臆测 fake-IP 映射或地址族约束，未签发许可。 |

全部 bundle 输入源码在采样前后哈希一致。真实地址、每族问题/回答及 TTL 在仅供主进程审查的 [脱敏结果](./network-minimal-operation-scope.results.json) 中；没有 Cookie、Token、完整请求地址、响应正文或账号信息。

可复跑：`node scripts/electron-minimal-operation-scope-probe.mjs`。脚本固定一个目标、最多一次公网轻请求、8 秒探针超时、30 秒子进程上限；显式使用本轮已确认的字面 loopback 控制器 `http://127.0.0.1:9790` 和空密钥，失败不会尝试其它控制地址或凭据，也不会读取账号/凭据数据库。

## 这个范围仍需补的实际证据

1. **同一个精确业务目标、实际传输上下文。** 后续 `PathInputReader`、真实 DNS/地址族/OS 选路、进程/socket/内核连接归因和大陆出口证据应选 `api.bilibili.com:443`。此前 `www.bilibili.com + creator.bilibili.com` 的演示输入不能替代它。诊断 Session 的成功不能直接转成账号 Session.fetch 的等价性。
2. **认证探测的封闭分支。** 应独立确认固定 nav 探测在合格路径下的有登录态、未登录/失效、重定向及撤销行为。当前 `gatedSessionFetch` 没有强制 `redirect:error`，因此不能从 robots 不重定向推断业务永远不重定向。未知重定向目标必须由原 SessionGuard 拒绝；如果要支持实际出现的额外 origin，应先记录证据，再加入此操作审核和取证范围。禁止为了方便把 passport、验证码和整个根域预先全放入。
3. **确实没有页面背景范围。** 选择必须来自主进程实际的 `activePageOrigin:null`。已有/隐藏账号页、残留 ServiceWorker、在途后台任务不能被当作不存在；它们若发出范围外请求仍须拒绝和撤权。本次没有检查或清理生产账号的后台状态。
4. **其后动作保持独立。** 状态从 offline 变 online 会触发 `account-online`，随后安排 profile/collect；这些操作有自己的目录选择、审核和许可，当前不得一起放行。可以先验收已在线账号的单次无页状态复核；对其他状态，后续未审核工作仍应等待网络。参见 [事件接线](../src/main/index.ts#L322)。

范围不会因为打开一个页面而保持不变：有页 B 站 `check-status` 会把页面 origin 纳入必需集合，并优先页内 probe；`profile` 无页也会涉及 `member.bilibili.com` 页面准备；`collect/keepalive` 包含 member 与 api；`view-login` 涉及 passport 和真实页面资源。这些是下一批独立选择，不是此范围已完成的附属能力。

已有六平台匿名登录材料仍只证明静态壳候选：[第一轮](./network-stage2-login-catalog.md)、[抖音/快手补证](./network-stage2-login-catalog-followup.md)。例如 B 站登录壳还观察到 `passport.bilibili.com / s1.hdslb.com / api.bilibili.com / i0.hdslb.com`，动态请求与验证码并未完整执行；不需要让这批登录材料阻塞无页状态检查的单独补证。

也不能把“浏览公开 robots 页”伪装成 `view-navigate` 的完整流程审核：当前动态导航选择按 origin 绑定，没有将某一条无副资源的公开路径独立编码；审核同 origin 的一个 robots 文档，不能自动审核其所有可导航页面。

## 生产接入边界

可先将生产 source 的目标选择和匿名采样对准上述单 origin，为这个单独选择补齐证据。实际取证必须覆盖可能使用的两族；不能以其中一个成功地址代替全部必需分支。

只有主进程审核记录与当前 `sourceVersion + selectionKey` 对齐，并实际完成该受限操作的流程及路径验证，才可以设置相应 `flowReviewed:true`。届时 `reviewedRequestRange` 可先只包含这个 origin，`additionalRequiredOrigins` 为空；如果真实运行发现必需跳转则必须重新审核并撤旧许可。当前没有生成或安装这样的真实审核记录。

这轮交付的是一个可独立推进的实际业务选择及其新鲜匿名目标事实。它不要求全部 48 个操作类别同时完成，也没有用 HTTP 200、DIRECT 字样或候选输入代替严格模式验收。
