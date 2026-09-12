# 生产 AnonymousFlowCollector 独立验证

状态：2026-09-08 07:44（北京时间），冻结后的生产采样器完成**一次**实际匿名 `https://api.bilibili.com/robots.txt` 观察，12/12 检查通过。原有 [15/15 观察报告](network-fake-ip-flow-observation.md)及其结果未改写，本轮使用独立 [结果 JSON](network-anonymous-flow-collector-probe.results.json)。

脚本：[electron-anonymous-flow-collector-probe.mjs](../scripts/electron-anonymous-flow-collector-probe.mjs)。默认调用及 `--build-only` 都只构建，不启动 Electron、不读取控制器、不请求公网。只有显式 `--single-public-run` 执行一次；结果已存在时直接拒绝重复运行。本次结果不能作为运行时资格来源。

本次与旧脚本的关键区别是：调用生产 `AnonymousFlowCollector.collect()`，使用其生产 `AnonymousProofProbe` 和私有 observer hook。**不替换 `Session.fetch`，不访问私有 slots，不从包装后的响应时间拼造观察。** NetLog 使用生产 `AnonymousNetLogCapture` 收到的真实私有 capability；只对捕获、输入、连接及 Windows 读取接口加透明计数和脱敏投影。

Session API 也未替换；仅监听 `app` 的 `session-created` 事件，核验新 Session 的 `storagePath === null`，并在采样结束核对原始 `fetch` 引用没有变化。原生 `net.request` 入口的透明检查只放行精确生产 Session 的一次匿名请求，不替换其返回对象。

## 本次实际结果

| 项目 | 实际结果 |
|---|---|
| 生产 collector 调用 | 1，返回 `anonymous-factory-flow-observation` |
| 实际公网原生请求 | 1；没有重试或额外目的地 |
| 当前来源/控制器读取 | 16 轮，含 DNS 与连接读取合计 77 次本机 HTTP |
| A/AAAA 候选查询 | 10 次，均属于该精确 host |
| 完整 PathInput 读取 | 2 轮，含真正 HTTP 后的 postflight |
| 内核连接快照 | 3 次 |
| Windows TCP 读取 | 1 次 |
| 私有 NetLog | 1 次开始、1 次结束，生产解析器成功归属 |
| 匿名 Session / 账号 Session | 1 / 0 |
| 窗口 / WebContents | 0 / 0；实际静默窗口检查 33 次 |
| q / permit | 均未生成 |
| 源码摘要、清理 | 全部源码前后一致；子进程退出 0；原始临时数据删除，清理无拒绝 |

12 项检查覆盖：真实静默窗口、当前选定 loader/来源及读取后附件、生产 collector 可用、唯一原生匿名请求、原 `Session.fetch` 不变、唯一私有捕获、两轮实际输入、真实 Windows socket、没有业务或持久 Session，以及未生成资格/许可。语法与生产依赖打包检查在实跑前通过。没有首轮失败，也没有再次请求。

实际 HTTP 返回 200、未命中缓存，凭据为 omit，证书使用 Chromium 默认校验。内核连接记录为 TUN 入站且该链路 DIRECT；生产 NetLog 解析结果与 Windows 中同一 Network Service 的 Established socket 元组匹配。此处内核实际拨号目的地不是服务端观察的公网出口，仍不构成大陆出口证明。

HTTP 头完成时刻为单调时钟 6577.8815 ms，Windows 核对结束为 8079.7806 ms，第二轮完整输入**实际开始**于 8083.5201 ms、完成于 14653.6239 ms。首轮 DNS 的 1 秒 TTL 原样保留，末期实际重新读取 DNS；没有倒填 postflight 起点或延长旧答案有效期。最终 collector 完成于 14669.9641 ms。上述单调时钟只属于本次隔离进程，不用于跨进程恢复资格。

真实依赖包括当前选定客户端只读工厂、ClashReader、KernelDnsReader、PathInputReader、系统 hosts、Windows 内核 owner/网络/路由/socket 读取器。先取得当前来源，再使用本轮 `getSelectedLoader()` 的冻结附件调用 collector。版本为此独立观察轮的 generation 与当前控制器指纹，没有 Gate 许可。

隔离条件：

- 独立隐藏 Electron 进程、全新临时 userData/sessionData，不导入工作台主入口，不创建账号。`isQuiescent` 每次实际检查窗口和 WebContents 数量均为零、无持久/账号分区、临时数据路径仍匹配；新窗口/WebContents 事件立即撤销。
- 仅允许一个生产匿名池 Session。原生请求入口透明校验实际 Session、固定 GET `/robots.txt`、`credentials: omit`、手动重定向及一次请求预算；不跟随额外目的地。原 `Session.fetch` 函数引用最后再次核对。
- Node HTTP 只可读取 `127.0.0.1:9790` 的固定控制器接口及该 host 的 A/AAAA；阻止 Node 公网 fetch。Chromium 解析范围限制到该精确 host，默认 Session 拒绝请求。此脚本不是全机物理抓包或操作系统出站过滤证明。
- Collector 执行完整输入读取、capture hook、DNS/内核连接/真实 socket/Windows 核对及 HTTP 后的真正 postflight。请求、collector、脚本和父进程都有固定期限，失败不补第二次公网请求，不延长原输入 TTL。
- 捕获原文仅在独立临时空间与内存，生产 capture 停止并删除后只保存摘要、解析结论和脱敏地址；不保存源码配置、DNS 原地址、NetLog 正文或业务数据。
- 退出先撤销，再等待 collector/providers 的真实在途工作和 capture 清理；父进程核验精确临时目录后清理。结果记录各阶段计数、失败、清理和源码摘要前后一致性，失败或未完成不能写成零请求。

声明 `ipv4` 只是此次单个已观察目标的采样范围，不是业务仅 IPv4 的断言。本轮不生成 q，不设置 `flowReviewed`，不签任何账号许可，也不启用 strict。即使成功，也只完成生产采样器的一条当前匿名观察。
