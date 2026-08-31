---
name: use-omp-worker
description: Delegate complex coding, multi-tool analysis, AST refactoring, or repo-wide investigation tasks to the OMP (Oh My Pi) harness through a native Codex omp_worker child.
---

# Use OMP Worker

## Choose the worker

- Use `omp_worker` when a task benefits from OMP's coding-harness capabilities such as AST editing, language-server queries, codebase exploration, or longer autonomous execution.
- The model/provider used by OMP is configured entirely in the user's OMP installation. Codex remains the parent orchestrator.
- The parent owns scope, acceptance criteria, verification, and integration with the user.

## Deliver a job to OMP

1. Formulate a self-contained assignment with target files/symbols, the concrete goal, constraints, and acceptance criteria.
2. Stage the assignment via stdin using the installed bridge:
   - POSIX: `python3 "${CODEX_HOME:-$HOME/.codex}/hooks/codex-omp-subagent/omp_bridge.py" --mode stage`
   - Windows PowerShell: `$root = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }; $assignment | python (Join-Path $root 'hooks/codex-omp-subagent/omp_bridge.py') --mode stage`
3. Parse the JSON output. Require `"staged": true`, `"schema": 2`, `"agent_type": "omp_worker"`, and capture the returned `handoff_id` UUID.
4. Spawn a native Codex child with:
   - `agent_type`: `omp_worker`
   - `fork_turns`: `"none"`
   - `message`: `Execute staged OMP handoff <handoff_id>. Inspect and verify the resulting workspace changes, then report a concise result to the parent.`
5. The child itself runs the bridge with `--mode run --handoff-id <handoff_id>`. This is deliberate: OMP is launched from inside the child session instead of from a `SubagentStart` Hook, so execution follows the child's workspace sandbox boundary.
6. Wait for the child callback. Review its summary, workspace diff, and validation evidence before integrating the result.

## Concurrency and logs

- Each staged task has its own UUID, so multiple OMP handoffs can be pending or running independently.
- Raw OMP JSONL and stderr are retained under the bridge state directory for diagnosis. Do not copy full raw logs into the parent context unless the user explicitly asks for them.
- A completed UUID is idempotent: rerunning `--mode run` for the same completed handoff returns the stored structured result rather than launching OMP again.
