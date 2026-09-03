[Repository index](../../README.en.md) · [简体中文](README.md) ·
[Advanced notes](docs/advanced.en.md) · [Security](SECURITY.md)

# Codex DeepSeek Subagent (legacy)

This package is retained for compatible Codex `0.148.x` and older releases.
Starting with Codex `0.149.0`, a custom child inherits the parent's
`model_provider`, so the original OpenAI parent → DeepSeek child route no longer
works.

Use [`mixagents-broker`](https://www.npmjs.com/package/mixagents-broker) on
current releases:

```bash
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

See the [MixAgents Broker README](../broker/README.md) for configuration. The
upstream change is tracked in
[Issue #9](https://github.com/Utopia-V/mixagents/issues/9) and
[openai/codex#40858](https://github.com/openai/codex/issues/40858).

## Legacy behavior

On compatible releases, this component keeps the Codex parent on OpenAI while
delegating bounded, text-heavy work to a `deepseek-v4-flash` child.

Codex can deliver an unreadable encrypted assignment from an OpenAI parent to a
third-party-provider child. This component carries the assignment through a
one-shot plaintext `SubagentStart` Hook. See
[Why V2 needed the Hook](docs/advanced.en.md#why-v2-needed-the-hook).

## Legacy install

### 1. Configure the DeepSeek API key

Create a key in DeepSeek and expose it to the Codex process as the
`DEEPSEEK_API_KEY` environment variable. Never paste the key into a chat, Issue,
screenshot, or repository.

- Windows: set the user environment variable, then fully quit and restart Codex
  Desktop.
- macOS / Linux: set it in the shell or secret manager that launches Codex.

macOS also has an optional Keychain template; the environment variable remains
the default. See
[Optional macOS Keychain authentication](docs/advanced.en.md#optional-macos-keychain-authentication).

### 2. Let Codex install the component

Paste this into Codex:

```text
Read and follow
https://raw.githubusercontent.com/Utopia-V/mixagents/main/packages/codex-deepseek-subagent/prompts/install-with-codex.md
exactly to install its DeepSeek V4 Flash subagent. Preserve my current main
model/provider and ChatGPT login, never ask for or print my API key, and stop
after provider-free local validation; do not run the paid smoke test yet.
```

Installation adds the Agent, Skill, Hook script, and one routing entry to the
personal Codex configuration. It does not call DeepSeek.

### 3. Trust the Hook and test

1. Enter `/hooks` in Codex. Confirm that the Hook matches only
   `v4_flash_worker` and points to the installed `plaintext-handoff` script,
   then trust it.
2. Start a new Codex task. On Windows, fully restart Codex first if the key was
   just set or changed.
3. Paste this into the new task:

```text
Read and follow
https://raw.githubusercontent.com/Utopia-V/mixagents/main/packages/codex-deepseek-subagent/prompts/quick-smoke-test.md
exactly to test the installed v4_flash_worker. Do not use another provider, a
direct API call, or another Codex CLI.
```

The quick smoke makes one small billed DeepSeek request.

## What success looks like

- Codex creates a distinct `v4_flash_worker` child task.
- The child returns the fresh random marker and `arithmetic=323`.
- The pending handoff is consumed.
- The parent remains on its original OpenAI model/provider.

During normal use, the parent reads `$use-v4-flash-worker` only when the task is
a good fit for Flash. The assignment is briefly stored as plaintext in local
user state before being sent to DeepSeek. The child defaults to read-only, but
the parent's permissions may affect the effective sandbox. Do not delegate
private source, secrets, personal data, or regulated data without authorization
for the DeepSeek boundary.

## Common problems

- `v4_flash_worker` is missing: start a new task, then restart Codex if needed.
- The child received no task: check Hook trust and use a task created after
  installation.
- Authentication is missing: check only whether the environment variable or
  Keychain item exists; never print the key.
- Windows fails before the Hook runs: confirm that Codex inherited the
  environment variable and fully restart it.

See [Advanced notes](docs/advanced.en.md) for installation boundaries, V1
compatibility, Windows authentication, and the upstream defect. Contributor
smokes and protocol diagnostics live under [prompts/](prompts/).

DeepSeek API billing is separate from a ChatGPT/OpenAI subscription. The
component is licensed under [MIT](LICENSE) and is not affiliated with or
endorsed by OpenAI or DeepSeek.
