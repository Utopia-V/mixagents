[English](README.md) · [安全说明](SECURITY.md) · [设计说明（英文）](docs/design.md)

# MixAgents Broker

MixAgents Broker 让 Codex 会话把子任务交给其他模型供应商上的 worker，会话本身仍使用
原来的 provider。你预先配置若干 route，每条 route 指定一个 provider 和一个 model。插件
中的 `$broker` Skill 负责选择 route，本地 MCP server 则为这条 route 启动一个独立的
Codex App Server 进程作为 worker，它只与该 route 的 provider 通信。

## 什么时候适合用 Broker

Codex 的原生 subagent 按设计沿用 parent 的 provider（见
[subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)）。想在
Codex 里同时使用多个供应商的人，通常采用以下三种做法之一：

- **Broker**：主会话仍直接与自己的 provider 通信，中间没有代理；其他供应商上的
  worker 是 Broker 启动的独立 Codex 进程，通过六个工具汇报状态和结果。它适合留在主力
  供应商上、把边界清楚的任务交出去的用法。
- **本地 gateway**：在一个 Codex provider 条目后面接入多个供应商。由于所有模型都在
  同一个 provider 之后，原生 subagent 可以直接按 model 名称使用其他模型；代价是主会话
  的请求也要经过 gateway。
