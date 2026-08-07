[返回快速安装](../README.md) · [English](advanced.en.md)

# 高级说明

本页面向希望检查实现、调整兼容策略或贡献平台证据的用户。只想安装和使用时，
按 [README 三步流程](../README.md) 即可。

## 组合边界

主任务继续使用现有 OpenAI 模型、provider 和 ChatGPT 登录。DeepSeek 只存在于
独立的 `v4_flash_worker` child session 配置中。Codex 仍然原生管理 child 的创建、
身份、权限、生命周期、取消、等待和 callback；仓库只用一个受信任的
`SubagentStart` Hook 替换当前不可靠的跨 provider 任务载体。

它不是插件、MCP Server、wrapper、daemon、独立 Agent 应用或另一个 Codex CLI，
也不要求 CC Switch 一类全局 provider 切换工具。

## 适配其他 provider/model

“主任务与 child 使用不同 provider/model”是 Codex 的通用组合能力，不是 DeepSeek
特例。Codex 将每个独立 custom-agent TOML 作为 spawned session 的配置层，因此它
可以覆盖普通 session 支持的模型与 provider 设置。Codex 官方也允许指向任何支持
Responses 或 Chat Completions API 的模型/provider；由于 Chat Completions 支持已经
标记为将来移除，新的适配应优先使用 Responses。

一个新的 provider/model 组合至少需要满足：

1. provider 暴露 Codex 当前支持的 wire API，并能通过独立 Agent 配置安全取得认证；
2. model 具备目标任务真正需要的能力；若要执行本地搜索、读取或其他工具工作，
   还必须可靠支持相应 tool calls；
3. 独立 Agent 文件能够完整定义自己的身份、model、`model_provider`、provider
   配置、指令与权限，而不切换主任务 provider；
4. 用户接受该 provider 会收到 child assignment、上下文与工具结果的数据边界；
5. 实测 native spawn、任务交付、必要工具、结果 callback 与取消语义。若目标
   provider 已能可靠消费原生 V2 collaboration message，就不需要本仓库的 Hook；
   若仍遇到跨 provider ciphertext 边界，则可适配同一 one-shot Hook 协议。

本仓库的现成工件仍然有意绑定 `v4_flash_worker` 和 DeepSeek：Agent 模板、认证、
Hook matcher、脚本中的 role、skill、`AGENTS.md` 索引与 smoke oracle 必须作为一个
整体一致地改名和重验。只替换 `model` 或 `base_url` 不足以证明新的组合可用。

## 已测试基线

| 组件 | 已测试版本或路径 |
| --- | --- |
| Windows Codex Desktop | `26.727.6591.0` |
| Codex CLI | `0.146.0` |
| Multi-agent 路径 | V2、`fork_turns="none"`、`SubagentStart` plaintext Hook |
| DeepSeek 模型别名 | `deepseek-v4-flash` |
| DeepSeek 文档标注版本 | `DeepSeek-V4-Flash-0731` |
| 日期 | Windows `2026-08-05`；macOS POSIX 加固 `2026-08-08` |

Windows Desktop live smoke 已验证 OpenAI parent → DeepSeek child → native callback，
PowerShell 协议测试也在 Windows 通过。macOS 的 Python/POSIX 路径已在 Codex
`0.146.0` 上通过同一原生 callback 流程，并通过 25 项协议、并发与故障恢复测试；
Linux 使用同一 POSIX 实现。PowerShell 与 Python 是独立实现，因此下文的 POSIX
锁和 quarantine 保证不自动延伸到 Windows。

Codex `0.145.0` 将可配置 subagent 模型与 reasoning effort 的 Multi-agent V2
标记为稳定。custom agent、Hook 和跨 provider transport 仍在演进，优先使用当前
稳定版本。

## 安装后的文件与配置

