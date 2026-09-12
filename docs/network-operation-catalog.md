# 国内业务操作目录：实施状态

实现为 `src/main/network/operation-catalog.ts`，已接入 `NetworkRuntime`。六个平台各有 `view-home`、`view-login`、`view-upload`、`view-navigate`、`check-status`、`profile`、`collect`、`keepalive`，共 48 个操作类别组合。`view-navigate` 还按实际目标 origin 分别形成选择，不能用一个类别审核所有导航目的地。

目录将源码固定请求、当前账号页选择、完整页面流程审核分开。38 条 collector 候选由测试使用 TypeScript AST 与现有 collector 源码独立核对；API 字段解析和候选重试顺序没有改变。

`requiredOrigins` 是本次操作必须覆盖的 origin；`candidateRequestRange` 仅是待审核候选；`reviewedRequestRange` 是已经审核、仍须逐目标证明的可取证范围。可选验证码、未使用官网和失效旧候选不会全部变成每次操作的必需目标。目录只约束精确协议、host、port，不推断实际地址族。

完整流程审核只能由可信主进程来源提供，绑定平台、操作、源码版本和实际页面选择。未审核、部分审核、审核范围不匹配、lookup 抛错或调用输入夹带 review 都不能提升为完整审核。通过观察临时发现 host 不会自动加入允许范围。

当前 48 个类别组合均未取得真实平台完整流程审核，源码固定清单不等于流程已验收。主入口仍为 `observe`；正式 bootstrap 已构造 `ProofCoordinator`，但未安装可签发真实业务许可的 `ProofEvidenceSource`。

## 运行时操作选择

`registerSession()` 先注册身份并完成 Session 保护，不再默认登记 `view-home` 采样范围。没有操作意图的账号仍出现在 `getAccountStates()`，状态为 `checking`；仅没有可采样 scope，不会在严格模式界面消失。

主进程外层入口调用：

```ts
runtime.prepareOperation(accountId, {
  operation: "collect",
  activePageOrigin: { protocol: "https:", host: "member.bilibili.com", port: 443 },
});
runtime.setPageOperation(accountId, {
  operation: "view-navigate",
  activePageOrigin: null,
  targetPageOrigin: { protocol: "https:", host: "www.bilibili.com", port: 443 },
});
```

两者同步提交范围，返回 `{ ready, contextId, scopeVersion }`。`ready` 只等待 Session 初始化/在途清理，不等待两轮证据，不表示允许业务请求。严格业务继续立即执行 Gate 检查，缺证返回等待国内网络。`activePageOrigin` 必须显式传现有页面 origin 或 `null`；`view-navigate` 必须传经过平台 host 校验的精确目标，其他视图操作按静态 route 选择。目录和事件不保存导航路径、query 或完整账号 URL。

账号服务已在打开页面、导航、登录探测、资料刷新等外层入口声明；调度采集/保活、发布助手从各自外层声明。`pool.ensure`、`pageFetch`、底层 session.fetch 不再改范围，只检查已有 Gate/lease。观察模式下声明失败不会改变原业务行为。

当前页面的背景范围与该页面期间声明过的操作合并；任务结束不立即缩范围，避免并发 check-status/profile/collect 或重试反复撤证。相同页面操作与目标的重试保持幂等，新页面选择或 Session 重建结束旧页面范围。新增操作须独立完整审核；只有已用审核版本不变、所有新增操作受支持且已审核、合并必需范围与已审核请求范围都完全相同时，才保留原许可版本。新增真实目标、审核范围变化或已用审核换版，会先撤销旧 lease、停止页面/在途连接，再等待新范围证据。不会用新 sample ID 重新包装旧证据。

生产 scope 的 targets 来自当前操作合集的 `requiredOrigins`，默认展开 IPv4/IPv6 所有可能分支。Gate 仍验证全部目标，任一必需目标缺证即拒绝。可选 `reviewedRequestRange` 不会自动变成必需项或已有许可；可选分支真正成为所选操作依赖时须进入审核记录的 `additionalRequiredOrigins`，然后重新取证。`resolveScope` 仅保留为明确的受控测试接口。

## 目录刷新与采样生命周期

主进程审核清单若热更新，调用 `refreshOperationCatalogs(accountId?)`。它在返回 Promise 前重解析所有选中账号并撤销失效权限，不等下一次用户操作；返回 Promise 只等待保护完成。某个审核读取异常不会跳过其余账号，失败返回固定错误。没有新增目录持久化或 renderer 接口。

`listProofScopes()` 和 `subscribeProofScopes(upsert | remove)` 供主进程协调器使用，只暴露保护完成的 scope 副本。身份和 scope 先提交，再发事件；初始化、撤销清理、删除、重建期间不发布可采样 scope。移除通知前先更新内部可见性；清理完成后才重新 upsert。事件没有 Session、Cookie、Token 或页面 URL，renderer 继续只接收网络状态投影。

验证包含：38 个源码 collector 候选 AST 对照、48 类默认未审核、精确自定义导航、无意图 checking 投影、后台同范围操作不销毁页面、新 API 目标先撤旧许可、完整 AND、审核热更新、清理/采样事件顺序，以及观察模式业务行为不变。运行时与目录 75 项定向测试通过；再含协调器测试共 87 项通过，Electron TypeScript 检查及四文件 ESLint 通过。这些受控测试不能替代六平台真实登录/验证码/轮询资源、认证后页面和上传路径审核。
