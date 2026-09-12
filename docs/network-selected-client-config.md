# 已选客户端配置读取工厂

本轮补齐可打包的只读输入：`SelectedClientConfig` 将当前明确选中的猫猫云 5.5.6 客户端与现有 `EffectiveConfigSource` 连接起来。它仍只产生本机配置候选和已选 loader 合同，不产生路径资格、出口证明或 Gate 许可；本轮没有改主入口、启用 strict 或修改 mihomo 配置。

后续接线更新（2026-09-08）：主入口已通过 [ProductionProofRuntime](./network-proof-source-runtime.md) 接入明确目录设置和来源生命周期；保留 observe 与缺真实资格时不可用的边界。`whenIdle()` 等待实际旧来源 I/O，供重配置和退出使用。下文首次模块实测记录仍保留原执行范围。

## 最小调用接口

```ts
const configuration = new SelectedClientConfig({
  resourcesPath: selectedResourcesPath, // 主进程明确选择的本地目录
  readController: signal => clashReader.read(signal),
  onChange: snapshot => { /* unavailable 时撤销依赖它的资格 */ },
});

// 必须在 PathInputReader 实际观察轮开始前完成，不能在读完 inputs 后补造 selection。
const loader = await configuration.select();
if (!loader) return unavailable;
// PathInputReader 的 configuration 可直接使用该对象的 read()。
// 后续关联仍须核对 getSelectedLoader()，不得继续使用已撤销的 loader 引用。
```

`read()` 不会自动选取、搜索或回退到另一个文件；未选择即 unavailable。`getSelectedLoader()`、`getSnapshot()`、`invalidate()`、`dispose()` 为主进程接口。候选到期、文件/解析/控制器读取失败均撤销 selection；后续须在新观察轮前重新 `select()`。同一读取合并，取消后立即返回不可用，但未退出的实际文件读取仍占有单一工作槽；dispose 后旧回调不能恢复资格。

## 固定版本与解码边界

- 仅接受当前已审核的 `package.json` SHA 和 `src/main/main.js` SHA；前者绑定 MAOMAOYUNAPP 5.5.6 及其入口字段，后者为 `2e66e4eb0592dc7d4c2be715d325784a3e473225ca149929963430406ef6e85c`。
- 主程序只保存原文中 12 个数据片段的固定坐标及 base64/RC4 算法。每次先验原文完整摘要，再读取这些数据；没有执行客户端 JavaScript，也没有将 key/IV 值写入源码、构建产物或报告。解密后的 YAML 只交给现有候选读取器，仍受体积、解析及控制器字段比较限制。
- 使用 Electron 原生 ASAR 文件系统和 Node 内建 crypto/fs。构建输入不含探索时使用的 Babel、TypeScript、`@electron/asar` 或 VM。Electron 的 `lstat(app.asar)` 呈现为目录；内部文件仍逐个按固定摘要核对。
- `resources/extra/config.yaml` 是这个固定客户端主程序中已审核的生产路径。规范路径、目录/文件类别与非符号链接检查在读取前后执行；UNC、设备路径、ADS、含控制字符等选项被拒绝。支持范围没有扩大为任意客户端或任意配置发现。
- 该客户端 `package.json` 的入口为 `main.node`。本轮没有审计其内部加载行为或证明内核内存中实际已加载的 payload。loader 合同继续保留既定的 `KNOWN_SELECTED_LOADER_USES_SELECTED_SOURCE` 假设；规则比较相同不消除这一假设。
- 每次候选读取前后重新核对当前固定文件，旧报告不作为任何输入。版本或字节变化即不可用，不能重新计算摘要后自动批准新版本。

## 当前内核兼容附件（2026-09-08）

`KnownSelectedLoaderContract` 增加可选的只读 `kernelCompatibility?: SelectedKernelCompatibility`。`select()` 只建立原有来源选择；附件要等本轮 `read()` 取得实际控制器版本、配置候选，并完成内核文件前后核对后才可能生成：

```ts
const snapshot = await configuration.read();
const currentLoader = configuration.getSelectedLoader();
const compatibility = currentLoader?.kernelCompatibility; // 缺失表示兼容未知
```

