[返回实验与设计](advanced.zh-CN.md) · [使用说明](../README.zh-CN.md)

# pi-dsh-mimic Project2 证据账本

> **Owner:** `pi-dsh-mimic` 维护者
>
> **状态:** 当前请求流程的 Project2 实验已收束；满足更新条件时重开
>
> **基准:** Project2 V4.1b，冻结提交 `04255b55f16c4439e538239fb9783070c4165081`
>
> **最后整理:** 2026-08-17
>
> **更新条件:** 新的完整 Pi Project2 评分、同树 ESP-IDF build 证据，或本文引用来源的实质更正。

本文记录支持当前实现的完整结果、纳入与排除规则、外部校准和来源关系。原始 run、
trajectory、provider capture 与 grader 输出由维护者实验归档保存，不随仓库分发。

Project2 V4.1b 是一个个人、自托管的长程代码维护评测，不是跨项目通用 benchmark。
候选模型需要修复一个多模块 Python 后端与 ESP32-S3 固件仓库，覆盖鉴权与 session 隐私、
数据库迁移、跨模块功能、兼容性、Wi-Fi/MQTT/NVS/协议与 ESP-IDF 契约，以及交付证据。
100 分 Ability 分数表示这套冻结任务中的工程完成度。

## 计分口径

- 同一运行中断后续跑，只保留最终交卷分；续跑前分数属于中间状态。
- `We need`、`Let me` 和 reasoning block 数量只作轨迹指纹。
- F3、迁移、ESP 契约、hidden tests 和最终交付决定能力判断。
- Grader 的词法盲点可以解释，但不改写原分。

## 当前结论

1. 同批决定性对照是 **默认 Pi 92 → 早期 Minimal 模拟原型 98**。
2. 相同 one-shot 请求流程的四次最终结果为 **98、96、96、98**，均保持 F3 16/16。
3. 高分流程是：原任务进入 Minimal 两工具首包；第一次有效响应后恢复 Pi 原生完整目录；
   Minimal persona 保持；不重放完整 Pi system context。
4. 持续 DSH wire、Whoami、Wire Think、Pi 原生 `bash/read` 和 context 重放都没有提供更好
   的完整任务结果。
5. DeepSeek 官方 API 与 OpenCode Go 都进入 96–98 分档。

## 完整运行

本表只列最终且可解释的运行。

| 运行 | 首请求与后续执行 | 指纹 | 分数 | 关键分项 | 对实现的意义 |
| --- | --- | --- | ---: | --- | --- |
| 默认 Pi baseline | 完整 Pi prompt + 5 工具，全程 native | `Let me` | **92** | F3 11，F6 10，F8 6 | 默认对照；ambient-session 少 5 分 |
| 早期 Minimal 模拟原型 | 原任务 + Minimal + DSH `bash/editor`；随后 Pi 原生 5 工具；不重放 context | `We need` | **98** | F3 16，F6 10，F8 7 | 首次证明 Pi 能进入高能力轨迹 |
| 首次 package 化实现 | 同一首包；随后 Pi 原生；同 session 续过一次 402 | `We need` | **96** | F3 16，F6 8，F8 7 | 干净 package 复现目标轨迹；迁移少 2 分 |
| 当前独立实现 | 初始首包遇 403；opt-in 后同 session 续跑并恢复 Pi 原生 | `We need` | **98** | F3 16，F6 10，F8 7 | OpenCode Go 再次进入同一高分档 |
| 持续 DSH wire | 同一首包；后续请求继续 DSH 规范化 | `We need` | **94** | F3 11，F6 10，F8 8 | 指纹保持，关键安全判断没有保持 |
| Pi context 重放 | 同一首包；随后 Pi 原生，但把完整 system context 作为额外 user message | `We need` | **90** | F3 11，F6 8，F8 6 | 额外 context 增加干扰，迁移退化 |
| 同流程复现实验 | 同一首包；随后 Pi 原生；不重放 context | `We need` | **96** | F3 16，F6 10，F8 5 | 高分区间复现；ESP 静态完成度较低 |
| 近似 Minimal → Pi 原生 | 旧的近似 Minimal 首包，随后 Pi 原生 | `Let me` | **93** | F3 11，F6 10，F8 7 | 请求表面近似不足以命中同一轨迹 |
| Pi 原生 `bash/read` | Minimal persona + Pi 原生 `bash/read`，随后完整 Pi | `Let me` | **93** | F3 11，F6 10，F8 7 | 两个工具本身不是触发条件 |
| Wire Think | 全工具可见；首轮禁止工具后再执行 | `We need` | **94** | F3 16，F6 6，F8 7 | 指纹和 F3 正确仍不足以保证迁移 |
| Whoami | 0-tool `你是谁`；随后原任务 + 完整 Pi | `We need` | **93** | F3 11，F6 10，F8 7 | 额外身份轮没有提升完整任务结果 |

