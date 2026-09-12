# 互斥切换：当前构建与验证

2026-09-08。当前入口是“代理关闭后恢复国内；系统代理或 TUN 开启后国内休眠”。国际本机配置、网页登录入口、官方授权／取消、手动读取、Token 刷新、读取队列、TikTok 草稿和 YouTube 上传队列已接入；X 写入与平台侧撤销仍待完成。代理模式不等于国际账号已授权或可发布。

## 最新构建：22:52

国外账号侧栏的异步状态读取已加入版本保护：窗口状态事件不会被旧刷新结果覆盖，已删除账号不会残留在窗口统计中；分组标题、官网工作区和国内／国外互斥行为保持不变。进入国外页面后，列表中的第一个账号会自动作为工作区当前账号显示，但不会自动打开官网或发起登录请求；用户点击账号行后仍可切换。最终全量复跑为 138 个测试文件／4084 项通过，typecheck、lint、打包和 `--packaged` Electron 冒烟均通过；未切换系统代理/TUN，未使用真实账号或凭据。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `7C3560491BA94C9D3F0F78042E7179BCAEF332519B821DAD8B60CCAB72A8523E` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `11352558A74E14BED9972DDCC0798C09093437874B6F810A55EB7B02FF1512A8` |

## 最新构建：22:09

最终包再加入代理未知态保持闭闩、国外窗口撤销清理、重复打开等待 cleanup barrier、删除账号清理官网工作区，以及“窗口”统计语义修正。138 个测试文件／4081 项、typecheck、lint、打包和 `--packaged` Electron 冒烟均通过；未切换系统代理/TUN，未使用真实账号或凭据。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `144B7B3CFC9F4D8178DD84A346E24A292C020B800C2E6F6AFDE65F4A6303AA84` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `41EFD8C4F8F91712C24C24FB160E091E937DAA1107B87BA01827C13D397FA30C` |

## 历史构建：22:02

最终包包含：国外同构账号侧边栏、平台专属官网工作区、代理撤销关闭窗口、过期/不可读代理证据保持国内闭闩、删除账号清理工作区，以及最新的国际 API 文案和回归测试。138 个测试文件／4081 项、typecheck、lint、打包及 `--packaged` Electron 冒烟全部通过。没有切换系统代理/TUN，也没有使用真实账号或凭据。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `F198458F0EBB7CBD90F743C5B696C26DFF2D9A45192033309F7D1665F7F73FE9` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `CF82ABDA3DF3E8C81600CB1B6A71BA34F3370CC0CED6E85D95F7A9A1F54F0FBB` |

## 历史构建：21:18

已打包包含国外同构账号侧边栏、平台专属官网工作区、独立 Chrome 生命周期和网页代理 relay。`npm run typecheck`、`npm run lint`、定向 UI／网络测试及 `--packaged` Electron 启动冒烟通过；没有切换系统代理／TUN，也没有使用真实账号或凭据。当前包哈希见下表。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `58FE8842B39B45E219372AC9DDAF6AB511DECC5AC6E3BFDE7BD2EC150C2A63A9` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `12A5048FA52C1B7FB053130ECFA374502002728B7D55322D36E33ABF57DB875E` |

## 历史构建：19:23

按用户最新要求加入[国内／国外分类与可选 API 区域](global-web-entry.md)，已进入 **2026-09-08 19:23:42** 构建。主导航“国内平台／国外平台”、国外平台筛选、隐藏国内账号树及默认网页账号分类视图均已接入。API 配置、授权、数据和上传工具由用户主动打开。独立网页登录环境仍未接入，页面明确显示“网页登录待接入”，没有使用默认浏览器冒充隔离账号环境。

