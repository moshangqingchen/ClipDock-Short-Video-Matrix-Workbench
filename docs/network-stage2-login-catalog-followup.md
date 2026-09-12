# 阶段 2 登录目录补证：官方引用链与精确静态 host

本轮核实了 **4 个**此前注册范围外的精确 host 引用链：抖音 2 个、快手 2 个。它们只在匿名诊断脚本中临时开放 script / stylesheet，本项目平台注册表和 mihomo 规则没有修改。

扩大这四个精确静态候选后，抖音出现了更多脚本、iframe 和仍待审核的资源 host；快手的首批主资源已能加载。**这使目录证据更完整，但不证明完整扫码或验证码流程通过，完整登录目录仍未冻结。**

## 运行记录与隔离

- 成功采样开始：2026-09-07T15:18:25.512Z（UTC）；结束：2026-09-07T15:19:06.310Z（UTC）。
- Electron 43.3.0 / Chromium 150.0.7871.212；独立临时资料、非生产 session、隐藏窗，复用现有 Chrome UA 和语言设置。
- 只访问官方登录文档及其直接引用的有限静态资源；不使用真实账号 Cookie、Token 或 Authorization，不扫码、不点击、不发送平台业务写入。
- 每次实际采样前重跑受控接收端：`session.fetch`、页面导航、页内 fetch 三条路径，共 3 次准许请求；接收端敏感头 0、禁止端点 0、响应 Cookie 落库 0。
- 请求头按白名单清理，响应移除 Set-Cookie；没有把原文、完整 URL、path/query、源码片段、Cookie 或二维码写入本报告/JSON。
- 当前内核为 `rule + TUN`、3341 条规则。全程每个平台与整次前后 context hash 一致；只读 controller。
- rules hash：`10d4aad5e5d8103457178c7e7c3928ff49c3056615a0d181a51f749323ade849`。
- context hash：`bdb51b507995c49642af4f272eb0af346eeaeb7aea9183178adaa10b847ea82f`。

第一次加上体积计量后，隐藏诊断窗在尚无文档时等待 DevTools Network.enable，进程被总超时结束；检查点复现定位后，改为先加载本地 about:blank 再启用计量。本报告只采用最终成功运行的数据，没有把失败尝试当作目录验收。

复跑命令：`node scripts/electron-login-catalog-probe.mjs --followup`。仅本地隔离验证：`node scripts/electron-login-catalog-probe.mjs --followup --fixture-only`。

脚本：[electron-login-catalog-probe.mjs](../scripts/electron-login-catalog-probe.mjs)；本轮脱敏结果：[network-stage2-login-catalog-followup.results.json](./network-stage2-login-catalog-followup.results.json)。此前六平台报告和结果保留：[第一轮报告](./network-stage2-login-catalog.md)、[第一轮结果](./network-stage2-login-catalog.results.json)。

## 数量、大小与时间界限

源审核每平台最多读取一个官方 HTML（512 KiB）及三个由它直接引用的脚本（每个 2 MiB），每个请求 5 秒超时，禁止重定向。文本只在内存中查找目标 host 与 script/link 属性；不向第二层脚本继续爬取。

页面每平台一个初始登录文档，20 秒，最多在前 120 次请求事件内放行。XHR/fetch、POST、ping、WebSocket、业务端点、worker、下载、外部窗口仍拒绝；新增域仅精确匹配审核通过的 host，且只允许静态脚本或样式扩展名。

单资源超过 4 MiB 的已声明响应在响应头阶段取消；运行时通过 DevTools 字节事件计量解码数据，单资源超过 4 MiB 或累计超过 16 MiB 即关闭页面。这是客户端收到字节事件时的停止阈值，不是对底层缓冲字节的原子限额。本轮没有触发体积或请求预算，页面关闭后的临时资料已清理。

| 平台 | 审核源数 | 新候选核实数 | 页面 host 数 | 页面请求事件 | 已观察解码字节 |
|---|---:|---:|---:|---:|---:|
| 抖音 | 1 | 2/2 | 15 | 63 | 6708988 |
| 快手 | 4 | 2/13 | 10 | 28 | 5745097 |

## 一手来源链

“官方”入口来自当前仓库平台配置；脚本来源只取官方 HTML 的直接引用。下面保存来源主机、类型、字节数和正文摘要值，便于核对，不展示原始地址或原文。摘要值可能随平台部署变化，不当作永久证书。

