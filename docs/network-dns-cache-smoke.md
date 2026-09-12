# Electron DNS 缓存实验

执行时间：2026-09-07T20:42:09.426Z。

独立临时 Session 只查询 api.bilibili.com 的 A 记录；webRequest 拒绝 HTTP 请求。没有账号、Cookie、系统 DNS 或 mihomo 配置改动。

依次验证：空缓存仅本地查询失败 → 一次匿名解析 → 缓存命中 → closeAllConnections 后查询 → clearHostResolverCache 后查询。报告不保存解析地址。

结果：通过。

- 通过：初始仅本地缓存查询无结果
- 通过：匿名解析取得 A 记录
- 通过：仅本地查询命中刚取得的记录
- 通过：关闭连接后 DNS 缓存仍在
- 通过：显式清理后仅本地查询不再命中
- 通过：未产生 HTTP 请求

这只验证 Session 的 DNS 缓存 API 行为，不证明 DNS 与内核解析一致，也不证明大陆出口或地址族约束。

生产改动已按这项结果接入：严格初始化维持 setProxy(direct) 完成后立即关闭连接，再清解析缓存；撤销仍先停止旧页面/worker 和连接，待停止完成后做最终 DNS 清理。清理失败不恢复 readiness；匿名 TLS/出口工厂在每轮新请求前也清缓存。账号 Cookie 与登录存储保留，观察模式不因此修改业务 Session。原生后台 DNS 任务是否存在更晚的完成窗口未在本实验中测量，不能声称物理零竞态。

当前清理与匿名模块 6 文件 168 项定向测试通过；全项目 65 文件 1616 项测试通过，HTTP/1.1 44 项、HTTP/2 50 项、B 站 45 项受控 Electron 回归通过。首次脚本因 entry-point 顶层等待 app.whenReady 未完成而没有取得子报告，原结果保留为 `network-dns-cache-smoke-startup-initial-observation.results.json`；修正启动时序后的本次 6 项结果没有倒填首次观察。

依据：[Electron resolveHost](https://www.electronjs.org/docs/latest/api/session#sesresolvehosthost-options)、[clearHostResolverCache](https://www.electronjs.org/docs/latest/api/session#sesclearhostresolvercache)。
