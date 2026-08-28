# Quick Smoke Test for OMP Subagent

Copy the prompt below into a new Codex session to verify that `omp_worker` can be staged, spawned, executed, and summarized back to the parent.

```text
Please test the installed omp_worker by following the $use-omp-worker protocol:
1. Stage a simple test task: "Please print the current working directory and confirm OMP readiness with marker 'OMP_READY_12345'".
2. Spawn omp_worker with fork_turns="none".
3. Wait for the subagent callback and verify that OMP was invoked and returned output.
```
