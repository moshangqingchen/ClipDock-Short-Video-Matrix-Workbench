# 主进程 ProofIssuer 接续说明

截至 2026-09-08，`src/main/network/proof-issuer.ts` 已实现证据采样协调、续证与取消；新增 `proof-coordinator.ts` 已连接 Runtime 的 scope 生命周期，正式 bootstrap 已构造并启动协调器。**当前没有真实 `ProofEvidenceSource`，缺省来源不会采样；没有据此完成真实生产许可签发，生产观察模式未改变。** 本模块不采集账号 Cookie、不调用业务 Session，也不持久化许可。

## 职责与接口

`EgressGate` 继续决定证据是否合格、何时失效及是否具备实际执法权。`ProofIssuer` 负责何时向只读主进程来源索取新证据，并将原始证据对象交给 Gate。

| 接口 | 用法与边界 |
| --- | --- |
| `new ProofIssuer({ gate, source?, clock?, ... })` | 不自动采样；没有 source 就不签发证据。 |
| `registerScope(scope, { generation, rulesVersion })` | 注册当前账号、传输上下文、审核域名类和版本；同 scope/版本幂等。变化时先撤销旧许可。 |
| `start()` | 显式开启后台匿名采样。构造或注册本身不启动采样。 |
| `request(accountId)` | 返回本轮结果；同账号等待中或进行中的请求共享一个 Promise，不绕过预热间隔。 |
| `cancel(accountId)` | 暂停该账号，先撤证再取消采样；显式 request 或 registerScope 可重新启用。 |
| `removeScope(accountId)` | 撤证并移除采样记录；不卸载 Session 守卫，不替 Runtime 注销账号。 |
| `forgetRevokedScope(accountId)` | Runtime 已撤权后取消并移除采样，避免再次触发清理；若 Gate 仍有可用许可，主动撤销。 |
| `invalidate(reason)` | 全局 Gate 代际失效后取消所有采样，清除版本绑定；恢复必须重新注册当前版本。 |
| `setSource(source?)` | 替换或撤去来源时先执行全局失效；不能沿用旧许可。 |
| `stop()` / `dispose()` | 先撤证再取消；dispose 另移除监听及内存记录。不无限等待不响应取消的来源。 |
| `snapshot()` | 只给调度摘要：是否运行、实际采样数、账号绑定/排队/采集中状态和原因；不含证据、出口 IP 或秘密。 |

来源契约：

```ts
interface ProofEvidenceSource {
  collect(request: ProofCollectionRequest): Promise<ProofCollectionResult>;
}
```

请求包含不可变 `scope`、当前 `generation/rulesVersion`、本轮唯一 `requestId`、`startedAtMono` 和 `AbortSignal`；不包含业务 Session。成功返回 `{ kind: "evidence", requestId, batch }`，其中 `batch.sampleId` 必须等于本轮 `requestId`。无法证明则返回 `{ kind: "unavailable", reason }`。来源必须保留真实证据来源，不得把可达、裸 `DIRECT=true` 或渲染层输入改写成路径适用性证明。

## 时序、合并与撤销

- 默认首次采样后等待至少 15s，再做第二轮新采样；Gate 仍独立验证两轮证据。正常续证间隔默认 10s。
- 每轮 route/TLS/DNS 和 batch 时间必须在该次请求开始与完成之间；新 requestId 不能替缓存样本换标签。出口样本可按既有 DirectProof 的独立 TTL 复用，适用性仍须真实成立。
- 续证读取 `gate.permitExpiresAtMono(accountId, contextId)`，不使用 renderer 投影或墙钟计算权限。若控制器或其它证据更早到期，提前续证；默认提前量至少 3s，并计入上一轮采样耗时。最小续证间隔为 `min(renewMs, renewLeadMs)`，默认 3s，防止控制器刷新延迟时围绕同一期限忙轮询；赶不上截止时由 Gate 正常撤证，不延长许可。
- 同账号、同 scope/版本合并；不同账号默认最多 2 个实际来源调用。默认来源超时为 15s。数值可经配置调整，但不能改变目标、上下文、代际、地址族和新样本要求。
- 来源即使忽略 AbortSignal，仍占用实际并发槽及该账号锁，直到真正结束；不能因逻辑超时制造无限并发。旧结果通过账号记录、任务、代际和取消状态检查后丢弃。
- Gate 的外部撤销会取消对应采样；范围变化、停止、来源失败均先闭闩，再通知来源取消。共享控制器/凭据失联及网络版本变化会全局撤证，并要求重新绑定版本。
- 观察模式下 Gate 的决策没有实际取消权；Issuer 不切换执行模式，也不触发账号 online 事件。

## 已接入的生命周期桥

`new ProofCoordinator({ gate, scopes: runtime, source?, issuerOptions? })` 拥有 Issuer，提供 `start/request/setSource/stop/dispose/snapshot`；构造不会开始采样，bootstrap 显式调用 start，退出先停止协调器，再完成 Runtime 清理。

- Runtime 的 `listProofScopes()` 与 `subscribeProofScopes(upsert | remove)` 只公开 ready scope。初始化、清理、删除期间不可采样；不把 Session 对象交给来源。
- `gate.currentProofVersion()` 只返回当前可读、未过期的 rule 模式版本，不能授权账号。Gate 的专用 `network` 事件在环境提交或失效后通知协调器；协调器不订阅 UI `state`，注册以微任务合并，避免递归。
- 网络/OS 失效同步撤销旧绑定；恢复使用新 generation/rulesVersion。scope 删除先取消，异步清理完成后的新 upsert 才能重新登记并预热。
- 取消进行中的来源后，Issuer 保留短暂的账号采样退避，默认 10s，仅存于内存。快速 cleanup/upsert 不能绕过失败重试间隔或导致连续匿名请求。

## 真实签发仍需提供

实现真实只读来源，按所支持配置组合当前规则证据、实际传输上下文、DNS/TLS、出站路径和地址族适用性以及大陆出口证据。Issuer 本身不补造这些输入，也不要求每轮每目标再做一次 socket 关联。由控制器及 OS 观察者继续维护 Gate 当前状态和版本；真实来源恢复不能复用旧许可。真实来源和当前配置的验收完成前保持观察模式。

## 已完成的验证

Issuer 29 项测试与协调器 12 项测试覆盖续证、合并、缓存拒绝、取消及生命周期。协调器包含真实 Runtime 的初始化/清理 ready 联动与失败退避集成测试。相关 DirectProof / LiveRuleEvidence / EgressGate / Issuer / Coordinator / Runtime 六模块本轮共 192 项测试通过；Electron typecheck 和本轮源码文件的 ESLint 通过。

这些是受控模块与集成测试结果，不能替代真实 source、当前网络配置下的许可签发或业务验收。
