# MixAgents Broker

MixAgents Broker is a Codex plugin that lets a Codex session hand subtasks to
workers on other model providers while the session stays on its own provider.
It contains the `$broker` Skill and a local MCP server that runs each worker as
a separate Codex App Server process on the provider and model of a route you
configure.

Requirements: Codex `0.149.0` or later, Node.js `22.19.0` or later, a provider
endpoint compatible with the OpenAI Responses API, and an API key for it.

Install through the MixAgents marketplace, then start a new Codex task:

```bash
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

Routes and credentials must be configured before first use. The documentation
covers configuration, use, data handling and the Linux sandbox:
[English](https://github.com/Utopia-V/mixagents/blob/main/packages/broker/README.md) ·
[简体中文](https://github.com/Utopia-V/mixagents/blob/main/packages/broker/README.zh-CN.md) ·
[Security](https://github.com/Utopia-V/mixagents/blob/main/packages/broker/SECURITY.md)
