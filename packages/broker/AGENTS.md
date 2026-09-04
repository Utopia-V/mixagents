# Broker project instructions

- Read `README.md` for product status,
  `docs/backend-and-lifecycle-policy.md` for routing and thread semantics,
  `docs/controller-contract.md` for the Skill/MCP boundary, and `SECURITY.md`
  before changing provider data, credentials, permissions, tools, lifecycle,
  or paid-call behavior.
- Broker is a cross-provider subagent adapter. Keep the controller on its
  selected provider while delegating to explicitly selected worker routes. Do
  not turn Broker into a generic task platform or a provider-specific model
  wrapper.
- Preserve native-sized controller semantics: agent identity, a small status
  set, final text or error, send, wait, interrupt, and list. Keep App Server
  thread/turn details and qualification evidence internal unless needed for a
  truthful diagnostic.
- A completed, failed, or interrupted turn does not destroy its agent thread;
  follow-up input can start another turn.
- The `$broker` Skill calls native collaboration tools directly only for a
  currently qualified route. The local `broker` STDIO MCP server owns managed
  App Server agents and never impersonates a native child.
- Select the backend before dispatch. Do not trial-spawn native per task,
  silently change provider or model, migrate an active agent, or create a
  second worker after an ambiguous creation.
- MCP inputs select preconfigured routes only. Never accept inline credentials,
  base URLs, authorization headers, or provider definitions from model
  context.
- Send only the assignment and explicitly included context to the worker
  provider. Do not copy the controller's conversation automatically.
- Default to read-only access. `workspace-write` must remain within both the
  route cap and host authority. A worker cannot expand either boundary through
  an approval request.
- Treat configured and client-advertised workspace roots as preauthorization.
  An unlisted canonical `cwd` may be approved through MCP elicitation only for
  the current connection; never persist that grant or broaden it beyond the
  approved directory and descendants.
- Use the supplied workspace directly. Broker does not own worktree creation,
  merging, rebasing, diff handoff, or cleanup. The controller serializes
  overlapping writers and gives concurrent writers disjoint ownership.
- App Server owns thread history, turn results, and recovery. Persist only the
  non-secret runtime metadata that cannot be reconstructed from it.
- Scope managed runtimes by route and effective access. Pass only the selected
  route's credentials, filter those credentials from worker shell commands,
  and disable nested Broker/multi-agent behavior.
- Treat `turn/interrupt` as local interruption only; it does not prove that
  provider computation or billing stopped.
- Offline tests must make no provider call. Live qualification or smoke tests
  require explicit authorization and must state the provider data boundary.
- Keep `codex-deepseek-subagent` as historical evidence and
  `pi-dsh-mimic` as an independent package; neither is a Broker runtime
  dependency.