- **整体切换会话的 provider**：手动修改配置，或使用 cc-switch 这类工具。切换后包括
  subagent 在内的所有请求都发往新的 provider，同一时间只用一个供应商。用这种方式切换时
  如何保留 Broker，见[与 cc-switch 共存](#与-cc-switch-共存)。

## 运行要求

- Codex `0.149.0` 或更高版本，支持插件与 App Server；
- Node.js `22.19.0` 或更高版本；
- 与 OpenAI Responses API 兼容的供应商 endpoint；
- 每条 route 对应的 API key。

CI 每周用最新的稳定版 Codex 运行一次 Broker，模型由 mock provider 代替，本文写作时
是 Codex `0.170.0`。唯一一次对真实 provider 的运行使用的是 Codex `0.151` 与
OpenCode Go。

## 安装

npm 包提供插件内容，MixAgents marketplace 负责让 Codex 发现这个包。只发布到 npm
不会自动进入 Codex 默认的公共插件目录。

添加 MixAgents marketplace：

```bash
codex plugin marketplace add Utopia-V/mixagents
```

随后在 Codex 的 Plugins 页面选择 **MixAgents**，找到 **MixAgents Broker** 并安装；
也可以使用 CLI：

```bash
codex plugin add mixagents-broker@mixagents
```

安装后新建一个 Codex 任务。

### 与 cc-switch 共存

cc-switch 每次切换 Codex 供应商时，都会用「通用配置」片段重新生成
`~/.codex/config.toml`，只保留供应商自身的字段、通用配置片段和它自己管理的 MCP
服务。写在 `config.toml` 里的其它内容，包括插件与 marketplace 注册，会在切换后消失；
Codex 于是不再认识这个插件，需要重新安装一次。

要让注册跟着走，把下面两段加入 cc-switch 的 Codex 通用配置片段：

```toml
[marketplaces.mixagents]
source_type = "git"
source = "https://github.com/Utopia-V/mixagents.git"

[plugins."mixagents-broker@mixagents"]
enabled = true
```

然后在每个 Codex 供应商的编辑弹窗里勾上「应用通用配置」：复选框在 `config.toml` 编辑器
右上角，旁边的「编辑通用配置」用来修改片段内容。没有勾选的供应商在切换时不会写入这段
片段，插件注册仍然会丢。cc-switch 自己的提示也写明了这一点：新安装插件或 Hook 后需要
重新同步一次通用配置。

切换后可以用 `codex plugin list` 确认注册还在。注册确实丢了时，按顺序执行：

```bash
codex plugin marketplace remove mixagents
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

第一条不能省，残留的 marketplace 副本会让 `add` 报「already added from a different
source」。修好后新建一个 Codex 任务；`$broker` 还没有出现时，完全退出并重新打开 Codex。

## 配置 route

创建配置文件：

- Linux/macOS：`~/.config/mixagents/broker.json`
- Windows：`%APPDATA%\MixAgents\broker.json`

示例：

```json
{
  "defaultRoute": "opencode-deepseek-flash",
  "routes": {
    "opencode-deepseek-flash": {
      "description": "用于审阅、提取和编码任务的快速 worker。",
      "provider": "opencode_go",
      "providerName": "OpenCode Go",
      "model": "deepseek-v4.1-flash",
      "contextWindow": 1000000,
      "baseUrl": "https://opencode.ai/inference/go/openai/v1",
      "envKey": "OPENCODE_API_KEY",
      "tags": ["fast", "low-cost", "coding"],
      "maxAccess": "workspace-write",
      "reasoningEffort": "high"
    }
  }
}
```

这条 route 使用 OpenCode Go 的 Responses endpoint，OpenCode 在
[Codex 接入说明](https://opencode.ai/docs/console/harnesses/codex)中给出的就是这个地址；
DeepSeek V4.1 Flash 这类原生使用 Chat Completions 的模型，由 OpenCode 负责转换请求。
DeepSeek 官方 API 的文档只列出 Chat Completions 和 Anthropic 格式的 endpoint，没有
Responses endpoint，因此不能直接作为 route。

`workspaceRoots` 是可选的固定目录预授权，并会与 MCP client 提供的 roots 合并。`cwd`
不在这些目录内时，Broker 会在第一次派发前请求确认。确认后只在当前 MCP 连接内授权
该目录的规范化真实路径及其子目录，不会写回配置。无法显示 MCP elicitation 的 client
仍需显式配置 `workspaceRoots`。

`maxAccess` 是 route 的权限上限，每次派发仍默认使用 `read-only`。

用 `MIXAGENTS_BROKER_CONFIG` 可以指定其他绝对配置路径。runtime state 在
Linux/macOS 默认位于 `~/.local/state/mixagents-broker`，在 Windows 默认位于
`%LOCALAPPDATA%\MixAgents\Broker`；可用 `MIXAGENTS_BROKER_DATA_DIR` 修改。

Broker 通常会自动解析 Codex 可执行文件。Windows 上通过 npm 安装的 Codex 会直接解析到
同一版本自带的原生 `codex.exe`，不会把 `codex.cmd` 或 `codex.ps1` shim 当作可执行文件。
无法自动解析时，在配置顶层设置 `codexBin`，或把
`MIXAGENTS_BROKER_CODEX_BIN` 设为 Codex 可执行文件的完整路径。

## 配置凭据

启动 Codex 的进程需要提供 `MIXAGENTS_BROKER_CREDENTIALS_JSON`。它是一个 JSON
object，key 与 route 中引用的环境变量名对应：

```json
{
  "OPENCODE_API_KEY": "<secret>",
  "ANOTHER_PROVIDER_KEY": "<secret>"
}
```

通过启动 Codex 的 launcher 或 secret manager 注入这个值。不要把凭据写入
`broker.json`、prompt、shell history、截图或仓库。route 引用的凭据缺失时，该 route
不可用。

Broker 只在内存中展开凭据映射。每个 App Server runtime 只获得当前 route 引用的凭据，
模型生成的 shell command 不会继承这些变量。

## 使用

需要指定供应商时直接写 route：

```text
$broker 使用 opencode-deepseek-flash 审阅这个模块，只返回最重要的三个问题。
```

也可以让 Broker 根据 route 的说明和 tags 选择：

```text
$broker 把这个提取任务交给已配置的低成本 worker。
```

派发前，controller 会说明实际使用的 provider 和 model。只有 assignment 与明确附带的
context 会发送给该 provider，parent conversation 不会被自动复制。

managed Agent 直接使用传入的 workspace。一次 turn 完成、失败或中断后，仍可在同一个
Agent thread 中继续发送消息。

`cwd` 应传入当前 workspace 的绝对路径。未预授权的 workspace 只有在 host 确认后才会
使用；拒绝确认不会启动 worker。

## Linux sandbox

在 Linux 上，Codex 用 bubblewrap sandbox 执行 worker 的命令，这需要非特权 user
namespace。Ubuntu 24.04 通过 AppArmor 限制了这项能力
（`kernel.apparmor_restrict_unprivileged_userns=1`），sandbox 因此无法启动，命令会以
`bwrap: loopback: Failed RTM_NEWADDR` 失败。默认 `read-only` 权限的 worker 于是不能
执行任何命令，转而请求在 sandbox 之外运行，每条命令都会弹出一次确认。Codex `0.166` 和
`0.170` 上都出现了这个问题，它影响的是 Codex 本身，并非 Broker 独有。

OpenAI 的 [sandboxing 文档](https://learn.chatgpt.com/docs/sandboxing)建议加载
`bwrap-userns-restrict` AppArmor profile，让 bubblewrap 可以创建 namespace，同时对其他
程序保留限制；文档把在全系统关闭这项限制列为备选办法。
[openai/codex#29908](https://github.com/openai/codex/issues/29908) 跟踪这个问题，
[openai/codex#38715](https://github.com/openai/codex/issues/38715) 则报告了这个
profile 可能与其他软件为 `bwrap` 安装的 profile 冲突。

## 技术实现

`$broker` Skill 在派发前调用 `routes`。每条 route 固定 provider 和 model。

Broker 按 route 和访问级别分别启动独立的 Codex App Server runtime。App Server 负责
模型循环、工具、thread history、turn result 与恢复；Broker 把这些能力映射为六个操作：

- `routes`
- `spawn_agent`
- `send`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

controller 看到的状态只有 `starting`、`running`、`completed`、`failed`、
`interrupted` 和 `not_found`。如果无法保持配置的 provider、model、workspace 或
权限边界，Broker 会直接失败，不会替换 route。

多个 Codex 对话可以共用同一个 Broker 数据目录，彼此都能看到对方的 agent。
`list_agents` 和 `wait_agent` 观察其他对话拥有的 agent 时不会接管它；由于收不到
那个对话的通知，`wait_agent` 会轮询它的状态。只要那个对话的 Broker 仍在运行，
对这类 agent 调用 `send` 或 `interrupt_agent` 会返回 `agent_owned_elsewhere`。
那个 Broker 退出以后，任何对话都可以继续这个 agent。

worker 为什么是独立进程，以及工具、状态、确认请求和恢复的细节，见
[docs/design.md](docs/design.md)（英文）。

## 权限与数据

- 每次派发默认使用 `read-only`；需要修改文件时才请求 `workspace-write`。
- managed worker 直接修改传入的 workspace；Broker 不创建 worktree，也不合并改动。
- worker 读取的文件内容和工具结果可能发送给所选 provider，由该 provider 计费。
- worker 请求执行 sandbox 不允许的命令或文件修改时，你会看到确认提示；确认后，这项请求
  会在 sandbox 之外执行。
- Codex sandbox 管理权限，但不保证 `cwd` 之外的所有文件都不可读。
- `interrupt_agent` 只停止本地 turn，上游计算和计费可能继续。

处理私有或受监管数据前阅读 [SECURITY.md](SECURITY.md)。

## 更新与卸载

```bash
codex plugin marketplace upgrade mixagents
codex plugin add mixagents-broker@mixagents
```

```bash
codex plugin remove mixagents-broker@mixagents
```

更新后新建一个 Codex 任务。

## 开发

```bash
cd packages/broker
npm install
npm run check
npm run pack:check
```

发布到 npm 的 package 位于 `plugin/mixagents-broker`，其中包含 plugin manifest、
`$broker` Skill、STDIO MCP 配置，以及 `npm run build` 从 `src/` 编译到 `dist/` 的
JavaScript runtime。`dist/` 不进 git，检查和发布流程都会先构建。生产运行时没有第三方
Node.js 依赖。

`npm run check` 使用模拟的 App Server。`npm run test:codex` 则让 Broker 的 MCP
server 连接真实的 Codex：默认使用 `PATH` 中的 `codex`，也可以通过
`MIXAGENTS_BROKER_CODEX_BIN` 指定其他构建。模型由测试进程内的模拟 Responses
provider 代替，Codex home、Broker 数据目录和 workspace 均为临时目录，因此这项检查
不需要 provider 账号或密钥，也不会读写 `~/.codex`。它覆盖 route 与凭据隔离、
follow-up turn、provider 失败、中断、重启恢复、两个对话共用数据目录，以及 worker
shell 命令的凭据过滤。
CI 每周、每次推送到 `main` 以及每个修改 Broker 的 pull request 都会用最新的稳定版
Codex 运行这项检查。