**相关界面 76 项回归、typecheck、全仓 lint、打包通过；19:24 新包隔离桌面冒烟退出 0，约 9.87 秒。** 实际截图已查看：分类导航与三个国外分组正确，默认不展开 API，主动打开后原授权／上传检查继续通过；国内严格互斥、网络内存投影和凭据加密保持。此次只有渲染和冒烟脚本变更，未重跑上一节 3949 项全量，不能将该历史次数冒记为本构建全量验收。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `a3d6ec4dc3594933dd5fefa4b494c08d5b0081c76cda83492c0cb7bd319eadb3` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `d35b6cfc0eb8100b267ad4b1c9d671abe2ddf87b09adfd9dac54aae9a08cd087` |

原 `启动工作台.cmd` 直接使用新包。结果在 `docs/.compare/global-category-delivery-results.json`，相关测试 `global-category-verified-tests.json`，桌面 `global-category-smoke.log/.json`，截图 `shot-platform-categories.png`。没有启动真实网页账号浏览器或改用户代理／TUN。下一阶段优先完成独立网页登录与网络控制，现有 API 与剩余官方能力保留。

## 历史构建：19:02

[YouTube 可恢复上传](global-youtube-upload-delivery.md)已进入 **2026-09-08 19:02:59** 的当前可执行文件，原 `启动工作台.cmd` 直接启动。独立上传授权、默认私密的元数据表单、原 URL 加密保存、按服务器确认位置续传、持久等待期限及取消后仅查结果均已接入。处理完成和实际公开分别显示；未审核应用被限为私密时不伪报公开。

**19:01 全量 128 文件／3949 项通过（`--maxWorkers=4`），无 pending；typecheck、全仓 lint、打包通过。19:04 新包隔离桌面冒烟退出 0，约 8.68 秒。** 真实 exe／preload／系统加密验证了独立 YouTube 授权入口、未配置与未授权拒绝、默认私密和必填受众声明；实际截图已查看，上传控件没有横向溢出。TikTok、国内 strict、网络内存投影与国际无分区检查继续通过。迁移 11 的真实 v10 数据库升级保留旧上传任务及密文，唯一活动任务与删除级联通过。

首次全量的 8 个账号页测试缺少新上传 API 模拟，已修正并单独复测通过；同轮匿名 TLS 测试 worker 意外退出，38 个断言未完成。该文件独立 46 项及随后完整重跑均通过；保留原报告，不声称已确定或修复原生退出根因。既有嵌套按钮／无布局图表提示和打包 chunk／依赖提示仍保留。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `77e50bbe425c4a55c3f00b43ee324be1478b3e99671108063837504153899f06` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `f943dcbf0dc49c412cb5171369ec67d56ecd8385c5baf8baeec174e72e77446e` |

机读结果：`docs/.compare/global-youtube-delivery-results.json`；完整报告 `global-youtube-verified-tests.json`，首次报告 `global-youtube-initial-tests.json`；打包日志 `global-youtube-pack.log`；桌面日志／结果 `global-youtube-smoke.log/.json`；截图 `shot-youtube-upload.png`。均使用受控数据，没有真实平台上传、开发者应用或代理切换验收。X 写入、远端撤销及真实国内／国际验收仍在项目范围中。

## 历史构建：18:15

[TikTok 草稿上传](global-tiktok-draft-delivery.md)已进入 **2026-09-08 18:15:11** 的当前可执行文件，原 `启动工作台.cmd` 直接启动该构建。独立 `video.upload` 授权、素材选择、持久任务、等待代理、取消、分片传输与原任务状态核验已接入；传完只显示待处理，官方确认送达后才显示收件箱。发布由用户在 TikTok 完成，不调用 Direct Post。

**18:12 全量 127 文件／3838 项全部通过，typecheck、全仓 lint、打包通过；18:15 隔离桌面冒烟退出 0，约 6.59 秒。** 已检查实际 TikTok 面板截图：独立授权按钮可见，未授权的提交禁用，控件未溢出。主进程、真实 preload、系统加密、国际无分区、拒绝未配置授权、拒绝未授权上传、内存网络投影继续通过。受控 API 与本机 TLS 接收端验证没有真实 Token 或平台上传。

