---
name: maintain-mixagents
description: Maintain or diagnose mixagents package contracts in Broker, codex-deepseek-subagent, or pi-dsh-mimic, including cross-provider routing, worker lifecycle, plaintext handoff, first-request payloads, and session stages. Skip unrelated repository work.
---

# Maintain Mixagents

The repository contains two independent integrations and the provider-neutral
Broker project. Select the affected package first and keep its lifecycle,
distribution surface, and evidence separate from the others. Do not introduce
a shared abstraction merely because packages involve agents, providers, or
similar transports.

## MixAgents Broker

Read the Broker [product and status owner](../../../packages/broker/README.md),
its accepted
[backend and lifecycle policy](../../../packages/broker/docs/backend-and-lifecycle-policy.md),
its accepted
[controller contract](../../../packages/broker/docs/controller-contract.md),
its [local project instructions](../../../packages/broker/AGENTS.md), and its
[security owner](../../../packages/broker/SECURITY.md) before changing routing,
worker lifecycle, provider data, credentials, permissions, tools, or paid-call
behavior.

Broker exists to schedule workers across model providers without globally
switching the controller's provider. Preserve that parent outcome rather than
reducing the package to a DeepSeek-specific adapter or a one-shot model tool.
Keep these boundaries explicit:

- Name the effective controller, provider, model, backend, worker identity, and
  lifecycle owner truthfully.
- A backend owns only the lifecycle semantics it can actually provide. Never
  present an externally managed worker as a native Codex child.
- Provider selection does not grant tool, filesystem, network, or mutation
  authority. The effective harness and environment own those permissions and
  side effects.
- Missing capability, credentials, or transport fails closed. Never silently
  change provider, model, backend, or task carrier.
- Prefer native Codex children only when the full cross-provider capability
  contract passes; otherwise select the qualified App Server fallback before
  dispatch. Never migrate a live Agent as an implicit retry.
- Route from a versioned qualification record. Do not trial-spawn a native
  child per Agent; requalify only when the Codex build, plugin, route, credential
  identity, environment, permissions, or relevant protocol changes. Start with
  offline checks, and require explicit authorization for a live canary.
- Promote a fully evidenced qualification atomically for new Agents only. Demote
  the affected key on a provider, transport, identity, or lifecycle contract
  violation, not an ordinary task failure. Reuse the same creation through App
  Server only after proving native accepted no child and began no external
  effect; ambiguity must not create a second worker.
- Preserve the native-sized Agent thread contract: `routes`, `spawn_agent`,
  `send`, `wait_agent`, `interrupt_agent`, and `list_agents`; a small status
  vocabulary; and final text or an error. Do not reintroduce a generic Job,
  revision, pending-action, cancellation, artifact, or release protocol without
  a demonstrated consumer that App Server threads cannot serve.
- Completion, failure, and interruption end the current turn, not the Agent
  thread. Follow-up input may start another turn on the same App Server thread.
- App Server owns managed thread history, turn results, and recovery. Persist
  only non-secret runtime metadata that cannot be reconstructed from it.
- Scope runtime processes by route and effective access. The `$broker` Skill
  routes qualified native Agents through Codex collaboration tools directly;
  the local STDIO MCP server owns App Server-backed Agents.
- MCP tools accept only preconfigured routes, never inline credentials,
  endpoints, headers, or provider definitions.
- Send only the complete assignment and context explicitly selected for the
  worker. Managed workers use the supplied checkout directly; the controller
  serializes overlapping writers or prepares a Codex worktree before dispatch.
- Relay transient non-secret approval or user-input requests through the host
  only when it advertises elicitation during an associated call. Otherwise
  decline explicitly; never collect credentials or expand route authority.
- Treat App Server `turn/interrupt` as a local turn result. State the provider
  compute/billing limitation instead of inventing a remote-cancellation claim.
- Treat probes as disposable evidence; record only decision-grade results in
  their durable project owner.

