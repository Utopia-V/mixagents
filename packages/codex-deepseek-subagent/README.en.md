[Repository index](../../README.en.md) · [简体中文](README.md) · [Advanced notes](docs/advanced.en.md)

# Codex DeepSeek Subagent

Keep the Codex main task on GPT / OpenAI while using the inexpensive, fast
`deepseek-v4-flash` as a native subagent for search, enumeration, logs, and
high-volume text work.

DeepSeek is the ready-to-use implementation shipped by this repository, not a
limit of the composition. Any provider/model pair that Codex can call through a
supported API and that satisfies the task's capability and data boundaries can
be adapted into an independent subagent in the same way. The current installer
still installs only the verified DeepSeek configuration. See
[Adapting another provider/model](docs/advanced.en.md#adapting-another-providermodel).

This installation does not require CC Switch, MCP, a plugin, another Codex CLI,
or a global switch to DeepSeek. Complete the three steps below.

## Three-step install

### 1. Set the DeepSeek API key

Create a key in DeepSeek and store it as the `DEEPSEEK_API_KEY` environment
variable. Never paste the key into a Codex chat, Issue, screenshot, or repository.

- Windows: search System Settings for “environment variables” and add
  `DEEPSEEK_API_KEY` under user variables, then fully quit and restart Codex
  Desktop. Do not rely on an already-running Desktop process to read a variable
  that was set later.
- macOS / Linux: set `DEEPSEEK_API_KEY` in the shell or secret manager that will
  launch Codex, then start Codex.

macOS also has a separate Keychain authentication template for launch paths that
do not inherit a shell environment. The default remains the environment-variable
template; Keychain is selected only when explicitly requested, and existing
installations are not migrated automatically. See
[Optional macOS Keychain authentication](docs/advanced.en.md#optional-macos-keychain-authentication).

If you do not know how, ask Codex to explain environment-variable setup for your
operating system without giving it the key itself. See [SECURITY.md](SECURITY.md).

### 2. Paste this into Codex

```text
Read and follow
https://raw.githubusercontent.com/Utopia-V/codex-deepseek-subagent/main/packages/codex-deepseek-subagent/prompts/install-with-codex.md
exactly to install its DeepSeek V4 Flash subagent. Preserve my current main
model/provider and ChatGPT login, never ask for or print my API key, and stop
after provider-free local validation; do not run the paid smoke test yet.
```

Codex downloads, merges, and validates the agent, skill, Hook, and two-rule
`AGENTS.md` index. Installation does not call DeepSeek or replace the main
model/provider.

### 3. Trust the Hook, then test

After installation:

1. Enter `/hooks` in Codex. Confirm that the Hook matches only
   `v4_flash_worker` and points to the installed `plaintext-handoff` script,
   then trust it.
2. **Start a new Codex task.** A task that was already running is not guaranteed
   to reload the new Hook. On Windows, fully restart Codex first if the API key
   was just set or changed; otherwise a full application restart is normally
   unnecessary.
3. Paste this into the new task:

```text
Read and follow
https://raw.githubusercontent.com/Utopia-V/codex-deepseek-subagent/main/packages/codex-deepseek-subagent/prompts/quick-smoke-test.md
exactly to test the installed v4_flash_worker. Do not use another provider, a
direct API call, or another Codex CLI.
```

The quick smoke requires no repository checkout and makes one small paid
DeepSeek API request.

## What success looks like

All of these must be true:

- Codex exposes a distinct native child task whose agent type is
  `v4_flash_worker`.
- The child returns the parent's fresh random marker and `arithmetic=323`.
- The one-shot pending handoff is consumed.
- The main task remains on its original OpenAI model/provider.
- No secondary CLI, direct API request, or substitute model fakes the result.

After that, normal use is ready. The parent loads `$use-v4-flash-worker` only
when appropriate and still decides whether delegation is useful; installation
does not force every task through Flash.

Installation only adds or updates a standalone agent, skill, Hook, and two
routing rules in personal Codex configuration. It does not add a top-level
DeepSeek provider or switch the main task model. The only manual decision is
reviewing and trusting the Hook through `/hooks`. See
[Advanced notes](docs/advanced.en.md) for exact file boundaries.

## If it does not work

- **`v4_flash_worker` is missing:** start a new task first; if it is still
  missing, restart Codex once.
- **The child says no task arrived:** the Hook is usually untrusted, the current
  task predates installation, or the Hook did not load. Check `/hooks`, then
  start a new task. Do not switch to inherited turns.
- **Authentication is missing:** check only whether the selected environment
  variable or Keychain item exists; never paste the key into chat.
- **Windows reports the Agent unavailable before the Hook runs:** make sure the
  Codex process inherited the environment variable and fully restart it.
  User/HKCU command auth may resolve against a sandbox identity; see
  [Advanced notes](docs/advanced.en.md#windows-authentication-boundary).
- **The installer asks to switch the global provider, start another CLI, or
  install MCP:** stop. That is not this repository's route.

If the problem remains, prefer the appropriate
[structured Issue Form](https://github.com/Utopia-V/codex-deepseek-subagent/issues/new/choose).
If none fits, a Blank Issue is also available. Please provide the operating
system, Codex version, failing boundary, and redacted output where possible.
Never attach an API key, complete request headers, or an unredacted configuration
dump. An agent may help draft the report, but a person must check the observations,
inferences, and controls that were not run before submission. Reproducible
evidence helps distinguish failures in configuration, agent discovery, the Hook,
the provider request, and the callback, and it also helps later users.

## Advanced users and contributors

- Architecture, the V1 workaround, current upstream V2 defect, configuration
  boundaries, and migration condition: [Advanced notes](docs/advanced.en.md)
- Full agent-facing installation contract:
  [prompts/install-with-codex.md](prompts/install-with-codex.md)
- Contributor smoke with local tools and SHA-256:
  [prompts/smoke-test.md](prompts/smoke-test.md)
- Raw V2 message-only diagnostic:
  [prompts/message-handoff-probe.md](prompts/message-handoff-probe.md)
- Credentials, plaintext local state, and the DeepSeek data boundary:
  [SECURITY.md](SECURITY.md)

The Windows Desktop route has a live-smoke baseline; the hardened PowerShell
implementation passes its local protocol, concurrency, and recovery suite and
still needs a post-hardening live smoke. On macOS, the Python/POSIX route has
passed a native callback smoke on Codex `0.146.0` and 27 protocol tests; Linux
uses the same POSIX implementation.

## Cost and affiliation

DeepSeek API billing is separate from a ChatGPT/OpenAI subscription.
Installation makes no DeepSeek call; the quick smoke and later Flash children
are billed to the DeepSeek account.

[MIT](LICENSE). This component is an independent configuration example and is
not affiliated with or endorsed by OpenAI or DeepSeek.
