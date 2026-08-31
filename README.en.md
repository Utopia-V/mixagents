[简体中文](README.md)

# mixagents

This repository contains two independent agent integrations. They solve
different problems and can be installed separately.

## Codex DeepSeek Subagent

Keep the Codex parent on OpenAI while delegating bounded, text-heavy work to a
`deepseek-v4-flash` child. The current release uses a one-shot plaintext Hook to
work around unreadable cross-provider child assignments in Codex.

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

Both integrations send task content to a third-party provider configured by the
user. The Codex integration briefly stores a plaintext assignment in local user
state; the Pi package contributes a `str_replace_editor` that can read and write
files. DeepSeek and OpenCode billing is separate from a ChatGPT/OpenAI
subscription. See [SECURITY.md](SECURITY.md) for the repository-level boundary.

Each integration keeps its source, tests, and documentation under `packages/`.
The root `prompts/` directory only preserves redirects for old raw URLs. See
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for issue and contribution
conventions.

This is an independent community project and is not affiliated with or endorsed
by OpenAI, DeepSeek, Pi, or OpenCode.
