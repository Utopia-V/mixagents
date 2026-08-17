[English](advanced.md) · [返回使用说明](../README.zh-CN.md) · [完整证据账本](project2-evidence.md)

# 用 DSH Minimal 启动 V4 Pro，再回到 Pi

`pi-dsh-mimic` 只模拟 DSH 最有价值的一小段：第一次模型请求。真实任务进入 Minimal
persona 与 `bash/str_replace_editor` 两工具环境，V4 Pro 由此进入已验证的高能力工程
轨迹；第一次有效响应后，请求恢复为 Pi 原生格式，模型继续使用 Pi 的完整工具目录和其他
插件。

这条路线不需要复刻完整 DSH harness。DSH Minimal 提供首请求的训练接口，Pi 继续负责
session、工具执行、文件编辑和插件组合。用户既能获得 Project2 中反复出现的 96–98 分
能力档，也保留了 Pi 作为成熟 Agent runtime 的优势。

## 实验口径

本地实验使用 Project2 V4.1b，冻结于提交
`04255b55f16c4439e538239fb9783070c4165081`。同一运行中断后续跑时，只记录最终交卷分；
错误 project root、零 token 配置失败和重复评分不计作新样本。

`We need`、`Let me` 和 reasoning block 数量用于识别推理轨迹。最终判断来自 F3 的
ambient-session 安全边界、F6 数据库迁移、F8 ESP 契约、hidden tests 和完整交付。
Evaluator IDs 与排除项见[证据账本](project2-evidence.md)。

## DSH Minimal 证明能力可达

外部同题结果给出了清楚的校准：DSH Minimal 在相同 WSL/max/build 条件下得到 99、96，
Standard 为 91，PTC 为 92。后来的 Anchored Standard 又在首次工具调用后从两个工具恢复
到 25 个工具，并得到 98、99。

这些结果揭示了两个关键事实：首请求的 persona 与 schema 会影响 V4 Pro 的工程轨迹；
轨迹建立后，完整工具目录并不会自动破坏它。`pi-dsh-mimic` 把这两个事实带进 Pi。

## Pi 中的决定性对照

同批本地对照把主要差异定位到首请求：

| 运行 | 首请求与后续执行 | 分数 | 关键结果 |
| --- | --- | ---: | --- |
| 默认 Pi baseline | 完整 Pi prompt 与 5 个工具，全程 native | 92 | F3 11，F6 10，F8 6 |
| 早期 Minimal 模拟原型 | 原任务进入 Minimal 两工具首包；首次工具调用后恢复 Pi；不重放 Pi context | **98** | F3 16，F6 10，F8 7，hidden 44/45 |

98 分轨迹在约第 107 个 assistant response 推翻了自己早期的 ambient fallback：敏感
context 必须显式携带 `session_id`，voice 路径先取得 current session 再传回。这个自纠
直接解释了 F3 16/16，比首行短语更接近真正的能力差异。

## 负结果如何收窄实现

后续实验逐项排除了其他解释：

| 问题 | 实验条件 | 结果 | 实现选择 |
| --- | --- | ---: | --- |
| 是否需要额外身份轮 | zero-tool Whoami | 93 | 原任务直接进入请求 #1 |
| 是否只要减少工具数量 | Pi 原生 `bash/read` | 93 | 首请求使用 DSH Minimal schema |
| 是否应先强迫模型说出轨迹指纹 | Wire Think | 94；F3 16，F6 6 | 不注入或追求 `We need` |
| 是否应全程模拟 DSH wire | 持续 DSH wire | 94；F3 11 | 第一次有效响应后恢复 Pi 原生请求 |
| 是否应在恢复后重放 Pi system context | 完整 context 重放 | 90；F6 8 | 保持 Minimal persona，不重放完整 Pi context |
| 近似的 Minimal 表面是否足够 | 近似 Minimal → Pi 原生 | 93，首行回到 `Let me` | 以实际 98 分首包作为实现基准 |

另一次相同流程复现实验得到 96，并保持 F3 16/16；主要波动来自 ESP 静态完成度。

## 从实验原型到当前实现

同一请求流程随后在两个干净实现中得到完整 Project2 结果：

| 实现 | Provider | 分数 | F3 | F6 | F8 |
| --- | --- | ---: | ---: | ---: | ---: |
| 首次 package 化实现 | DeepSeek 官方 API | 96 | 16 | 8 | 7 |
| 当前独立实现 `0.1.0` | OpenCode Go | **98** | 16 | 10 | 7 |

OpenCode Go 的初始请求在生成 token 前遇到账户 opt-in 403。同一 session 完成 opt-in 后
续跑，模型最终自然 `stop` 并得到 98。这次运行验证了当前实现能够通过 OpenCode Go
进入同一高分档。

DeepSeek 官方 API 与 OpenCode Go 都得到 96–98 分，当前能力差异无需再用“OpenCode
提供的 V4 更弱”解释。

