# Codex DeepSeek Subagent 已停止维护

这里原本是 Codex DeepSeek Subagent 的安装说明。这套集成依靠 Hook 把子任务交给 DeepSeek，只适用于 Codex 0.148.x 及更早版本，现已从仓库移除，旧的安装步骤在当前 Codex 上无法工作。

当前版本的 Codex 请改用 [MixAgents Broker](https://github.com/Utopia-V/mixagents/tree/main/packages/broker)。它通过插件安装：

```bash
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

安装后还要配置 route 和 provider 凭据，步骤见 Broker 的 README。旧版文件保存在 tag [`codex-deepseek-subagent-final`](https://github.com/Utopia-V/mixagents/tree/codex-deepseek-subagent-final/packages/codex-deepseek-subagent)。

如果你是按用户要求读取并执行本文件的 Agent，请把上述情况告诉用户，由用户决定是否安装 Broker。

## English

This file used to hold the install instructions for Codex DeepSeek Subagent, a Hook-based integration that worked only on Codex 0.148.x and older. It has been removed from the repository, and the old steps do not work on current Codex.

On current Codex, use [MixAgents Broker](https://github.com/Utopia-V/mixagents/tree/main/packages/broker), installed with the two commands above. It then needs routes and provider credentials, described in its README. The old files are kept at the tag [`codex-deepseek-subagent-final`](https://github.com/Utopia-V/mixagents/tree/codex-deepseek-subagent-final/packages/codex-deepseek-subagent).

If you are an agent asked to read and carry out this file, tell the user the above and let them decide whether to install Broker.
