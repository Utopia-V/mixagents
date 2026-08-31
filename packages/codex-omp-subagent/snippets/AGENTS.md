<!-- codex-omp-subagent:start -->
- For complex coding tasks, AST refactoring, multi-tool analysis, or tasks best executed by the OMP (Oh My Pi) harness, the main agent may consider `omp_worker`; delegation remains optional and the parent retains verification and integration.
- Before spawning, continuing, or troubleshooting `omp_worker`, use `$use-omp-worker`. Stage a schema-2 UUID handoff first, then spawn `omp_worker` with `fork_turns="none"`; the child runs the bridge in `run` mode. Do not use the legacy `SubagentStart` Hook workflow.
<!-- codex-omp-subagent:end -->
