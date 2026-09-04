[English](README.md) · [安全说明](SECURITY.md)

# MixAgents Broker

MixAgents Broker 让 Codex 在不切换当前 controller provider 的情况下，把子任务交给其他
模型供应商。当前 Codex 的原生 custom child 会继承 parent provider，Broker 使用独立的
Codex App Server worker 执行跨供应商任务。

插件包含一个 `$broker` Skill 和一个本地 STDIO MCP server。Skill 选择预先配置的
route，MCP server 使用该 route 指定的 provider 和 model 启动 worker。

## 运行要求

- 支持插件与 App Server 的 Codex；
- Node.js `22.19.0` 或更高版本；
- 与 Responses API 兼容的供应商 endpoint；
- 每条 route 对应的 API 凭据。

Broker 面向 Codex `0.149.0` 及以后版本。当前兼容基线为 Codex
`0.151.0-alpha.7.2` 与 OpenCode Go `deepseek-v4-flash`。其他 provider 和 model 需要
提供兼容的 Responses endpoint。

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
      "model": "deepseek-v4-flash",
      "contextWindow": 1000000,
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "envKey": "OPENCODE_API_KEY",
      "tags": ["fast", "low-cost", "coding"],
      "maxAccess": "workspace-write",
      "reasoningEffort": "medium"
    }
  }
}
```

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

派发前，controller 会说明实际使用的 provider、model 和 backend。只有 assignment 与
明确附带的 context 会发送给该 provider，parent conversation 不会被自动复制。

managed Agent 直接使用传入的 workspace。一次 turn 完成、失败或中断后，仍可在同一个
Agent thread 中继续发送消息。

`cwd` 应传入当前 workspace 的绝对路径。未预授权的 workspace 只有在 host 确认后才会
使用；拒绝确认不会启动 worker。

## 技术实现

`$broker` Skill 在派发前调用 `routes`。每条 route 固定 provider 和 model。

当前 Codex 无法让原生 custom child 切换到不同于 parent 的 provider，因此 Broker
直接选择 `app_server`，不会在每个任务中重复尝试 native。只有某条 route 的缓存资格记录
已经验证跨供应商创建、工具调用、等待、中断和结果返回时，才会使用 native backend。

App Server backend 按 route 和实际访问级别启动独立 runtime。Codex App Server 负责
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

详细契约见 [controller-contract.md](docs/controller-contract.md) 和
[backend-and-lifecycle-policy.md](docs/backend-and-lifecycle-policy.md)。

## 权限与数据

- 每次派发默认使用 `read-only`；需要修改文件时才请求 `workspace-write`。
- managed worker 直接修改传入的 workspace；Broker 不创建 worktree，也不合并改动。
- worker 读取的文件内容和工具结果可能发送给所选 provider。
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
`$broker` Skill、STDIO MCP 配置和预编译 JavaScript runtime。生产运行时没有第三方
Node.js 依赖。
