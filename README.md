# 短视频矩阵工作台

面向 Windows 10/11 的桌面应用,用一个窗口管理 **抖音、快手、小红书、哔哩哔哩、百度百家号、微信视频号** 上的多个账号。每个账号拥有完全独立的浏览器环境(Cookie / 本地存储 / 缓存互不串号),登录在平台官方页面完成,账号数据(粉丝、获赞、评论、播放、作品)在账号自己的会话内只读采集并长期记录。

## 功能

- **独立登录环境**:每个账号一个持久化 `persist:sv-account-<uuid>` 分区。切换账号、打开弹窗都只是隐藏 / 显示,不会重新加载页面;二维码不会因为切换而失效。
- **不掉线**:会话型 Cookie 在登录域上自动转为持久化并在变更后写盘;退出前强制 flush;后台保活续期;登录态变化(掉线 / 需验证 / 即将过期)自动检测并系统通知。
- **真实浏览器身份**:账号页面使用与本机 Chromium 同版本的纯 Chrome UA,不带 `Electron/` 或应用名;正常的自动播放、剪贴板与下载行为。不做指纹伪装、代理池、自动互动或验证码绕过。
- **数据观测**:登录成功后立即采集,之后按设置间隔在后台采集(随机抖动、并发上限、429 退避)。账号维度看当前值与日 / 周 / 月增量和趋势,平台维度看账号明细与同平台合计,总览看全局 KPI 与需要关注的账号。
- **发布助手**:选择本地素材与文案,一键打开该账号的官方上传页并把文件填入上传控件,文案一键复制;最终发布由你在平台页面确认。
- **素材库 / 备份**:素材保留在本机原位置只记录引用与缩略图;备份为 AES-256-GCM 加密文件,不包含 Cookie 或浏览器数据。

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
