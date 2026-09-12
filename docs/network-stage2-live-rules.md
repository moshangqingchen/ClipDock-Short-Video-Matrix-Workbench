# 阶段 2：当前 mihomo 国内候选域名规则匹配

采样时间（UTC）：2026-09-07T13:10:23.524Z。

读取当前运行内核的只读 /configs、/rules、/version；未读取或替换磁盘规则／geo，未改用户配置，未向平台发带 Cookie 的业务请求。

采样环境：mode=rule，TUN=开启，当前内核规则数=3311。

候选来源：当前 src/main/network/catalog.ts 的 candidateTargets()；使用仓库 src/main/network/rules.ts 的 evaluateRules() 按真实规则顺序判定。上下文限定为 HTTPS/TCP 443，未填入未经实验验证的进程名或进程路径。遇到先行且不可解释的规则即返回 unknown，不跨过它寻找后面的 DIRECT。

**DIRECT 仅表示本次静态目标与当前规则子集匹配为直连候选，不是请求实测链路或 DirectProof。** 未验证出口地理、实际进程／传输等价性、DNS／地址族、完整登录／验证码／CDN 清单，也未签发或恢复任何业务许可。已匹配 host 不能代表其全部子域、其他端口或重定向目标。

本报告只保存平台分组、目标 host、规则类型及 DIRECT／unknown／proxy 结论；不保存原始配置、节点名、秘密、请求头或响应正文。

| 平台 | 候选 host 数 | DIRECT | unknown | proxy |
|---|---:|---:|---:|---:|
| 抖音 | 5 | 0 | 5 | 0 |
| 快手 | 5 | 0 | 5 | 0 |
| 小红书 | 2 | 0 | 2 | 0 |
| B 站 | 9 | 0 | 9 | 0 |
| 百家号 | 2 | 0 | 2 | 0 |
| 微信视频号 | 7 | 0 | 7 | 0 |

## 抖音

| 目标 host | 规则类型 | 规则候选结果 |
|---|---|---|
| creator.douyin.com | IPCIDR | unknown |
| www.douyin.com | IPCIDR | unknown |
| verify.snssdk.com | IPCIDR | unknown |
| verify.zijieapi.com | IPCIDR | unknown |
| rmc.bytedance.com | IPCIDR | unknown |

## 快手

| 目标 host | 规则类型 | 规则候选结果 |
|---|---|---|
| cp.kuaishou.com | IPCIDR | unknown |
| www.kuaishou.com | IPCIDR | unknown |
| captcha.zt.kuaishou.com | IPCIDR | unknown |
| captcha.kuaishou.com | IPCIDR | unknown |
| sec.kuaishou.com | IPCIDR | unknown |

## 小红书

| 目标 host | 规则类型 | 规则候选结果 |
|---|---|---|
| creator.xiaohongshu.com | IPCIDR | unknown |
| www.xiaohongshu.com | IPCIDR | unknown |

## B 站

| 目标 host | 规则类型 | 规则候选结果 |
|---|---|---|
| passport.bilibili.com | IPCIDR | unknown |
| member.bilibili.com | IPCIDR | unknown |
| www.bilibili.com | IPCIDR | unknown |
| api.bilibili.com | IPCIDR | unknown |
| static.geetest.com | IPCIDR | unknown |
| api.geetest.com | IPCIDR | unknown |
| gcaptcha4.geetest.com | IPCIDR | unknown |
| geetest.com | IPCIDR | unknown |
| gt4.geetest.com | IPCIDR | unknown |

## 百家号

| 目标 host | 规则类型 | 规则候选结果 |
|---|---|---|
| baijiahao.baidu.com | IPCIDR | unknown |
| wappass.baidu.com | IPCIDR | unknown |

## 微信视频号

| 目标 host | 规则类型 | 规则候选结果 |
|---|---|---|
| channels.weixin.qq.com | IPCIDR | unknown |
| captcha.qq.com | IPCIDR | unknown |
| t.captcha.qq.com | IPCIDR | unknown |
| ssl.captcha.qq.com | IPCIDR | unknown |
| captcha.gtimg.com | IPCIDR | unknown |
| global.captcha.gtimg.com | IPCIDR | unknown |
| sg.captcha.qcloud.com | IPCIDR | unknown |

## 实施审查的范围

本次没有启用严格拦截；观察器保持 observe，候选规则和匿名诊断不能批准账号请求。完整 fail-closed 与敏感边界问题单独反馈给实施负责人。

## 规则合并尝试与中断后核对

