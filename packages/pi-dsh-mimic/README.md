[Repository index](../../README.en.md) · [简体中文](README.zh-CN.md) ·
[Experiments and design](docs/advanced.md) ·
[Project2 evidence ledger](docs/project2-evidence.md)

# pi-dsh-mimic

`pi-dsh-mimic` changes only the first DeepSeek V4 Pro request in
[Pi](https://github.com/earendil-works/pi). The real task begins with the DSH
Minimal persona and its `bash` and `str_replace_editor` tools. After the first
valid response, later requests return to Pi-native formatting and the complete
tool catalog.

It does not require the full DSH harness and adds no extra model round.

## How it works

1. In a fresh target session, the original task becomes the Minimal request.
2. The first successful assistant response or actual tool call ends bootstrap.
3. Later requests keep the Minimal persona while Pi again owns payload encoding,
   tool ordering, and plugin tools.

Provider errors and aborted responses do not consume bootstrap. A small Pi
custom entry persists the phase across resume. If the process crashes after a
completed response but before the phase is recorded, durable assistant/tool
history repairs the state on reload.

## Experimental result

On one frozen Project2 V4.1b long-horizon maintenance task, default Pi scored
92. Four final runs of the same one-shot flow scored 98, 96, 96, and 98. This
comparison supports the current first-request design; it does not establish a
general result across projects, model revisions, or evaluations.

See [Experiments and design](docs/advanced.md) for conditions, negative results,
and implementation choices. The [Project2 evidence ledger](docs/project2-evidence.md)
contains the complete runs and evaluator sources.

## Install and use

Requirements: Node.js 22.19 or later, Pi 0.84.2 or later, and either the official
DeepSeek API or OpenCode Go configured in Pi.

Install for the current user:

```bash
pi install npm:pi-dsh-mimic
```

Install at project scope:

```bash
pi install -l npm:pi-dsh-mimic
```

Try the current checkout directly:

```bash
pi -e ./packages/pi-dsh-mimic \
  --provider deepseek \
  --model deepseek-v4-pro
```

For OpenCode Go, set Pi's expected `OPENCODE_API_KEY` environment variable and
select the `opencode-go` provider.

Select V4 Pro before starting a new session. Switching to V4 Pro inside an
existing conversation does not create a synthetic bootstrap. The extension
registers `str_replace_editor` in a target session; if that same session later
switches to another model, the tool may remain in the current catalog. Start a
new session when a clean non-target tool catalog matters.

## Request changes

| | First request | Later requests |
| --- | --- | --- |
| Persona | `You are a helpful software engineer assistant.` | unchanged |
| User history | Original task, including Pi images | unchanged |
| Tools | `bash`, `str_replace_editor` | Pi's current full catalog, including plugin tools |
| Payload | DSH Minimal shape | Pi-native encoding and ordering |

`str_replace_editor` can view, create, and modify absolute paths with the Pi
process's filesystem permissions. The task, context, and tool results are sent
to the selected DeepSeek or OpenCode provider. The extension does not read or
store API keys. See [SECURITY.md](SECURITY.md) for the full boundary.

## Development

```bash
cd packages/pi-dsh-mimic
npm install
npm run check
npm run pack:check
```

The Minimal persona and two tool protocols come from DeepSeek Harness's
[public Minimal protocol](https://github.com/deepseek-ai/deepseek-harness). See
[LICENSE](LICENSE) and [NOTICE](NOTICE). This project is not affiliated with or
endorsed by Pi, DeepSeek, OpenCode, or OpenAI.
