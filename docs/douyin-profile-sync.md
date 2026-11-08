# 抖音精选昵称与头像同步

## 问题与现场验证

抖音精选网页已不提供旧代码依赖的 `__INITIAL_STATE__.userStore` 和 `currentUserStore`。旧主页检测只能从顶栏 `/user/self` 链接读取头像；被动资料观察器又只接入创作者后台，导致头像在正常打开主页后能更新，昵称仍保留旧值。

本次只读核对中，同一账号的官方 `/user/self` 页面显示“心愿_AIGC”，工作台仍显示“陌上轻尘”。修复后的主页脚本在该已加载页面上返回 `online`、正确昵称和有效头像，未修改平台资料。

## 同步来源

- 被动观察精确的 `https://www.douyin.com/aweme/v1/web/user/profile/self/`。只接受成功 `status_code`、根级 `user` 和有效正数 `uid`；不新增、重放或签名账号请求。公共作者 `/profile/other/` 和携带目标用户参数的请求不参与。
- 在精确 `/user/self` 路由读取当前资料区的昵称。要求唯一可见 `data-e2e="user-info"`、唯一标题及相邻头像，并将头像资产与已登录顶栏比对。不同尺寸、格式与签名仅在比较时归一；下载地址保持原样。推荐流、文章、公共个人页、隐藏或冲突结构不导入昵称。
- 继续沿用账号服务的资料版本检查、更新通知和头像缓存入口；资料响应不替代主页登录确认。

## 官方静态证据

从已加载官方页面取得脚本 URL，再匿名读取静态文件，确认：

- [client-entry~4.d357451c.js](https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/client-entry~4.d357451c.js) 区分自身与作者接口，并从根级 `user` 提取资料。
- [client-entry~63949b7a.62046bdd.js](https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/client-entry~63949b7a.62046bdd.js) 映射昵称、头像与抖音原生统计字段。
- [client-entry~7.23b7b299.js](https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/client-entry~7.23b7b299.js) 对自身响应使用成功状态和 `user.uid` 判断。

本机证据清单位于 `output/douyin-profile-fix/official-static-evidence.json`，含 URL、SHA-256 和必要短摘录。未抓取完整真实账号响应或凭据。

## 验证范围

主页及身份回归覆盖新旧昵称、签名与尺寸不同的同一头像、缺失旧 store、作者资料、目标用户参数、隐藏元素、多根冲突、加载过渡和错误响应。另回归账号同步、资料采集与数据库更新，并执行类型检查、ESLint 和生产构建。

手机或其他浏览器修改资料后，工作台仍需正常加载到新的官方资料响应或自身页面才会更新。当前已打开页面如果尚未取得新资料，不能凭本机时间推断资料已变更。