## 为什么 Pi 插件仍然可用

| | Bootstrap 请求 | 执行阶段请求 |
| --- | --- | --- |
| System persona | `You are a helpful software engineer assistant.` | 保持不变 |
| User 历史 | 原始任务，包括 Pi 原生图片 block | 不变 |
| Provider 可见工具 | `bash`、`str_replace_editor` | Pi 当下完整目录，包括其他插件工具 |
| Provider payload | DSH Minimal 形状；移除 Pi cache 字段 | Pi 原生编码与排序；cache 随 provider 配置 |

扩展从不调用 `setActiveTools`，也不覆盖 Pi 的 `bash`、`read`、`edit` 或 `write`。它只在
目标新 session 武装时注册一个可执行 `str_replace_editor`。请求 #2 起，Pi 重新掌管
provider payload 和 active catalog，其他 package 的工具会自然出现。

这正是 mimic 与完整 harness port 的区别：它只负责让首请求进入 DSH Minimal 分布，
任务执行仍由 Pi 负责。

## 产品行为与证据

| 当前行为 | 主要证据 |
| --- | --- |
| 只武装目标 provider/model 的新 session | 已有对话无法还原真实 bootstrap；隔离测试覆盖目标与非目标模型 |
| 原任务直接进入请求 #1 | 早期原型 98；Whoami 93 |
| 请求 #1 使用 Minimal persona 与 DSH 两项 schema | Pi 原生 `bash/read` 93；近似 Minimal 93 |
| 第一次有效响应后恢复 Pi 原生执行 | one-shot 96–98；持续 DSH wire 94 |
| 保持 Minimal persona，不重放完整 Pi system context | context replay 90 |
| Provider error 或 aborted response 不消耗 bootstrap | 错误重试、阶段持久化和 crash-stale 恢复测试 |

## 轨迹与工具规模

按不区分大小写统计，默认 Pi baseline 的 78 个 reasoning blocks 中出现了 156 次
`let me`，98 分原型的 135 个 blocks 中只有 1 次；按精确大小写统计则为 115 对 1。
这个差异能快速显示首请求是否改变了模型的推理习惯。

完整 11 组运行的 assistant、reasoning、`We need / Let me`、tool calls、工具种类和
stopReason 已整理进[证据账本](project2-evidence.md)。工具量本身不决定能力：持续 DSH
wire 调用 225 次工具只得到 94，早期原型调用 148 次得到 98；当前实现使用
`bash/read/edit/write` 共 193 次并得到 98。

持续 DSH wire 同样很少出现 `Let me`，Wire Think 也从 `We need` 开始却只有 94。
插件只观察这些短语，不向 prompt 注入它们。

## 实现验证

TypeScript typecheck 已通过，13 项自动化测试全部通过：12 项覆盖两个 provider、图片、
错误重试、文本晋升、session resume、crash-stale 恢复、已有对话隔离和非目标模型隔离；
另 1 项验证 session 统计工具。
Editor 测试覆盖 create、view、unique replace、insert、相对路径拒绝和歧义替换拒绝。

OpenCode Go bash-first 与 editor-first 离线回环通过 Pi 的真实 package loader 和 provider
路径捕获两个请求，全程 `realModelCalls=0`。请求 #2 恢复
`read/bash/edit/write/str_replace_editor`，并携带真实工具结果。归一 user task 后，新请求
#1 与历史 98 分 capture 在消息、字段顺序、schema、`strict:false` 和序列化结构上逐项
相等。

## 分数细节与重开条件

98 分原型和可核验的 DSH Minimal 99 都通过 hidden 44/45、F3 16/16，只错相同的 1 分
F12 拒绝原因字符串。原型的另一个失分来自 grader 只识别特定 readiness 函数名；实现
本身已经检查 Wi-Fi、UID、room 和 bed。本文按评分器原分报告。

当前 Project2 请求流程已有四次 96–98 分结果。新任务、模型或服务版本变化、provider
payload 实质变化，或新的完整任务结果，才需要重新运行付费实验。

## 来源与归属

Minimal persona、bash 描述、editor 描述和 function schema 来自
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的公开 Minimal 协议；
精确 commit 与许可声明见 [LICENSE](../LICENSE) 和 [NOTICE](../NOTICE)。外部 Project2
校准来自 [`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) 与
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)。

当前源码依据 DeepSeek Harness Minimal 协议、本项目捕获的请求和本项目实验实现，没有
参考或移植 [`kxh4892636/pi-deepseek-anchor`](https://github.com/kxh4892636/pi-deepseek-anchor)
的源码。早期探索中曾加载该 extension 验证 Pi 上的两阶段路径，因此证据账本保留这项
运行 provenance；当前实现、自动化测试、离线回环和 Project2 评分均由本项目完成。
