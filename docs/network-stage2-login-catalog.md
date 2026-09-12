# 阶段 2：六平台匿名登录壳与资源 host 候选清单

本次结果：六个平台均收到初始页面的 HTTP 200，观察到 **56 个平台与 host 的关联**。**完整登录清单仍为 0 份，不能签发账号出网许可。** 页面 load 完成只表示本次匿名文档加载结束，不能证明二维码可用、验证码可用或登录成功。

## 环境与复跑

采样开始：2026-09-07T14:17:07.564Z（UTC）；最后一个平台结束：2026-09-07T14:19:08.034Z（UTC）。

- Electron 43.3.0，Chromium 150.0.7871.212，Windows 开发版；未验打包版进程身份。
- 直接复用仓库 `toChromeUserAgent()` 和业务工厂的语言设置；没有另造 UA。第一轮使用默认 Electron UA 的探索结果已由本轮替代。
- 真实内核为 `rule + TUN`，版本 `424c2ef`，共 **3341** 条规则。每个平台开始前与结束后，以及整次开始/结束时的 context hash 均相同。没有写入 controller 或修改配置。
- 本次 live rules SHA-256：`10d4aad5e5d8103457178c7e7c3928ff49c3056615a0d181a51f749323ade849`。
- 本次配置/规则上下文 SHA-256：`bdb51b507995c49642af4f272eb0af346eeaeb7aea9183178adaa10b847ea82f`。
- 复跑：`node scripts/electron-login-catalog-probe.mjs`。仅验证隔离：`node scripts/electron-login-catalog-probe.mjs --fixture-only`。完整采样会更新 JSON；本文是上述时间点的书面结论，复跑后应重新对照 JSON。
- 脚本：[electron-login-catalog-probe.mjs](../scripts/electron-login-catalog-probe.mjs)；脱敏结果：[network-stage2-login-catalog.results.json](./network-stage2-login-catalog.results.json)。

## 隔离边界与受控接收端

脚本启动单独的隐藏 Electron。临时 `userData`、`sessionData` 和随机非持久化 partition 与生产资料隔离，未启动 ClipDock 主入口、读取账号数据库、复用生产 partition、扫码或执行任何页面交互。

每个 session 先安装请求策略，再依次等待 `setProxy({ mode: "direct" })` 和 `closeAllConnections()`，然后才加载页面。此顺序清理连接池，不能绕过 TUN。

先用本地受控接收端验证 `session.fetch`、页面导航、页内 fetch 三条路径。预置的都是合成 Cookie/Authorization/自定义秘密头。接收端恰好收到 **3** 次准许请求，敏感头计数为 **0**；拒绝端点收到 **0** 次；三次响应中的 Set-Cookie 均被移除，未存入 cookie jar。隔离验证失败时不访问外部平台。

实际平台采样只允许 GET/HEAD 的文档、iframe、脚本、样式、图片、字体，并要求 host 属于现有平台或验证域范围。XHR/fetch、POST、ping、WebSocket、业务端点路径特征、worker、下载、外部窗口与外部协议导航均拒绝。未知第三方 host 只记录并取消。每平台一个初始 login 页面，20 秒后关闭 WebContents、清理 ServiceWorker 与连接，最终清理临时资料。每平台在第 180 次请求事件之后只取消；此上限限制新的放行，不会让网页内部停止重试。

请求头采用明确白名单，Cookie、Authorization、Proxy-Authorization、任意自定义 token/secret 头以及 Referer 都不发送；响应移除 Set-Cookie/Set-Cookie2。平台脚本仍可能在临时页面中设置设备 cookie，本次抖音/小红书/B 站/百家号分别留下 2/6/2/4 个临时 cookie，清理前只记录数量，不记录名称或值；这些 cookie 仍被出站头策略剥离。不能把“响应 Set-Cookie 已删除”写成“脚本无法写 cookie”。

本次观察到 500 个请求事件，278 个请求进入请求头清理钩子，去掉 13 个响应中的 cookie 头。平台服务器不受本工具控制，**这些客户端计数不能代替受控接收端的物理出口或敏感信息零泄漏证明**。所有真实账号凭据均未参与实验。

记录仅包含 host、资源类型、次数、HTTP 结果、固定错误码和环境摘要；不保存 URL path/query、请求头、响应正文、二维码、截图或页面 DOM。Electron stdout/stderr 不输出到报告，避免引入完整 URL。

## 六平台概览

