[Repository security entry point](../../SECURITY.md)

# Codex DeepSeek Subagent Security

## API keys

Never commit a DeepSeek API key, paste it into a prompt, include it in a screenshot, or store it as `experimental_bearer_token`. Repository templates name local secret sources but never embed a credential.

If a key has been exposed, revoke or rotate it in the DeepSeek console before doing anything else. Do not open a public issue containing the key, request headers, or an unredacted configuration dump.

The portable `env_key` template is the default on Windows, macOS, and Linux. A Windows process must inherit `DEEPSEEK_API_KEY`; a value stored in the logged-in user's environment is not proof that a sandboxed Codex process can read it. The optional Windows live-environment and macOS Keychain variants use command-backed authentication. Windows User/HKCU lookup is resolved under the authentication command's actual process identity, which may be a Codex sandbox identity. The macOS variant reads one generic-password item whose service is `io.github.utopia-v.codex-deepseek-subagent.deepseek-api-key` and whose account is the current macOS short user name. These are alternative templates; do not combine `env_key` with `[model_providers.deepseek.auth]`. An authentication command prints the token only to Codex's authentication channel; validation must use a Boolean existence probe and must never print the token to the task transcript.

## Data boundary

When `v4_flash_worker` runs, the task context and tool results supplied to that
child are sent through the configured external provider endpoint to the
`deepseek-v4-flash` model. In the repository templates that endpoint is
`https://api.deepseek.com`. The main Agent remains on its existing provider;
the child credential comes from the selected local environment or Keychain
source and must never be staged in an assignment. A read-only sandbox limits filesystem mutation; it does not
prevent disclosure through model input. Parent-session permission selections
may also override a custom agent's sandbox default in current Codex releases.

Do not delegate private source, secrets, personal data, regulated data, or other sensitive material unless the user has accepted DeepSeek as a processor for that material.

## Plaintext handoff Hook

The recommended V2 route uses a user-trusted `SubagentStart` command Hook. The
parent stages one complete assignment in local user state; the Hook claims it
for the next exact `v4_flash_worker` child and injects it as developer context.
The assignment is therefore briefly present as plaintext on local disk before
it is sent to DeepSeek. This mechanism is a transport workaround, not an
encryption or data-loss-prevention boundary.

Default state locations are:

- Windows: `%LOCALAPPDATA%\Codex\plaintext-subagent-handoff`
- macOS/Linux with `XDG_STATE_HOME`: `$XDG_STATE_HOME/codex/plaintext-subagent-handoff`
- other macOS/Linux environments: `~/.local/state/codex/plaintext-subagent-handoff`

Each platform implementation allows one pending Flash assignment per state
root and holds an OS-owned nonblocking dispatch lock across stage, claim,
stdout flush, and consumption. POSIX uses `flock`; Windows uses an exclusive
file handle. Both atomically publish the envelope, validate its schema, UUID,
assignment, and timezone-aware timestamps, match the exact agent type, and
deliver at most once. The lock covers only the short dispatch window; workers
whose assignments have already been delivered can continue concurrently.

Malformed claim state is preserved under a quarantine filename and blocks
staging until explicitly resolved. A later operation may remove only a
structurally valid expired pending item or expired orphan claim while holding
the dispatch lock. Unknown state is never overwritten automatically. These
controls prevent accidental stale or cross-role delivery; they do not protect
plaintext from another process acting with the same user account.

Do not stage secrets or material that the user has not authorized for the
DeepSeek boundary. Never spawn after a failed stage. If a spawn fails before
the Hook consumes the assignment, let a structurally valid pending item expire,
or inspect and remove only the exact state file after confirming its path and
purpose. Then perform a complete new stage and spawn only if it succeeds.

Review the installed Hook command and script before trusting them through
`/hooks`. Codex records trust against the Hook definition; a material definition
change requires renewed review. Never bypass or forge the trust hash merely to
make installation non-interactive.

## Cost and compatibility

DeepSeek API use is billed separately from an OpenAI or ChatGPT subscription. The installation workflow deliberately makes no provider request. The smoke test makes a small paid API request only when the user explicitly runs it.

DeepSeek's Responses API is not a complete implementation of every OpenAI Responses feature. Consult the current compatibility table before depending on conversation state, background execution, storage, service tiers, or another advanced request field.
