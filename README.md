[English](README.en.md)

# Codex 与 Pi 的 Agent 集成

本仓库维护两个彼此独立的组件：一个为 Codex 增加 DeepSeek V4 Flash 原生子 Agent，
另一个让 Pi 中的 DeepSeek V4 Pro 先以 DSH Minimal 环境启动，再回到 Pi 原生执行。

| 组件 | 作用 | 当前状态 | 文档 |
| --- | --- | --- | --- |
| **Codex DeepSeek Subagent** | Codex 主任务继续使用 OpenAI，把适合的文本、日志和搜索工作交给 `deepseek-v4-flash` child | Windows 与 POSIX plaintext handoff 已完成协议验证 | [使用说明](packages/codex-deepseek-subagent/README.md) · [高级说明](packages/codex-deepseek-subagent/docs/advanced.md) |
| **Pi DSH Mimic** | 在 Pi 的首请求中复现 DSH Minimal，激活 V4 Pro 的高能力轨迹；随后恢复 Pi 完整工具目录与插件生态 | `0.1.0`；同一请求流程在 Project2 得到 98、96、96、98；尚未发布到 npm | [使用说明](packages/pi-dsh-mimic/README.zh-CN.md) · [实验与设计](packages/pi-dsh-mimic/docs/advanced.zh-CN.md) · [证据账本](packages/pi-dsh-mimic/docs/project2-evidence.md) |

## 怎样选择

- 想保留 Codex 的 OpenAI 主 Agent，同时使用更便宜的 DeepSeek child，安装
  **Codex DeepSeek Subagent**。
- 已经在 Pi 中使用 `deepseek-v4-pro` 或 `opencode-go/deepseek-v4-pro`，希望模型从
  已验证的 DSH Minimal 轨迹起步，同时继续使用 Pi 的 `read/edit/write` 和其他插件，
  安装 **Pi DSH Mimic**。

Pi DSH Mimic 只复现 DSH Minimal 的首次请求界面。用户无需安装或运行完整 DSH harness；
真正执行任务、管理 session 和组合插件的仍然是 Pi。

## 数据、安全与费用

两个组件都会把任务内容发送给用户配置的第三方 provider。Codex 组件会在本地用户状态中
短暂保存明文任务；Pi 组件提供可以写文件的 `str_replace_editor`。安装前请阅读：

- [Codex 安全说明](packages/codex-deepseek-subagent/SECURITY.md)
- [Pi 安全说明](packages/pi-dsh-mimic/SECURITY.md)
- [仓库级安全入口](SECURITY.md)

DeepSeek 与 OpenCode API 费用独立于 ChatGPT/OpenAI 订阅。离线安装和测试不应调用模型；
smoke test 和完整模型运行会按对应 provider 计费。

## 仓库结构与旧入口

每个组件的源码、测试和文档都位于自己的 `packages/` 子目录。根部 `prompts/` 只保留
旧公开 raw URL 的转发入口，Codex 安装 prompt 的正式版本由其组件目录维护。

Issue 与贡献约定见 [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)。本仓库为独立
社区项目，与 OpenAI、DeepSeek、Pi 或 OpenCode 均无隶属或官方背书关系。