迁移 10 在新表中原样复制旧凭据密文；真实 v9 SQLite 升级检查通过。断开本机授权和更换应用会清理签名上传密文；失败回滚及旧回调拒绝均有回归。首次全量报告保留：两处旧迁移测试假设与新 schema 不符，另有 59 条 pending 断言；修正测试夹具后的完整重跑 3838 条均为 passed，没有把该首次运行计作通过。首次 lint 只在测试目录清理处报错，抽出带路径校验的函数后通过。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `354ed939387fc576fe154297a9e8a6c15b5ca051fa5148ebbb02ccd7483af0d6` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `0a67e927ae499c981c9fe1604f833945ec44d3a9bac647431e365a96192d0d79` |

机读结果：`docs/.compare/global-tiktok-delivery-results.json`；完整测试：`global-tiktok-verified-tests.json`；原始首次报告：`global-tiktok-final-tests.json`；桌面日志及结果：`global-tiktok-smoke.log/.json`。本轮没有更改实际系统代理、TUN 或真实账号目录。尚无官方开发者应用，真实授权／上传／地区上传域名未验收；YouTube resumable、X 写入、远端撤销及用户暂缓的国内恢复与六平台登录仍未完成，整个项目继续推进。

## 历史构建：17:19

国际长连接续证已进入当前程序，`app.asar` 写入于 **2026-09-08 17:19:47**、exe 于 **17:19:48**。原 `启动工作台.cmd` 继续指向该构建。匿名出口复核有独立读取器和保留槽位，业务请求保持串行；同一隧道用当期证据更换短许可，失败／到期／取消即结束，原 TTL 没有放宽。实现和受控边界见[国际隧道续证](global-proxy-tunnel.md)。

**17:17 全量 121 文件／3710 项、typecheck、全仓 lint、打包通过；17:20 新包隔离桌面冒烟退出 0，约 6.69 秒。** 本机接收端完成跨越原 5 秒许可的 6 MiB 请求，仅一条 CONNECT／TLS；失败、取消及迟到结果测试通过。真实 exe 的严格互斥状态、内存网络投影、系统加密、三平台未授权配置与读取队列拒绝路径继续通过；账号页截图已查看。机读结果在 `docs/.compare/global-tunnel-renewal-delivery-results.json`。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `1df6bf1c56ee0093b6d354c334f26e7474f7a8173b9941ef86f32ea90e8ade71` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `ceb75a4f1e1613ab6cbfb9a9d609ffd2ef64ee0d523c673eefe05610c8294870` |

本轮完成上传前置传输能力，尚未开放三平台草稿／上传／发布，正文限制和默认 15 秒请求超时仍在。没有真实平台授权、上传或 mihomo 长上传验收；真实代理／TUN 与账号目录未修改。官方应用配置和真实网络切换验收仍按用户此前选择暂缓，整个项目保持未完成。

## 历史构建：16:48

`npm run pack` 已完成，当前 `app.asar` 写入于 **2026-09-08 16:48:30**、exe 于 **16:48:31**。原 `启动工作台.cmd` 继续指向 `release/win-unpacked`。新增迁移 9、授权版本绑定、国际读取队列和账号卡任务状态；使用、取消、重启与退避边界见[国际读取任务交付](global-jobs-delivery.md)。

**16:47 全量 121 文件／3676 项通过；typecheck、全仓 lint 通过。16:50 当前包桌面冒烟退出 0，约 6.70 秒。** 全量报告为 `docs/.compare/global-jobs-final-tests.json`。本轮真实 exe／preload／SQLite 检查：三平台未授权账号的 `globalJobs.submit` 立即返回固定拒绝、列表为空、取消不存在的任务返回 null，原直接 `globalRead.refresh`／`cancel` 不再暴露；没有账号 Token 出网。原 strict、网络状态仅内存、系统加密、国际无分区与应用配置检查继续通过。账号页截图已查看，最后编辑弹窗 1464×881、127 ms 返回。等待／成功任务的正向业务路径由受控 SQLite／服务及页面测试覆盖，尚无真实平台授权验收。

