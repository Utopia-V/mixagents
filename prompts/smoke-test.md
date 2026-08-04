# Native runtime smoke test

Run this from a new Codex task whose workspace is this repository, after the
custom agent and the one-shot `SubagentStart` Hook have been installed and
trusted. This test verifies the complete recommended path: Hook delivery,
custom-agent discovery, native child creation, DeepSeek authentication, a local
read-only tool call, and the native completion callback.

```text
Run the repository's native DeepSeek subagent smoke test.

1. As the root agent, generate a fresh unpredictable marker locally. Do not put
   the marker or the child assignment in user-visible commentary, the spawn
   message, or any repository file.
2. Build this complete child assignment in parent-owned local execution state:
   - You are the spawned v4_flash_worker child, not the root agent.
   - Read fixtures/smoke-input.txt from the current repository with an available
     local read-only tool.
   - Return the exact third non-empty line.
   - Compute and return the file's SHA-256 digest with a local read-only tool.
   - Return the fresh marker exactly once.
   - State whether you changed any file.
   - Do not spawn another agent or continue unrelated root work.
3. Pipe that assignment through stdin to the installed handoff script in stage
   mode:
   - Windows: <codex-home>/hooks/codex-deepseek-subagent/plaintext-handoff.ps1
     -Mode stage
   - macOS/Linux: python3
     <codex-home>/hooks/codex-deepseek-subagent/plaintext_handoff.py --mode stage
   Require a successful JSON result naming agent_type v4_flash_worker. Do not
   print the assignment or marker merely to stage it.
4. Immediately use Codex's native subagent mechanism to spawn the exact agent
   type v4_flash_worker with a unique task name and fork_turns="none". Its spawn
   message may say only that it must execute the assignment supplied by the
   trusted one-shot SubagentStart Hook. The spawn message must not carry the
   marker or the fixture instructions.
5. Do not solve the fixture task yourself. Wait idly through the native callback;
   do not short-poll, send follow-up messages, or duplicate the child's work.
6. If staging, Hook trust, Hook execution, native spawn, agent discovery,
   authentication, the provider request, child task visibility, or callback
   fails, report that exact boundary and stop. Do not retry through inherited
   turns or another transport.

For the whole test, do not use curl, an SDK, a direct DeepSeek API call, another
Codex CLI process, another application, a differently named agent, or a main-
agent calculation as fallback.

After the child returns, report:
1. the spawned agent type and whether Codex exposed a distinct child task;
2. whether the child returned the parent's exact fresh marker;
3. the child's third-line and SHA-256 results;
4. whether the one-shot pending handoff was consumed;
5. whether any file changed;
6. whether the parent model/provider configuration changed.
```

Expected fixture result:

- Third non-empty line: `responses`
- SHA-256: `b7383fea044646d48d597239385c40246df3ef511a3486053d4711d171589bc1`
- Files changed by the child: none

A successful answer without a distinct native `v4_flash_worker` child, exact
fresh-marker return, and consumed one-shot handoff is not a pass. The marker
proves that the task came through the Hook: it exists in neither inherited turns
nor the V2 spawn message.

This smoke test deliberately does not require raw V2 message-only delivery to
work. That upstream compatibility boundary has its own diagnostic in
[message-handoff-probe.md](message-handoff-probe.md); it is not a preflight for
ordinary delegation.