对应 evaluator IDs（按表中顺序）：

1. `20260816_194641`
2. `20260816_194701`
3. `20260817_122813`
4. `20260817_161004`
5. `20260816_224400`
6. `20260816_234202`
7. `20260817_002358`
8. `20260817_045709`
9. `20260817_064341`
10. `20260817_071127`
11. `20260817_074443`

## 98 分原型与 DSH Minimal 99

- 两者的 hidden 都是 44/45、F3 都是 16/16，只错相同的 1 分 F12 原因字符串：实现返回
  `not_authenticated`，grader 要求 `not_authorized_for_target`。
- 原型的 F8 唯一失败是 `V4-F8-08`。实现中的
  `device_config_is_network_ready()` 已检查 `wifi_ssid`、`wifi_password`、
  `bemfa_uid`、`room` 和 `bed`；grader 只接受另外三个函数名。
- 轨迹约在第 107 个 assistant response 推翻早期 ambient fallback，改成敏感 context
  必须显式携带 `session_id`，voice 路径先取 current session 再传回。这个自纠解释了
  F3 16/16。

## 当前实现的 OpenCode Go 运行

- evaluator `20260817_161004` 为 98：hidden 44/45、F3 16、F6 10、F8 7。
- 初始 `system,user` 首包与历史 capture 逐字节相等，但在生成 token 前被账户 opt-in 的
  403 拒绝；同一 session 续跑后的成功 bootstrap 为 `system,user,user`。
- 首个成功工具调用后恢复 `read/bash/edit/write/str_replace_editor` 与 Go provider 原生
  envelope。
- 同一 session 最终自然 `stop`：160 个成功 assistant responses、193 次工具调用、
  156 个 reasoning blocks，`Let me=0`。

这次结果证明当前实现通过 OpenCode Go 得到 98。由于成功 bootstrap 发生在续跑后，不能
用它单独证明字节完全相同的首次成功请求导致了该分数。

## 轨迹、工具与 stopReason

统计由只读脚本 [`scripts/session-stats.mjs`](../scripts/session-stats.mjs) 从每个运行最终
保存的 Pi session JSONL 生成。恢复运行的 session 文件已经包含完整逻辑状态，因此没有
再叠加 `pi-resume-*` 或 `pi-audit-*` event log，避免重复计数。

“成功 assistant”只计 `stopReason=toolUse` 或 `stop` 的 assistant message；reasoning
blocks 只计 assistant content 中的 `thinking` block。`We need` 与 `Let me` 在 thinking
文本中按大小写精确匹配，同时保留不区分大小写的对照。

| 运行 | 分数 | 成功 assistant | Reasoning blocks | 精确 `We need` | 精确 `Let me` | 不区分大小写 `we need / let me` |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 默认 Pi baseline | 92 | 113 | 78 | 0 | 115 | 2 / 156 |
| 早期 Minimal 模拟原型 | 98 | 149 | 135 | 8 | 1 | 10 / 1 |
| 首次 package 化实现 | 96 | 147 | 147 | 11 | 0 | 11 / 0 |
| 当前独立实现 | 98 | 160 | 156 | 7 | 0 | 7 / 0 |
| 持续 DSH wire | 94 | 196 | 190 | 6 | 2 | 7 / 2 |
| Pi context 重放 | 90 | 189 | 184 | 6 | 0 | 8 / 0 |
| 同流程复现实验 | 96 | 160 | 155 | 10 | 0 | 12 / 0 |
| 近似 Minimal → Pi 原生 | 93 | 159 | 156 | 11 | 10 | 13 / 11 |
| Pi 原生 `bash/read` | 93 | 184 | 182 | 7 | 12 | 8 / 13 |
| Wire Think | 94 | 123 | 118 | 10 | 5 | 13 / 5 |
| Whoami | 93 | 169 | 164 | 7 | 1 | 7 / 1 |