| 当前文件 | SHA-256 |
| --- | --- |
| `release/win-unpacked/resources/app.asar` | `44c62ee3442f9d6f4f3f00912b908af96a3cdf89fb9867a34b9c18d13a69b834` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `32e485958c916ad8bbbfbdc28864530eb6124fc8e0b04789c5898ef60b38a304` |
| `scripts/electron-window-smoke.mjs` | `5f44cdf3d98de1b68e8c5dfef27d55f7a633c748bdde648bcaac8b521fab926d` |

本轮未切换系统代理／TUN、未修改真实账号目录，未做真实平台请求；既有测试／构建提示和历史失败记录保留。上传／草稿／发布及其队列、远端撤销、真实平台验收，以及用户暂缓的真实国内恢复仍待完成，整个项目未完成。

## 历史构建：16:10

`npm run pack` 于 **2026-09-08 16:10:02** 生成当前 `release/win-unpacked`，原 `启动工作台.cmd` 继续指向该目录。新增官方读取器、Token 刷新与 CAS 保存、迁移 8 的独立公开快照、主进程取消生命周期和读取面板；具体使用、平台权限及未验收范围见[国际手动读取交付](global-read-delivery.md)。当前 TikTok 仅 basic scope，不请求统计或作品；其他平台也必须有真实授权、有效代理证据和 API 权限。

**16:08 全量 118 文件／3631 项通过；typecheck、全仓 lint 通过。16:11 新包桌面冒烟退出 0，约 6.73 秒。** 结果保存于 `docs/.compare/global-read-final-tests.json`。新增实际 preload 检查：三个未授权账号 get 均为 null，refresh 在出网前返回 `GLOBAL_READ_UNAUTHORIZED`，cancel 正常；没有平台 Token 请求。保留原 strict、网络状态不持久化、系统加密、全球账号无分区及配置清除检查。最终截图 1464×881、128 ms 返回，页面已目视核验。既有测试／构建提示及旧失败记录保留。

| 当前文件                                    | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `release/win-unpacked/resources/app.asar`   | `5625e81ed94d2f6c2dacc96c44a5d53d25042639392a16ce39f95e679178479d` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `2925fd7e37cf9032e302e653ca28c3eea3e6ba940adbb4ba6093f177b9063dc3` |
| `scripts/electron-window-smoke.mjs`         | `dc32e52b28af62853cba1d4dd1c6571ec3f01ac5e3977dffec242c8bc707acfd` |

未切换系统代理／TUN，也未使用真实平台账号。整个项目仍缺上传、国际队列、远端撤销和真实平台验收；用户暂缓的国内真实恢复也未由合成测试替代。

## 历史构建：15:39

`npm run pack` 成功，`release/win-unpacked/resources/app.asar` 写入时间为 **2026-09-08 15:39:09**。现有 `启动工作台.cmd` 与兼容模式启动脚本继续指向该目录，真实数据仍在原 `workbench-data`，未移动或清理。

本轮增加按需国际出口来源与官方授权的主入口、IPC、preload 和界面组合。mixed 端口归属核对改用实际已接受的反向 Established socket，避免猜测 `::` 监听是否覆盖 IPv4。匿名探针只在 TLS 后进行一次同连接核验；业务凭据发送前的门闩保留。首次采样期间控制器失联／变化会撤销，续证按实际耗时提前安排，原证据过期时间不变。国内互斥、调度、登录状态与网络状态分离及凭据隔离继续保留。

**15:38 全量 111 文件／3468 项测试通过；typecheck、全仓 lint 通过。15:39 新包桌面冒烟退出 0，整轮约 6.73 秒。** 全量结果保存在 `docs/.compare/global-oauth-final-tests.json`。冒烟实际启动打包后的 exe，使用一次性数据目录，经真实 preload／SQLite 验证国内 strict 与网络状态不持久化、系统凭据加密、三个国际账号无分区、配置与合成密钥保存／清除。新增 OAuth 状态只返回五个安全字段；未配置时开始授权返回 `GLOBAL_OAUTH_NOT_CONFIGURED`，没有打开授权浏览器或发起出口采样；取消和本地清除正常。正式授权按钮已显示，但不伪造成功。

