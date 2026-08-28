# Install OMP Subagent with Codex

Copy the prompt below into Codex. It installs the personal custom `omp_worker` subagent, its lazy-loaded skill, and its task-bridge Hook.

```text
Install the OMP (Oh My Pi) custom subagent from the `packages/codex-omp-subagent` component in https://github.com/Utopia-V/mixagents into my personal Codex configuration.

Scope and invariants:
- Preserve my current main model, model provider, ChatGPT login, and provider configuration.
- Install the standalone agent file as <codex-home>/agents/omp-worker.toml.
- Install the skill as <codex-home>/skills/use-omp-worker/ (including SKILL.md and agents/openai.yaml).
- Install the bridge script to <codex-home>/hooks/codex-omp-subagent/omp_bridge.py.
- Configure or update ~/.codex/hooks.json to trigger omp_bridge.py for SubagentStart on matcher ^omp_worker$.
- Append the snippets/AGENTS.md routing snippet to my personal AGENTS.md if not already present.
- Do not make a paid provider call during installation.
```
