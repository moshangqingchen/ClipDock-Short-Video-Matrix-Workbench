# 头像与封面的主进程缓存实现

本轮实现承接定稿第 8.3 节；不是新的总方案。正式主入口仍为 observe。当前没有已审核的真实 CDN 用途与 Session 路径证据，生产下载授权返回 unreviewed，不会因代理可达或观察模式而启动新下载。

## 已接入的路径

- `RemoteMediaService` 独立管理有界图片队列、缓存与本地响应，不占用用户素材表。仅主进程收到并提交的资料／采集结果可以 offer 原始地址；没有 download(url) IPC。
- `media-intake` 在 strict 下将新写入的 avatarUrl／coverUrl 转为空值，事务提交并复核 lease 后才提交可选图片任务。图片失败不改变登录结论、指标结果或发布记录。strict 启动前，旧数据库的两字段在同一事务内清除，不把旧 URL 还原成下载任务。
- `createMediaProjection` 覆盖所有账号返回、账号事件、作品、平台汇总和总览嵌套数据。strict 只从本地索引取得经过格式检查的 `sv-asset://remote/<UUID>` 或 null；不信任数据库保存的图片地址。observe 显式保留原有显示行为。
- `sv-asset` 由现有唯一 protocol handler 按 remote／file／thumb 分派。remote 只读本地缓存；未命中、非法 ID、未知 hostname 与非 GET/HEAD 请求不回落文件或网络。壳守卫只新增这一条本地协议分支，远程 HTTP(S)/WS 拦截不放宽。
- 公开 accountUpdate 拒绝 avatarUrl 输入。备份导出和旧备份导入无条件清空头像、封面引用，包括本地缓存 ID；旧导入先核对原始校验和。缓存目录和原始图片地址不进 BackupPayload。
- Avatar 在 src 改变后可重新显示；三个作品入口统一封面占位，加载失败不回落原远程地址。

## 下载与证据边界

下载器只接受主进程构造的固定 GET：credentials=omit、no-store、redirect=error、no-referrer 和固定图片 Accept。仅支持受限 PNG/JPEG/WebP；先检查格式及尺寸，再用 Electron nativeImage 生成缩略 PNG。请求体、像素、输出、缓存、并发和等待时间有上限。源 URL 仅在有界任务内存中；本地清单只保存对象归属、版本摘要和文件信息。

authorize 依赖必须同时核对：受审媒体用途、统一工厂的原账号 Session、当前传输上下文对 session.fetch 的适用性、图片精确目标及可能地址族的有效许可。可选图片目标不合格时只显示占位，不自动扩展 collect scope，不触发账号撤证以“试一下 CDN”。许可撤销、来源替换、账号删除或退出使旧任务失去结果提交权。

当前生产 authorize 明确为 unreviewed；这是一项尚待真实审核的接线条件。隔离测试中显式注入的许可仅验证缓存和取消实现，不能用于给真实平台签发证明，也不能声称六个平台图片均已恢复。

## 缓存服务的实现边界

`RemoteMediaService.offer(subject, {sourceUrl, sourceRevision})` 只接收主进程提供的来源；subject 是账号头像或指定作品封面。`preview()` 返回本地 URL/null 和有限状态，`responseFor(cacheId)` 只读本地文件，缓存 miss 永不进入下载队列。构造器导出的 `RemoteMediaOrigin` 保留精确协议、host、port；`authorize` 拒绝时服务不调用 fetch，也不改变账号 scope。

- 默认全局 2 个、每账号 1 个并发，最多 256 个图片条目。每项源 URL 上限 8192 字符，来源版本非空；任务合并使用摘要，源 URL 不写清单、文件名、日志或回调。
- 默认下载上限 4 MiB、4 百万像素、单边 4096 像素，缩略图最长边 480，PNG 输出最多 1 MiB。图片头在 nativeImage 解码前校验；拒绝 HTML/SVG、格式与 MIME 不符、APNG/动画 WebP、超限尺寸，以及 WebP 外层尺寸与内帧不一致。真正解码失败仍拒绝，不把头检查当成完整图片校验。
- 默认缓存有效负载预算 32 MiB；并发提交至多额外占用有界的临时输出。缓存条目 LRU 淘汰，更新保留最新来源权：旧下载晚到不能覆盖新引用。磁盘占用／权限导致删除失败时关闭新的下载写入，不把未删除文件当成已释放预算；启动清理失败同样拒绝初始化，不继续从空预算写入。
- 持久 manifest 只含随机 UUID、subject、来源版本摘要、图片内容 SHA-256、字节数和时间。启动和每次响应重新核对受控目录、文件类型/长度、PNG 头尺寸及内容 SHA-256；同长度损坏也返回 404。启动仅清理本模块 UUID 命名的遗留 PNG/临时文件，不递归删除用户目录。
- manifest 使用随机 UUID 临时文件、独占创建 `wx` 与同目录 rename。创建缓存目录前拒绝 reparse 祖先，使用 Windows native realpath 统一长短路径拼写；不把 `ADMINI~1` 与 `Administrator` 误认成不同目录，也不允许 UNC/目录逃逸。原始 source URL 的控制字符、空白、反斜杠、userinfo、非 HTTPS 和规范化后的 IP 字面量均拒绝。
- `suspendAccount()` 同步撤销在途结果提交权并 abort，保留最新内存来源和已有缓存；`resumeAccount()` 显式唤醒，支持同一 tick 暂停后恢复，不丢失旧任务尚未结束时的排队项。`forgetAccount()` 与 `dispose()` 在返回 Promise 前撤权，Promise 只等待任务收尾。回调异常不会影响租约释放或其他图片任务。

服务测试 42 项、独立格式测试 25 项已通过。覆盖原 Session 的固定匿名请求配置、缺审核零调用、latest-wins、并发、撤销 body、永不 settle 的 fetch、同 tick 暂停恢复、401/重定向拒绝、流量/像素/输出限量、磁盘删除失败闭写、重启遗留、内容损坏、reparse 和独占 manifest。Windows 8.3 短路径导致本地缓存误 404 的问题由正例测试发现并修复。

真实 Electron 的 [22 项本机检查](network-remote-media-smoke.md)另行验证 nativeImage、同 Session include/omit 并发、Cookie/Basic 认证隔离、Set-Cookie 不落库、流式撤销及生产 sv-asset 协议。这些结果均使用隔离 Session、本机 TLS 与合成凭据，不替代真实 CDN 审核。

## 验证

模块测试覆盖 strict 数据库清理的事务性、资料与采集提交次序、撤销后不 offer、IPC 注册后的完整投影、本地协议无网络回落、备份边界和组件失败恢复。缓存模块与 Electron 接收端结果分别记录于其测试及 `network-remote-media-smoke.md`；只有实际生成且通过的报告才计入验收。

本机实验只用临时域名、本机 TLS 和合成 Cookie，不发送真实账号凭据。实际国内 CDN 的兼容性、匿名用途审核和目标路径证据仍属于阶段 2 的未完成项目。
