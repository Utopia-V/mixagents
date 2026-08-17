[仓库索引](../../README.md) · [English](README.md) · [实验与设计](docs/advanced.zh-CN.md) · [Project2 证据账本](docs/project2-evidence.md)

# pi-dsh-mimic

`pi-dsh-mimic` 在 [Pi](https://github.com/earendil-works/pi) 的第一次模型请求中复现
DeepSeek Harness Minimal 环境，让 DeepSeek V4 Pro 从已验证的高能力轨迹起步；第一次
有效响应后，它立即回到 Pi 原生执行，恢复完整工具目录和用户安装的其他插件。

它把两件事放进同一个 session：

- DSH Minimal 首请求带来的 V4 Pro 工程能力；
- Pi 成熟的工具、session 管理和插件生态。

用户无需安装或运行完整 DSH harness，也不必长期停留在两个工具的 Minimal 环境中。

## 工作方式

新建目标 session 的真实任务直接成为第一次模型请求：

1. 请求 #1 使用 Minimal persona，只暴露 DSH 风格的 `bash` 与
   `str_replace_editor`；
2. 第一个成功 assistant response 或 durable tool call 后，请求 #2 恢复 Pi 原生
   provider payload 和当下完整工具目录；
3. Minimal persona 在整个 session 保持，Pi 较长的自动 system prompt 不会作为额外
   user message 重放。

扩展不增加身份 warm-up 或模型轮次，不复制原任务，不注入 `We need`，也不代理 API。

## Project2 结果

默认 Pi 得到 92。相同 one-shot 请求流程的四次最终结果为 **98、96、96、98**，均保持
F3 16/16：

| 运行 | Provider | 分数 | 关键分项 |
| --- | --- | ---: | --- |
| 默认 Pi baseline | DeepSeek 官方 API | 92 | F3 11，F6 10，F8 6 |
| 早期 Minimal 模拟原型 | DeepSeek 官方 API | **98** | F3 16，F6 10，F8 7 |
| 同流程复现实验 | DeepSeek 官方 API | 96 | F3 16，F6 10，F8 5 |
| 首次 package 化实现 | DeepSeek 官方 API | 96 | F3 16，F6 8，F8 7 |
| 当前独立实现 `0.1.0` | OpenCode Go | **98** | F3 16，F6 10，F8 7 |

这些结果表明：DSH Minimal 首请求可以在 Pi 中稳定建立高能力轨迹，而恢复 Pi 完整工具
目录不会破坏它。实验过程、被否决的设计和每项实现选择的依据见
[实验与设计](docs/advanced.zh-CN.md)；完整 evaluator IDs 与来源见
[Project2 证据账本](docs/project2-evidence.md)。

## 安装和使用

要求：Node.js 22.19 或更新版本、Pi 0.84.2 或更新版本，并已配置 DeepSeek 官方 API 或
OpenCode Go。Pi 0.84.2 已内置两条 provider 路径。

直接试用当前 checkout：

```bash
pi -e ./packages/pi-dsh-mimic \
  --provider deepseek \
  --model deepseek-v4-pro
```

使用 OpenCode Go 时，把 key 配置在 Pi 期望的 `OPENCODE_API_KEY` 环境变量中：

```bash
pi -e ./packages/pi-dsh-mimic \
  --provider opencode-go \
  --model deepseek-v4-pro
```

安装到当前用户：

```bash
pi install ./packages/pi-dsh-mimic
```

项目级安装使用 `pi install -l ./packages/pi-dsh-mimic`。当前 package 尚未发布到 npm。
Manifest 已包含 Pi gallery 要求的 `pi-package` keyword；发布到 npm 后才会出现在
[Pi Package Catalog](https://pi.dev/packages)，安装命令将是
`pi install npm:pi-dsh-mimic`。当前 checkout 不会被市场索引。

先选择 V4 Pro，再新建 session。在已有对话中途切换到 V4 Pro 不会伪造新的 bootstrap。

## 请求生命周期

| | Bootstrap 请求 | 执行阶段请求 |
| --- | --- | --- |
| System persona | `You are a helpful software engineer assistant.` | 保持不变 |
| User 历史 | 原始任务，包括 Pi 原生图片 | 不变 |
| Provider 可见工具 | `bash`、`str_replace_editor` | Pi 当下完整目录，包括其他插件工具 |
| Provider payload | DSH Minimal 形状；移除 Pi cache 字段 | Pi 原生编码与排序；cache 随 provider 配置 |

扩展不调用 `setActiveTools`，也不覆盖 Pi 原生 `bash`、`read`、`edit` 或 `write`。目标
新 session 武装时才注册一个可执行 `str_replace_editor`；请求 #2 起，其他 package
提供的工具会自然出现在完整目录中。

Provider error 或 aborted response 不消耗 bootstrap。阶段通过小型 Pi custom entry
持久化，恢复时也能根据 durable assistant/tool 历史修正 crash-stale 状态。

## 离线验证

TypeScript typecheck 已通过，13 项自动化测试全部通过。其中 12 项覆盖 package 行为与
manifest，1 项验证 session 统计工具。Package 行为测试覆盖：

- 首请求原任务、persona、字段顺序、cache 移除和两工具 schema；
- 请求 #2 恢复 Pi 原生 payload、完整目录和其他插件工具；
- 图片、API error 重试、文本回答晋升、session resume 和 crash-stale 恢复；
- 已有对话隔离、DeepSeek/OpenCode 双 provider 与非目标模型隔离；
- editor 的 create、view、replace、insert 和歧义替换拒绝。

OpenCode Go bash-first 与 editor-first 离线回环还通过 Pi 的真实 package loader 和 provider
路径验证了两个请求，`realModelCalls=0`。请求 #2 携带真实工具结果，并恢复
`read/bash/edit/write/str_replace_editor`。归一 user task 后，新请求 #1 与历史 98 分
capture 在消息、字段顺序、schema、`strict:false` 和序列化结构上逐项相等。

## 开发

```bash
cd packages/pi-dsh-mimic
npm install
npm run check
npm run pack:check
```

## 安全、费用与来源

本 package 以 Pi 进程的文件系统权限运行；`str_replace_editor` 可以创建和修改文件。
任务、上下文和工具结果会发送给所选 DeepSeek 或 OpenCode provider。package 不读取、
保存、记录或传输 API key，也不增加额外模型轮次。完整说明见
[SECURITY.md](SECURITY.md)。

Minimal persona 与两项工具协议文本来自
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的公开 Minimal 协议；
对应许可声明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。当前实现依据该公开协议、本项目
捕获的请求和 Project2 实验完成，与 Pi、DeepSeek、OpenCode 或 OpenAI 均无隶属或官方
背书关系。
