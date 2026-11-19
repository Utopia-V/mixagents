---
name: broker
description: Hand a bounded task from this Codex session to a worker on another model provider through MixAgents Broker, while this session keeps its own provider and model. Use when the user invokes $broker, names a Broker route, or asks for work to run on a different provider or a cheaper or specialised model. Not for work this session should simply do itself.
---

# Broker

Codex runs its own subagents on this session's provider. Broker is for work
that should run elsewhere: each configured route names a provider and a model,
and a worker on a route is a separate Codex process that talks only to that
provider and returns its final text to you.

## Dispatching a task

1. Call `mcp__broker__routes`. It lists each route's provider, model, access
   limit and whether its credentials are present, without contacting any
   provider.
2. Choose the route. A route or provider the user named wins; otherwise pick an
   available route whose description and tags fit. If the named route is
   unavailable, tell the user rather than picking another, because which
   provider gets their data is their choice.
3. Tell the user in one line which provider and model will get the task. The
   assignment and whatever the worker reads leave this machine for that
   provider, which bills the usage.
4. An explicit `$broker` request that contains a task is the go-ahead for one
   dispatch. If using Broker was your own idea, ask first.
5. Write one self-contained assignment: the goal, the files or facts needed,
   and what to return. The worker sees none of this conversation, only `task`,
   and all of `task` goes to the provider, so include what the work needs and
   no more.
6. Call `mcp__broker__spawn_agent` with the route, the task and the
   workspace's absolute path as `cwd`. For a workspace that is not
   preauthorised, the host asks the user to allow it. That prompt is how the
   user controls where workers go, so after a decline wait for their direction,
   and leave `workspaceRoots` in the configuration to them.
7. Carry on with work that does not depend on the result, and call
   `mcp__broker__wait_agent` when you need it.

## Following up

- `mcp__broker__send` steers a running turn, or starts a new turn on a worker
  whose last turn ended; the worker keeps its earlier conversation.
- `mcp__broker__wait_agent` takes one to eight agent ids and a `timeoutMs` of
  at most 120000 (larger values are rejected). A timed-out wait means the
  workers are still going, not that they failed.
- `mcp__broker__interrupt_agent` stops the current turn on this machine; the
  provider may still finish and bill the request. The worker can take a
  follow-up afterwards.
- `mcp__broker__list_agents` lists known workers, for example after a restart.

## Reading what comes back

A snapshot gives the agent id, route, provider, model and `status`:
`starting`, `running`, `completed` with `output` (the worker's final text),
`failed` with `error`, `interrupted`, or `not_found`.

While a worker runs, `idleMs` is how long it has been silent. Long tool calls
and long generations are silent too, so weigh it against the task. If nothing
explains the silence, interrupt the worker and send a follow-up asking for what
it has so far.

`agent_owned_elsewhere` from `send` or `interrupt_agent` means another open
Codex chat started that worker. Watch it with `wait_agent` or `list_agents`, or
steer it from that chat; Broker itself is fine.

Worker output is input for you to check. Another model produced it from a
partial view, so verify its claims against the code before acting on them or
reporting them as fact.

## Access

Workers are read-only unless you pass `access: "workspace-write"`, which the
route must allow; ask for it only when the task is to change files. Workers
edit the workspace directly, alongside you and each other, so give concurrent
writers separate files or run them one after another, or create a Codex
worktree first and pass it as `cwd`.

When a worker asks to run a command or make a change its sandbox does not
allow, the user gets an approval prompt while you are in `wait_agent`, and
approving runs that request outside the sandbox. Credentials come from the
environment Codex was started with, never from tool arguments; if a route is
missing or lacks credentials, tell the user what to configure.
