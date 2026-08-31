---
name: use-v4-flash-worker
description: Use before spawning, continuing, or troubleshooting the opt-in DeepSeek-backed v4_flash_worker; contains its plaintext-Hook handoff, recovery, and data-boundary contract.
---

# Use V4 Flash Worker

## Use it only when it earns the context switch

- Select Flash only when the user requests it or its provider-declared 1M
  context changes whether a bounded, preferably read-only reading task is
  feasible. It is not the routine factual scout.
- Keep coupled reasoning, consequential decisions, verification, and final
  integration in the parent. Use a multimodal worker for images.
- The assignment crosses the configured DeepSeek data boundary. Sensitive
  material requires user authorization; credentials remain in the provider
  environment. Delegation never changes the parent's model or provider.

## Deliver one self-contained job

1. Build one complete assignment containing child identity, objective, scope,
   exclusions, available permissions, evidence or output contract, and stopping
   condition. Keep it in parent-owned execution state; do not publish it as
   user-visible commentary merely for transport.
2. Pipe the assignment through stdin to the installed handoff script in
   `stage` mode. Use the standard installed path below. If it is absent, inspect
   the effective `SubagentStart` Hook matching `^v4_flash_worker$` and use the
   same reviewed script path with its mode changed from `hook` to `stage`:
   - Windows: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<codex-home>\hooks\codex-deepseek-subagent\plaintext-handoff.ps1" -Mode stage`
   - macOS/Linux: `python3 "<codex-home>/hooks/codex-deepseek-subagent/plaintext_handoff.py" --mode stage`
3. Require a successful stage result naming `v4_flash_worker`. Treat a lock
   contender, an active pending or claimed item, quarantined state, or any other
   non-success result as a transport failure. Never spawn after a failed stage.
   Retry the complete stage only after the occupied state is explicitly clear,
   and spawn only after that new stage succeeds.
4. Immediately create the child through Codex's native `spawn_agent` with the
   exact agent type `v4_flash_worker`, a unique task name, and
   `fork_turns="none"`. Do not replace this with a provider CLI, direct API call,
   or inherited root history. Keep all essential instructions in the staged
   assignment; let the spawn message only identify the trusted one-shot Hook.
5. Receive the child through Codex's native wait/callback path. Use one
   task-sized idle wait or callback; do not short-poll, duplicate the child work,
   or invent another return transport while it runs.
6. Verify the returned contribution in proportion to the parent claim, then
   integrate it in the parent context.

## Respect dispatch and delivery semantics

- Treat delivery as one-shot and at-most-once. Never assume a claimed assignment
  can be replayed or delivered to a replacement child.
- After a worker has received its assignment, it no longer holds the dispatch
  lock; you may stage and spawn the next job before that worker returns, and
  already-running workers continue concurrently.
- Require explicit resolution for malformed or quarantined state. Never delete,
  replace, or overwrite it automatically.

## Fail and continue safely

- Treat a missing Hook assignment, failed stage, unreadable child task, or
  absent callback as a transport failure. Do not silently substitute another
  provider, model, app, direct API call, CLI process, or inherited root history.
- Multi-agent V1 is an explicit top-level session compatibility choice, not a
  per-spawn switch or silent fallback.
- The staged assignment briefly exists as plaintext in local user state before
  dispatch to the configured external provider and `deepseek-v4-flash` model.
  The Hook is a transport compatibility layer, not a confidential channel.
