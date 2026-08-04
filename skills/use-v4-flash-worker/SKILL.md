---
name: use-v4-flash-worker
description: Use the DeepSeek-backed v4_flash_worker through the installed one-shot plaintext SubagentStart Hook. Use whenever Codex considers spawning, continuing, or troubleshooting this worker; it governs task suitability, plaintext staging, fork_turns=none, idle callback, failure recovery, V1 fallback boundaries, and the DeepSeek data boundary.
---

# Use V4 Flash Worker

## Choose the worker

- Use it for bounded, preferably read-only text, code, log, search, extraction,
  enumeration, or high-volume reading work whose raw material is much larger
  than the useful conclusion.
- Keep tightly coupled reasoning, consequential decisions, verification, and
  final integration in the parent. Use a multimodal worker when the task needs
  image understanding.
- Do not send secrets, private source, personal data, or regulated material
  unless the user has authorized the external DeepSeek data boundary.

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
3. Require a successful stage result naming `v4_flash_worker`. Do not echo the
   assignment, replace an active or malformed pending item, or stage a second
   Flash job before the first is consumed.
4. Immediately spawn the exact agent type `v4_flash_worker` with a unique task
   name and `fork_turns="none"`. The spawn message may point to the trusted
   one-shot Hook but must not contain the only copy of essential instructions.
   Let the parent choose ordinary reasoning effort; do not invent a token budget.
5. Use one task-sized native idle wait or callback. Do not short-poll, duplicate
   the child work, or invent another transport while it runs.
6. Verify the returned contribution in proportion to the parent claim, then
   integrate it in the parent context.

## Fail and continue safely

- Treat a missing Hook assignment, failed stage, unreadable child task, or
  absent callback as a transport failure. Do not silently substitute another
  provider, model, app, direct API call, CLI process, or inherited root history.
- Current V2 `send_message` and `followup_task` payloads can cross the same
  encryption boundary. When essential task information changes, stage a new
  self-contained job and start a new child.
- An unconsumed item expires after its TTL. A later stage may recover only a
  structurally valid expired item; never delete or overwrite unknown state.
- Multi-agent V1 is an explicit top-level session compatibility choice, not a
  per-spawn switch or silent fallback.
- The staged assignment briefly exists as plaintext in local user state before
  it is sent to DeepSeek. The Hook is a transport compatibility layer, not a
  confidential channel.
