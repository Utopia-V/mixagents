# Broker controller contract

> Status: accepted on 2026-09-03. This document owns Broker's
> controller-facing integration and logical tool contract.

## Product interaction

Broker is a cross-provider subagent adapter. A controller uses the `$broker`
Skill to delegate work to a configured provider route while keeping the
controller's own provider unchanged. The ordinary experience stays close to a
native Codex subagent: create an agent thread, optionally send more input,
wait for its final text, and interrupt it when necessary.

The `mixagents-broker` plugin contains:

- the `$broker` routing Skill;
- a local STDIO MCP server named `broker` for Broker-managed agents.

The Skill resolves the route before dispatch:

1. If a current qualification record proves that Codex can create a native
   child on the requested provider and model, the Skill calls Codex's native
   collaboration tools directly.
2. Otherwise, the Skill calls the `broker` MCP server, which maps the agent to
   a provider-scoped Codex App Server thread.
3. If neither backend can preserve the requested provider, model, workspace,
   and access boundary, creation fails before a worker is started.

Fallback changes only the backend. It never substitutes another provider or
model. A managed App Server thread is reported as `app_server`, not presented
as a native Codex child.

## Tool surface

The MCP server exposes six tools. Normal delegation uses only `routes`,
`spawn_agent`, and `wait_agent`.

| Tool | Purpose |
| --- | --- |
| `routes` | List configured provider/model routes, availability, and the resolved backend without invoking a provider |
| `spawn_agent` | Create a managed agent thread and start its first turn |
| `send` | Add input to a running turn or start a follow-up turn on an inactive agent |
| `wait_agent` | Wait for one of up to eight agents to finish, fail, interrupt, or request host interaction |
| `interrupt_agent` | Interrupt the active turn without destroying the agent thread |
| `list_agents` | List recoverable managed agents for the configured local runtimes |

The Skill uses the equivalent native collaboration operations when `routes`
selects `native`; the MCP server does not proxy native agents.

## Agent representation

Creation returns the smallest identity needed by the controller:

```text
agentId
route
provider
model
backend              native | app_server
status               starting | running | interrupted | completed | failed |
                     not_found
```

`completed` contains the latest turn's final assistant text. `failed` contains
its error. These are turn outcomes, not immutable job terminals: `send` may
start another turn on an agent whose previous turn completed, failed, or was
interrupted.

Broker does not expose a second task protocol, revisions, cancellation
substates, result references, diff manifests, or release handles. App Server
thread and turn identifiers may appear in diagnostics, but they are not the
controller's normal working vocabulary.

## Tool behavior

### `routes`

Returns each configured route's id, description, provider, model, tags,
credential availability, maximum access, selected backend, and selection
reason. It reads configuration and cached qualification only; it makes no
provider request and never creates a trial child.

An explicit route choice is authoritative. When no route was specified, the
controller may choose among available routes using their descriptions and
tags. Once selected, an unavailable route fails rather than silently choosing
another provider.

### `spawn_agent`

Required input:

- `route`: a configured route id;
- `task`: a complete worker assignment;
- `cwd`: the current workspace's absolute working directory.

Broker accepts `cwd` when its canonical path is inside a root supplied by the
Codex MCP client or preauthorized in local configuration. Otherwise, when the
client advertises MCP elicitation, Broker asks the host to approve that exact
canonical directory. Approval covers the directory and its descendants for
the current MCP connection and is not persisted. A decline, cancellation, or
client without elicitation support fails before App Server or a provider is
invoked.

Optional `access` is `read-only` by default and may request
`workspace-write`. It cannot exceed the route's configured maximum or the
authority granted by the host.

The assignment and explicitly included context are sent to the selected
worker provider. Parent conversation history is not copied automatically.
Credentials, provider endpoints, headers, and inline provider definitions are
not accepted as tool arguments.

For the managed backend, creation returns after App Server has durably created
the thread and accepted the first turn. It does not wait for model completion.

### `send`

Accepts `agentId` and `message`.

- If the agent has an active turn, the message steers that turn.
- If the latest turn is inactive, the message starts a follow-up turn in the
  same App Server thread.
- A pending host interaction must be resolved or declined before unrelated
  follow-up input is accepted.

### `wait_agent`

Accepts one to eight agent ids and a bounded timeout. It returns immediately
when a requested agent already has a non-running outcome. Otherwise it waits
until any target changes materially or the timeout expires, then returns
compact snapshots for all targets.

If App Server asks for command/file approval or ordinary user input while the
wait call is active, Broker may use the MCP client's declared elicitation
capability to present that request. The response is relayed directly to App
Server and is not retained as a separate Broker task. If the host cannot
present the request, Broker declines it explicitly; credentials are never
collected through elicitation.

### `interrupt_agent`

Requests interruption of the current App Server turn and returns the previous
status. The thread remains available for `send`.

`interrupted` means Broker will not apply later output from that turn. It does
not claim that a remote provider stopped computation or billing.

### `list_agents`

Returns managed App Server threads discoverable from Broker's configured local
runtimes. App Server history remains authoritative; the list is a recovery and
navigation aid rather than an audit archive.

## Workspace and write behavior

Managed agents use the supplied `cwd`, including its current tracked and
untracked state. File changes occur directly in that workspace, as they do for
native subagents. Broker does not create worktrees, merge, rebase, release, or
summarize diffs on the controller's behalf.

The controller should serialize overlapping write tasks or give concurrent
workers disjoint ownership. When isolation is required, the controller first
uses a Codex-managed worktree or supplies a separately prepared allowed
workspace.

## Implementation boundary

The initial local implementation includes the plugin manifest, `$broker`
Skill, STDIO MCP server, route configuration, provider-scoped App Server
runtimes, host-interaction bridge, and offline tests. It does not include a
remote Broker service, custom UI, a replacement model/tool loop, MCP Tasks, or
automatic source-control integration.

## Sources

- [OpenAI Docs: Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI Docs: Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [OpenAI Docs: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Docs: MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [Broker backend policy](backend-and-lifecycle-policy.md)