最终编辑弹窗截图为 1464×881，145 ms 返回；本轮账号页截图已目视核验。Windows 隔离截图开关沿用下述 14:36 修复，产品启动参数没有增加。测试仍有既有嵌套 button、无布局图表尺寸提示，构建仍有 renderer chunk 大小及打包依赖的弃用提示。

| 构建文件                                    | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `release/win-unpacked/resources/app.asar`   | `c267e221470a5141d08957bf280e2a9dfab7b8de3adbe1e413fe49cc90f96ae8` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `d3c58961cbaf4321176cc976ccc9a9beedd6bc8c4b2afa9b1d18474bde5bb731` |
| `scripts/electron-window-smoke.mjs`         | `72f23482040fb20132ea358bd38fdc33b8ad69c2e4277ca0177500bc85aa2694` |

本机 accepted socket 的零应用字节验证已通过；修复后的一次匿名样本取得 JP／IPv6 与有效链路，但源码一致性检查因一行注释变化失败。原报告及精确注释差异核对保留，整轮未改记成功，详见[真实观察与范围](global-proxy-tunnel.md)。没有据此确认三平台授权或物理出站地址族。

15:06 曾有一次全量 Vitest worker 意外退出，没有普通断言失败或已确认的原生退出原因；原失败保留。15:09、15:16 带观测的完整复跑，以及本轮改动后的 15:31／15:38 全量均通过，未将“未再复现”写成“根因已修复”。用户要求保持当前系统代理／TUN，真实关闭后的国内恢复及六平台真实扫码仍待验收。无官方开发者应用，真实 OAuth、Token 刷新／远端撤销、国际队列与业务适配仍未完成；本记录是本轮构建交付，不是整个项目完成声明。

## 历史构建与窗口验证：14:09–14:36

该时点的 `npm run pack` 成功重新生成 **2026-09-08 14:09:11** 构建，包含国内互斥、国际账号记录、本机开发者应用配置和本地授权清除，以及账号数据库写入核验、控制器 GET 连接清理修正。下列旧哈希和验证时间保留作历史，最新可执行文件以上节为准。

**历史验证：14:32 全量 103 文件／3305 项通过；typecheck、全仓 lint 与按仓库原换行设置执行的 `git diff --check` 通过。14:36 新包窗口冒烟通过，退出码 0，整轮约 9.31 秒。** 除下述既有检查，当轮经真实 preload 验证清除本机授权后账号记录仍保留、状态未授权且远端身份为空。当时独立 OAuth／隧道模块尚未装入主入口，不计为生产授权验收。测试仍输出已有的嵌套 button 与无布局环境图表尺寸提示，未将提示隐藏成无警告运行。

