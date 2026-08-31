[仓库索引](../../README.md) · [English](README.en.md) ·
[高级说明](docs/advanced.md) · [安全说明](SECURITY.md)

# Codex DeepSeek Subagent

让 Codex 主任务继续使用 OpenAI，把边界明确、以文本为主的大批量阅读、搜索、日志和整理
任务交给 `deepseek-v4-flash` 子代理。是否委派仍由 Codex Parent 决定；安装不会更换主
任务的 model、provider 或 ChatGPT 登录。

当前 Codex 在 OpenAI Parent 与第三方 provider child 之间仍可能交付不可读的加密任务。
本组件用一次性 plaintext `SubagentStart` Hook 传递 assignment；上游恢复可靠的
provider-neutral 传输后，这层 workaround 可以删除。技术背景见
[高级说明](docs/advanced.md#为什么-v2-需要-hook)。

## 安装

### 1. 配置 DeepSeek API key

在 DeepSeek 创建 key，并以 `DEEPSEEK_API_KEY` 环境变量提供给启动 Codex 的进程。不要
把 key 发进聊天、Issue、截图或仓库。

- Windows：在用户环境变量中设置，然后完整退出并重新启动 Codex Desktop。
- macOS / Linux：在启动 Codex 的 shell 或 secret manager 中设置。

macOS 另有可选 Keychain 模板；默认仍使用环境变量。详见
[macOS Keychain 认证](docs/advanced.md#macos-keychain-可选认证)。

### 2. 让 Codex 安装组件

把下面内容复制给 Codex：

```text
请读取并严格执行
https://raw.githubusercontent.com/Utopia-V/mixagents/main/packages/codex-deepseek-subagent/prompts/install-with-codex.md
为我安装其中的 DeepSeek V4 Flash subagent。保留当前主模型、provider 和 ChatGPT
登录，不得索要或输出 API key；完成无付费调用的本地验证后停止，暂不运行 smoke
test。
```

安装会写入个人 Codex 配置中的 Agent、Skill、Hook 脚本和一条路由索引，不会调用
DeepSeek。

### 3. 信任 Hook 并测试

1. 在 Codex 输入 `/hooks`，确认 Hook 只匹配 `v4_flash_worker`，命令指向刚安装的
   `plaintext-handoff` 脚本，然后选择信任。
2. 新开一个 Codex 任务。Windows 如果刚设置或修改 key，先完整重启 Codex。
3. 在新任务中发送：

```text
请读取并严格执行
https://raw.githubusercontent.com/Utopia-V/mixagents/main/packages/codex-deepseek-subagent/prompts/quick-smoke-test.md
测试刚安装的 v4_flash_worker。不得使用替代 provider、直接 API 或另一个 Codex
CLI。
```

quick smoke 会发起一次很小的 DeepSeek 请求并产生相应费用。

## 成功时会看到什么

- Codex 创建一个独立的 `v4_flash_worker` child task；
- child 返回本次随机 marker 和 `arithmetic=323`；
- pending handoff 被消费；
- Parent 仍使用原来的 OpenAI model/provider。

日常使用时，Parent 只在任务明确适合 Flash 时读取 `$use-v4-flash-worker`。assignment
会短暂以明文写入本地用户状态，随后发送给 DeepSeek；默认 child 为只读，但当前 Parent
权限仍可能影响实际 sandbox。不要委派未获授权的私有源码、秘密、个人数据或受监管数据。

## 常见问题

- 找不到 `v4_flash_worker`：先新开任务，仍看不到再重启 Codex。
- child 没收到任务：检查 `/hooks` 是否已信任，并确认当前任务是在安装后新建的。
- 认证缺失：只检查环境变量或 Keychain item 是否存在，不要输出 key。
- Windows 在 Hook 前报告 Agent 不可用：确认 Codex 进程继承了环境变量并完整重启。

更多安装边界、V1 兼容路径、Windows 认证和上游缺陷见
[高级说明](docs/advanced.md)。协议诊断与贡献者 smoke 位于 [prompts/](prompts/)。

DeepSeek API 费用独立于 ChatGPT/OpenAI 订阅。组件采用 [MIT](LICENSE) 许可证，与
OpenAI 或 DeepSeek 无隶属或官方背书关系。