用户随后授权代为合并 30 条候选 DOMAIN 规则。当前客户端是猫猫云，其实际配置为加密格式。已确认格式并完成原密文无损往返验证；合并脚本对原密文做了备份，尝试写入及重载后未完成运行配置一致性验证，走了回滚分支。本次不能记作合并成功。

中断后根任务核对：配置文件与备份 SHA-256 相同，运行规则仍为 **3311** 条，没有新增 30 条候选规则生效。重载曾使内核进入 global；已仅通过 PATCH mode 恢复操作前确认的 **rule**，再次读到 **rule + TUN 开启 / 3311 条规则**。未进一步覆盖客户端配置。

- 当前文件：`C:\Users\Administrator\AppData\Local\Programs\MAOMAOYUNAPP\resources\extra\config.yaml`
- 原密文备份：`C:\Users\Administrator\AppData\Local\Programs\MAOMAOYUNAPP\resources\extra\config.yaml.clipdock-before-direct-20260907T133726Z.bak`

下一次合并须先处理“磁盘配置与正在运行的配置不完全一致”的情况，保留当前运行设置，并逐项验证重载前后差异；不能再次用磁盘重载结果覆盖用户当前模式。客户端订阅刷新是否覆盖手工规则也尚未确认。当前严格模式仍未启用。

## 已授权合并成功：2026-09-07 14:09 UTC

本节是上述失败记录之后的实际结果。用户授权继续代为合并；已在当前客户端配置中完成 **30 条精确 DOMAIN,DIRECT 规则**的合并和内核重载，没有修改客户端程序。

失败原因已经定位：磁盘 YAML 没有 `tun` 段，当前运行内核则有开启的 TUN 设置；客户端在运行时补入的设置不能在重载时丢失。本次检查时磁盘与运行时 `mode` 均为 `rule`。本次仅在原始 YAML 中插入 30 条规则，并补入当前内核原有的 `tun` 值；其余解析字段与原配置完全相等。节点、订阅、DNS、既有规则及秘密未被改写。密文解密、协议参数和完整配置只在进程内存中使用，没有将它们输出或保存为明文。

| 检查 | 实际结果 |
|---|---|
| 重载前规则 | 3311 条，先与磁盘原规则逐条核对 |
| 新规则插入点 | 原索引 16，即首条 IP-CIDR 之前 |
| 重载后规则 | 3341 条；原 3311 条按原顺序逐项保留，新增恰好 30 条 |
| 模式与 TUN | 仍为 `rule`、TUN 开启 |
| mixed 端口 | 仍为 10090 |
| 其余运行配置 | `/configs` 重载前后整对象深比较一致，差异字段为 `[]` |
| 候选匹配 | 本仓库规则解释器对 30 个 host 均返回 `Domain / direct` |
| 延时只读复验 | 14:12:35 UTC 仍为上述状态，活动密文 SHA-256 与合并成功时一致 |

操作前对原密文进行了字节往返和备份验证，写入前重新比较磁盘密文、运行配置及原规则快照，再通过同目录密文临时文件替换；检测到并发变化时停止，不覆盖客户端的新内容。重载后未忽略 `/configs` 的字段差异。脚本回滚分支同时恢复原密文和原运行配置，并验证模式、TUN 与全部旧规则，不能仅恢复文件后留下 global 状态；本次成功路径没有执行回滚。

原密文备份：`C:\Users\Administrator\AppData\Local\Programs\MAOMAOYUNAPP\resources\extra\config.yaml.clipdock-before-direct-20260907T140938Z.bak`。脱敏复验结果与密文哈希见 [network-stage2-rule-merge-result.json](./network-stage2-rule-merge-result.json)。

**这次通过的是用户真实配置上的规则匹配验收，不是 DirectProof 或阶段 3 放行验收。** 出口地理、实际进程与地址族、完整登录/验证码/轮询资源清单仍须独立验证，不能由这 30 个静态目标代替。

持久性边界：当前文件已经保存并已在现运行内核生效；没有为了验证而重启用户客户端或触发订阅刷新，尚不能承诺这些动作不会覆盖手工规则。若后续配置被客户端重建，观察器必须按新的配置版本重新判定，不得沿用本报告的 DIRECT 结论。此脚本是针对本次已核对配置的一次性迁移工具，不是任意订阅格式的自动维护器。

2026-09-07 当晚完成后续源码检查时再次只读核对：仍为 rule、TUN 开启、mixed 10090、3341 条规则；候选文件中的 30 个 host 均存在精确 Domain/DIRECT 条目。本轮没有再次写入或重载配置。
