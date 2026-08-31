[Repository index](../../README.en.md) · [中文](README.md)

# Codex OMP Subagent

This component lets a Codex parent delegate complex refactors, repository-wide investigations, AST/LSP-assisted work, and longer coding tasks to the external **OMP (Oh My Pi)** coding harness while keeping Codex's native `spawn_agent` parent/child structure.

V2 changes the execution boundary: **OMP is no longer launched by a `SubagentStart` Hook before the child starts. The native `omp_worker` child launches OMP itself.** The worker uses a modern Codex permission profile that inherits the built-in `:workspace` filesystem boundary while enabling outbound network access for the model provider configured inside OMP. It does not fall back to `danger-full-access` just to obtain network access.

## V2 flow

```text
Codex Parent
  -> stage assignment
  -> UUID handoff
  -> spawn_agent(agent_type="omp_worker", fork_turns="none")
  -> native Codex omp_worker child
       filesystem: :workspace
       network: full outbound, local binding disabled
  -> omp_bridge.py --mode run --handoff-id <UUID>
  -> OMP
  -> bounded structured result + local raw logs
  -> child verifies workspace diff/tests
  -> concise native callback to Parent
```

## Handoff protocol

Stage a self-contained assignment via stdin:

```bash
printf '%s' 'Refactor src/foo.py and run focused tests.' | \
  python3 "${CODEX_HOME:-$HOME/.codex}/hooks/codex-omp-subagent/omp_bridge.py" --mode stage
```

The bridge returns schema 2 JSON containing a unique `handoff_id` and the resolved `state_root`. Multiple UUID handoffs may coexist.

The native child then executes:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/hooks/codex-omp-subagent/omp_bridge.py" \
  --mode run \
  --handoff-id <UUID>
```

When `OMP_ARGS` is not set, OMP is launched as:

```bash
omp --print --mode json --no-session -- "<assignment>"
```

The `--` separator prevents assignments beginning with `-` from being parsed as CLI options. `OMP_BIN` and `OMP_ARGS` use POSIX shell-word parsing on POSIX and native `CommandLineToArgvW` parsing on Windows, so Windows paths are not corrupted by POSIX backslash semantics.

## Results and logs

Full OMP stdout/stderr are not injected into the Codex child context. The bridge returns a bounded JSON result with status, exit code, structured stop/error information, final summary, usage when available, a bounded stderr tail, and artifact paths.

The parser handles two important OMP JSON-mode cases: a structured assistant `stopReason` of `error` or `aborted` is treated as failure even if the process exits with code 0, and a malformed/truncated terminal record can be ignored when a complete earlier `message_end` already provides the usable final result.

Raw artifacts are stored under the bridge state directory:

```text
<state-root>/
  pending/<uuid>.json
  running/<uuid>.json
  completed/<uuid>.json
  failed/<uuid>.json
  jobs/<uuid>/
    envelope.json
    omp.jsonl
    stderr.log
    result.json
```

### Default state root

The default is the **system temporary directory**, not a home-state directory. Codex's built-in `:workspace` permissions include workspace roots and system temp directories as writable locations, while arbitrary paths such as `~/.local/state` are not guaranteed writable from a workspace-scoped parent or child.

- POSIX: `<system-temp>/codex-omp-subagent-<uid>`
- Windows: `<system-temp>/codex-omp-subagent`

POSIX directories are created with `0700` and job files with `0600`. Set `CODEX_OMP_HANDOFF_DIR` for explicit persistent storage, but that path must itself be writable under the active Codex permission policy.

## Installation

Prerequisites:

1. A recent Codex build with standalone custom subagents / `spawn_agent` and permission profiles.
2. A working OMP installation (`omp --version` or `omp`).
3. The desired provider/model configured inside OMP.

For automatic installation, copy [`prompts/install-with-codex.md`](prompts/install-with-codex.md) into Codex.

V2 installs:

```text
<codex-home>/agents/omp-worker.toml
<codex-home>/skills/use-omp-worker/
<codex-home>/hooks/codex-omp-subagent/omp_bridge.py
```

**V2 does not require a `SubagentStart` Hook.** If V1 was installed, remove the old OMP matcher `^omp_worker$` from the active `hooks.json` so the same job cannot be executed twice.

The worker declares:

```toml
default_permissions = "omp-network-workspace"

[permissions.omp-network-workspace]
extends = ":workspace"
network = { mode = "full", allow_local_binding = false }
```

This allows OMP to modify the active workspace and reach whichever external provider the user configured, without granting writes outside the workspace or allowing local listener binding. Administrator-managed Codex requirements may still narrow these permissions.

## Parent workflow

The parent follows `$use-omp-worker`:

1. Build a self-contained assignment with targets, constraints, and acceptance criteria.
2. Stage it with the bridge.
3. Capture the returned UUID.
4. Spawn `omp_worker` with `fork_turns="none"` and include the UUID in the message.
5. Wait for the native child callback.
6. Review the child's workspace diff and validation evidence before integrating the result.

Recommended spawn message:

```text
Execute staged OMP handoff <UUID>. Inspect and verify the resulting workspace changes, then report a concise result to the parent.
```

## Configuration

- `OMP_BIN`: OMP executable/command prefix, default `omp`
- `OMP_ARGS`: override the default OMP CLI arguments
- `OMP_TIMEOUT`: OMP process timeout in seconds, default 600
- `CODEX_OMP_HANDOFF_DIR`: override the local state directory

The bridge also exposes `--timeout-seconds` and `--ttl-seconds`.

## Concurrency and idempotency

V2 uses one UUID file per handoff instead of a single global pending file, so separate OMP workers can process different jobs concurrently.

Calling `--mode run` again for a completed UUID returns the stored `result.json` instead of launching OMP again.

## Tests

Offline tests do not call a real model provider:

```bash
python -m unittest packages/codex-omp-subagent/tests/test_omp_bridge.py -v
python packages/codex-omp-subagent/tests/test_agent_templates.py
```

Coverage includes multiple pending jobs, real-shape OMP `message_end` parsing, structured provider failure despite exit code 0, truncated terminal-record tolerance, CLI separator behavior, idempotency, invalid UUIDs, the worker permission profile, and Ubuntu/Windows CI on Python 3.11/3.13.

A real end-to-end probe is documented in [`prompts/quick-smoke-test.md`](prompts/quick-smoke-test.md). It may incur charges from the provider configured in OMP.

## Security boundary

V2 does not use `danger-full-access`. The `omp_worker` profile inherits Codex's `:workspace` filesystem boundary and adds only the outbound network access OMP needs, with local binding disabled.

OMP is still a full coding harness and can use tools, run commands, and modify code within the child permissions. Do not send sensitive repository data to an untrusted third-party provider. If organization-level Codex policy blocks network access or custom permission profiles, the smoke test should fail clearly rather than bypass that policy.

This is an independent community integration and is not officially affiliated with or endorsed by OpenAI or OMP.