当前唯一兼容 profile 来自 [8 组合本机实验](./network-mihomo-ipv6-fake-pool-compatibility.md)：固定 `resources/extra/mihomo-windows-386.exe` 的 SHA-256 必须为 `d354a6b31e89db289a46fffd8913c2da4ee1e2218882d75cacc49c41b425dde9`，本轮 `ClashReadResult.version` 必须精确为 `424c2ef`。文件只读、上限 64 MiB，仍受原有单飞、10 秒读取超时及实际 I/O 排空规则约束；没有执行该二进制。二进制路径摘要和字节摘要纳入选中 artifact 的 identity，报告 JSON 不参与运行时读取。

附件绑定 selection ID、来源/解码身份、source generation、配置文件/路径政策/控制器摘要，并保留实际控制器采样时间、本轮核对时间和候选原有过期时间。它不重置候选期限。每次更新生成新的冻结 loader 对象；其他操作已经持有的旧引用不会被补上或续期，调用方仍须核对当前来源与版本。

内核文件最初缺失、不可读、超限或摘要未知时，已支持的客户端配置仍可产生候选，附件保持缺失；实际控制器版本不符也不生成附件。已选择之后二进制出现、消失或字节变化会使 artifact identity 不一致，撤销旧来源和附件；实际旧读取排空后须重新明确选择。来源或附件到期、来源/政策/控制器绑定不符时不能继续使用旧兼容记录。

分类器只在启用 fake-IP、`fake-ip-range6` 确实缺项且附件当前有效时，应用“该精确构建没有缺省 IPv6 fake 池”的有限事实；显式空值、非法值和特殊地址仍为未知，显式池仍按原 CIDR 分类。这不证明正在运行的进程加载了这些字节，继续保留既定 selected-loader 观察假设；也不构成业务单族约束、解析等价、DIRECT、大陆出口或 Gate 许可。配置候选的 `runtimeConfigurationProven` 仍为 false。

本次兼容接线的四文件定向回归共 246/246 通过（含原配置关联回归），主进程类型检查和定向 ESLint 通过。下列首次来源实测保留其原始时间和计数，不混作此次兼容接线的实测。

## 实测与回归

执行：`node scripts/electron-selected-client-config-smoke.mjs`。

2026-09-07 20:49:42 UTC 的 Electron 43.3.0 最终实测通过 12/12 项检查。当前选定原生 ASAR 的固定包、主程序和数据解码可用；有效配置与实时本机控制器的 3341 条规则比较一致。观察为 rule + TUN，内核版本 `424c2ef`，控制器 fingerprint 为 `5cc197058efc435fabbd518ff97564995e80b4af5a09f8961b989ce627db14ee`。结果为 `local-config-candidate`，`runtimeConfigurationProven` 保持 false。

本次使用临时 userData/sessionData，没有窗口、账号或分区。计数为一次 ClashReader 读取、四个固定本机 GET、零 Session 创建、零 Electron 网络请求。当前控制器无需秘密；未访问任何账号 Cookie/Token、外部 HTTP、二维码或平台 API，配置文件前后摘要相同。源码构建输入摘要在结束时全部保持一致。

22 项单元测试使用合成固定版本和文件系统/候选读取器边界，覆盖未选择、文件或路径变化、摘要失配、前后核对、并发、过期、取消、超时、dispose、旧回调和通知期间的同步撤销/重入；真实原文解码与原生 ASAR 行为由上述 Electron 实测验证。定向测试、主进程 typecheck 和三个源文件的 ESLint 通过。

首次实测由于将 ASAR 错判为普通文件而在控制器读取前拒绝。两次失败结果分别保留为 `network-selected-client-config-live.20260907T204429851Z.results.json` 和 `network-selected-client-config-live.20260907T204503890Z.results.json`；后续成功未覆盖这些失败证据。

机器可读结果：`network-selected-client-config-live.results.json`。这完成了“当前选定源可读”的适配，尚不等于生产已具备完整证明：PathConformance 的当前 loader/配置关联、传输上下文、解析对应关系和实际路由资格仍须独立提供与验证。
