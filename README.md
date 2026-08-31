[English](README.en.md)

# mixagents

这里收录两套彼此独立的 Agent 集成。它们解决的问题不同，可以单独安装。

## Codex DeepSeek Subagent

让 Codex 主任务继续使用 OpenAI，把边界明确、文本量较大的任务交给
`deepseek-v4-flash` 子代理。当前版本使用一次性 plaintext Hook，绕过 Codex
跨 provider 子任务正文不可读的问题。

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

两套集成都会把任务内容发送给用户配置的第三方 provider。Codex 组件会在本地用户状态中
短暂保存明文任务；Pi 组件提供可以读写文件的 `str_replace_editor`。DeepSeek 与
OpenCode 的费用独立于 ChatGPT/OpenAI 订阅。仓库级说明见 [SECURITY.md](SECURITY.md)。

各组件的源码、测试和文档都在自己的 `packages/` 目录中。根目录 `prompts/` 只保留旧
raw URL 的转发入口。Issue 与贡献约定见
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)。

本仓库是独立社区项目，与 OpenAI、DeepSeek、Pi 或 OpenCode 均无隶属或官方背书关系。
