# 当前路径符合性适配器

2026-09-08。新增 `src/main/network/path-conformance.ts`，连接现有真实读取器与 `ProductionProofSource` 的 `conformance.read / bindSamples`。本轮没有修改 bootstrap、网络配置、既有 source/route 合同，也没有运行公网或账号请求。

`PathConformanceAdapter` 构造时接收主进程已选择的当前 loader 和 `RetainedPathQualification`。缺少资格返回 null，`lastFailure()` 提供固定主进程原因码。构造本身不读网络或 OS。

## 资格从哪里来

保留资格包含原 `CurrentPathInputs`、原 loader、实际 `associateCurrentConfiguration()` 产生且仍保留在内存中的 association、原路径样本、工厂 profile、Electron/启动 TCP 资格、审核后的 origin/可能地址族、resolver 观察及显式跨工厂等价覆盖。

adapter 不实施这些原资格实验，也不把一组 evidenceId、候选 JSON、配置字段或 socket 唯一性升级成资格。原 association 的品牌仅核对配置关联来源，不证明 DNS/流归因；资格生产者仍必须保留路径、选族、resolver、工厂审查记录。原始 association 的 JSON 副本会被拒绝，不能从 docs 历史结果恢复放行条件。当前实际内核物理 socket 候选若 `flowAttribution=false`，仍不足以填入已归因的 RouteConformanceSample。

账号 context 来自 Runtime 的真实请求范围；所选资格须覆盖实际账号工厂行为和匿名工厂。没有额外的 context 证书、注册者或同 PID 要求。工厂 resolver 可以采用实际观察，也可以引用从已观察 profile 到另一个 profile、明确覆盖地址族的审核等价记录；仅把名字放进 profile 数组不够。单族约束及回显工厂的选族对应必须已有有效原证据，不能用出口响应正文的 IP 类型或一次 DNS NODATA 代替。

## 每轮做什么

1. 复制输入；核对当前 Gate 版本、真实 controller 快照、有序规则、当前配置关联及原资格依赖。`runtimeConfigurationProven` 保持 false，沿用已冻结的所选 loader 观察模型。
2. 真实 startup 事实来自 `readChromiumTransportState(app)`：版本/profile 匹配、ready 前配置、disable-quic 仍存在。每轮检查事实，不重复 QUIC 资格实验。
3. 只处理请求范围内所需族的当前 real DNS 候选。无关另一族缺失不会单独拒绝已约束单族；Chromium 的 fake-IP 与内核真实目的地址须有单独保留的实际映射，unknown 不猜测。真实地址分支继续核对集合相等，新增 fake-IP 分支见[对应模块](./network-resolver-flow-mapping.md)。
4. 物理源必须来自原实际路径样本。按源合并，最多 16 个目的地址一批，调用生产 `WindowsRouteSelectionReader` 的源地址条件查询。保留原未约束 OS 路由，包括 TUN 接口；条件查询本身不宣称新 socket 或内核实际选择。
5. 用原样本、当前物理投影和有序规则运行真实 `verifyRouteApplicability()`。原 route.binding 先对原 inputs 核对，之后才建立独立的本轮 binding。原样本和日期不改，原有效期不会被延长。
6. `bindSamples` 按实际 factoryId/context/origin/digest/原日期匹配当前工厂路径资格；检查 source 提供的 branded route 结果，生成现有绑定类型。缓存复用保留原始 path 和采样日期，仅更新本轮适用性。

本轮内存记录按完整 inputs/conformance 内容核对，兼容 source 的 structuredClone；不会要求它把同一个对象实例传回来。取消、超时或撤销先结束公开等待，真实 OS 工作及 `whenIdle()` 未结束前继续占用读取槽。getter 同步触发撤销也会再次核对，不能把已清理记录写回来。

原资格依赖包括来源/decoder、有效路径 policy、DIRECT policy、kernel owner 和 OS 指纹。当前配置或规则完整 hash、sourceGeneration、Gate generation 变化时可重新检查；它们不单独迫使重做 socket。路径相关依赖变化则现资格不可用。未要求每目标公网回显、每轮 socket、完整运行 payload 或完整内核源码。

资格的 `qualifiedAtMono` 是实际完成后验审核的时刻，不必早于历史 DNS 到期。原 association 仍按原 `checkedAtMono` 验证，fake-IP 映射的实际发送到响应头必须处于原有效窗口，全部观测与后验必须早于真实审核时刻。每次使用还需未过期的资格、新鲜的当前配置关联与 DNS；这不是延长历史答案或倒填时间。

## 生产接线

调用方保留 `readController` 最近一次实际结果，供同步 `getController()` 使用。source 首读可能在 inputs 开始前，adapter 检查真实时间/版本/TTL，而不要求重复 HTTP 或新造输入时间。配置读取器同轮取得的字段核对仍由当前 association 检查。将 adapter 直接传给既有 `ProductionProofSource({ ...options, conformance: adapter })`；随后由根接 Coordinator。本模块不决定 enforcement 模式。

后续唯一外部材料是正确选择并保留实际路径资格；今天的候选不会自动取得资格。数值与批量粒度沿用阶段 2 验收调整范围，没有新增证明总纲。

## 验证

定向 `path-conformance.test.ts` 53 个测试通过，Electron typecheck、两文件 ESLint 通过。真实生产 source → adapter 的受控结构测试产生可通过 `validateDirectEvidence` 的单族、双族结果，运行真实 association、规则和路由校验器。另覆盖原 binding 篡改、resolver coverage 缺失、迟加 QUIC flag、原零代际、克隆/输入 mutation、旧缓存日期、在途撤销、超时 drain、合并与 16 地址批量。

这是内存/固定读取器替身的单元及集成验证；没有把它写成真实机器路径资格或严格模式已上线。

追加：适配器现为 92 项、映射 43 项；合并生产 Source 和 route 校验共 320 项通过。后验时序正例使用原期限 1100ms、后验 1200ms、检查 1201ms、审核 1202ms，再用 2000ms 的新一轮输入构造证据；旧输入、当期 DNS 过期及倒填审核时刻均拒绝。原始物理路径记录缺失仍拒绝；robots 请求不能换标签冒充出口回显，映射样本也不能取代业务地址族约束。

追加：适配器增加每组 resolver 映射的独立原始输入上下文，并将诊断目录检查提前，定向测试现为 131 项。新上下文必须与资格参照属于同一环境并精确覆盖原映射，不能用较新的输入替换旧记录的时间或来源标记。缺失/重复诊断项、范围不匹配或没有原单族约束，在准备资格和采样前拒绝。`hasValidRetainedQualification()` 只检查保留记录和实际 Chromium 启动事实，不读取当前路由、不签发许可；当前适用性仍走 `read()`。实际组合接口见[运行时组合记录](./network-path-qualification-producer.md)。