| 平台 / 来源编号 | 来源 host | 角色 | HTTP | 字节数 | SHA-256 |
|---|---|---|---:|---:|---|
| 抖音 / 0 | creator.douyin.com | 官方登录 HTML | 200 | 17221 | `d501fbebf9fef551da49f90ba51a3c724f39a2f4cb4f2a3d7934d7d74c6c8d06` |
| 快手 / 0 | cp.kuaishou.com | 官方登录 HTML | 200 | 53868 | `bdc38b0d5b77d8ad3240980a9374e9e9f64af54647b357538870e3bb76c9f1dc` |
| 快手 / 1 | p66-plat.wskwai.com | 官方 HTML 直接引用脚本（父来源 0） | 200 | 8179 | `7b7725f1272812182ec5d25aefd6284c96c38447500b0bdfb88f93ab35538b08` |
| 快手 / 2 | p66-plat.wskwai.com | 官方 HTML 直接引用脚本（父来源 0） | 200 | 905419 | `92a7c58982cfe9d2228e295b98a424295b85a66ca48c3cc070b9036ae014fc5a` |
| 快手 / 3 | p66-plat.wskwai.com | 官方 HTML 直接引用脚本（父来源 0） | 200 | 878636 | `c67265e44314afd3735e6cfb1f9840c7b19f6d3ce0fea0bdc9b81e8016141a54` |

没有引用搜索结果、第三方域名归属推测或另一份 geosite 数据。“官方页面引用了这个 host”只证明本次资源引用关系，不额外声称所有权、未来用途或所有子域都可信。

## 15 个待补证目标的结果

`script-src` / `link-href` 表示官方文档中的静态属性引用；`exact-host-literal` 表示源中确实存在完整主机名。后者可能是动态资源配置，必须再结合实际资源类型与加载结果，不能只看文字就签发业务许可。

| 平台 | 精确 host | 官方引用证据 | 本次诊断范围 | 本次完成 HTTP 状态 |
|---|---|---|---|---|
| 抖音 | lf3-short.ibytedapm.com | 来源 0：exact-host-literal | 仅诊断 script / stylesheet | 200 × 5 |
| 抖音 | unpkg.byted-static.com | 来源 0：script-src | 仅诊断 script / stylesheet | 200 × 4 |
| 快手 | p1-plat.wsbkwai.com | 本轮未核实 | 不扩展 | 请求取消，无完成状态 |
| 快手 | p1-plat.wskwai.com | 本轮未核实 | 不扩展 | 本轮未请求 |
| 快手 | p2-plat.wsbkwai.com | 本轮未核实 | 不扩展 | 本轮未请求 |
| 快手 | p2-plat.wskwai.com | 来源 1：exact-host-literal | 仅诊断 script / stylesheet | 本轮未请求 |
| 快手 | p23-plat.wsbkwai.com | 本轮未核实 | 不扩展 | 请求取消，无完成状态 |
| 快手 | p23-plat.wskwai.com | 本轮未核实 | 不扩展 | 请求取消，无完成状态 |
| 快手 | p3-plat.wsbkwai.com | 本轮未核实 | 不扩展 | 本轮未请求 |
| 快手 | p3-plat.wskwai.com | 本轮未核实 | 不扩展 | 本轮未请求 |
| 快手 | p4-plat.wsbkwai.com | 本轮未核实 | 不扩展 | 请求取消，无完成状态 |
| 快手 | p5-plat.wsbkwai.com | 本轮未核实 | 不扩展 | 本轮未请求 |
| 快手 | p5-plat.wskwai.com | 本轮未核实 | 不扩展 | 请求取消，无完成状态 |
| 快手 | p66-plat.wsbkwai.com | 本轮未核实 | 不扩展 | 本轮未请求 |
| 快手 | p66-plat.wskwai.com | 来源 0：link-href | 仅诊断 script / stylesheet | 200 × 12 |

- 抖音：`unpkg.byted-static.com` 在官方 HTML 的 script 属性出现；`lf3-short.ibytedapm.com` 在同一 HTML 以完整主机名出现。本轮分别完成 4、5 个 script 请求。
- 快手：`p66-plat.wskwai.com` 被官方 HTML 引用，源审核还读取了它的三个直接引用脚本；`p2-plat.wskwai.com` 出现在其中一个脚本。p66 本轮完成 12 个 script / stylesheet 请求；p2 本轮未被页面使用，不能因此宣称其实际链路或功能已通过。
- 快手其余 11 个目标没有在限定源审核中取得精确字符串证据。**保持未核实，不按 p* 命名规律自动补出或批准整个根域。** 它们可能由动态 CDN 选择/失败重试产生，但本轮没有静态或调用来源证据证明该解释。

## 新出现的依赖及下一步

相对于此前抖音与快手样本，本轮新增 8 个平台与 host 的关联：

