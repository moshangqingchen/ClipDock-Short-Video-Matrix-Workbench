# 抖音登录资源范围修复（2026-09-28）

真实账号的脱敏审计发现，规则分流模式把官方登录页面调用的脚本、图片和 XHR 以 `UNKNOWN_TARGET` 取消。`domestic-web-target-policy.ts` 原来仅复用顶层导航/验证域名，加上快手专有的资源域名族；抖音没有独立资源范围，导致导航主页面可加载而安全组件不完整。

本次只补充下表的**精确主机名**。它们参与国内网页资源的 CONNECT 候选判断；顶层导航目录没有变化，HTTPS/WSS、443 端口、账号隔离和实际 DIRECT 路由验证继续执行。主域、其他子域、不同平台不继承这些权限。

| 精确主机 | 公开一手来源及用途 |
|---|---|
| `unpkg.byted-static.com` | [抖音创作者中心 HTML](https://creator.douyin.com/) 直接引用 React、React DOM、SystemJS 和浏览器检查组件的脚本。 |
| `lf3-short.ibytedapm.com` | 同一 HTML 的 Slardar 脚本加载器直接指定 `/slardar/fe/sdk-web/browser.cn.js`；这是官方页面使用的监测 SDK，并非认证接口。 |
| `lf-ucenter-web.yhgfb-cn-static.com` | HTML 直接引用的[用户中心安全 SDK](https://lf-fe-creator.douyinstatic.com/obj/passport-fe/ucenter_fe/byted/secure-consumer-sdk/1.0.0.22/index.umd.production.js) 将其设置为分包基地址 `u.p`。 |
| `lf-headquarters-speed.yhgfb-cn-static.com` | HTML 直接引用的[安全组件加载器](https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.62/sdk-glue.js) 在 `bdms.srcList` 中指定此备用安全脚本主机。 |
| `lf-rc1.yhgfb-cn-static.com` | 同一加载器的 `verifyCenter.srcList` 指定验证码脚本，并通过 `window.TTGCaptcha.init` 初始化。 |
| `lf-rc2.yhgfb-cn-static.com` | 同一验证码脚本的备用主机；后续验证组件也引用该主机。 |
| `lf-cdn-tos.bytescm.com` | 上述加载器指定 `captchaVersion=4.0.10`；该版本的[验证码脚本](https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/sec_sdk_build/4.0.10/captcha/index.js) 在 `back_up_js_v2.cn` 中指定这个主机的验证组件。该[后续验证组件](https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/verifycenter/@latest/index.js) 再次列出了同一备用主机。 |
| `lf3-config.bytetcc.com` | 创作者中心直接引用的 [AccountSDK 分包](https://lf-fe-creator.douyinstatic.com/obj/douyn-creator-scm-cdn/douyin-creator-master-new/static/js/174.1f82796a.js) 加载[用户中心安全 SDK](https://lf-ucenter-web.yhgfb-cn-static.com/obj/passport-fe/ucenter_fe/@byted/uc-secure-sdk-online/latest/index.umd.production.js)。该 SDK 在未禁用 TCC 时读取 `ucenter.fe.ztsdk` 配置；没有有效缓存时，直接向这个精确主机的 `/obj/tcc-config-web/tcc-v2-data-ucenter.fe.ztsdk-default` 发起静态配置 XHR，合并当前应用的安全规则。 |

查证只读取公开 HTML 和顺着其直接引用、明确版本与静态依赖地址得到的脚本。未执行网页，未使用账号 Cookie，未请求账号资料、二维码生成、二维码轮询或验证提交接口。完整 SDK 只存在读取过程的内存中；抓取时间、HTTP 状态、原始字节 SHA-256 和必要短摘录保存在本次本地调查产物 `output/login-investigation/douyin-resource-fix-evidence.json`，最初证据保存在 `douyin-public-evidence.json`。

rc.2 之后的补充证据保存在 `output/login-investigation/douyin-rc2-static-evidence.json`。TCC 配置 SDK 缓存有效期为 6 小时；因此已经命中缓存的页面与首次初始化的页面可能表现不同。SDK 的安全时间戳更新名单包含 `/passport/web/check_qrconnect`，仅在启用安全时间戳且满足请求配置的条件下参与该分支；是否代理或签名另由提供方、消费方等配置决定。不能把这个名单解读为“生成二维码不签名、扫码轮询才签名”。配置依赖被拦截是已证实缺口，但这份静态分析不能断言用户扫码后的业务错误码或“访问太频繁”的唯一原因。

同一 AccountSDK 分包明确定义 `/passport/web/get_qrcode/` 与 `/passport/web/check_qrconnect/`。同一安全 SDK 还把 `/check_qrconnect` 放入消费方路径列表，并定义它到 `/passport/sso/check_qrconnect/` 的路径重写；因此被动诊断必须覆盖这两个已证实的扫码状态别名。SDK 中 API 主机可由配置决定，这些脚本不能证明用户现场使用的具体主机。消费者主页的本次匿名 HTML 读取只返回挑战文档，未执行挑战；`sso.douyin.com`、`passport.web.douyin.com` 以及无前缀的 `/get_qrcode/` 均没有被本次静态证据确认为现场端点。实际请求主机、扫码后的业务码和状态应由已有请求的被动观察裁定。

`vc-gate-edge.ndcpp.com` 虽出现在真实拦截日志中，本次有限官方静态依赖链未独立证实其用途，仍不放行。`storage.googleapis.com` 和仅出现在 DNS 预取声明中的其他 CDN 主机也不据此自动加入。后续如仍有请求失败，应对该确切依赖继续取证，不扩大整个注册域或关闭请求门闩。

回归覆盖新增主机的资源准入、顶层导航权限不变、跨平台隔离、父域和额外子域拒绝、相似域与带端口/用户信息的非法主机拒绝；并运行国内直连准入与规则传输的已有测试，核实新增资源候选没有绕过端口和 DIRECT 验证。

本次静态资源调查确认并修复了官方安全/验证码依赖被本地错误拒绝的缺口；该阶段没有取得产生“访问太频繁”提示的精确平台业务码与界面分支，因此资源缺口不能单独解释现场提示。后续修复预发布版本浏览器标识后获得了可以登录的用户反馈，见 [1.0.6-rc.4 说明](releases/v1.0.6-rc.4.md)。
