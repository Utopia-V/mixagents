# MixAgents Broker security

[README](README.md) · [简体中文](README.zh-CN.md) · [Design](docs/design.md)

## What is sent to the provider

Each route fixes a provider and a model. `spawn_agent` sends that provider the
assignment the controller wrote, including any context it chose to put there;
the rest of the controller's conversation is not copied. While the worker runs,
the provider also receives the files it reads and the results of the commands
it runs, as with any Codex session. The provider bills that usage under your
account with it.

The controller names the route's provider and model before it dispatches.
Broker never moves a worker to another route or model; when the configured one
cannot be used, the call fails.

## Credentials

Routes refer to credentials by environment-variable name. The process that
starts Codex provides one variable, `MIXAGENTS_BROKER_CREDENTIALS_JSON`, that
maps those names to secrets. Broker expands it in memory and gives each App
Server process only the variables its route references. Tool arguments,
assignments and Broker's stored metadata never carry credentials, and a
worker's shell commands run without the route credential, other
credential-like variables or proxy variables.

The map is in the Codex host process before the plugin starts, so exclude
`MIXAGENTS_BROKER_CREDENTIALS_JSON` from the controller's own
`shell_environment_policy` as well. Inject it with a launcher or secret manager
rather than a command that stays in shell history.

## Workspace authorisation

Broker starts a worker only in a directory the user has allowed: a root the
MCP client advertises, a `workspaceRoots` entry in `broker.json`, or a
directory the user approves when Broker asks. That approval covers the
directory's canonical path and its descendants for the current MCP connection,
and is kept only in memory. Declining starts no worker.

This decides where a worker runs, not what it can read. Codex's read-only
sandbox may still allow reads outside `cwd`; use a container, a separate user
account or a dedicated workspace when other local files must stay out of the
provider's reach.

## Sandbox and approvals

Workers run in Codex's `read-only` sandbox unless the call asks for
`workspace-write` and the route's `maxAccess` allows it. A `workspace-write`
worker edits the workspace directly; Broker does not merge or revert its
changes.

When a worker wants to run a command or change a file that its sandbox does not
allow, Broker shows the user an approval prompt. Approving runs that command or
change once outside the sandbox, with your user account's permissions, whatever
the worker's access level. The prompt is where you decide that. Requests for
extra permissions or network access, and file changes on a read-only worker,
are declined without a prompt. Questions marked secret are never relayed, so a
worker cannot collect a password or key through Broker.

On Linux, Codex's sandbox needs unprivileged user namespaces; where they are
restricted, workers cannot run commands at all. See the
[README](README.md#linux-sandbox) for the symptom and the fixes OpenAI
documents.

## Stored data

Broker's data directory (`~/.local/state/mixagents-broker` on Linux and macOS,
`%LOCALAPPDATA%\MixAgents\Broker` on Windows, or `MIXAGENTS_BROKER_DATA_DIR`)
holds each worker's App Server history: the assignment, what the worker read
and ran, and its replies. Broker restricts the directory to your user where the
platform has POSIX permissions. Treat it as private user data.

## Interruption

`interrupt_agent` stops the worker's turn on your machine. The request already
sent to the provider may run to completion and be billed.

## Reporting

Report problems as described in the repository's [SECURITY.md](../../SECURITY.md).
