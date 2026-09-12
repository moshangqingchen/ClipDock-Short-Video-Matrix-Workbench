# 短视频矩阵工作台

面向 Windows 10/11 的桌面应用,用一个窗口管理 **抖音、快手、小红书、哔哩哔哩、百度百家号、微信视频号** 上的多个账号。每个账号拥有完全独立的浏览器环境(Cookie / 本地存储 / 缓存互不串号),登录在平台官方页面完成,账号数据(粉丝、获赞、评论、播放、作品)在账号自己的会话内只读采集并长期记录。

## 功能

- **短视频创作者平台**:主导航统一进入创作者平台，页面内切换国内六个平台与 YouTube、TikTok、X。国外可按平台筛选，默认展示独立网页账号环境；“官方 API（可选）”需主动打开，API 授权不会显示成网页登录成功。
- **独立登录环境**:每个账号一个持久化 `persist:sv-account-<uuid>` 分区。切换账号、打开弹窗都只是隐藏 / 显示,不会重新加载页面;二维码不会因为切换而失效。
- **登录态保留**:会话型 Cookie 在登录域上自动转为持久化并在变更后写盘;退出前强制 flush。国内网络允许时执行保活与登录探测;网络休眠不清 Cookie、不改登录结论、不发掉线通知。
- **国内直连／海外代理分流**:规则模式下国内与国外平台同时启用。国内每条新 CONNECT 验证实际 DIRECT 路由及本机内核归属，已建立的连接随当前网络与规则观测续期；不再依赖每 15 秒访问 IP 查询网站。代理关闭时国内照常直连；全局模式或无法确认规则通路时暂停国内。
- **国际账号与官方 API**:独立管理 YouTube、TikTok、X 的本机账号记录，不创建浏览器分区；本机应用配置、主动官方授权与取消、手动读取、本地快照及按需 Token 刷新已接入。TikTok 可单独授权草稿上传，传到收件箱后由用户确认发布；YouTube 支持单独授权视频上传，默认私密，按服务器确认位置续传。X 上传尚未开放。当前尚无真实平台验收，代理开启不等于账号已授权。
- **真实浏览器身份**:账号页面使用与本机 Chromium 同版本的纯 Chrome UA,不带 `Electron/` 或应用名;正常的自动播放、剪贴板与下载行为。不做指纹伪装、代理池、自动互动或验证码绕过。
- **数据观测**:登录成功后立即采集,之后按设置间隔在后台采集(随机抖动、并发上限、429 退避)。账号维度看当前值与日 / 周 / 月增量和趋势,平台维度看账号明细与同平台合计,总览看全局 KPI 与需要关注的账号。
- **发布助手**:选择本地素材与文案,一键打开该账号的官方上传页并把文件填入上传控件,文案一键复制;最终发布由你在平台页面确认。
- **素材库 / 备份**:素材保留在本机原位置只记录引用与缩略图;备份为 AES-256-GCM 加密文件,不包含 Cookie 或浏览器数据。

## 网络模式

规则模式支持国内 DIRECT 与国外代理同时使用；国内新连接必须通过实际连接验证。网络、规则、控制器配置或内核身份变化时撤销旧通路，观测过期也暂停。仅打开代理客户端窗口不等于启用代理。网络状态只保存在主进程内存，重启后先检查，不沿用上次的绿灯。

国际授权与手动官方读取已接入；实际使用须有官方开发者应用、有效代理证据和对应权限，尚未完成真实平台验收。打开页面只读本机快照与任务记录，点击“读取数据”会提交可取消的任务；代理不合格时等待，重启后保留意图并重新检查，主进程按需刷新 Token。TikTok 普通授权仅申请基本资料，草稿按钮另申请上传范围，统计与作品列表仍缺授权范围。TikTok 草稿和 YouTube 上传队列已接入，X 上传和远端撤销仍未完成；“代理模式”不代表账号已经授权或能发布。国内发布助手继续由用户在官方页面确认，恢复网络后不自动重新挂文件或发布。