| 平台 | host 数 | 请求事件 | 进入请求头清理 | 文档加载结果 |
|---|---:|---:|---:|---|
| 抖音 | 9 | 34 | 21 | LOAD_COMPLETED |
| 快手 | 15 | 79 | 1 | LOAD_COMPLETED |
| 小红书 | 8 | 124 | 46 | LOAD_COMPLETED |
| B 站 | 4 | 28 | 20 | LOAD_COMPLETED |
| 百家号 | 13 | 189 | 162 | LOAD_COMPLETED |
| 微信视频号 | 7 | 46 | 28 | LOAD_COMPLETED |

- 快手只加载成功初始文档；页面随后请求的 `wskwai.com` / `wsbkwai.com` 下 13 个具体静态 host 不在现有平台注册范围，全部取消。**这份结果不能算快手登录页可用。**
- 抖音也出现两个注册范围外的脚本 host：`lf3-short.ibytedapm.com`、`unpkg.byted-static.com`，均未放行。是否必要及归属还未独立核实。
- 视频号出现 `open.weixin.qq.com` 的 subFrame/image、`lp.open.weixin.qq.com` 的 script、`res.wx.qq.com` 的多类资源。不能只审核 `channels.weixin.qq.com`，也不能据此放行整个 `qq.com`。
- 视频号还尝试了 `localhost.weixin.qq.com` 的 POST 请求，全部取消。该名称不能直接当作公网 CDN 候选，需分别检查它的解析和用途，禁止仅凭域名后缀给它出网资格。
- 小红书的 `customer.xiaohongshu.com`、B 站的 passport/api、其他平台的动态请求已取消。本实验没有请求用户资料/作品接口去补全清单。
- 百家号在限制范围内也产生大量静态资源，并触发请求预算。增加公开资源候选的批量验证粒度应依据实测，不能给每个资源 URL 单独调用 controller；本采样预算不是生产许可 TTL。
- script 类型可能承载 JSONP/轮询，image 也可能承载请求；不依据资源类型认定它永远是静态文件。特别是视频号 script 观察只证明 host 出现过，未验证完整扫码协议、票据生命周期或可中止性。

## 可优先补证的精确 host 候选

六个初始文档 host 仍是当前代码中的 `creator.douyin.com`、`cp.kuaishou.com`、`creator.xiaohongshu.com`、`passport.bilibili.com`、`baijiahao.baidu.com`、`channels.weixin.qq.com`。以下为本轮在已有注册范围内至少有一次 HTTP 2xx 的其他具体 host，**仅建议进入下一步验证，不自动加入任何放行清单或 mihomo 规则**：

| 平台 | 匿名公开资源 / frame 的精确候选 |
|---|---|
| 抖音 | `lf-c-flwb.bytetos.com`、`lf-fe-creator.douyinstatic.com`、`lf-security.bytegoofy.com`、`lf1-cdn-tos.bytegoofy.com` |
| 快手 | 本次没有 |
| 小红书 | `fe-static.xhscdn.com`、`fe-video-qc.xhscdn.com` |
| B 站 | `s1.hdslb.com` |
| 百家号 | `code.bdstatic.com`、`hercules.cdn.bcebos.com`、`now.bdstatic.com`、`passport.baidu.com`、`pic.rmb.bdstatic.com`、`ppui-static-pc.cdn.bcebos.com`、`ppui-static-wap.cdn.bcebos.com`、`ttl-bjh.baidu.com`、`wappass.baidu.com` |
| 微信视频号 | `lp.open.weixin.qq.com`、`open.weixin.qq.com`、`res.wx.qq.com` |

建议数据结构保持“平台 → 登录文档 / 已注册资源候选 / 已注册但动态未验 / 注册范围外待审核”几类，每类保存本次出现的**精确 host 集合**。批量续证可以合并调度，许可仍必须覆盖每个实际 host、协议、端口、地址族和传输上下文。不能把集合转成根域通配符，也不能以一个 CDN 成功批准同一类的其他 host。

注册范围外的脚本是否必要，要先核实来源和用途，再单独匿名验证；没有观察到的子域不能靠命名规律生成。本次既有 verificationHosts 的多数条目没有被触发，仍只是代码种子，不是实测域名。

## 全部观察明细

“允许尝试”表示本脚本允许这一次匿名请求进入网络栈；不是 DirectProof、不是实际 DIRECT 链证明。没有完成状态的请求可能在 20 秒结束时仍活动或已经失败，详见 JSON 固定错误码。

