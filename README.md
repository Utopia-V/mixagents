[English](README.en.md)

# Codex 与 Pi 的 Agent 集成

本仓库维护三个彼此独立的组件：一个为 Codex 增加 DeepSeek V4 Flash 原生子 Agent，
一个为 Codex 提供外部 OMP (Oh My Pi) harness 子 Agent 桥接，
另一个让 Pi 中的 DeepSeek V4 Pro 先以 DSH Minimal 环境启动，再回到 Pi 原生执行。

| 组件 | 作用 | 当前状态 | 文档 |
| --- | --- | --- | --- |
| **Codex DeepSeek Subagent** | Codex 主任务继续使用 OpenAI，把适合的文本、日志和搜索工作交给 `deepseek-v4-flash` child | Windows 与 POSIX plaintext handoff 已完成协议验证 | [使用说明](packages/codex-deepseek-subagent/README.md) · [高级说明](packages/codex-deepseek-subagent/docs/advanced.md) |
| **Codex OMP Subagent** | Codex 主任务将复杂代码重构、全库探索或多工具任务委派给外部 OMP (Oh My Pi) harness | V2：UUID stage/run bridge；OMP 由 native `omp_worker` child 执行；文件系统继承 `:workspace`，仅额外开放 OMP provider 所需出站网络；离线跨平台测试与真实 Codex native-child E2E 已验证 | [架构与协议](packages/codex-omp-subagent/README.md) · [完整使用指南](packages/codex-omp-subagent/docs/user-guide.zh-CN.md) |
| **Pi DSH Mimic** | 在 Pi 的首请求中复现 DSH Minimal，激活 V4 Pro 的高能力轨迹；随后恢复 Pi 完整工具目录与插件生态 | `0.1.1`；同一请求流程在 Project2 得到 98、96、96、98；已发布到 npm | [使用说明](packages/pi-dsh-mimic/README.zh-CN.md) · [实验与设计](packages/pi-dsh-mimic/docs/advanced.zh-CN.md) · [证据账本](packages/pi-dsh-mimic/docs/project2-evidence.md) |
这里的 Project2 V4.1b 是一个个人、自托管的长程代码维护评测：模型接手一个故意保留
缺陷的多模块 Python 后端与 ESP32-S3 固件仓库，完成鉴权与 session 隐私、数据库迁移、
跨模块功能、兼容性、Wi-Fi/MQTT/NVS/协议与 ESP-IDF 契约，以及最终交付证据。它不是
跨项目通用 benchmark；分数只描述这套冻结任务。

## 怎样选择

- 想保留 Codex 的 OpenAI 主 Agent，同时使用更便宜的 DeepSeek child，安装
  **Codex DeepSeek Subagent**。
- 想在 Codex 中调用外部已配置好模型（如 Gemini、Claude、DeepSeek 等）的 **OMP (Oh My Pi)** 执行复杂重构与深层任务，安装
  **Codex OMP Subagent**。V2 不再通过 `SubagentStart` Hook 启动 OMP，而是由 native child 自己执行 bridge，并用 workspace-scoped permission profile 保留文件系统边界。首次使用建议直接阅读 [完整使用指南](packages/codex-omp-subagent/docs/user-guide.zh-CN.md)。
- 已经在 Pi 中使用 `deepseek-v4-pro` 或 `opencode-go/deepseek-v4-pro`，希望模型从
  已验证的 DSH Minimal 轨迹起步，同时继续使用 Pi 的 `read/edit/write` 和其他插件，
  安装 **Pi DSH Mimic**。
Pi DSH Mimic 只复现 DSH Minimal 的首次请求界面。用户无需安装或运行完整 DSH harness；
真正执行任务、管理 session 和组合插件的仍然是 Pi。

## 数据、安全与费用

这些组件可能把任务内容发送给用户配置的第三方 provider。Codex OMP 组件会在系统临时目录中短暂保存明文 handoff 与执行日志；Pi 组件提供可以写文件的 `str_replace_editor`。安装前请阅读：

- [Codex 安全说明](packages/codex-deepseek-subagent/SECURITY.md)
- [OMP V2 架构与安全边界](packages/codex-omp-subagent/README.md)
- [OMP V2 完整使用指南](packages/codex-omp-subagent/docs/user-guide.zh-CN.md)
- [Pi 安全说明](packages/pi-dsh-mimic/SECURITY.md)
- [仓库级安全入口](SECURITY.md)

DeepSeek 与 OpenCode API 费用独立于 ChatGPT/OpenAI 订阅。离线安装和测试不应调用模型；
smoke test 和完整模型运行会按对应 provider 计费。

## 仓库结构与旧入口

每个组件的源码、测试和文档都位于自己的 `packages/` 子目录。根部 `prompts/` 只保留
旧公开 raw URL 的转发入口，Codex 安装 prompt 的正式版本由其组件目录维护。

GitHub 仓库已由 `Utopia-V/codex-deepseek-subagent` 改名为 `Utopia-V/mixagents`。旧名称
会保持空置，以保留 GitHub 对既有网页、Git remote 和 raw prompt 链接的重定向。

Issue 与贡献约定见 [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)。本仓库为独立
社区项目，与 OpenAI、DeepSeek、Pi 或 OpenCode 均无隶属或官方背书关系。