窗口脚本保留真实截图和全部功能断言，使用一次性目录，不打开用户账号。此前最终弹窗截图出现长等待；改用持久 CDP 和 30 秒截止仍超时，随后仅增加焦点模拟及两次真实动画帧也失败。这些失败不是验收成功。固定版本 [Chromium 150 的功能定义](https://github.com/chromium/chromium/blob/150.0.7871.212/content/common/features.cc)说明 `CDPScreenshotNewSurface` 用于避免 ForceRedraw 呈现等待；[实现分支](https://github.com/chromium/chromium/blob/150.0.7871.212/content/browser/renderer_host/render_widget_host_impl.cc#L2046)使用新 surface 后复制画面。最后仅给 Windows 隔离 smoke 子进程增加该开关，14:36 最终 1464×881 PNG 在 81 毫秒返回且已目视核验；产品启动未加开关，不将其宣称为一般 GPU 或产品问题的修复。

最终脚本 SHA-256 为 `47f08b409e2e2852b1bcfdfa3163ce385332fb88c1da6a034fb75a6c06997722`；`shot-global-app-editor.png` 为 `9f592574aaf971458993aa3092e1386e6ded21316501819a9ad8ffc83fa19403`。源码语法及格式检查通过；失败轮次未删除断言，也未用旧截图充当最新成功。

上一版 13:27:55 构建的 `node scripts/electron-window-smoke.mjs --packaged` 在 13:30 完成并退出成功。直接启动该可执行文件，使用一次性数据目录验证：壳与 IPC 正常、互斥 strict 模式可见、网络许可不进入 renderer 存储、系统加密凭据可保存与删除；三个国际账号默认未授权、不建分区且国内视图拒绝；本机应用配置可经 preload 保存和读取，合成 TikTok 应用密钥实际加密保存后清除，通用凭据 IPC 拒绝绕过专用清除流程，编辑密码框不回显原值。实验没有打开真实账号目录。运行版本为 Electron 43.3.0、Chromium 150.0.7871.212。

| 构建文件                                    | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `release/win-unpacked/resources/app.asar`   | `dd73c60f36293f7195a763f9ee99a40093b5fb3f4050792d56037085143cfc5f` |
| `release/win-unpacked/短视频矩阵工作台.exe` | `9a0eea31a80273faf09d7bcabdeaeb2be7456c6c8833eacf76ca3de037c0a013` |

上一版源码验证为 13:26 全量 **98 文件／3025 项**通过，typecheck、全仓 lint、diff 空白检查通过。国际账号与本机配置范围见[基础设施记录](global-api-foundation.md)和[填写说明](global-app-setup.md)。下列 12:23、12:30、12:35 的国内实验保留各自时间和范围。

## 业务控制面

新增 `src/main/network/exclusive-business.integration.test.ts`，使用实际 Switch、Runtime、BusinessAccess、CollectScheduler、PublishService、AccountService 及内存 SQLite；Electron 视图、匿名网络与平台响应使用受控替身。21 项集成检查覆盖：

- 六平台在代理开启时，手动采集立即返回等待任务，定时与保活合并且不导航、探测。
- 两次稳定关闭及网络检查后，仅登录状态允许的账号恢复；离线账号不会凭网络恢复自动采集。
- 迟到采集结果、失败与登录成功响应不得提交旧数据、改写登录验证时间、发送上线事件或重新入队；取消后旧回调不能复活任务。
- 上传页与挂文件入口在休眠时直接拒绝，恢复后不自动挂文件或发布。

它与[25 项真实 Electron 请求实验](network-exclusive-runtime-smoke.md)互补：前者验证业务队列与服务语义，后者验证本机接收端实际到达、响应中止及请求取消，不能互相替代。

12:23 全量 **86 文件／2829 项**通过；`typecheck`、全仓 `lint` 通过，生产构建与可执行文件窗口验证通过。构建仍有已有的 renderer chunk 大小提示。

## 上传中途撤销

12:30 的 HTTP/1.1 与 12:35 的 HTTP/2 [实际 Electron 上传实验](network-exclusive-upload-smoke.md)分别 **18／18 通过**。每种协议各验证一次主进程 fetch 和页面 XHR 的 32 MiB 合成上传；接收端施加背压后触发代理开启事件，生产许可同步撤销、连接实际关闭，页面销毁。四次上传均未接收完整正文，关闭后的三类新上传均零到达，退出时资源归零。

H2 前两次失败是误将 Node 兼容流的 `complete`、`end` 当成正文收全；失败报告保留，依据锁定版本源码修正实验判据，并通过完整正文、无取消等反例检查。生产取消代码未为此改动。最终依据接收字节不足、取消事件及协议取消码等事实验收；撤销前已排队的字节仍可能到达，不承诺物理零包。

## 保留的验收边界

用户本轮明确选择“暂不切换，先完成其余验证”。没有关闭或修改当前系统代理、TUN、规则、节点或加密配置；关闭真实代理后国内自动恢复仍待本机验收。合成网络状态不能代替这一结果。

六平台真实扫码及平台页面兼容性、国际 API 授权与业务调用仍未验收。没有据本次构建宣称全部项目完成、国际可用或物理零包。