当前网络实现和实测记录见[规则模式国内外同时使用](docs/规则模式国内外同时使用-20260912.md)。采用“国外网页登录为主、API 可选”的产品方向，已交付分类、独立官网入口与可选工具区；范围见[网页入口调整](docs/global-web-entry.md)。
国际接入进度见[官方 API 基础设施记录](docs/global-api-foundation.md)，本机填写方式见[国际应用配置说明](docs/global-app-setup.md)。
读取字段与权限见[官方读取适配器](docs/global-read-adapter.md)，Token 轮换边界见[刷新合同](docs/oauth-refresh-contract.md)，等待与取消见[国际读取队列](docs/global-jobs-delivery.md)。
国际持续连接支持[同一隧道续证](docs/global-proxy-tunnel.md)，证据失效仍立即停止。[TikTok 草稿上传](docs/global-tiktok-draft-delivery.md)和[YouTube 可恢复上传](docs/global-youtube-upload-delivery.md)支持等待代理、取消、原任务进度核验及恢复；传输完成不会误报为已发布，真实平台使用仍待验收。
已有国际授权记录可在“国际账号”中清除本机授权，保留账号记录；此操作不撤销平台侧的应用授权。授权组合模块及三平台兑换的实施边界见[生命周期记录](docs/global-oauth-lifecycle.md)。

## 开发

```powershell
npm install --legacy-peer-deps
npm run dev            # Vite + Electron(热更新)
npm run typecheck
npm run lint
npm test
npm run smoke:electron # 构建并启动一次,验证壳与 IPC 正常
```

`npm run dev:renderer` 单独启动 Vite 后可在浏览器中打开 <http://127.0.0.1:5173> 预览 UI(使用内置演示数据,不接触真实平台)。

## 构建与分发

```powershell
npm run build          # dist/(渲染层)+ dist-electron/(主进程 + 预加载)
npm run pack           # release/win-unpacked
npm run dist           # portable 单文件 + NSIS 安装器
```

`启动工作台.cmd` 以 unpacked 版本运行并把数据放在项目目录的 `workbench-data/`(便携用法);`启动工作台-兼容模式.cmd` 关闭 GPU 加速,用于无法启动 Chromium GPU 进程的受管控电脑。

当前未配置代码签名证书,Windows 会提示“未知发布者”;正式对外分发前请配置组织的 Authenticode 证书。

## 目录结构

```
src/
  shared/      平台契约(platforms.ts)、类型、IPC 通道与 zod 校验
  main/
    browser/   user-agent、account-session、cookie-guard、navigation-policy、view-pool、login-detector
    data/      collectors/(六平台会话内采集器)、scheduler、read-model
    db/        node:sqlite + WAL、迁移、repositories/
    ipc/       handlers/ + register(仅壳主框架可调用)
    services/  account-service、asset-service、publish-service
    security/  backup(AES-256-GCM)
    network/   Windows代理检测、互斥切换、账号请求守卫、匿名诊断
    api/       国际账号模型、OAuth事务、加密Token提交与显式代理传输
    window/    BaseWindow + Shell WebContentsView
  preload/     最小 typed bridge(无 Node 依赖,沙箱 CJS)
  renderer/    React 19 + zustand + recharts;features/ 按页面划分,components/ui 为设计系统
scripts/       build-electron(esbuild)、dev 启动、Electron 冒烟、CDP 调试
```

## 平台契约

[`src/shared/platforms.ts`](src/shared/platforms.ts) 是唯一的平台知识点:登录链路域、验证码域、登录路由、登录 Cookie 键、会话 TTL、创作者中心各页面地址、登录探针接口。平台页面变化时改这一处即可。

采集端点位于 `src/main/data/collectors/*`。每个采集器按候选端点依次尝试,失败时退化为读取页面文本,不伪造数据;返回 401 或“未登录”负载会触发登录状态复核。

## 安全边界

- 渲染层永不接触 Cookie;账号页面运行在 `sandbox: true` 且无 preload 的 WebContentsView 中。
- 主进程 IPC 只接受壳的主框架调用,所有入参经 zod 校验。
- 摄像头 / 麦克风 / 屏幕捕获权限一律拒绝;下载走系统保存对话框。
- 仅“重置登录环境”和“删除账号”会清理分区数据。
- 同一台电脑上多个账号共享 IP 与硬件特征,与在 Chrome 中开多个 Profile 一致;应用不承诺“绝不封号”。

## 数据目录

默认 `%APPDATA%\short-video-matrix-workbench\`(可用环境变量 `SV_WORKBENCH_DATA_DIR` 覆盖):

- `workbench.db` — SQLite(账号、数据快照、作品、素材引用、发布记录、设置、审计)
- `profiles/Partitions/sv-account-*/` — 各账号独立的浏览器数据
- `thumbnails/` — 素材缩略图
- `window-state.json` — 窗口位置

## 仓库文件维护

仓库保留源码、测试、维护脚本和技术文档。`output/`、`docs/.compare/`、诊断脚本生成的 `docs/*.results.json` 等报告、截图及本机工具记录不提交。历史文档中提到的原始报告属于本机运行产物，需要时通过对应脚本重新生成；测试使用的 fixture 和规则示例仍保留在仓库中。
