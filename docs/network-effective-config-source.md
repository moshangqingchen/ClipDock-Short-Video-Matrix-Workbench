# 当前本地配置来源读取模块

实现：`src/main/network/effective-config-source.ts`。这是主进程内的当前文件候选读取器；不修改用户配置、不重载内核、不读取历史报告签发许可，也没有 renderer/IPC 接口。

## API 与接入

```ts
const source = new EffectiveConfigSource({
  path: selectedAbsoluteLocalPath,
  format: "yaml",
  readController: () => reader.read(),
  onChange: snapshot => handleCurrentSourceState(snapshot),
});
const snapshot = await source.read();
```

加密来源必须显式选择 `format: "decoded-yaml"`，提供 `decoderIdentity` 和 `decode(bytes, signal)`。解码实现由调用方选定并版本化，模块不猜密文格式、密钥或客户端协议。原始文件、解码文本、resolver/hosts 原值和代理配置仅在本次读取的主进程内存处理；模块没有写文件或日志操作。JavaScript 字符串无法承诺内存物理擦除，因而不作这种保证。

初始状态为 `checking`。`read()` 返回 `candidate` 或带固定原因码的 `unavailable`，同一实例并发调用共享一次读取。每次完成后重新调用会执行新的文件和控制器读取，不能把旧 `ClashReadResult` 放进回调复用。控制器采样开始、完成时刻必须落在当前文件检查窗内；与另一更早批次共享的 reader 结果会被拒绝，应由本轮 source 负责发起 reader 的批次。

`getSnapshot()` 检查过期；`invalidate()` 立即撤销当前 generation 并取消读取；`dispose()` 为终态。超时可以立即返回，但未结束的异步解码/读取仍占据单飞槽，防止超时后重叠发起第二次任务。注入的解码器应遵守 AbortSignal；同步解码器只能由调用方保证其复杂度有界。

发现文件、必要策略或有序规则摘要发生变化时，先发布 `SOURCE_CHANGED`，下一次稳定读取才能产生新 generation 的候选。候选生成、失联、过期等通过 `onChange` 通知；生产接线应在不可用时撤销许可，并将 source generation、文件及策略摘要合入当前证明的网络代际。这里没有自动文件监控，调用方按当前批次续读；TTL 在没有续读时负责失效。

## 实际核对

1. 读取调用方选定的绝对本地路径，检查普通文件和大小，采用只读句柄；读取前后比较文件标识、大小、修改时间和字节摘要。
2. 显式解码、解析 YAML，拒绝重复键、循环引用、危险对象类型和超限对象图；支持普通配置锚点与 merge。
3. 形成必要 DNS/hosts/sniffer/IPv6/TUN/DIRECT 出站策略摘要。缺项保持 `present: false`；`use-system-hosts` 等字段不补默认。显式 null 的整体摘要仍保留，未把 null 推导为关闭或开启。
4. 在当前文件检查窗内调用 `readController`。生产读数必须包含同批 `configFieldHashes`、`configPathHashes`、DIRECT 元数据和单调时间；缺失时不能退回仅比较 mode/规则。
5. 对文件与 `/configs` 共同显式字段进行 JSON Pointer 叶节点核对，数组按整个有序值比较。比如文件只写 `tun.enable`，内核额外给出 `tun.stack` 默认值时，只核对共同的 `/tun/enable`，不伪造默认值相同。对象/标量形状差异会拒绝。
6. 完整核对当前全部有序规则的 type/payload/proxy，仅规范化 API 的拼写差异（如 GEOIP 大小写和 IP-CIDR6 的 IPCIDR 名称）。`no-resolve` 等源文件附加选项另计摘要，不能宣称 API 已验证没有返回的选项。未知的复杂规则解析或实际差异会拒绝，不猜 DIRECT。
7. 再次读取文件并比较字节、文件标识和实际路径摘要，确认本轮文件未在控制器采样期间发生变化。

不读取配置中提及的订阅、节点服务器或 provider/geo 文件，也不会请求 resolver URL。当前目标若由早期 DOMAIN 终止，不因后面的未使用 RULE-SET/geo 来源未安装而拒绝这个文件候选。是否可以解释规则并放行目标仍由规则决策器负责。

## 输出与证明范围

`EffectiveConfigCandidate` 固定为 `kind: "local-config-candidate"`、`runtimeConfigurationProven: false`。包含当前采样时间、source generation、路径身份摘要、原文件摘要、共同字段列表、有序规则摘要、策略摘要、DIRECT 当前元数据。路径身份是规范路径字符串的摘要，**不是文件内容或可执行文件二进制身份**。

`rules` 与 `currentDirectPolicy` 为主进程内存输入，其中规则可以包含私有策略名称、DIRECT 元数据可以包含接口名；整个候选不得直接进入 renderer、备份或日志。面向日志只投影固定原因码、计数和摘要。策略摘要不输出 resolver 地址、hosts 原值、订阅或代理密码，且不拷贝 controller adapter 的未知额外字段。

候选只能支持方案 A 的当前来源一致性观察。磁盘与当前有序规则/共同可见字段相符，不能证明 API 隐藏的 DNS/hosts 已加载，也不能证明四个 API 请求是原子快照。生产流程仍需当前来源/加载边界、内核生命周期、OS 网络代际、目标与传输上下文，以及匿名路径符合性；已接受的外部控制者在观察与发包之间改路由的竞态继续明确保留。

此模块不把“API 不返回 DNS”升级为永久不可验证的新条件；它为当前轮次保留实际解析字段及缺项的摘要，让后续加载来源与路径符合性按冻结的信任模型作判断。重启时不能从历史文档或旧摘要自动构造 candidate。

## 有界默认值与验证

默认读取截止 5 秒、候选 TTL 15 秒；它们属于阶段 2 出发值，调用方可以在受支持上限内调整。硬上限为读取 15 秒、TTL 60 秒、原文件 8 MiB、解码 YAML 4 MiB、20,000 条规则、200,000 个图节点、40 层深度、20,000 个 YAML merge keys。控制器字段摘要也有数量和长度限制。超限或失联返回不可用，不截断后签发。

定向验证（2026-09-08 本地）：`effective-config-source.test.ts` 的 36 项测试通过；模块 ESLint 和 Electron TypeScript 检查通过。测试使用真实临时文件和合成配置，覆盖共同嵌套字段、完整规则顺序、缺项、显式解码、文件变更、单飞、期限、撤销及异常脱敏。测试只清理精确合成文件和空临时目录；未读取或修改本机客户端配置、未进行公网或账号请求。
