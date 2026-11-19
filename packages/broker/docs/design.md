[README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Security](../SECURITY.md)

# Broker design

## Why workers are separate App Server processes

Codex runs a native subagent on its parent's model provider, and it does so on
purpose. [openai/codex#39299](https://github.com/openai/codex/pull/39299),
shipped in Codex 0.149.0, restricts agent roles so that they customise a child
"without expanding the authority or changing the provider configuration
inherited from its parent session". The
[subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
says the same: `model_provider` in a custom agent file does not override the
parent configuration. A role file can still change the child's model name, but
the request goes to the parent's provider. The
[2026-11-20 re-run](app-server-backend-probe-2026-09-03.md#re-run-on-codex-0166-2026-11-20)
of the backend probe found this on Codex 0.166 in all 13 configurations it
tried. [openai/codex#40858](https://github.com/openai/codex/issues/40858) asks
for a per-child provider; it is open and has no maintainer response.

A worker on another provider therefore has to be another Codex process. For
each route, Broker starts a Codex App Server configured with that route's
provider and model, and leaves the model loop, tools, sandbox, thread history,
interruption and recovery to App Server. Broker's own job is to choose the
runtime, pass it the right credentials, and translate App Server threads into a
small set of tools for the controller. If Codex lets a native child use its own
provider, Broker is no longer needed.

The plugin has two parts. The `$broker` Skill tells the controller how to pick a
route and write an assignment. The local STDIO MCP server named `broker` owns
the App Server runtimes and exposes the tools below.

## Tools

| Tool | What it does |
| --- | --- |
| `routes` | Lists configured routes: id, description, provider, model, tags, access limit, whether the credentials are present, and which is the default. Makes no provider request. |
| `spawn_agent` | Starts a worker on one route with a task, an absolute `cwd` and optional `access`, and returns once App Server has created the thread and accepted the first turn. |
| `send` | Steers the active turn, or starts a follow-up turn on the same thread when the last one has ended. |
| `wait_agent` | Waits for one to eight agents and returns `{ timedOut, agents }`. |
| `interrupt_agent` | Interrupts the active turn; the thread stays usable. |
| `list_agents` | Lists the agents in Broker's local runtimes, for recovery after a restart. |

Normal delegation uses `routes`, `spawn_agent` and `wait_agent`. Tool arguments
accept a configured route id, never endpoints, headers, credentials or provider
definitions, so a model cannot point a worker at a provider the user did not
configure. When a route is unavailable, or Broker cannot keep its provider,
model, workspace or access, the call fails; Broker does not try another route.

The assignment and whatever the controller puts in it are what the provider
receives at dispatch. The controller's conversation is not copied.

### Snapshots and statuses

Every tool that returns an agent returns this snapshot:

| Field | Present |
| --- | --- |
| `agentId` | always; identifies the runtime and the App Server thread |
| `route`, `provider`, `model` | always |
| `status` | always |
| `output` | when `completed`: the latest turn's final assistant text |
| `error` | when `failed` |
| `idleMs` | when `starting` or `running` and this process owns the agent: milliseconds since App Server last sent Broker anything about the thread |

The statuses are `starting` (the turn is being accepted), `running` (a turn is
active, including while a tool runs or an approval waits), `completed`,
`failed`, `interrupted`, and `not_found`. The middle three describe the latest
turn, not the agent: `send` can start another turn after any of them.

`idleMs` is a measurement. Broker sets no threshold and never acts on it; the
controller judges it against what the task involves.

`wait_agent` returns at once when a target is already `completed`, `failed`,
`interrupted` or `not_found`. Otherwise it returns when a target changes or the
timeout ends. `timeoutMs` defaults to 30000 and is rejected above 120000, so a
controller learns about the limit instead of having its wait silently cut short.

`interrupt_agent` maps to App Server's `turn/interrupt`. Broker then ignores
later output from that turn. The provider request may continue, and be billed,
after the local turn has stopped; the result's `providerMayContinue` is true
when the turn was running.

## Workers owned by another chat

Each Codex chat starts its own Broker, and several Brokers can share one data
directory and so one set of thread histories. Only one App Server process can
write a thread at a time: the process that started or resumed it holds the
thread's writer lock until it exits, and `thread/resume` elsewhere is refused
meanwhile.

`list_agents` and `wait_agent` therefore read another chat's thread with
`thread/read` and do not resume it. `wait_agent` polls such a thread, because
the owner's notifications reach only the owner, and its snapshot carries no
`idleMs`.

App Server reports a turn running in another process the same way as one whose
process died mid-turn: thread `notLoaded`, latest turn `interrupted`, no
`completedAt`. In that case only, Broker asks the writer lock by trying
`thread/resume`. A refusal means a live owner, reported as `running`; success
means the owner is gone, the turn really was interrupted, and this process now
owns the thread. One `wait_agent` call probes a target at most once.

`send` and `interrupt_agent` need the writer lock. While another live process
holds it they fail with `agent_owned_elsewhere` and leave the thread alone.
After that process exits, they resume the thread in this one.

## Approvals and user input

Workers run with `approval_policy = "on-request"` inside the sandbox of their
access level, `read-only` by default or `workspace-write` when the call asks
for it and the route allows it. When a worker wants something its sandbox does
not allow, App Server sends Broker an approval request. An approved command
runs outside the sandbox. App Server's `item/commandExecution/requestApproval`
carries nothing that marks it as such an escalation, so Broker's prompt states
it for every command approval.

Broker queues these requests and presents them while a `wait_agent` call is in
progress, through MCP elicitation, if the host supports it:

- command and file-change approvals are shown with the command, directory and
  reason, and the consequence of approving;
- requests for extra permissions or network access, file changes on a
  read-only worker, and file changes that ask for a new writable root are
  declined without asking;
- questions for the user are shown as a form, except questions marked secret,
  which are never relayed, so a credential cannot be collected this way.

Without an elicitation-capable host, or when `interrupt_agent` finds a request
pending, Broker declines it and App Server reports the outcome to the worker.
`send` does not accept unrelated input while a request is pending.

## Workspace authorisation

`cwd` is resolved to its canonical path. Broker accepts it inside a root the
MCP client advertises or a `workspaceRoots` entry in the configuration.
Otherwise, if the host supports elicitation, Broker asks the user to approve
that directory. The approval covers the directory and its descendants for the
current MCP connection, is kept only in memory, and is checked before any App
Server runtime or provider request starts. A decline, a cancellation, or a host
without elicitation starts no worker.

Workers use the workspace as it is, tracked and untracked files included, and
write to it directly. Broker does not create worktrees, merge, or clean up. The
controller runs overlapping writers one at a time and prepares a Codex worktree
first when it wants isolation.

## Runtime isolation and credentials

Broker runs one App Server process per route and access level, each with its
own clean Codex home. The runtime configuration sets the route's provider,
model, reasoning effort and context window, `wire_api = "responses"`, and turns
off plugins and multi-agent delegation, so a worker cannot start Broker or
subagents of its own. Project instructions and project skills in the workspace
still apply.

The plugin launcher forwards one variable, `MIXAGENTS_BROKER_CREDENTIALS_JSON`,
which maps environment-variable names to secrets. Broker expands it in memory
and gives each App Server process only the variables its route references,
plus an allowlisted operating-system and toolchain environment and any proxy
variables. The runtime's shell-environment policy removes the route credential,
other credential-like names and proxy variables from commands the model runs.

## Recovery and what Broker stores

App Server persists each thread's history, identity and turn results, and
resumes it after a restart. Broker derives the agent id from the runtime and
the thread id and stores only small non-secret runtime metadata it cannot get
back from App Server: no job database, no copy of the conversation.

A change to a route's provider, model, endpoint, credentials or access creates
a new runtime identity for new agents; editing a description or tags does not.
An existing agent keeps the runtime identity in its id, as long as its
credential is still available.

## Upstream behaviour Broker depends on

| Behaviour | Watched by |
| --- | --- |
| A native subagent cannot use its own provider, which is why Broker exists | [Backend probe](app-server-backend-probe-2026-09-03.md), re-run by hand |
| App Server honours a per-process provider, model and `wire_api = "responses"` | `npm run test:codex` |
| `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/list` and their notifications keep their shape | `npm run test:codex` |
| A thread has one writer, and `thread/resume` elsewhere is refused while it is held | `npm run test:codex` (two Brokers sharing a data directory) |
| A command that needs escalation reaches Broker as `item/commandExecution/requestApproval` | `npm run test:codex` (credential-filter check) |
| The shell-environment policy filters the route credential from worker commands | `npm run test:codex` |
| `thread/read` with `includeTurns` and the history hydration in `thread/resume` keep working | `npm run test:codex`; App Server marks both deprecated in favour of `thread/turns/list`, and Broker has not moved yet |

`npm run test:codex` runs the built server against the real `codex` with a mock
Responses provider. CI runs it weekly against the latest stable Codex, on
pushes to `main`, and on pull requests that change Broker, so an upstream change
to any row above shows up as a failing check.

## Sources

- [OpenAI: Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI: Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [OpenAI: MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [openai/codex#39299](https://github.com/openai/codex/pull/39299)
- [openai/codex#40858](https://github.com/openai/codex/issues/40858)
