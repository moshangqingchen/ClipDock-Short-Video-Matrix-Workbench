# 首条有限客户端目录审核

已新增主进程 `resolveReviewedOperationCatalog(input)`，并由 `src/main/index.ts` 显式选为 Runtime 的目录解析器。只启用下述已审核客户端分支：生产 enforcement 仍为 observe，来源门面已接入但实际路径资格仍缺省，不能因此产生真实出网许可。其他目录分支继续未审核。

审核只覆盖 `bilibili / check-status / activePageOrigin:null`，且没有导航目的地。required origins 与 reviewed request range 均仅为 `https://api.bilibili.com:443`。原 Session 上的 GET、最多 5 次同 HTTPS origin 重定向、明确 JSON/401 认证合同、未知回应和未发探测时保留认证状态，构成这份有限客户端行为审核。有页面的 B 站、扫码、profile、collect、其他平台和其他操作继续未审核；省略页面状态也不等于显式无页面。

当前依据是 [2026-09-07 22:28:32.389–22:28:35.812 UTC 的 45 项受控实测](./network-bilibili-no-view-client-review-2026-09-08.results.json)，冻结副本 SHA-256 为 `41dfdfe30699333a6302844e039a9ac5c273ca1e14edac14f3788264a1846165`。其含 45 项 bundle 输入摘要，全部请求仅至本机 TLS，Cookie 全为合成值。[先前审核副本](./network-bilibili-no-view-client-review-2026-09-07.results.json)保留，未覆盖。

本次重新审核由其它五平台的未确认回应修复引起：共用 detector 文件改变，但 B 站严格回应解析、原 Session GET 和同源重定向合同未改。共用无观察路径原本已返回 unconfirmed；删除的普通 URL 启发式对该分支不可达。B 站主进程阳性回应但没有预期 Cookie 时仍保留旧逻辑，未将此异常组合纳入新的平台兼容性承诺。源码复核后重新执行全部 45 项，才更新绑定的 detector 摘要和审核 ID；其余七项实现摘要、固定源版本、选择键和请求范围不变。

详见 [实验及修复记录](./network-bilibili-check-status-smoke.md)。这份审核不宣称真实平台接口已兼容、真账号认证判断已通过、扫码完结，或公网出口、DNS/地址族/进程归因已合格。

审核记录写死当前 `sourceVersion`、`selectionKey` 和审核实现摘要，不根据当次解析结果自动生成匹配凭据。运行时还要求构建包版本与实际 Electron 均为 **43.3.0**。绑定范围限以下 8 个文件，不扩展为全仓或整张网络证明图：

- `src/main/browser/login-detector.ts`
- `src/main/network/gated-session-probe.ts`
- `src/main/services/account-service.ts`
- `src/main/data/scheduler.ts`
- `src/main/db/repositories/accounts.ts`
- `src/main/network/business-access.ts`
- `src/main/network/operation-catalog.ts`
- `src/shared/platforms.ts`

`scripts/reviewed-operation-build.mjs` 一次读取这些文件，计算摘要，同时由 esbuild 插件把**同一份源码快照**提供给编译器，避免摘要与实际编译内容读取时序不同。现有 `build-electron.mjs` 只向 main build 注入这份声明，preload 和 renderer 不接收。打包后无需读取源码文件，也没有新生成文件或证书系统。8 项中任一摘要缺失/改变、版本不符、来源/选择键变化，都只返回原未审核目录；独立脚本未注入构建声明时同样默认未审核。不能把这份构建绑定理解为抗恶意篡改的代码签名，受信任的主进程审核文件和构建配置仍是项目代码的一部分。

验证：新增 **11 项测试通过**，测试直接复用生产 build helper，以 esbuild 生成内存 ESM 产物并导入解析器，覆盖唯一正例、其余 47 个平台/操作组合、有页面/省略页面/导航目的地、缺少声明、构建或运行版本变化、8 个摘要逐个修改/缺失、平台元数据变化，以及拒绝外带 review 和返回对象污染。ESLint、typecheck、实际 `npm run build:electron` 通过。此模块只产生目录元数据，不产生请求或出网许可。