The existing Codex DeepSeek package is inherited evidence, not a Broker runtime
dependency. Pi DSH mimic remains a separate first-request integration.

## Codex DeepSeek subagent

Read the [composition and transport design](../../../packages/codex-deepseek-subagent/docs/advanced.en.md)
before changing provider routing, child creation, Hook transport, authentication,
or installed files. Read the [security owner](../../../packages/codex-deepseek-subagent/SECURITY.md)
when a change affects credentials, plaintext state, permissions, or provider
data. The [runtime skill](../../../packages/codex-deepseek-subagent/skills/use-v4-flash-worker/SKILL.md)
is the parent Agent's installed consumer contract; update it only when that
observable contract changes.

Keep these ownership boundaries intact:

- `hooks/plaintext_handoff.py` and `hooks/plaintext-handoff.ps1` implement the
  same one-shot envelope and state transitions on different platforms.
- `agents/`, the Hook examples, `snippets/AGENTS.md`, and
  `prompts/install-with-codex.md` jointly define what installation distributes
  and wires into Codex.
- Codex continues to own child identity, permissions, cancellation, waiting,
  and callback. This package owns only the temporary cross-provider assignment
  transport.

Preserve stage-before-spawn, the exact `v4_flash_worker` role,
`fork_turns="none"`, atomic at-most-once delivery, and explicit handling of
pending, claimed, expired, locked, or quarantined state. A transport failure
must not silently switch provider, model, collaboration mode, or task carrier.
Changes to this contract normally propagate across both platform scripts, the
installer and Hook templates, the runtime skill, and their focused tests.

## Pi DSH mimic

Read the [request and experiment design](../../../packages/pi-dsh-mimic/docs/advanced.md)
before changing activation, bootstrap payloads, tools, or stage transitions.
Read the [security owner](../../../packages/pi-dsh-mimic/SECURITY.md) when a
change affects provider data or filesystem authority.

Use the existing code owners:

- `src/session-stage.ts` owns route activation and durable stage restoration.
- `src/protocol.ts` owns the Minimal first-request shape and later persona
  preservation.
- `src/index.ts` maps those rules onto Pi events; `src/editor.ts` owns the
  contributed `str_replace_editor` behavior.

The user's real task must occupy request one without a synthetic model round.
Arm only a new session whose model id contains `deepseek-v4-pro`; do not forge a
bootstrap after a conversation has started. Provider errors and aborted
responses retain the bootstrap, while a successful assistant response or real
tool call promotes the session. After promotion, Pi again owns the native
payload and full tool catalog while the Minimal persona remains. Preserve
resume and crash-stale recovery, non-target isolation, image-bearing tasks, and
the editor's explicit filesystem boundary.

## Evidence and delivery

Choose checks from the behavior actually changed:

- Broker plugin, Skill, and App Server adapter:
  `npm --prefix packages/broker run check`,
  `npm --prefix packages/broker run pack:check`, plugin validation, Skill
  validation, local Markdown links, and final diff inspection. These tests use
  a fake App Server; a separate loopback-provider probe may exercise the real
  bundled Codex without contacting a provider.
- Codex templates and distribution links:
  `python3 packages/codex-deepseek-subagent/tests/test_agent_templates.py`
- POSIX handoff protocol:
  `python3 packages/codex-deepseek-subagent/tests/test_plaintext_handoff.py`
- Windows handoff protocol, on Windows:
  `powershell -NoProfile -File packages/codex-deepseek-subagent/tests/plaintext-handoff.windows.ps1`
- Pi extension behavior and package contents:
  `npm --prefix packages/pi-dsh-mimic run check` and
  `npm --prefix packages/pi-dsh-mimic run pack:check`

These local checks make no provider call. Run a Broker provider qualification,
a DeepSeek smoke test, or a Project2 experiment only with explicit
authorization for its cost and external data boundary. Keep completion claims
backend-, platform-, provider-, and evidence-specific, and update the affected
English and Chinese public owners when observable behavior or safety guidance
changes.