### 抖音

| 实际出现的精确 host | 资源类型 | 允许尝试 / 取消 | 已完成 HTTP 状态 | 取消原因 |
|---|---|---:|---|---|
| creator.douyin.com | mainFrame, other | 1 / 5 | 200 × 1 | 动态/后台请求 |
| lf-c-flwb.bytetos.com | script | 2 / 0 | 200 × 2 | — |
| lf-fe-creator.douyinstatic.com | script, stylesheet | 16 / 0 | 200 × 16 | — |
| lf-security.bytegoofy.com | script | 1 / 0 | 200 × 1 | — |
| lf1-cdn-tos.bytegoofy.com | script | 1 / 0 | 200 × 1 | — |
| lf3-short.ibytedapm.com | script | 0 / 1 | 未确认 | 注册表之外 |
| mon.zijieapi.com | ping | 0 / 1 | 未确认 | 非 GET/HEAD |
| mssdk.bytedance.com | xhr | 0 / 2 | 未确认 | 非 GET/HEAD |
| unpkg.byted-static.com | script | 0 / 4 | 未确认 | 注册表之外 |

### 快手

| 实际出现的精确 host | 资源类型 | 允许尝试 / 取消 | 已完成 HTTP 状态 | 取消原因 |
|---|---|---:|---|---|
| cp.kuaishou.com | mainFrame | 1 / 0 | 200 × 1 | — |
| log-sdk.ksapisrv.com | ping | 0 / 6 | 未确认 | 非 GET/HEAD |
| p1-plat.wsbkwai.com | script, stylesheet | 0 / 6 | 未确认 | 注册表之外 |
| p1-plat.wskwai.com | script, stylesheet | 0 / 10 | 未确认 | 注册表之外 |
| p2-plat.wsbkwai.com | script, stylesheet | 0 / 4 | 未确认 | 注册表之外 |
| p2-plat.wskwai.com | script, stylesheet | 0 / 5 | 未确认 | 注册表之外 |
| p23-plat.wsbkwai.com | script, stylesheet | 0 / 4 | 未确认 | 注册表之外 |
| p23-plat.wskwai.com | script, stylesheet | 0 / 7 | 未确认 | 注册表之外 |
| p3-plat.wsbkwai.com | stylesheet | 0 / 2 | 未确认 | 注册表之外 |
| p3-plat.wskwai.com | script, stylesheet | 0 / 3 | 未确认 | 注册表之外 |
| p4-plat.wsbkwai.com | script, stylesheet | 0 / 8 | 未确认 | 注册表之外 |
| p5-plat.wsbkwai.com | stylesheet | 0 / 1 | 未确认 | 注册表之外 |
| p5-plat.wskwai.com | script, stylesheet | 0 / 8 | 未确认 | 注册表之外 |
| p66-plat.wsbkwai.com | script, stylesheet | 0 / 2 | 未确认 | 注册表之外 |
| p66-plat.wskwai.com | script, stylesheet | 0 / 12 | 未确认 | 注册表之外 |

### 小红书

| 实际出现的精确 host | 资源类型 | 允许尝试 / 取消 | 已完成 HTTP 状态 | 取消原因 |
|---|---|---:|---|---|
| apm-fe.xiaohongshu.com | xhr | 0 / 50 | 未确认 | 非 GET/HEAD |
| as.xiaohongshu.com | xhr | 0 / 13 | 未确认 | 非 GET/HEAD |
| creator.xiaohongshu.com | mainFrame | 1 / 0 | 200 × 1 | — |
| customer.xiaohongshu.com | xhr | 0 / 2 | 未确认 | 动态/后台请求，非 GET/HEAD |
| edith.xiaohongshu.com | xhr | 0 / 3 | 未确认 | 非 GET/HEAD |
| fe-platform.xhscdn.com | xhr | 0 / 3 | 未确认 | 动态/后台请求 |
| fe-static.xhscdn.com | image, script, stylesheet | 44 / 0 | 200 × 44 | — |
| fe-video-qc.xhscdn.com | media, script | 1 / 7 | 200 × 1 | 动态/后台请求 |

### B 站

