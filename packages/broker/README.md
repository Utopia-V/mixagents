[简体中文](README.zh-CN.md) · [Security](SECURITY.md) · [Design](docs/design.md)

# MixAgents Broker

MixAgents Broker lets a Codex session hand subtasks to workers on other model
providers while the session itself stays on its own provider. You configure
routes, each naming a provider and a model. The plugin's `$broker` Skill picks a
route, and its local MCP server starts the worker as a separate Codex App Server
process that talks only to that route's provider.

## When Broker is the right tool

Codex runs native subagents on the parent's provider, by design (see the
[subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)).
People who want more than one provider in Codex usually take one of three
approaches:

- **Broker.** The main session keeps talking to its provider directly, with no
  proxy in between. Workers on other providers are separate Codex processes
  that Broker starts and reports on through six tools. This suits staying on
  your main provider and handing out bounded tasks.
- **A local gateway** that serves several providers behind one Codex provider
  entry. Native subagents can then reach other models by model name, because
  every model sits behind the same provider; in exchange, the main session's
  traffic also goes through the gateway.
- **Switching the whole session's provider**, by hand or with a tool such as
  cc-switch. Everything, subagents included, then runs on the new provider, one
  provider at a time. [Coexisting with cc-switch](#coexisting-with-cc-switch)
  explains how to keep Broker installed when you switch this way.

## Requirements

- Codex `0.149.0` or later, with plugin and App Server support;
- Node.js `22.19.0` or later;
- a provider endpoint compatible with the OpenAI Responses API;
- an API key for each route.

CI runs Broker against the latest stable Codex every week, with a mock provider
in place of a real one; that was Codex `0.170.0` when this was written. The one
run against a real provider used Codex `0.151` with OpenCode Go.

## Install

The npm package contains the plugin. The MixAgents marketplace makes that
package discoverable to Codex. Publishing to npm alone does not add a plugin to
the default public directory.

Add the MixAgents marketplace:

```bash
codex plugin marketplace add Utopia-V/mixagents
```

Then install **MixAgents Broker** from the **MixAgents** source in the Codex
Plugins page, or install it from the CLI:

```bash
codex plugin add mixagents-broker@mixagents
```

Start a new Codex task after installation.

### Coexisting with cc-switch

Every time cc-switch switches a Codex provider, it regenerates
`~/.codex/config.toml` from the selected provider's fields, its common config
snippet, and the MCP servers cc-switch manages. Anything else in `config.toml`,
including plugin and marketplace registration, is gone after a switch — Codex no
longer knows the plugin and it has to be installed again.

Keep the registration by adding both blocks below to cc-switch's Codex common
config snippet:

```toml
[marketplaces.mixagents]
source_type = "git"
source = "https://github.com/Utopia-V/mixagents.git"

[plugins."mixagents-broker@mixagents"]
enabled = true
```

Then tick "apply common config" (应用通用配置) for every Codex provider: the
checkbox sits at the top right of the `config.toml` editor in the provider
dialog, next to the "edit common config" (编辑通用配置) link that opens the
snippet. A provider without the checkbox does not receive the snippet on a
switch, and the plugin registration is still lost. cc-switch's own guidance says
the same: after installing a plugin or hook, sync the common config again.

After a switch, `codex plugin list` confirms the registration. If it is really
gone, run these in order:

```bash
codex plugin marketplace remove mixagents
codex plugin marketplace add Utopia-V/mixagents
codex plugin add mixagents-broker@mixagents
```

The first command is required: a stale marketplace copy makes `add` fail with
"already added from a different source". Start a new Codex task afterwards, and
restart Codex if `$broker` is still missing.

## Configure routes

Create the configuration file:

- Linux/macOS: `~/.config/mixagents/broker.json`
- Windows: `%APPDATA%\MixAgents\broker.json`

Example:

```json
{
  "defaultRoute": "opencode-deepseek-flash",
  "routes": {
    "opencode-deepseek-flash": {
      "description": "Fast worker for review, extraction, and coding tasks.",
      "provider": "opencode_go",
      "providerName": "OpenCode Go",
      "model": "deepseek-v4.1-flash",
      "contextWindow": 1000000,
      "baseUrl": "https://opencode.ai/inference/go/openai/v1",
      "envKey": "OPENCODE_API_KEY",
      "tags": ["fast", "low-cost", "coding"],
      "maxAccess": "workspace-write",
      "reasoningEffort": "high"
    }
  }
}
```

This route uses OpenCode Go's Responses endpoint, which OpenCode documents for
[Codex](https://opencode.ai/docs/console/harnesses/codex); OpenCode translates
the request for models such as DeepSeek V4.1 Flash that natively use Chat
Completions. DeepSeek's own API documents Chat Completions and
Anthropic-format endpoints but no Responses endpoint, so it cannot serve as a
route directly.

`workspaceRoots` is optional. Its entries preauthorize fixed directories and
are merged with roots provided by the MCP client. When `cwd` is outside those
roots, Broker asks for confirmation before the first dispatch. Approval covers
that canonical directory and its descendants for the current MCP connection;
it is not written to configuration. Clients that cannot show MCP elicitation
must configure `workspaceRoots` explicitly.

`maxAccess` is the route's upper permission limit; each dispatch still defaults
to `read-only`.

Use `MIXAGENTS_BROKER_CONFIG` to select another absolute configuration path.
Runtime state defaults to `~/.local/state/mixagents-broker` on Linux/macOS
and `%LOCALAPPDATA%\MixAgents\Broker` on Windows. Use
`MIXAGENTS_BROKER_DATA_DIR` to select another state directory.

Broker normally resolves the Codex executable automatically. On Windows, an
npm-managed installation is resolved to its matching native `codex.exe`
instead of the `codex.cmd` or `codex.ps1` shim. If automatic resolution is not
available, set the top-level `codexBin` field or
`MIXAGENTS_BROKER_CODEX_BIN` to the full path of the Codex executable.

## Configure credentials

The process that starts Codex must provide
`MIXAGENTS_BROKER_CREDENTIALS_JSON`. Its value is a JSON object whose keys are
the environment-variable names referenced by routes:

```json
{
  "OPENCODE_API_KEY": "<secret>",
  "ANOTHER_PROVIDER_KEY": "<secret>"
}
```

Inject this value with the launcher or secret manager used to start Codex.
Keep credentials out of `broker.json`, prompts, shell history, screenshots,
and the repository. A route is unavailable when one of its referenced
credentials is missing.

The Broker process expands the map in memory. Each App Server runtime receives
only the credentials referenced by its route, and those variables are removed
from model-generated shell commands.

## Use

Name a route when the choice matters:

```text
$broker Use opencode-deepseek-flash to review this module and return the three
most important findings.
```

Broker can also choose from route descriptions and tags:

```text
$broker Delegate this extraction task to a configured low-cost worker.
```

Before dispatch, the controller reports the selected provider and model. The
assignment and any explicitly included context are sent to that provider. The
parent conversation is not copied automatically.

Managed agents use the supplied workspace. A completed, failed, or interrupted
turn keeps the same agent thread available for follow-up input.

Pass the current workspace's absolute path as `cwd`. An unlisted workspace is
used only after the host approves it; declining the prompt starts no worker.

## Linux sandbox

On Linux, Codex runs a worker's commands in a bubblewrap sandbox, which needs
unprivileged user namespaces. Ubuntu 24.04 restricts them through AppArmor
(`kernel.apparmor_restrict_unprivileged_userns=1`), and there the sandbox cannot
start: commands fail with `bwrap: loopback: Failed RTM_NEWADDR`, so a worker
with the default `read-only` access cannot run any command. The worker may then
ask to run commands outside the sandbox, which brings up an approval prompt for
each. This was seen on Codex `0.166` and `0.170` and affects Codex itself, not
only Broker.

OpenAI's [sandboxing documentation](https://learn.chatgpt.com/docs/sandboxing)
recommends loading the `bwrap-userns-restrict` AppArmor profile, which lets
bubblewrap create namespaces while the restriction stays on for everything
else, and gives turning the restriction off system-wide as the fallback.
[openai/codex#29908](https://github.com/openai/codex/issues/29908) tracks the
problem, and [openai/codex#38715](https://github.com/openai/codex/issues/38715)
reports that the profile can clash with another package's profile for
`bwrap`.

## Implementation

The `$broker` Skill calls `routes` before dispatch. A route fixes the
provider and model for the agent.

Broker starts a clean Codex App Server runtime for each route and access
level. App Server owns the model loop, tools, thread history, turn results, and
recovery. Broker maps that lifecycle to six operations:

- `routes`
- `spawn_agent`
- `send`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

The controller sees `starting`, `running`, `completed`, `failed`,
`interrupted`, or `not_found`. Broker fails when it cannot preserve the
configured provider, model, workspace, or access boundary; it does not
substitute another route.

Several Codex chats can share one Broker data directory, and each sees the
others' agents. `list_agents` and `wait_agent` observe an agent owned by
another chat without taking it over; `wait_agent` polls it, since that chat's
notifications do not reach this one. `send` and `interrupt_agent` on such an
agent fail with `agent_owned_elsewhere` while the other chat's Broker is
running. Once it has exited, the agent can be continued from any chat.

[docs/design.md](docs/design.md) explains why workers are separate processes
and describes the tools, statuses, approvals and recovery in detail.

## Permissions and data

- Dispatch defaults to `read-only`. Request `workspace-write` only for work
  that may change files.
- A managed worker writes directly to the supplied workspace. Broker does not
  create worktrees or merge changes.
- File content read by the worker and tool results may be sent to the selected
  provider, which bills the usage.
- When a worker asks to run a command or change files its sandbox does not
  allow, you get an approval prompt. Approving runs that request outside the
  sandbox.
- The Codex sandbox controls permissions but is not a guarantee that every
  file outside `cwd` is unreadable.
- `interrupt_agent` stops the local turn. Upstream computation and billing
  may continue.

Read [SECURITY.md](SECURITY.md) before enabling a route on private or regulated
data.

## Update or remove

```bash
codex plugin marketplace upgrade mixagents
codex plugin add mixagents-broker@mixagents
```

```bash
codex plugin remove mixagents-broker@mixagents
```

Start a new task after installing an updated version.

## Develop

```bash
cd packages/broker
npm install
npm run check
npm run pack:check
```

The npm package is `plugin/mixagents-broker`: the plugin manifest, the
`$broker` Skill, the STDIO MCP configuration, and the JavaScript runtime that
`npm run build` compiles from `src/` into `dist/`. `dist/` is not committed;
the checks and the publish workflow build it. The runtime has no production
dependencies.

`npm run check` uses a fake App Server. `npm run test:codex` runs the Broker
MCP server against the real `codex` on `PATH`, or the build named by
`MIXAGENTS_BROKER_CODEX_BIN`. A mock Responses provider inside the test stands
in for the model, and the Codex home, Broker data directory, and workspace are
temporary, so the check needs no provider account or key and never touches
`~/.codex`. It covers route and credential isolation, follow-up turns, provider
failure, interruption, restart recovery, two chats sharing one data directory,
and the credential filter on worker shell commands. CI runs it with the latest
stable Codex every week, on pushes to `main`, and on pull requests that change
Broker.
