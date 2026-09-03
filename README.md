[English](README.en.md)

# mixagents

本仓库包含三个可独立安装的 Agent package。

## MixAgents Broker

让 Codex 在不切换 controller provider 的情况下，把子任务交给其他模型供应商。npm
package 为 [`mixagents-broker`](https://www.npmjs.com/package/mixagents-broker)，通过
MixAgents marketplace 安装：

```bash
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

[安装、配置与实现说明](packages/broker/README.zh-CN.md) ·
[English](packages/broker/README.md) · [安全说明](packages/broker/SECURITY.md)

## Codex DeepSeek Subagent

旧版 DeepSeek 子代理方案，仅适用于 Codex `0.148.x` 及更早的兼容版本。Codex
`0.149.0` 起改用 MixAgents Broker。

[安装使用](packages/codex-deepseek-subagent/README.md) ·
[高级说明](packages/codex-deepseek-subagent/docs/advanced.md) ·
[安全边界](packages/codex-deepseek-subagent/SECURITY.md)

## pi-dsh-mimic

只修改 DeepSeek V4 Pro 在 Pi 中的第一次请求：先使用 DSH Minimal 的 persona 和两个
工具，第一次有效响应后恢复 Pi 原生请求与完整工具目录。在同一个冻结 Project2 任务中，
默认 Pi 得到 92，四次相同流程得到 96–98；这个结果不代表通用 benchmark。

[安装使用](packages/pi-dsh-mimic/README.zh-CN.md) ·
[实验与设计](packages/pi-dsh-mimic/docs/advanced.zh-CN.md) ·
[证据账本](packages/pi-dsh-mimic/docs/project2-evidence.md) ·
[安全边界](packages/pi-dsh-mimic/SECURITY.md)

## 安装前

这些 package 可能把任务内容、文件内容和工具结果发送给配置的第三方 provider，相关费用
独立于 ChatGPT/OpenAI 订阅。安装前阅读 [SECURITY.md](SECURITY.md)。

各 package 的源码、测试和文档都在自己的 `packages/` 目录中。根目录 `prompts/` 只保留旧
raw URL 的转发入口。Issue 与贡献约定见
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)。

本仓库是独立社区项目，与 OpenAI、DeepSeek、Pi 或 OpenCode 均无隶属或官方背书关系。
