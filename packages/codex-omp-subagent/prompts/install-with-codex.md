# Install OMP Subagent V2 with Codex

Copy the prompt below into Codex. It installs the personal `omp_worker` subagent, its lazy-loaded skill, and the V2 stage/run bridge.

```text
Install the OMP (Oh My Pi) custom subagent from the `packages/codex-omp-subagent` component in https://github.com/feiyushaw/mixagents into my personal Codex configuration.

Scope and invariants:
- Preserve my current main model, model provider, ChatGPT login, and unrelated provider configuration.
- Install the standalone agent file as <codex-home>/agents/omp-worker.toml.
- Install the skill as <codex-home>/skills/use-omp-worker/ (including SKILL.md and agents/openai.yaml if present).
- Install the bridge script to <codex-home>/hooks/codex-omp-subagent/omp_bridge.py.
- This is the V2 child-executed bridge. Do NOT register a SubagentStart hook for omp_worker.
- If the active CODEX_HOME hooks.json already contains a legacy OMP SubagentStart entry matching ^omp_worker$, remove only that legacy OMP entry while preserving all unrelated hooks.
- Preserve the V2 agent permission profile exactly: it must inherit :workspace filesystem permissions, enable outbound network for OMP's configured provider, disable local binding, and must not use danger-full-access.
- The bridge's default handoff state belongs in the system temporary directory; do not rewrite it to ~/.local/state or another path outside the active writable roots. Respect CODEX_OMP_HANDOFF_DIR only when the user has explicitly configured it.
- Append/update the snippets/AGENTS.md routing snippet in my personal AGENTS.md if the component provides one, without duplicating it.
- Verify the installed bridge with offline/local checks only: Python syntax, `--help`, TOML parse, and the repository unit tests when practical.
- If the installed Codex version does not understand the V2 `default_permissions` / `[permissions.*]` profile in the standalone agent, report that compatibility failure and recommend updating Codex; do not silently replace it with danger-full-access.
- Do not make a paid provider/model call during installation.
- After installation, tell me exactly which files changed, whether a legacy V1 hook was removed, and whether the V2 permission profile parsed successfully.
```
