---
name: use-omp-worker
description: Delegate complex coding, multi-tool analysis, AST refactoring, or repo-wide investigation tasks to the OMP (Oh My Pi) harness worker via the installed task-bridge Hook.
---

# Use OMP Worker

## Choose the worker

- Use `omp_worker` when a task requires the specialized tools of OMP (e.g. AST editing, language server queries, code graph exploration, or long-range autonomous execution).
- The underlying model (e.g., Gemini 3.7 Flash or other configured provider) is managed entirely inside your OMP installation configuration. Codex acts as the coordinator and parent session.
- The parent retains high-level orchestration, goal setting, verification of changes, and integration with the user.

## Deliver a job to OMP

1. Formulate a self-contained task assignment containing:
   - Clear target files and symbols
   - The concrete goal and constraints
   - Expected acceptance criteria or deliverables
2. Pipe the assignment via stdin to the installed bridge script in `stage` mode:
   - POSIX: `python3 "<codex-home>/hooks/codex-omp-subagent/omp_bridge.py" --mode stage`
   - Windows: `python.exe "<codex-home>\\hooks\\codex-omp-subagent\\omp_bridge.py" --mode stage`
3. Verify that the stage output contains `"staged": true` and names `omp_worker`.
4. Spawn the subagent using Codex's native `spawn_agent` mechanism:
   - `agent_type`: `omp_worker`
   - `fork_turns`: `"none"`
   - `message`: Briefly identify the task title.
5. The `SubagentStart` Hook automatically intercepts the launch, invokes `omp` in the background within the workspace directory, captures the execution stdout/stderr, and injects the output as `additionalContext`.
6. Wait for the `omp_worker` callback, review the synthesized results and modified files, and integrate the findings into the main conversation.
