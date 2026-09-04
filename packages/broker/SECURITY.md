# MixAgents Broker Security

This file owns the security boundary of the local Broker plugin and its
managed App Server workers.

## Provider data and route selection

Each route fixes an effective provider and model. `spawn_agent` sends that
provider the complete assignment and any context explicitly included in it;
the controller's full conversation is not copied automatically. Tool results
and file content read by the worker may also cross the selected provider
boundary.

The selected route is reported before dispatch. Broker may change between a
qualified native backend and App Server for the same route, but it never
silently substitutes another provider or model.

## Credentials

Routes refer to credentials by environment-variable name. The plugin launcher
forwards a single `MIXAGENTS_BROKER_CREDENTIALS_JSON` environment value that
maps those names to secrets; Broker expands it in memory and passes only the
selected route's entries to its App Server process. A directly launched server
may instead receive an explicitly forwarded named variable. Provider tokens
are not accepted in MCP arguments, assignments, model context, repository
files, diagnostic output, or persisted thread metadata.

Inject the credential map through the Codex launcher or another process secret
source. Avoid commands that leave the value in interactive shell history.
The map necessarily exists in the Codex host process before plugin launch, so
the controller's own `shell_environment_policy` must also exclude
`MIXAGENTS_BROKER_CREDENTIALS_JSON`. Broker enforces the corresponding filter
inside every managed worker runtime.

A managed App Server process receives only the credential variables referenced
by its route plus an allowlisted operating-system/toolchain environment needed
to start Codex. Network proxy variables may also be passed to App Server for
provider connectivity. Codex shell-environment policy removes credential-like
and proxy variables, including the route credential, from model-generated
commands. Different routes and access classes do not share worker processes.

Broker configuration may contain non-secret provider endpoints and environment
variable names. It must remain outside model-controlled tool arguments. A
missing credential makes the route unavailable before dispatch.

## Workspace authority

`cwd` is resolved to its canonical path. Broker accepts it inside a root
advertised by the MCP client or preauthorized by local configuration. If no
such root covers it, an elicitation-capable host may approve that exact
canonical directory and its descendants for the current MCP connection. The
grant is held only in memory and is not written to `broker.json` or runtime
state. Decline, cancellation, or a host without elicitation starts no worker.
Changing a symlink after approval cannot redirect the dispatch to another
directory.

This containment controls which workspace Broker may select; it is not by
itself a read-confidentiality boundary. The stable Codex read-only sandbox may
permit reads outside `cwd`. Use an external sandbox, container, or dedicated
user/workspace when other local files must be hidden from the worker model.

Access defaults to read-only. `workspace-write` is accepted only when the route
allows it and the host authorizes the MCP call. Managed workers use the current
workspace directly, so concurrent writers must have disjoint ownership or run
serially. Broker does not merge, revert, or clean worker changes.

Provider selection does not grant network, filesystem, MCP, connector, or
account authority. The App Server sandbox and configured worker tool set own
those effects.

## Runtime and interaction

Managed runtimes use a clean Codex home with Broker, plugins, and multi-agent
delegation disabled by default. This prevents recursive Broker invocation and
limits inherited capabilities. Project instructions in the selected workspace
still apply.

Command/file approval and ordinary user-input requests are transient. Broker
relays a non-secret request through host-supported MCP elicitation only while
an associated call is active. If the host cannot present it, Broker declines
the request. Elicitation must never request passwords, API keys, access tokens,
or payment information, and it cannot widen the configured route or access
boundary. Workspace confirmation changes only which canonical directory may be
selected during that MCP connection; it does not increase the route's access
class or authorize a provider/model dispatch.

## Interruption and recovery

App Server owns persisted thread history and turn results. Broker stores only
small non-secret runtime metadata needed to locate that owner. It does not copy
assignments, complete conversations, tool outputs, or provider responses into
a second job database.

Each runtime directory is restricted to the current operating-system user when
the platform supports POSIX-style modes. Its App Server history still contains
the worker assignment and returned content, so the configured data directory
must be treated as private user state.

An `interrupt_agent` result confirms local turn interruption. The provider
request may continue, so interruption does not prove that remote computation
or billing stopped.

## Testing and reports

Offline tests use fake Responses providers and must not read real credentials
or contact paid endpoints. A live provider qualification or smoke test requires
separate authorization that identifies the provider and data being sent.

Security reports should follow the repository-level [security
instructions](../../SECURITY.md).
