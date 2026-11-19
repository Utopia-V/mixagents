[仓库索引](../../README.md) · [English](README.md) ·
[实验与设计](docs/advanced.zh-CN.md) · [Project2 证据账本](docs/project2-evidence.md)

# pi-dsh-mimic

`pi-dsh-mimic` 只修改 DeepSeek V4 Pro 在 [Pi](https://github.com/earendil-works/pi)
中的第一次模型请求。真实任务先进入 DSH Minimal 的 persona 与 `bash`、
`str_replace_editor` 两个工具；第一次有效响应后，后续请求恢复 Pi 原生格式和完整工具
目录。

它不需要安装完整 DSH harness，也不会增加额外模型轮次。

## 维护状态

本包已冻结：继续修复缺陷，不再增加功能。实验证据取自 2026 年 8 月的 DeepSeek V4 Pro
（0813 版）和 Pi 0.84.2，此后有两处变化。

DeepSeek Harness 自 2026 年 9 月 3 日起把 Minimal 模式缩减为只有 `bash` 一个工具。
本包沿用 8 月的双工具形态，实验结果也是在这一形态下测得的。Pi 已更新到 1.5.2，本包的
类型检查和离线测试在该版本上通过，真实任务没有在该版本上重新运行。

`deepseek-v4-pro` 被新的 Pro 模型取代，或 Pi 的扩展接口变更使本包失效时，本包停止维护。

## 工作方式

1. 新建目标 session 后，原始任务直接成为 Minimal 请求；
2. 第一次成功的 assistant response 或实际 tool call 结束 bootstrap；
3. 后续请求继续使用 Minimal persona，但 payload、工具排序和插件工具由 Pi 接管。

Provider error 或 aborted response 不消耗 bootstrap。阶段会写入一个小型 Pi custom entry，
因此 session resume 后仍能恢复；如果进程在响应完成后、阶段写入前崩溃，durable
assistant/tool 历史会把状态修正到执行阶段。

## 实验结果

在一个冻结的 Project2 V4.1b 长程代码维护任务中，默认 Pi 得到 92；使用相同 one-shot
流程的四次最终结果为 98、96、96、98。这是一个个人任务上的四次运行，其他项目、模型
版本和评测尚未测试。

实验条件、负结果和实现取舍见[实验与设计](docs/advanced.zh-CN.md)，完整运行与 evaluator
来源见 [Project2 证据账本](docs/project2-evidence.md)。

## 安装和使用

要求：Node.js 22.19 或更新版本、Pi 0.84.2 或更新版本，并已在 Pi 中配置模型标识包含
`deepseek-v4-pro` 的 provider。扩展已在 DeepSeek 官方 API 与 OpenCode Go 上测试过；
其他 provider 只要模型标识满足这一条件，也会激活扩展。

安装到当前用户：

```bash
pi install npm:pi-dsh-mimic
```

项目级安装：

```bash
pi install -l npm:pi-dsh-mimic
```

直接试用当前 checkout：

```bash
pi -e ./packages/pi-dsh-mimic \
  --provider deepseek \
  --model deepseek-v4-pro
```

OpenCode Go 使用 Pi 预期的 `OPENCODE_API_KEY` 环境变量，并将 provider 设为
`opencode-go`。

请先选择 V4 Pro，再新建 session。已有对话中途切换到 V4 Pro 不会补造 bootstrap。
扩展在目标 session 中注册 `str_replace_editor`；如果在同一个 session 里再切换到其他
模型，这个工具可能继续留在当前工具目录。需要干净的非目标模型环境时，新建 session。

## 请求变化

| | 第一次请求 | 后续请求 |
| --- | --- | --- |
| Persona | `You are a helpful software engineer assistant.` | 保持不变 |
| User 历史 | 原始任务，包括 Pi 图片 | 保持不变 |
| 工具 | `bash`、`str_replace_editor` | Pi 当前完整目录，包括其他插件工具 |
| Payload | DSH Minimal 形状 | Pi 原生编码与排序 |

`str_replace_editor` 可以查看、创建和修改绝对路径文件，并继承 Pi 进程的文件系统权限。
任务、上下文和工具结果会发送给你在 Pi 中选择的 provider，按普通请求计费。详细说明见
[SECURITY.md](SECURITY.md)。

## 开发

```bash
cd packages/pi-dsh-mimic
npm install
npm run check
npm run pack:check
```

Minimal persona 与两项工具协议来自 DeepSeek Harness 的
[公开 Minimal 协议](https://github.com/deepseek-ai/deepseek-harness)，许可见
[LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