| 路径 | 用途 |
| --- | --- |
| [`agents/v4-flash-worker.toml`](../agents/v4-flash-worker.toml) | macOS/Linux Agent 模板 |
| [`agents/windows-live-env/v4-flash-worker.toml`](../agents/windows-live-env/v4-flash-worker.toml) | Windows 实时读取用户环境变量的模板 |
| [`skills/use-v4-flash-worker/SKILL.md`](../skills/use-v4-flash-worker/SKILL.md) | 按需加载的选择、交付、等待与失败协议 |
| [`hooks/plaintext-handoff.ps1`](../hooks/plaintext-handoff.ps1) | Windows stage / Hook 脚本 |
| [`hooks/plaintext_handoff.py`](../hooks/plaintext_handoff.py) | macOS/Linux Python 3 脚本 |
| [`hooks/hooks.windows.example.json`](../hooks/hooks.windows.example.json) | Windows Hook 结构模板 |
| [`hooks/hooks.posix.example.json`](../hooks/hooks.posix.example.json) | macOS/Linux Hook 结构模板 |
| [`snippets/AGENTS.md`](../snippets/AGENTS.md) | 两条父 Agent skill 索引 |
| [`prompts/install-with-codex.md`](../prompts/install-with-codex.md) | 交给 Codex 的幂等安装合同 |
| [`prompts/quick-smoke-test.md`](../prompts/quick-smoke-test.md) | 无需 checkout 的快速 smoke |
| [`prompts/smoke-test.md`](../prompts/smoke-test.md) | 贡献者的工具与 SHA-256 smoke |
| [`prompts/message-handoff-probe.md`](../prompts/message-handoff-probe.md) | 原始 V2 message-only 诊断探针 |

Agent registration、`model_provider` 和 `[model_providers.deepseek]` 只存在于独立
Agent 文件。顶层配置不增加 `[agents.v4_flash_worker]` 或
`[model_providers.deepseek]`，主任务 provider 不变。用户信任 Hook 时，Codex
可能在顶层 `config.toml` 写入 `hooks.state` trust hash；安装器不会伪造它。

有意不设置 `model_reasoning_effort`，使父 Agent 能按任务选择。声明
`model_context_window = 1000000` 只描述 provider 容量，不要求每次发送 1M tokens，
也不保证接近满窗口时性能不变。`sandbox_mode = "read-only"` 是 mutation 默认值，
不是防泄漏边界。

## 自主路由与上下文成本

安装 custom agent 只让它可被发现，并不强迫父 Agent 使用它。个人
`AGENTS.md` 只保留两条 `$use-v4-flash-worker` 索引；完整协议在父 Agent 真正考虑
该 worker 时才加载。

Flash 适合边界明确、以文本为主、会产生大量原始材料而只需少量结论的代码、日志、
搜索、提取、枚举和阅读工作。紧密耦合的推理、重要决策、验证与最终整合留在父
Agent。需要图像理解时使用多模态 worker。

## 为什么 V2 需要 Hook

理想的 Multi-agent V2 语义是：父 Agent 在 `spawn_agent.message` 中给 child 一个
自洽任务，child 不继承根任务历史。但当前 OpenAI parent → 非 OpenAI custom child
路径可能把 collaboration 参数生成为 provider-internal ciphertext。Codex 创建了
正确的 DeepSeek child，child 可见的 `Payload:` 却为空，任务只存在于它无法解释的
`encrypted_content` 中。