| 实际出现的精确 host | 资源类型 | 允许尝试 / 取消 | 已完成 HTTP 状态 | 取消原因 |
|---|---|---:|---|---|
| api.bilibili.com | xhr | 0 / 5 | 未确认 | 动态/后台请求，非 GET/HEAD |
| i0.hdslb.com | xhr | 0 / 1 | 未确认 | 动态/后台请求 |
| passport.bilibili.com | mainFrame, xhr | 1 / 2 | 200 × 1 | 动态/后台请求 |
| s1.hdslb.com | image, script, stylesheet, subFrame | 19 / 0 | 200 × 19 | — |

### 百家号

| 实际出现的精确 host | 资源类型 | 允许尝试 / 取消 | 已完成 HTTP 状态 | 取消原因 |
|---|---|---:|---|---|
| baijiahao.baidu.com | mainFrame, xhr | 1 / 1 | 200 × 1 | 非 GET/HEAD |
| code.bdstatic.com | script | 3 / 0 | 200 × 3 | — |
| h2tcbox.baidu.com | image | 1 / 0 | 未确认 | — |
| hercules.cdn.bcebos.com | script | 1 / 0 | 200 × 1 | — |
| now.bdstatic.com | script, stylesheet | 90 / 0 | 200 × 90 | — |
| nsclick.baidu.com | image | 4 / 0 | 未确认 | — |
| passport.baidu.com | script, stylesheet, xhr | 6 / 5 | 200 × 6 | 非 GET/HEAD，业务端点特征 |
| pic.rmb.bdstatic.com | font, image, media, script, xhr | 44 / 15 | 200 × 41 | 动态/后台请求，采样预算 |
| ppui-static-pc.cdn.bcebos.com | image, script, stylesheet | 5 / 0 | 200 × 5 | — |
| ppui-static-wap.cdn.bcebos.com | script | 1 / 0 | 200 × 1 | — |
| ttl-bjh.baidu.com | image | 2 / 0 | 200 × 2 | — |
| wappass.baidu.com | script | 4 / 2 | 200 × 4 | 业务端点特征 |
| xlab.baidu.com | ping, xhr | 0 / 4 | 未确认 | 非 GET/HEAD，采样预算 |

### 微信视频号

| 实际出现的精确 host | 资源类型 | 允许尝试 / 取消 | 已完成 HTTP 状态 | 取消原因 |
|---|---|---:|---|---|
| astra-web.weixin.qq.com | xhr | 0 / 4 | 未确认 | 非 GET/HEAD |
| channels.weixin.qq.com | mainFrame, ping | 1 / 2 | 200 × 1 | 非 GET/HEAD |
| localhost.weixin.qq.com | xhr | 0 / 6 | 未确认 | 非 GET/HEAD |
| lp.open.weixin.qq.com | script | 2 / 0 | 200 × 1 | — |
| open.weixin.qq.com | image, subFrame | 2 / 0 | 200 × 2 | — |
| res.wx.qq.com | font, image, media, script, stylesheet | 23 / 3 | 200 × 22 | 动态/后台请求 |
| support.weixin.qq.com | image | 0 / 3 | 未确认 | 业务端点特征 |

## 阶段 2 尚未完成的登录补证

以下缺口不能靠这份匿名采样变绿：

1. 六个平台二维码生成、轮询、刷新/过期、手机确认后的浏览器回调、验证码/滑块、passport 跳转均需独立验收。应先完成实际目标直连与出口证据，在合格路径下由用户人工登录；不得为了测试把真实 Cookie 送到不合格出口。
2. 登录后重定向和 authenticated API/CDN/上传 host 仍未覆盖。保持原业务入口，发现未知目标时拒绝并给出明确原因，不在登录过程中临时猜测放行。人工发布和挂文件不自动重放。
3. 本清单没有冻结 IPv4/IPv6、TLS/SNI、实际目的地址，也没有对每个 host 关联 mihomo 的实时链路、进程路径、端口或 mainland 出口证据。相同规则 hash 只能说明这些采样点的配置摘要稳定。
4. 不得将隐藏匿名 session 的成功加载与真实账号分区或打包版 Network Service 进程互认证据。进程归因结果需与单独的四路径报告关联。
5. 仍需验证本项目严格撤销组合对六个平台登录体验与 ServiceWorker 的影响。关闭前已发送的数据不能收回，本次清单采样也没有声称解决外部路由切换的竞态。
6. 本次没有调节或冻结生产 10 秒 / 15 秒 / 60 秒默认值；应在这些功能性实验通过后，只调整数值和按账号批量续证粒度，保持证明模型。

**阶段 2 登录目录状态：候选已实测，完整登录/验证码/轮询清单未冻结。阶段 3 不应仅凭本报告启用。**
