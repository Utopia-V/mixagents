[English](README.en.md)

# mixagents

本仓库主要维护 MixAgents Broker。它是一个 Codex 插件，让 Codex 保持当前使用的模型，同时把子任务交给其他模型供应商上的 worker 完成。仓库里还有一个与 Broker 无关的小扩展 pi-dsh-mimic，供 Pi coding agent 使用。

## MixAgents Broker

Codex 原生的 subagent 沿用 parent 的 provider，无法为某个子任务单独换一个供应商。Broker 由一个 `$broker` Skill 和一个本地 MCP server 组成：你预先配置好 route，每条 route 指定 provider 和 model；派发子任务时，MCP server 按所选 route 启动独立的 Codex App Server worker，任务完成后把结果交回当前对话。

npm 包为 [`mixagents-broker`](https://www.npmjs.com/package/mixagents-broker)，通过本仓库的 marketplace 安装：

```bash
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

安装后还需要配置 route 和凭据，步骤见[使用说明](packages/broker/README.zh-CN.md)（[English](packages/broker/README.md)）。worker 会把任务和它读取的文件内容发送给所选 route 的 provider，费用由该 provider 另行计费；数据和本地权限的细节见 [Broker 安全说明](packages/broker/SECURITY.md)。

## pi-dsh-mimic

pi-dsh-mimic 是 [Pi](https://github.com/earendil-works/pi) 的扩展，可以单独安装：

```bash
pi install npm:pi-dsh-mimic
```

它只改变 DeepSeek V4 Pro 在新 session 中的第一次请求：先使用 DSH Minimal 的 persona 和两个工具，第一次有效响应后恢复 Pi 原生请求和完整工具目录。在作者自建的一个长程代码维护任务上，默认 Pi 得到 92 分，这一流程的四次运行得到 96–98 分。

[使用说明](packages/pi-dsh-mimic/README.zh-CN.md) · [实验与设计](packages/pi-dsh-mimic/docs/advanced.zh-CN.md) · [安全说明](packages/pi-dsh-mimic/SECURITY.md)

## 其他

仓库最初的 Codex DeepSeek Subagent 基于 Hook 实现，只适用于 Codex 0.148.x 及更早版本，现已移除，旧文件保存在 tag [`codex-deepseek-subagent-final`](https://github.com/Utopia-V/mixagents/tree/codex-deepseek-subagent-final/packages/codex-deepseek-subagent)。

提交 Issue 或 PR 前可以先读[贡献说明](.github/CONTRIBUTING.md)，安全问题的报告方式见 [SECURITY.md](SECURITY.md)。本项目是独立的社区项目，与 OpenAI、DeepSeek、Pi 和 OpenCode 没有隶属关系。