| 平台 | 新 host | 本次观察 | 当前结论 |
|---|---|---|---|
| 抖音 | auth.zijieapi.com | script，200 × 1 | 在已有平台注册范围内；需补用途与实际链路证明 |
| 抖音 | lf-zt.douyin.com | subFrame，200 × 1 | 需审核 frame 的登录关联；不能以 host 名猜测具体用途 |
| 抖音 | lf-ucenter-web.yhgfb-cn-static.com | script × 9，全部取消 | 新的未审核脚本依赖；下一轮应先从官方引用链核实 |
| 抖音 | lf3-config.bytetcc.com | XHR × 1，取消 | 未审核动态端点，未发送 |
| 抖音 | lf3-static.bytednsdoc.com | image × 2，取消 | 未审核图片依赖，未发送 |
| 抖音 | mcs.snssdk.com | POST XHR × 1，取消 | 动态请求未执行，未核用途 |
| 快手 | gdfp.gifshow.com | POST XHR × 3，取消 | 动态请求未执行，未核用途 |
| 快手 | static.yximgs.com | script，200 × 1 | 在已有注册范围内；需补用途与实际链路证明 |

审核后的 p66 上还有一个 image 被取消：临时诊断扩展限定于 script / stylesheet，未自动扩大资源用途。抖音和快手各自官方主机上的动态请求同样取消；没有为了让页面“看起来能登录”而打开这些探针。

下一轮应优先用静态来源或实际请求的可靠发起源归因，核对新的脚本依赖及快手 CDN 选择关系。取得证据前保留精确 host 的候选状态。二维码生成/轮询、验证码、确认回调、登录后跳转依旧要单独验证；只能在真实目标直连与出口证据合格后由用户人工参与登录。

## 本轮完整 host 明细

“允许”是匿名诊断脚本的请求尝试；与业务 DirectProof 无关。HTTP 200 也不证明页面功能、实际 DIRECT 链或大陆出口。

| 平台 | host | 资源类型 | 允许 / 取消 | 完成 HTTP 状态 |
|---|---|---|---:|---|
| 抖音 | auth.zijieapi.com | script | 1 / 0 | 200 × 1 |
| 抖音 | creator.douyin.com | mainFrame, other, xhr | 1 / 10 | 200 × 1 |
| 抖音 | lf-c-flwb.bytetos.com | script | 2 / 0 | 200 × 2 |
| 抖音 | lf-fe-creator.douyinstatic.com | script, stylesheet | 16 / 0 | 200 × 16 |
| 抖音 | lf-security.bytegoofy.com | script | 1 / 0 | 200 × 1 |
| 抖音 | lf-ucenter-web.yhgfb-cn-static.com | script | 0 / 9 | 未确认 |
| 抖音 | lf-zt.douyin.com | subFrame | 1 / 0 | 200 × 1 |
| 抖音 | lf1-cdn-tos.bytegoofy.com | script | 1 / 0 | 200 × 1 |
| 抖音 | lf3-config.bytetcc.com | xhr | 0 / 1 | 未确认 |
| 抖音 | lf3-short.ibytedapm.com | script | 5 / 0 | 200 × 5 |
| 抖音 | lf3-static.bytednsdoc.com | image | 0 / 2 | 未确认 |
| 抖音 | mcs.snssdk.com | xhr | 0 / 1 | 未确认 |
| 抖音 | mon.zijieapi.com | ping, xhr | 0 / 6 | 未确认 |
| 抖音 | mssdk.bytedance.com | xhr | 0 / 2 | 未确认 |
| 抖音 | unpkg.byted-static.com | script | 4 / 0 | 200 × 4 |
| 快手 | cp.kuaishou.com | mainFrame, xhr | 1 / 3 | 200 × 1 |
| 快手 | gdfp.gifshow.com | xhr | 0 / 3 | 未确认 |
| 快手 | log-sdk.ksapisrv.com | ping, xhr | 0 / 2 | 未确认 |
| 快手 | p1-plat.wsbkwai.com | image | 0 / 1 | 未确认 |
| 快手 | p23-plat.wsbkwai.com | image | 0 / 1 | 未确认 |
| 快手 | p23-plat.wskwai.com | image | 0 / 1 | 未确认 |
| 快手 | p4-plat.wsbkwai.com | image | 0 / 1 | 未确认 |
| 快手 | p5-plat.wskwai.com | image | 0 / 1 | 未确认 |
| 快手 | p66-plat.wskwai.com | image, script, stylesheet | 12 / 1 | 200 × 12 |
| 快手 | static.yximgs.com | script | 1 / 0 | 200 × 1 |

## 目录冻结状态

已从“未核实第三方脚本”推进到四个具有官方引用链的精确静态候选，并暴露后续依赖。仍没有完整扫码/验证码/轮询清单、目标级出口证据、真实业务进程等价性、IPv4/IPv6/TLS 范围或登录后资源回归。

本轮没有变更生产 10 秒 / 15 秒 / 60 秒默认值，没有写平台注册表，没有加 mihomo 规则，也没有启用阶段 3。**四个候选不等于四张业务许可，阶段 2 登录目录仍未冻结。**

