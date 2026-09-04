[简体中文](README.zh-CN.md) · [Security](SECURITY.md)

# MixAgents Broker

MixAgents Broker runs Codex subagents on configured model providers without
changing the controller's provider. It is designed for cross-provider
delegation on current Codex releases, where a native custom child inherits the
parent provider.

The plugin provides a `$broker` Skill and a local STDIO MCP server. The Skill
selects a configured route. The MCP server starts a Codex App Server worker on
that route's exact provider and model.

## Requirements

- Codex with plugin and App Server support;
- Node.js `22.19.0` or later;
- a provider endpoint compatible with the Responses API;
- an API credential for each configured route.

Broker targets Codex `0.149.0` and later. The current compatibility baseline is
Codex `0.151.0-alpha.7.2` with OpenCode Go `deepseek-v4-flash`. Other providers
and models must expose a compatible Responses endpoint.

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

## Configure routes

Create the configuration file:

- Linux/macOS: `~/.config/mixagents/broker.json`
- Windows: `%APPDATA%\MixAgents\broker.json`

Example:

```json
{
  "defaultRoute": "opencode-deepseek-flash",
  "workspaceRoots": [
    "/absolute/path/to/projects"
  ],
  "routes": {
    "opencode-deepseek-flash": {
      "description": "Fast worker for review, extraction, and coding tasks.",
      "provider": "opencode_go",
      "providerName": "OpenCode Go",
      "model": "deepseek-v4-flash",
      "contextWindow": 1000000,
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "envKey": "OPENCODE_API_KEY",
      "tags": ["fast", "low-cost", "coding"],
      "maxAccess": "workspace-write",
      "reasoningEffort": "medium"
    }
  }
}
```

`workspaceRoots` lists directories that Broker may use and is merged with any
roots provided by the MCP client. `maxAccess` is the route's upper permission
limit; each dispatch still defaults to `read-only`.

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

Before dispatch, the controller reports the selected provider, model, and
backend. The assignment and any explicitly included context are sent to that
provider. The parent conversation is not copied automatically.

Managed agents use the supplied workspace. A completed, failed, or interrupted
turn keeps the same agent thread available for follow-up input.

## Implementation

The `$broker` Skill calls `routes` before dispatch. A route fixes the
provider and model for the agent.

On current Codex releases, Broker selects `app_server` directly because a
native custom child cannot switch away from the parent provider. It does not
retry the native backend for every task. A native backend is used only after a
cached qualification proves cross-provider creation, tool use, waiting,
interruption, and result delivery for that route.

The App Server backend starts a clean runtime for each route and effective
access level. Codex App Server owns the model loop, tools, thread history,
turn results, and recovery. Broker maps that lifecycle to six operations:

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

The detailed contracts are in
[controller-contract.md](docs/controller-contract.md) and
[backend-and-lifecycle-policy.md](docs/backend-and-lifecycle-policy.md).

## Permissions and data

- Dispatch defaults to `read-only`. Request `workspace-write` only for work
  that may change files.
- A managed worker writes directly to the supplied workspace. Broker does not
  create worktrees or merge changes.
- File content read by the worker and tool results may be sent to the selected
  provider.
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

The npm package is built at
`plugin/mixagents-broker`. It contains the plugin manifest, `$broker` Skill,
STDIO MCP configuration, and prebuilt JavaScript runtime. Production runtime
dependencies are empty.
