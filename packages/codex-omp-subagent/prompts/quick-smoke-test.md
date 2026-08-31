# Quick Smoke Test for OMP Subagent V2

Copy the prompt below into a new Codex session after installation. This is a real end-to-end test and may use the provider/model configured in OMP.

```text
Please verify the installed OMP V2 worker by following $use-omp-worker exactly.

1. Create a self-contained assignment that does not modify files:
   "Print the current working directory, report the active OMP readiness, and finish with the exact marker OMP_READY_12345. Do not modify any files."
2. Stage the assignment with the installed omp_bridge.py in --mode stage and capture the returned schema-2 handoff_id.
3. Spawn a native Codex child with agent_type="omp_worker" and fork_turns="none". Put the handoff UUID in the spawn message.
4. Do not invoke OMP from a SubagentStart Hook and do not manually execute the handoff in the parent.
5. Wait for the omp_worker callback.
6. Verify all of the following:
   - the bridge result reports schema 2;
   - the OMP execution completed successfully;
   - the callback contains OMP_READY_12345;
   - the child confirms no workspace files were modified;
   - a job directory contains result.json and omp.jsonl;
   - running the same completed handoff UUID again returns the stored result rather than launching a second OMP run.
7. Report PASS/FAIL and the decisive evidence only. Do not paste the full OMP JSONL log.
```