早期账本中的 baseline `Let me=156` 使用了不区分大小写统计；精确大小写计数为 115。
后续引用应标明统计口径。

| 运行 | Tool calls | 工具种类与次数 | stopReason 分布 |
| --- | ---: | --- | --- |
| 默认 Pi baseline | 157 | `bash` 79，`edit` 32，`read` 30，`write` 16 | `toolUse` 112，`stop` 1，`error` 1 |
| 早期 Minimal 模拟原型 | 148 | `bash` 83，`edit` 49，`write` 16 | `toolUse` 148，`stop` 1 |
| 首次 package 化实现 | 189 | `bash` 82，`read` 48，`edit` 42，`write` 17 | `toolUse` 146，`stop` 1，`error` 2 |
| 当前独立实现 | 193 | `bash` 98，`read` 49，`edit` 31，`write` 15 | `toolUse` 159，`stop` 1，`error` 1 |
| 持续 DSH wire | 225 | `bash` 94，`edit` 65，`read` 53，`write` 13 | `toolUse` 195，`stop` 1 |
| Pi context 重放 | 220 | `bash` 76，`edit` 66，`read` 63，`write` 15 | `toolUse` 188，`stop` 1 |
| 同流程复现实验 | 176 | `bash` 176 | `toolUse` 159，`stop` 1，`error` 1 |
| 近似 Minimal → Pi 原生 | 201 | `bash` 93，`read` 46，`edit` 45，`write` 17 | `toolUse` 158，`stop` 1，`error` 1 |
| Pi 原生 `bash/read` | 204 | `bash` 120，`edit` 48，`read` 19，`write` 17 | `toolUse` 183，`stop` 1 |
| Wire Think | 134 | `bash` 81，`edit` 37，`write` 16 | `toolUse` 121，`stop` 2 |
| Whoami | 195 | `read` 67，`bash` 59，`edit` 55，`write` 14 | `toolUse` 167，`stop` 2，`error` 1 |

这两张表带来三个直接观察：

- 工具调用更多不代表分数更高。持续 DSH wire 调用了 225 次工具，仍只有 94；早期原型
  只调用 148 次工具，得到 98。
- 高分轨迹能够使用 Pi 原生工具。当前实现调用 `bash/read/edit/write` 共 193 次并得到
  98；同流程复现实验甚至只调用 `bash`，仍得到 96。
- 完整 Project2 运行没有调用 `str_replace_editor`，因为模型在首包选择了 `bash`。
  Editor-first 离线回环单独验证了该工具可以真实执行。Project2 也没有加载额外 Pi
  package；插件工具在恢复后的可见性由离线组合测试验证。

所有最终 session 的 stopReason 分布都包含 `stop`。Wire Think 与 Whoami 各含两个
`stop` message，分别对应额外思考/身份轮与后续任务。`error` 记录保留了运行中的 provider
错误或续跑边界，不计入成功 assistant 数量。

## 实现选择

1. **真实任务直接进入首请求。** 早期原型得到 98；Whoami 只有 93。
2. **首请求使用 DSH Minimal persona 与 `bash/str_replace_editor` schema。** Pi 原生
   `bash/read` 只有 93。
3. **第一次有效响应后恢复 Pi 原生执行。** 持续 DSH wire 只有 94，并会妨碍 Pi 原生
   cache、消息编码和插件工具。
4. **保持 Minimal persona，不重放完整 Pi system context。** Context 重放实验只有 90。
5. **首包以实际 98 分 capture 为基准。** 近似 Minimal 的运行回到 `Let me` 并得到 93。

## 不纳入主表的工件

- `20260816_1845_project2_v4pro_pair01` 没有完整 `run.json`。
- evaluator `20260816_224346` 误把 `workspace/` 当 project root；正确评分为同目录的
  `20260816_224400`。
- 同流程复现与 Whoami 的较低分是续跑前中间交卷。
- 近似 Minimal → Pi 原生的两个 93 是同一运行的重复评分。
- `20260817_131349_opencode_zen_pi_dsh_anchor_0_3_0_project2` 是错误 Zen route 的零
  token、零费用配置失败。名称保留为实验归档定位，不代表公开 package 版本。

