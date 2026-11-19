[简体中文](README.md)

# mixagents

This repository is mainly home to MixAgents Broker, a Codex plugin that keeps Codex on its current model while handing subtasks to workers on other model providers. It also holds pi-dsh-mimic, a small extension for the Pi coding agent that is unrelated to Broker.

## MixAgents Broker

Native Codex subagents inherit the parent's provider, so a single subtask cannot run on a different one. Broker consists of a `$broker` Skill and a local MCP server. You configure routes in advance, each naming a provider and a model; when a subtask is dispatched, the MCP server starts a separate Codex App Server worker for the chosen route and returns its result to the current conversation.

The npm package is [`mixagents-broker`](https://www.npmjs.com/package/mixagents-broker). Install it through this repository's marketplace:

```bash
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

Routes and credentials are configured after installation; see the [user guide](packages/broker/README.md) ([简体中文](packages/broker/README.zh-CN.md)). The worker sends the task and the file content it reads to the route's provider, which bills that usage separately. Data handling and local permissions are described in the [Broker security notes](packages/broker/SECURITY.md).

## pi-dsh-mimic

pi-dsh-mimic is an extension for [Pi](https://github.com/earendil-works/pi) and installs on its own:

```bash
pi install npm:pi-dsh-mimic
```

It changes only the first DeepSeek V4 Pro request of a new session: that request uses the DSH Minimal persona and two tools, and after the first valid response Pi's native requests and full tool catalog return. On one long-horizon maintenance task the author built, default Pi scored 92 and four runs of this flow scored 96–98.

[User guide](packages/pi-dsh-mimic/README.md) · [Experiments and design](packages/pi-dsh-mimic/docs/advanced.md) · [Security](packages/pi-dsh-mimic/SECURITY.md)

## Other

The repository's original Codex DeepSeek Subagent was Hook-based and worked only on Codex 0.148.x and older. It has been removed; the old files are at the tag [`codex-deepseek-subagent-final`](https://github.com/Utopia-V/mixagents/tree/codex-deepseek-subagent-final/packages/codex-deepseek-subagent).

See the [contributing notes](.github/CONTRIBUTING.md) before opening an issue or pull request, and [SECURITY.md](SECURITY.md) for reporting security problems. This is an independent community project, not affiliated with OpenAI, DeepSeek, Pi, or OpenCode.