[openai/codex#35845](https://github.com/openai/codex/pull/35845) 增加了 plaintext
collaboration 分支，但只在调用已经带有明确 plaintext marker 时命中；真实 OpenAI
parent 仍可能先生成 ciphertext。因此包含该修复的版本仍可复现：

- [本仓库 Issue #1](https://github.com/Utopia-V/codex-deepseek-subagent/issues/1)：
  `fork_turns="1"` 继承根任务而不是父 Agent 后来形成的 child assignment，还可能
  使 child 误认自己是 root；
- [openai/codex#34833](https://github.com/openai/codex/issues/34833)：V2 跨
  provider child 无法消费 encrypted assignment；
- [openai/codex#36376](https://github.com/openai/codex/issues/36376)：在合入
  #35845 后的 `0.147.0-alpha.4` 上仍复现，并说明 plaintext 分支为何没有命中。

这是任务合同跨 provider 边界时的表示问题，不是 DeepSeek 模型、Responses API、
Agent discovery 或 native callback 本身失败。

## 首选路径：一次性 plaintext handoff

`$use-v4-flash-worker` 执行以下协议：

1. 父 Agent 形成完整、自洽的 child assignment；
2. 通过 stdin stage 到带 TTL 的单槽本地状态；
3. 立即以唯一 task name、精确 `v4_flash_worker` 和 `fork_turns="none"` 创建 child；
4. 受信任 Hook 在该 role 的 `SubagentStart` 时原子 claim，并通过
   `hookSpecificOutput.additionalContext` 注入 developer context；
5. child 通过 Codex 原生 callback 返回，父 Agent 使用 idle wait，不轮询。

macOS/Linux 实现使用 POSIX、OS-owned 的非阻塞 dispatch lock，只串行化很短的
plaintext dispatch window（stage、claim、交付输出与消费）；已启动的多个 worker
仍可并发运行，因此这不是多 worker 串行执行器，而是防止单槽状态在交付边界串任务。
损坏 claim 会被 quarantine，必须显式处理；TTL 只恢复结构有效的 pending 或无存活
holder 的过期 claim。stage 失败后绝不能 spawn，只有状态明确清除并重新 stage 成功
后才可创建 child。当前 V2 `send_message` / `followup_task` 可能遇到
同一加密边界，因此每个 Flash child 承担一个自洽 job；关键任务发生变化时创建新
child，而不是依赖 follow-up。

assignment 会短暂以 plaintext 存在于本地用户状态，并随后发送给 DeepSeek。Hook
是 transport compatibility layer，不是机密通道。默认状态位置与威胁边界见
[SECURITY.md](../SECURITY.md)。

## 可选兼容路径

### Multi-agent V1

仍暴露 feature switch 的 Codex 版本可以为整个新任务选择 V1：

```text
codex --disable multi_agent_v2
```

或在有意长期采用 V1 的可信配置层中设置：

```toml
[features]
multi_agent_v2 = false
```

V1 不走受影响的 V2 encrypted collaboration path，因此可作为显式 workaround；
本仓库 Issue #1 的报告者也确认 V1 恢复了交付。但它不是 per-spawn 参数，会改变
整个顶层 session 的 multi-agent 实现，并接受该版本中 V1/V2 在工具、角色、并发、
模型覆盖、身份恢复和导航等行为上的差异。默认安装不会静默切换用户 session。

### 继承 turns

正数 `fork_turns` 只能继承已经存在的轮次，不能携带父 Agent 内部后来形成的任务。
增加继承量只会扩大 DeepSeek 数据边界和身份混淆面，不会把缺失的 V2 message
变成 plaintext，因此不是自主委派 fallback。

## 上游迁移条件

当 Codex 能在调用外部 child provider 前，把 OpenAI parent 的 spawn assignment
和必要 follow-up 可靠表示为 provider-neutral plaintext，并保持真实的 child 身份、
权限、取消与 callback 语义，本仓库会恢复原生 collaboration message 为首选。
Hook 只在明确的旧版本窗口保留，并在最低支持版本覆盖该语义后移除。

## 外部资料

DeepSeek 将 `deepseek-v4-flash` 标注为 `DeepSeek-V4-Flash-0731`，支持 1M context、
Tool Calls 与 Responses API。其 Responses 实现无状态，并只部分实现若干请求字段；
价格和兼容范围应查看实时文档。

- [Codex：Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex：其他模型与 provider](https://learn.chatgpt.com/docs/models#other-models)
- [Codex：配置参考](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
- [Codex 0.145.0 release](https://github.com/openai/codex/releases/tag/rust-v0.145.0)
- [DeepSeek：Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api)
- [DeepSeek：模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
