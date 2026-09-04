# Broker backend and agent-thread policy

> Status: accepted on 2026-09-03. This document owns Broker's backend
> selection, worker-thread lifecycle, recovery, and runtime isolation policy.

## Parent outcome

Broker lets one controller schedule subagent work across model providers
without switching the controller's own provider. Its public abstraction is an
agent thread, not a durable workflow job. The worker's useful result is its
final assistant text plus any effects already made in the authorized
environment.

## Route and backend selection

A route fixes the effective provider and model. The controller may select an
explicit route or choose among configured routes by their declared purpose,
but Broker never substitutes a different route after dispatch.

Backend selection occurs before agent creation:

1. Use a native Codex child only when a current qualification record proves
   explicit cross-provider selection, usable assignment delivery, truthful
   identity, required tools and permissions, waiting, interruption, and final
   result delivery.
2. Otherwise use a provider-scoped Codex App Server runtime for the same route.
3. Otherwise fail before dispatch.

Qualification is cached by the Codex build, Broker version, route
configuration, credential identity, environment, permission boundary, and
relevant protocol versions. Broker does not trial-spawn a native child for
every task. Live provider canaries require explicit data and cost
authorization.

Codex `0.149.0` and later currently select App Server directly because the
native child inherits the parent provider. If a later qualification succeeds,
only newly created agents use native. Existing threads keep their lifecycle
owner. A runtime contract violation disables native for later creation; an
ambiguous native creation never causes a second worker to be started.

Qualification detail is diagnostic state. The controller normally sees only
the selected backend and concise reason returned by `routes`.

## Agent-thread lifecycle

A managed Broker agent corresponds to one persisted App Server thread. Each
`spawn_agent` starts the first turn; later `send` calls either steer the active
turn or start another turn on the same thread.

Broker uses the native-sized status vocabulary:

- `starting`: the thread exists and its first or next turn is being accepted;
- `running`: a turn is active, including time spent executing tools or waiting
  for a host interaction;
- `interrupted`: the latest turn was interrupted and the thread can continue;
- `completed`: the latest turn completed and carries its final assistant text;
- `failed`: the latest turn failed and carries an error;
- `not_found`: the referenced thread cannot be found in its owning runtime.

Completion, failure, and interruption end a turn, not the agent thread. A
follow-up may move any of them back to `running`. Broker does not add submitted,
input-required, auth-required, rejected, unknown, or immutable terminal job
states.

## Interaction and interruption

The selected sandbox and route cap define what a worker can do without new
authority. App Server requests for command/file approval or ordinary user
input are transient runtime interactions:

- while an associated MCP call is active and the host advertises elicitation,
  Broker presents a minimal non-secret prompt and relays the answer;
- otherwise Broker declines the request and lets App Server report the
  resulting worker outcome;
- a worker cannot use an interaction to expand beyond the route or host
  permission boundary;
- provider credentials are configured outside model context and never
  requested interactively.

`interrupt_agent` maps to App Server `turn/interrupt`. The acknowledged local
interruption prevents Broker from accepting later output from that turn. It is
not evidence that an upstream provider stopped computation or billing.

## Context and workspace

Cross-provider creation sends only the complete assignment and context the
controller explicitly includes. It does not clone the parent conversation by
default. The worker receives the requested `cwd`, loads applicable project
instructions there, and observes the workspace's current state.

Configured workspace roots are durable preauthorization. Roots advertised by
the MCP client are host authority. If neither covers `cwd`, an
elicitation-capable host may approve its canonical path for the current MCP
connection. The grant covers that path and descendants, is not persisted, and
is established before an App Server runtime or provider request starts.
Decline, cancellation, or a host without elicitation fails closed.

Agents use the current checkout. Broker does not create or manage worktrees.
The controller owns parallel-write decomposition: concurrent writers receive
disjoint scopes, overlapping writers run serially, and explicit isolation is
prepared by the Codex host or caller before dispatch.

## Runtime isolation

Broker runs a clean App Server runtime per route and effective access class.
The runtime receives:

- the selected provider definition and model;
- an allowlisted operating-system/toolchain environment plus the variables
  required to authenticate that route;
- the requested workspace boundary;
- Codex core tools plus applicable project instructions and project-scoped
  skills discovered from the supplied workspace.

The nested runtime disables Broker and multi-agent delegation so a managed
worker cannot recursively invoke Broker by default. Provider credential
variables are filtered out of model-generated shell commands.

The installed MCP process receives one generic credential map from its host
environment and expands it only in memory. Each child runtime receives only the
entries referenced by its route; the map itself is never forwarded.

Processes may be reused for several threads only inside the same route and
access boundary. Route credentials and runtime state are not shared across
those boundaries.

## Recovery owner

App Server owns persisted conversation history, thread identity, turn output,
and resume behavior. Broker derives its managed agent id from the runtime and
App Server thread identity. It stores only small non-secret runtime metadata
that cannot be reconstructed from App Server; there is no second job database
or copied conversation archive.

Configuration changes that affect provider execution create a new runtime
identity for new agents; presentation-only description and tag edits do not.
An existing agent continues through the runtime identity embedded in its
handle, provided its referenced credential is still available.

## Revisit conditions

Revise this policy when native Codex restores trusted per-child provider
selection, App Server changes its stable thread/turn contract, MCP interaction
semantics change, or real use shows that native-like thread controls are
insufficient. Do not add generic workflow machinery without an observed
consumer that cannot be served by the owning App Server thread.
