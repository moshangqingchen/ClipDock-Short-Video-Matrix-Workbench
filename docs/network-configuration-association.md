# 当前配置来源关联

`src/main/network/configuration-association.ts` 消费生产 `CurrentPathInputs` 和主进程明确选择的 `KnownSelectedLoaderContract`，不读取历史报告、不重载配置、不发送网络请求、不接 IPC，也不直接操作 Gate。

```ts
associateCurrentConfiguration({ inputs, loader }, nowMono)
// { valid: true, association } | { valid: false, reason }
validateConfigurationAssociation(association, inputs, loader, nowMono)
```

加载契约包含当前应用的 selectionId、已核对客户端的 loaderProfileId、预先选定的 sourcePathIdentity、decoderIdentity、原始资格记录引用和 selectedAtMono。资格引用必须指向调用方实际保留的主进程加载方式/路径/解码器记录。这个模块不产生那些事实；任意非空字符串、渲染层开关或旧报告摘要不能代替真实资格记录。调用方不能根据刚收到的 candidate 倒填选择，或只因另一个文件的规则相同便把它当成已选来源。

关联核对本轮文件来源、解码器、sourceGeneration、文件及相关政策摘要、全部有序规则、共有显式字段、真实 DIRECT 元数据、controller 可见版本、内核 owner/PID/创建时间/监听范围、OS 网络摘要在前后窗口一致。时间使用各读取器自己的单调时间；旧共享采样、窗口外记录、过期、换路径/解码器/owner 或读取结果缺失均拒绝。可执行路径保持明确的 null 不会单独阻断不依赖该字段的关联。

成功记录的模型固定为 `known-selected-loader-observation`，保留两个支持假设：已知选定加载器仍使用选定来源；未被观察到的外部隐藏配置替换不在支持范围。它不宣称接口已返回完整生效配置，不抹去外部改配置的观察竞态。`candidate.runtimeConfigurationProven` 和关联记录自身的该字段都保持 **false**。

记录绑定当前 inputSampleId、应用/来源代际、来源及解码器身份、文件/政策/controller/内核/OS 摘要和实际读取时间。有效期取当前输入及配置期限与最早相关采样时间加 15 秒的最小值；检查时不重新给旧样本加有效期。时间默认值仍服从阶段 2 冻结结果。

关联只能由本模块在当前进程构造。验证拒绝 JSON 反序列化、浅复制、换轮次或换加载契约的对象；它不提供任何从旧报告恢复关联或许可的入口。应用启动仍从 checking 开始，适配器明确选择已核对来源后重新读取。变更/失联撤代由外层生命周期处理。

配置关联与业务许可分开：相同且可关联的代理/global 配置也可以被描述，本模块不因此提供 DIRECT、DNS 终选、地址族、TLS、大陆出口或账号权限。现有 `conformance` 来源仍须独立提供其实际路径符合性记录。

验证：55 个定向单元测试、Electron TypeScript、目标 ESLint 通过。测试覆盖可成功关联的实际结构、保留缺项、换来源/解码器、文件/规则/政策/controller/owner/OS 变化、原始采样窗口和期限、调用方修改隔离、复制及旧记录拒绝。新增测试使用真实 EffectiveConfigSource 读取本地合成 YAML，确认初始来源代际 0 可以关联；Gate 代际仍须大于 0。

2026-09-08 补充：生产输入现在含系统 hosts 的前后读取。关联核对真实系统文件来源、解析版本、目标集、文件内容/身份、映射和原始窗口；任一变化、只提供半轮、测试文件或错误目标均拒绝。关联指纹含这组依赖，无法用旧关联套用新 hosts 内容。读取缺项的历史实验保留缺项，不意味着文件为空；此补充已通过回归测试，下节历史实测没有重新标成包含该读取的新实验。

## 本机真实只读组合

[当前结果](./network-configuration-association-live.results.json)来自 `docs/.compare/configuration-association-live-read.mjs`。2026-09-08 03:34 前后，这一轮实际读取当前客户端主脚本，在内存静态核对生产 BIN_PATH、CONFIG_PATH 和 spawn 的数据目录参数；独立解析已选来源 realpath，在取证前固定加载契约。没有执行客户端启动逻辑或重载，没有从旧报告恢复任何许可。

随后对 B 站固定 API 的双族候选调用真实 PathInputReader、配置/owner/OS/DNS/路由读取器，约 4.46 秒取得 observed。关联创建和当前验证均成功，复制后的关联拒绝；加载器脚本、控制器及 8 个模块源码哈希在本轮前后保持一致。结果仍明确 `runtimeConfigurationProven: false`，依赖本节所述已知加载方式的观察支持假设，没有确认隐藏运行 payload 或出口。

首次实际组合因校验器误把来源初始代际 0 当成非法值而失败，记录保留在 [首次观察](./network-configuration-association-initial-observation.results.json)。修复的是消费端与真实生产者的代际约定，没有修改生产者初值或给过期证据加时间；同类路径校验也补了 0 代际回归。当前实测没有账号会话、公开 HTTP 请求、配置修改或国内许可；内核 DNS 查询仍由真实运行内核处理。
