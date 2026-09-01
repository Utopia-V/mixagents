# Security

This file is the repository-level security entry point. Component-specific
behavior and data boundaries are maintained with the component that implements
them:

- [Codex DeepSeek Subagent security](packages/codex-deepseek-subagent/SECURITY.md)
- [Pi DSH Mimic security](packages/pi-dsh-mimic/SECURITY.md)

## Credentials and reports

Never commit or submit an API key, token, full request header, unredacted
configuration, plaintext credential, or unrelated private source. If a
credential has been exposed, revoke or rotate it with the provider before
doing anything else.

Public issues should contain only the shortest redacted evidence needed to
identify the affected component and failure boundary. Do not use a public
issue for a report that cannot be described without exposing a live secret or
private data.

## Component boundaries

| Component | External data boundary | Local authority |
| --- | --- | --- |
| Codex DeepSeek Subagent | The delegated assignment and returned tool context are sent to the configured DeepSeek endpoint | A trusted `SubagentStart` Hook briefly stages plaintext in local user state; the child defaults to read-only, but current Codex permission inheritance can affect the effective sandbox |
| Pi DSH Mimic | For model ids containing `deepseek-v4-pro`, the task, conversation context, and tool results are sent through the provider selected in Pi | The extension runs with the Pi process's permissions and contributes a `str_replace_editor` that can create and modify files |

A local sandbox is not a confidentiality boundary: content sent to a model
crosses the configured provider boundary even when filesystem mutation is
disabled.

## Cost

Provider usage is billed independently from an OpenAI or ChatGPT subscription.
Repository installation and offline tests must not make paid model calls.
Explicit smoke tests and model runs may incur charges and should say so before
execution.
