[简体中文](README.md)

# mixagents

This repository contains three independently installable agent packages.

## MixAgents Broker

Run Codex subagents on other model providers without changing the controller's
provider. The npm package is
[`mixagents-broker`](https://www.npmjs.com/package/mixagents-broker) and is
installed through the MixAgents marketplace:

```bash
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

[Installation, configuration, and implementation](packages/broker/README.md) ·
[简体中文](packages/broker/README.zh-CN.md) · [Security](packages/broker/SECURITY.md)

## Codex DeepSeek Subagent

Legacy DeepSeek subagent integration for compatible Codex `0.148.x` and older
releases. Use MixAgents Broker on Codex `0.149.0` and later.

[Install and use](packages/codex-deepseek-subagent/README.en.md) ·
[Advanced notes](packages/codex-deepseek-subagent/docs/advanced.en.md) ·
[Security boundary](packages/codex-deepseek-subagent/SECURITY.md)

## pi-dsh-mimic

Change only the first DeepSeek V4 Pro request in Pi: begin with the DSH Minimal
persona and two tools, then restore Pi-native requests and the full tool catalog
after the first valid response. On one frozen Project2 task, default Pi scored
92 and four runs of this flow scored 96–98. This is not a general benchmark.

[Install and use](packages/pi-dsh-mimic/README.md) ·
[Experiments and design](packages/pi-dsh-mimic/docs/advanced.md) ·
[Evidence ledger](packages/pi-dsh-mimic/docs/project2-evidence.md) ·
[Security boundary](packages/pi-dsh-mimic/SECURITY.md)

## Before installing

These packages may send task content, file content, and tool results to a
configured third-party provider. Provider billing is separate from a
ChatGPT/OpenAI subscription. Read [SECURITY.md](SECURITY.md) before installing.

Each package keeps its source, tests, and documentation under `packages/`.
The root `prompts/` directory only preserves redirects for old raw URLs. See
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for issue and contribution
conventions.

This is an independent community project and is not affiliated with or endorsed
by OpenAI, DeepSeek, Pi, or OpenCode.
