# Install with Codex

Copy the prompt below into Codex. It installs a personal custom subagent, its
lazy-loaded handoff skill, and its one-shot plaintext task Hook while preserving
the current OpenAI main-agent model and provider.

```text
Install the native DeepSeek V4 Flash custom subagent from
https://github.com/Utopia-V/codex-deepseek-subagent into my personal Codex
configuration.

Scope and invariants:
- Preserve my current main model, model provider, ChatGPT login, and
  provider configuration. Creating or updating the standalone custom-agent
  TOML, the personal use-v4-flash-worker skill, the user Hook
  script/configuration, and the compact personal AGENTS.md index described
  below is expected; this is not a zero-configuration installation. Do not
  globally switch Codex to DeepSeek. Codex may later add a `hooks.state` trust
  hash to the user config when I explicitly trust the Hook; do not write or
  forge that hash yourself.
- Keep the custom-agent registration, model_provider, and
  [model_providers.deepseek] definition inside the standalone agent TOML. Do not
  add [agents.v4_flash_worker] or [model_providers.deepseek] to the top-level
  config.toml. If this Codex release cannot discover standalone agent files, stop
  and report the version limitation instead of silently changing the global
  configuration strategy.
- Never ask me to paste an API key into chat, never print an existing key, and
  never write a plaintext key into TOML. The portable secret source is the
  environment variable DEEPSEEK_API_KEY. On macOS, the repository's Keychain
  template is also allowed only when I explicitly request it or the existing
  repository-managed agent already uses it.
- Do not make a paid provider call during installation.
- Use Codex's native `SubagentStart` Hook mechanism for task delivery. Do not
  install a plugin, MCP adapter, wrapper process, daemon, direct HTTP/SDK call,
  separate Codex CLI process, or another application as a fallback.

Procedure:
1. Detect the active Codex home without changing it. Respect an existing
   CODEX_HOME; otherwise use ~/.codex. Check `codex --version` when available.
   Recommend Codex CLI 0.145.0 or newer, but do not upgrade software unless I
   separately ask. Use the current repository checkout as the source when one
   is available. Otherwise acquire one temporary source snapshot from GitHub
   for this installation, verify that its remote is this repository, and use
   files from that snapshot rather than independently reconstructing them.
2. Inspect the target agents directory, any existing v4_flash_worker file, the
   `<codex-home>/skills/use-v4-flash-worker` directory, the applicable personal
   AGENTS.md, user `hooks.json`, inline user Hook configuration, and
   `<codex-home>/hooks/codex-deepseek-subagent` directory before changing
   anything. Preserve unrelated configuration. If an existing agent, skill, or
   Hook at the intended identity serves a different purpose, stop and report
   the conflict. Otherwise update idempotently and include the meaningful diff
   in the final report; do not pause merely to ask again for the installation
   authority already given by this prompt.
3. Install exactly one agent file as
   <codex-home>/agents/v4-flash-worker.toml:
   - On Windows or Linux, use agents/v4-flash-worker.toml. On Windows, a fully
     restarted Codex process must inherit DEEPSEEK_API_KEY; do not infer that a
     command-backed User/HKCU lookup sees the logged-in user's environment.
     If an existing repository-managed target exactly matches the former
     agents/windows-live-env/v4-flash-worker.toml variant, replace it with the
     portable template and report that migration and restart requirement. The
     former command-auth template remains an explicit compatibility option only;
     do not select it unless I separately request it after accepting its sandbox
     identity boundary.
   - On macOS, use agents/v4-flash-worker.toml by default. Use
     agents/macos-keychain/v4-flash-worker.toml only when I explicitly request
     the repository's Keychain variant or the existing repository-managed agent
     already uses that exact variant.
   `env_key` and command-backed authentication are alternative provider
   configurations. Never combine them or silently migrate a working existing
   installation from one to the other. If an existing target uses an unknown
   authentication command, stop and report the conflict.
   Fetch the raw repository file or use the local checkout; do not recreate it
   from memory.
4. Install `skills/use-v4-flash-worker` as
   `<codex-home>/skills/use-v4-flash-worker`, including its `SKILL.md` and
   `agents/openai.yaml`. Fetch or copy the repository files exactly; do not
   recreate the protocol from memory. Update an existing copy only when its
   identity matches this repository's skill.
5. Install the platform handoff script under the stable personal directory
   `<codex-home>/hooks/codex-deepseek-subagent`:
   - On Windows, install `hooks/plaintext-handoff.ps1`.
   - On macOS or Linux, require an available Python 3 and install
     `hooks/plaintext_handoff.py`. If Python 3 is unavailable, stop and report
     that the primary Hook path cannot be installed instead of silently making
     inherited turns the default.
   Preserve the source file exactly; do not embed the script body in config.
6. Install one `SubagentStart` command Hook whose matcher is exactly
   `^v4_flash_worker$`, whose timeout is 10 seconds, whose
   `additionalContextLimit` is 0, and whose command invokes the absolute path of
   the installed platform script in `hook` mode. Use the corresponding
   `hooks/hooks.*.example.json` as the structural source.
   - Preserve every unrelated existing Hook.
   - If the user layer already uses inline Hook configuration, merge there;
     otherwise merge into `<codex-home>/hooks.json`, creating valid JSON only
     when the file does not exist.
   - Detect an equivalent existing entry and update it once rather than
     duplicating it.
   - Do not add or alter a trusted hash. Codex must calculate it and I must
     review it through `/hooks`.
7. Merge snippets/AGENTS.md into the personal AGENTS.md once, preserving the
   start/end markers so future updates are idempotent. If equivalent routing
   policy already exists, do not duplicate it. If existing instructions
   conflict materially, stop and explain the conflict instead of overriding it.
   Read back the merged block and confirm that it tells the parent to load
   `$use-v4-flash-worker` before spawning, continuing, or troubleshooting the
   role. Keep the detailed transport protocol in the skill rather than copying
   it into always-loaded AGENTS.md. A stale block that embeds the old inherited-
   turn workflow or bypasses the skill is not equivalent and must be replaced
   inside this repository's marked block.
8. Parse the installed agent file with a real TOML parser. Confirm that it names
   v4_flash_worker, selects model_provider deepseek and model
   deepseek-v4-flash, uses the Responses wire API, declares a 1000000-token
   model context window, defaults to read-only, contains no
   model_reasoning_effort, contains its own [model_providers.deepseek] definition,
   and contains no plaintext credential. Confirm that the top-level config.toml
   did not gain any main-model, main-provider, agent-registration, or DeepSeek
   provider entries. Run the bundled skill-creator validator against the
   installed `use-v4-flash-worker` folder when that validator is available; if
   it is unavailable in this Codex build, parse the YAML files directly instead
   of installing another tool. Confirm that the frontmatter name and triggering
   description are valid, that no TODO placeholder remains, and that
   `agents/openai.yaml` names `$use-v4-flash-worker` in the default prompt.
9. Parse the final Hook source as JSON or TOML and verify its exact matcher,
   command path, timeout, event, and context limit. Run the matching local
   protocol test from the source snapshot against a temporary state directory.
   It must prove collision rejection, exact-role delivery, exact random-marker
   preservation, one-shot consumption, replay rejection, and recovery from a
   structurally valid expired handoff without calling a model or provider.
   The platform suite must also require atomic publication, strict envelope
   validation, controlled missing-handoff failure, malformed-state preservation,
   concurrent-stage exclusion, at-most-once delivery, and exclusion of stage
   while Hook output is live. Report only the platform implementation actually
   tested. Remove only verified temporary state created by this installation;
   do not remove a pre-existing checkout.
10. Check only whether the selected secret source is present; report a boolean,
    never its value.
    - For `env_key`, check whether DEEPSEEK_API_KEY is present in the current
      Codex process environment. On Windows, a user-scoped variable outside the
      process is not proof that the provider can read it; if absent, tell me to
      set it and fully restart Codex.
    - For the macOS Keychain template, use this exact secret-safe probe. It must
      omit `-w`, discard all `security` output, and report only `present` or
      `missing`:

      ```sh
      SERVICE='io.github.utopia-v.codex-deepseek-subagent.deepseek-api-key'
      ACCOUNT=$(/usr/bin/id -un)
      if /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
        printf '%s\n' present
      else
        printf '%s\n' missing
      fi
      ```

      If the item is missing, explain the expected service and account fields
      without asking for the key. Do not create or modify a Keychain item unless
      I separately authorize that credential mutation.
11. Read back the installed configuration with any credential-like text
    redacted, then report changed paths, validation performed, whether the key
    is present, and that the Hook is not runnable until I review its exact
    definition in `/hooks`. Do not bypass Hook trust. After I trust it, start a
    new Codex task before the paid smoke so that both the final Hook definition
    and custom-agent configuration are loaded together. On Windows, fully
    restart Codex first if DEEPSEEK_API_KEY was set or changed outside the
    current process; otherwise a full application restart is normally
    unnecessary. An already-running root task must not be treated as proof that
    a changed Hook was reloaded. Do not run the paid smoke test until I ask. Point me to
    `prompts/quick-smoke-test.md` as the default checkout-free test; reserve
    `prompts/smoke-test.md` for contributors testing local tool access.
```

The installed Hook is the preferred Multi-agent V2 task carrier for this
repository. Multi-agent V1 remains an explicit top-level compatibility choice,
not an installer fallback and not a per-spawn setting; see the repository
README for its trade-offs.
