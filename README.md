[English](README.en.md) · [高级说明](docs/advanced.md)

# Codex DeepSeek Subagent

让 Codex 主任务继续使用 GPT / OpenAI，同时把便宜、快速的
`deepseek-v4-flash` 当作原生 subagent 做搜索、枚举、日志和大量文本整理。

DeepSeek 是本仓库提供的开箱即用实现，不是这种组合的能力上限。凡是能被 Codex
通过受支持 API 调用、并满足目标任务能力与数据边界的 provider/model，都可以按
同一模式适配成独立 subagent；当前安装器仍只安装经过验证的 DeepSeek 配置。具体
条件见 [适配其他 provider/model](docs/advanced.md#适配其他-providermodel)。

这套安装不需要 CC Switch、MCP、插件或另一个 Codex CLI，也不会把主 Agent
切到 DeepSeek。只做下面三步。

## 三步安装

### 1. 设置 DeepSeek API key

在 DeepSeek 创建 key，然后把它保存为环境变量 `DEEPSEEK_API_KEY`。不要把 key
发进 Codex 聊天、Issue、截图或仓库。

- Windows：在系统设置中搜索“环境变量”，在“用户变量”中新建
  `DEEPSEEK_API_KEY`。已经打开的 Codex Desktop 也能使用这个用户变量。
- macOS / Linux：在启动 Codex 的 shell 或 secret manager 中设置
  `DEEPSEEK_API_KEY`，再启动 Codex。

不知道怎么设置时，可以让 Codex 只解释你当前系统的环境变量设置方法，但不要把
key 本身交给它。安全细节见 [SECURITY.md](SECURITY.md)。

### 2. 把这一段复制给 Codex

```text
请读取并严格执行
https://raw.githubusercontent.com/Utopia-V/codex-deepseek-subagent/main/prompts/install-with-codex.md
为我安装其中的 DeepSeek V4 Flash subagent。保留当前主模型、provider 和 ChatGPT
登录，不得索要或输出 API key；完成无付费调用的本地验证后停止，暂不运行 smoke
test。
```

Codex 会自行下载、合并和验证需要的 Agent、skill、Hook 与两条 `AGENTS.md`
索引。安装过程不会调用 DeepSeek，也不会改掉主模型/provider。

### 3. 信任 Hook，然后测试

安装完成后：

1. 在 Codex 输入 `/hooks`，检查它只匹配 `v4_flash_worker`，命令指向刚安装的
   `plaintext-handoff` 脚本，然后选择信任。
2. **新开一个 Codex 任务。** 已经运行的旧任务不保证重新加载新 Hook；通常不必
   重启整个应用。
3. 把下面一句复制到新任务：

```text
请读取并严格执行
https://raw.githubusercontent.com/Utopia-V/codex-deepseek-subagent/main/prompts/quick-smoke-test.md
测试刚安装的 v4_flash_worker。不得使用替代 provider、直接 API 或另一个 Codex
CLI。
```

这个 quick smoke 不要求 clone 仓库，会产生一次很小的 DeepSeek API 调用。

## 怎样算成功

测试结果应同时满足：

- 出现一个独立的原生 child task，agent type 是 `v4_flash_worker`；
- child 返回父 Agent 随机生成的 marker，并得到 `arithmetic=323`；
- 一次性 pending handoff 已被消费；
- 主任务仍使用原来的 OpenAI 模型/provider；
- 没有另起 CLI、直连 API 或换模型冒充成功。

满足这些条件后即可正常使用。父 Agent 会在适合的任务上按需加载
`$use-v4-flash-worker`，自行决定是否委派；安装并不强迫每个任务都使用 Flash。

安装只会在个人 Codex 配置中新增或更新独立 Agent、skill、Hook 和两条路由索引；
不会向顶层配置添加 DeepSeek provider，不会切换主任务模型。唯一需要你手动决定的
步骤是通过 `/hooks` 审查并信任 Hook。完整文件边界见 [高级说明](docs/advanced.md)。

## 如果没有成功

- **看不到 `v4_flash_worker`：** 先新开任务；仍看不到再重启 Codex 一次。
- **child 说没有收到任务：** 通常是 Hook 未信任、当前任务早于 Hook 安装，或者
  Hook 没有加载。检查 `/hooks` 后再新开任务，不要改用 inherited turns。
- **提示缺少 `DEEPSEEK_API_KEY`：** 只检查环境变量是否存在，不要把 key 贴进聊天。
- **安装 Agent 要你切换全局 provider、启动另一套 CLI 或安装 MCP：** 停止；那不是
  本仓库的安装路径。

仍失败时，优先选择合适的[结构化 Issue Form](https://github.com/Utopia-V/codex-deepseek-subagent/issues/new/choose)；
现有分类都不适用时，也可以开 Blank Issue。请尽量提供操作系统、Codex 版本、失败
边界和脱敏后的输出；不要附 API key、完整请求头或未脱敏配置。可以让 Agent 协助
整理报告，但提交前应由人核对实际观测、推断和未运行的对照。可复现的证据有助于
区分配置、Agent discovery、Hook、provider request 和 callback 等失败边界，也能
帮助后来的人。

## 高级用户与贡献者

- 实现原理、V1 workaround、当前 V2 上游缺陷、配置边界和迁移条件：
  [高级说明](docs/advanced.md)
- 完整 Agent 安装合同：[prompts/install-with-codex.md](prompts/install-with-codex.md)
- 带本地工具和 SHA-256 的贡献者 smoke：[prompts/smoke-test.md](prompts/smoke-test.md)
- 只诊断原始 V2 message-only 的探针：
  [prompts/message-handoff-probe.md](prompts/message-handoff-probe.md)
- 凭据、plaintext 本地状态和 DeepSeek 数据边界：[SECURITY.md](SECURITY.md)

Windows Desktop 的 PowerShell 路径已经 live-pass。macOS 的 Python/POSIX 路径已在
Codex `0.146.0` 上通过原生 callback smoke，并通过 25 项协议、并发与故障恢复测试；
Linux 使用同一 POSIX 实现。Python 脚本依赖 POSIX 锁，在 Windows 上会拒绝运行，
Windows 请使用独立的 PowerShell 脚本；锁保证不自动延伸到该路径。

## 费用与关联声明

DeepSeek API 费用独立于 ChatGPT/OpenAI 订阅。安装不产生 DeepSeek 调用；quick
smoke 和之后的 Flash child 会按 DeepSeek 账户计费。

MIT。本仓库是独立配置示例，与 OpenAI 或 DeepSeek 不存在隶属或官方背书关系。
