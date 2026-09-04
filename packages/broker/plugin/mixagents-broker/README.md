# MixAgents Broker

MixAgents Broker runs Codex subagents on configured model providers without
changing the controller's provider. It packages the `$broker` Skill and a
local STDIO MCP server backed by Codex App Server.

Requirements: Codex with plugin and App Server support, Node.js `22.19.0` or
later, a Responses-compatible provider endpoint, and its API credential.

## Install

Add the MixAgents marketplace:

```bash
codex plugin marketplace add Utopia-V/mixagents
```

Install **MixAgents Broker** from the **MixAgents** source in the Codex Plugins
page, or use:

```bash
codex plugin add mixagents-broker@mixagents
```

Start a new Codex task after installation.

## Configure

Create `~/.config/mixagents/broker.json` on Linux/macOS or
`%APPDATA%\MixAgents\broker.json` on Windows:

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

Broker normally resolves the installed Codex executable automatically. On
Windows, npm-managed installs use the matching native `codex.exe`. If it
cannot be resolved, set the top-level `codexBin` field or
`MIXAGENTS_BROKER_CODEX_BIN` to the full executable path.

The process that starts Codex must provide
`MIXAGENTS_BROKER_CREDENTIALS_JSON`:

```json
{
  "OPENCODE_API_KEY": "<secret>"
}
```

Inject the credential map through the launcher or secret manager. Do not place
credentials in `broker.json`, prompts, shell history, screenshots, or a
repository.

## Use

```text
$broker Use opencode-deepseek-flash to review this module and return the three
most important findings.
```

Broker reports the provider, model, and backend before dispatch. Only the
assignment and explicitly included context are sent to the selected provider.

## Implementation

The `$broker` Skill selects a configured route before dispatch. Each route
fixes the worker provider and model.

Current Codex releases use the `app_server` backend because a native custom
child inherits the parent provider. Broker starts a clean Codex App Server
runtime for the selected route and access level. App Server owns the model
loop, tools, thread history, turn results, and recovery.

Broker exposes:

- `routes`
- `spawn_agent`
- `send`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

Dispatch defaults to `read-only`. A managed worker uses the supplied
workspace directly. File content and tool results may cross the selected
provider boundary. Local interruption may not stop upstream computation or
billing.

Full documentation:
[github.com/Utopia-V/mixagents/tree/main/packages/broker](https://github.com/Utopia-V/mixagents/tree/main/packages/broker)
