[简体中文](README.md)

# Agent integrations for Codex and Pi

This repository maintains two independent components. One adds a native
DeepSeek V4 Flash child to Codex. The other starts DeepSeek V4 Pro inside Pi
with a DSH Minimal request, then returns to Pi-native execution.

| Component | Purpose | Current status | Documentation |
| --- | --- | --- | --- |
| **Codex DeepSeek Subagent** | Keep the Codex parent on OpenAI while delegating suitable text, log, and search work to a `deepseek-v4-flash` child | Windows and POSIX plaintext handoff protocol coverage | [User guide](packages/codex-deepseek-subagent/README.en.md) · [Advanced notes](packages/codex-deepseek-subagent/docs/advanced.en.md) |
| **Pi DSH Mimic** | Reproduce DSH Minimal for Pi's first request to activate a strong V4 Pro trajectory, then restore Pi's complete tool catalog and plugin ecosystem | `0.1.0`; the same request flow scored 98, 96, 96, and 98 on Project2; not yet published to npm | [User guide](packages/pi-dsh-mimic/README.md) · [Experiments and design](packages/pi-dsh-mimic/docs/advanced.md) · [Evidence ledger (Chinese canonical)](packages/pi-dsh-mimic/docs/project2-evidence.md) |

## Choose a component

- Install **Codex DeepSeek Subagent** to keep the Codex parent on OpenAI while
  using a lower-cost DeepSeek child for suitable bounded work.
- Install **Pi DSH Mimic** when Pi already uses `deepseek-v4-pro` or
  `opencode-go/deepseek-v4-pro` and the model should begin from the verified DSH
  Minimal trajectory while retaining Pi's `read/edit/write` tools and other
  plugins.

Pi DSH Mimic reproduces only DSH Minimal's first-request interface. Users do not
need to install or run the complete DSH harness; Pi still owns execution,
sessions, and plugin composition.

## Data, security, and cost

Both components send task content to the external provider configured by the
user. The Codex component briefly stores a plaintext assignment in local user
state. The Pi component contributes a `str_replace_editor` that can write files.
Review the relevant documentation before installation:

- [Codex security](packages/codex-deepseek-subagent/SECURITY.md)
- [Pi security](packages/pi-dsh-mimic/SECURITY.md)
- [Repository security entry point](SECURITY.md)

DeepSeek and OpenCode API charges are separate from an OpenAI or ChatGPT
subscription. Offline installation and tests should make no model request;
smoke tests and complete model runs are billed to the selected provider.

## Layout and legacy entry points

Each component keeps its source, tests, and documentation inside its own
`packages/` directory. The root `prompts/` directory contains only forwarders
for previously published raw URLs. The canonical Codex installation prompt is
maintained by the Codex component.

The GitHub repository was renamed from `Utopia-V/codex-deepseek-subagent` to
`Utopia-V/mixagents`. The former name will remain unused so GitHub can preserve
redirects for existing web, Git remote, and raw prompt URLs.

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for issue and contribution
conventions. This is an independent community project and is not affiliated
with or endorsed by OpenAI, DeepSeek, Pi, or OpenCode.
