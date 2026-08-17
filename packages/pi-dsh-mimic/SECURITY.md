# Security

## API keys

`pi-dsh-mimic` does not read, save, log, or transmit API keys. Provider
credentials remain under Pi and the selected provider's configuration. Never
put a DeepSeek or OpenCode key in a prompt, repository file, issue, screenshot,
or captured request.

If a credential has been exposed, revoke or rotate it with the provider before
continuing.

## Provider data boundary

For target sessions, the task, conversation messages, tool schemas, and later
tool results are sent through either `deepseek/deepseek-v4-pro` or
`opencode-go/deepseek-v4-pro`. The extension changes the first request's
persona and tool surface, but it is not an API proxy and does not create a
confidential channel.

The package adds no model round. The user's ordinary first task is the
bootstrap request and is billed normally by the selected provider.

## Filesystem and tool ownership

The extension runs with the Pi process's filesystem permissions. Its
`str_replace_editor` can view, create, and modify files. Review the package
before installation and apply the same workspace and permission controls used
for any other Pi extension.

The package does not call `setActiveTools` and does not override Pi's native
`bash`, `read`, `edit`, or `write`. Another extension that registers the same
`str_replace_editor` name creates a real ownership conflict and should not be
combined without review.

## Reports

Security reports and redacted repository issues should follow the root
[security guidance](../../SECURITY.md). Do not submit full provider payloads
until task content, headers, credentials, and unrelated source have been
removed.
