# Security

## API keys

`pi-dsh-mimic` does not read, save, log, or transmit API keys. Provider
credentials stay in Pi's provider configuration.

## Data sent to the provider

For target sessions, the task, conversation messages, tool schemas, and later
tool results are sent through the provider selected in Pi. A model id containing
`deepseek-v4-pro` activates the extension regardless of provider name, so any
provider serving such a model receives this data; the tested routes are
`deepseek/deepseek-v4-pro` and `opencode-go/deepseek-v4-pro`. The extension
changes the first request's persona and tool surface; it is not an API proxy,
and requests go to the provider through Pi as usual.

The package adds no model round. The user's ordinary first task is the
bootstrap request and is billed normally by the selected provider.

## Files and tools

The extension runs with the Pi process's filesystem permissions. Its
`str_replace_editor` can view, create, and modify files.

The package does not call `setActiveTools` and does not override Pi's native
`bash`, `read`, `edit`, or `write`. If another extension also registers a tool
named `str_replace_editor`, the two conflict; do not load both.

## Reports

Report problems as described in the root [SECURITY.md](../../SECURITY.md). If
you attach a captured provider payload, remove credentials, headers, task
content you cannot share, and unrelated source first.