## 离线实现证据

当前 package 不接管 active catalog，也不覆盖 Pi 的 `bash/read/edit/write`。DeepSeek
官方与 OpenCode Go 两条 provider 路径只在目标新 session 中注册可执行
`str_replace_editor`：

- 请求 #1：`system,user`、原始任务、Minimal persona、`bash/str_replace_editor`，无 Pi
  cache 字段；
- 请求 #2：恢复 Pi 原生 messages、provider envelope 和
  `read/bash/edit/write/str_replace_editor`；
- TypeScript typecheck 通过，12 项 package 行为/manifest 测试与 1 项 session 统计工具测试
  全部通过；
- OpenCode Go bash-first 与 editor-first 离线回环成功，`realModelCalls=0`；
- editor 的实际文件读取结果进入请求 #2；
- 归一 user task 后，新请求 #1 与历史 98 分 capture 在字段顺序、消息、schema、
  `strict:false` 和序列化结构上逐项相等。

这些检查验证请求机制。完整模型运行提供能力分。

## 外部校准与来源关系

### DeepSeek Harness 与 Project2

当前实现使用 DeepSeek Harness 的公开 Minimal persona、工具说明和 function schemas。
精确 commit 与 MIT 声明见 package 的 [NOTICE](../NOTICE)。

Project2 benchmark、外部分析和 DSH 结果来自：

- [`xiaobright/modeltest` V4 Pro harness 分析](https://github.com/xiaobright/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_PRO_HARNESS_ANALYSIS_20260814.md)
- [Minimal 99](https://github.com/xiaobright/modeltest/blob/main/evaluator/results/20260813_230337/summary.json)
- [Standard 91](https://github.com/xiaobright/modeltest/blob/main/evaluator/results/20260814_133328/summary.json)
- [PTC 92](https://github.com/xiaobright/modeltest/blob/main/evaluator/results/20260814_140756/summary.json)
- [`dsh-anchored-standard` Issue #60](https://github.com/xiaobright/dsh-anchored-standard/issues/60)

两次 Anchored Standard 98/99 实际来自 Windows `pwsh/read → 25 tools`。它们证明首包后
恢复完整工具可行，不给后来 `bash/str_replace_editor` 实现继承分数。

### 早期外部 Pi extension

早期探索中有一次 98 分运行加载了
[`kxh4892636/pi-deepseek-anchor`](https://github.com/kxh4892636/pi-deepseek-anchor)。
这只记录该次运行使用了什么 extension；当前源码没有参考或移植该仓库的源码。

2026-08-17 核对其 HEAD `d369f9664d2c710c259b9a186e69ce4c76e1bf5e` 时，仓库共有
8 个文件，没有 test/spec 路径或自动化测试文件，也没有公开的 Pi Project2 grader/build
工件。因此本文不使用该仓库自己的分数主张作为证据。表中的 98 来自本项目保存的运行与
evaluator。

## 当前决定

- 产品名为 `pi-dsh-mimic`。`0.1.0` 是首次公开实现；`0.1.1` 只补充 Project2 语境和
  已发布安装说明，运行时代码不变；`0.1.2` 将激活条件改为模型标识包含
  `deepseek-v4-pro`，不再按 provider 名称限制。
- 默认流程固定为 task-bearing one-shot：请求 #1 模拟 DSH Minimal，请求 #2 恢复 Pi。
- DeepSeek 官方 API 与 OpenCode Go 是本文已有运行和离线回环证据的 provider；第三方
  provider 可以激活扩展，但不属于本文已经验证的实验范围。
- Minimal persona 保持；完整 Pi system context 不重放。
- Project2 同一请求流程已有四次 96–98，不继续重复付费运行。
- 新任务、模型或服务版本变化、provider payload 实质变化，或新的完整任务结果可以重开
  实验。

## 工件可用性

完整 trajectory、provider capture、grader 输出和构建树保留在维护者实验归档中，没有
作为仓库的一部分公开。本文提供 evaluator IDs、结果、排除规则和外部来源。

若以后公开 capture 或运行摘要，应先移除任务中的私有材料、凭据、请求头和无关源码，
并保留足以对应本文运行与 evaluator 的标识。
