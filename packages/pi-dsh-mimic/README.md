[Repository index](../../README.en.md) · [简体中文](README.zh-CN.md) · [Experiments and design](docs/advanced.md) · [Project2 evidence ledger (Chinese canonical)](docs/project2-evidence.md)

# pi-dsh-mimic

`pi-dsh-mimic` reproduces the DeepSeek Harness Minimal environment for the
first model request in [Pi](https://github.com/earendil-works/pi). DeepSeek V4
Pro begins from a verified high-capability trajectory; after the first valid
response, execution returns immediately to Pi with its complete tool catalog
and the user's other plugins.

One session gets both:

- the V4 Pro engineering trajectory established by a DSH Minimal first request;
- Pi's mature tools, session management, and plugin ecosystem.

Users do not need to install or run the complete DSH harness, and the session
does not remain restricted to Minimal's two tools.

## How it works

For a fresh target session, the real task itself becomes the first model
request:

1. request #1 uses the Minimal persona and exposes only DSH-style `bash` and
   `str_replace_editor`;
2. after the first successful assistant response or durable tool call, request
   #2 restores Pi's native provider payload and complete current tool catalog;
3. the Minimal persona remains for the session, while Pi's larger generated
   system prompt is not replayed as an extra user message.

The extension adds no identity warm-up or model round, makes no hidden copy of
the task, does not inject `We need`, and does not proxy the API.

## Project2 results

Project2 V4.1b is a personal, self-hosted long-horizon repository-maintenance
evaluation. The model repairs a multi-module Python backend and ESP32-S3
firmware project covering authentication and session privacy, database
migrations, cross-module features, backward compatibility,
Wi-Fi/MQTT/NVS/protocol and ESP-IDF contracts, and delivery evidence. It is not
a general benchmark; these scores compare engineering completion on one frozen
task.

Default Pi scored 92. Four final runs of the same one-shot request flow scored
**98, 96, 96, and 98**, all with F3 at 16/16:

| Run | Provider | Score | Key dimensions |
| --- | --- | ---: | --- |
| Default Pi baseline | Official DeepSeek API | 92 | F3 11, F6 10, F8 6 |
| Early Minimal-mimic prototype | Official DeepSeek API | **98** | F3 16, F6 10, F8 7 |
| Same-flow replication | Official DeepSeek API | 96 | F3 16, F6 10, F8 5 |
| First packaged implementation | Official DeepSeek API | 96 | F3 16, F6 8, F8 7 |
| Current independent implementation | OpenCode Go | **98** | F3 16, F6 10, F8 7 |

The results show that a DSH Minimal first request can establish a strong V4 Pro
trajectory inside Pi and that restoring Pi's full tool catalog does not break
it. See [Experiments and design](docs/advanced.md) for the rejected alternatives
and the evidence behind each implementation choice. The
[Project2 evidence ledger](docs/project2-evidence.md), maintained in Chinese,
contains evaluator IDs and sources.

## Install and use

Requirements: Node.js 22.19 or later, Pi 0.84.2 or later, and either official
DeepSeek API or OpenCode Go configuration. Pi 0.84.2 includes both provider
routes.

Install from npm for the current user:

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

For OpenCode Go, configure Pi's expected `OPENCODE_API_KEY` environment variable
and select the `opencode-go` provider. The package is published to npm with the
`pi-package` keyword required by the
[Pi Package Catalog](https://pi.dev/packages).

Select V4 Pro before starting a new session. Switching to V4 Pro inside an
existing conversation does not forge a new bootstrap.

## Request lifecycle

| | Bootstrap request | Execution requests |
| --- | --- | --- |
| System persona | `You are a helpful software engineer assistant.` | unchanged |
| User history | Original task, including Pi-native images | unchanged |
| Provider-visible tools | `bash`, `str_replace_editor` | Pi's complete current catalog, including plugin tools |
| Provider payload | DSH Minimal shape; Pi cache fields omitted | Pi-native encoding and ordering; cache follows provider configuration |

The extension never calls `setActiveTools` and never overrides Pi's native
`bash`, `read`, `edit`, or `write`. It registers one executable
`str_replace_editor` only when a fresh target session arms. From request #2,
tools contributed by other packages appear in the complete catalog.

Provider errors and aborted responses do not consume the bootstrap. A small Pi
custom entry persists the phase, and durable assistant/tool history repairs a
crash-stale state on resume.

## Offline verification

TypeScript typechecking and all 13 automated tests pass. Twelve cover package
behavior and its manifest; one verifies the session-statistics helper. Package
behavior coverage includes:

- original task, persona, field order, cache omission, and two-tool schemas in
  request #1;
- Pi-native payload, complete catalog, and plugin-tool restoration in request
  #2;
- images, API-error retry, text promotion, session resume, and crash-stale
  recovery;
- existing-conversation isolation, both providers, and non-target models;
- editor create, view, replace, insert, and ambiguous-replacement rejection.

OpenCode Go bash-first and editor-first offline loopbacks also pass through Pi's
real package loader and provider path with `realModelCalls=0`. Request #2 carries
a real tool result and restores `read/bash/edit/write/str_replace_editor`. After
normalizing the user task, the new request #1 matches the historical 98-point
capture in messages, key order, schemas, `strict:false`, and serialized
structure.

## Development

```bash
cd packages/pi-dsh-mimic
npm install
npm run check
npm run pack:check
```

## Security, cost, and sources

This package runs with the Pi process's filesystem permissions;
`str_replace_editor` can create and modify files. The task, context, and tool
results are sent to the selected DeepSeek or OpenCode provider. The package
does not read, store, log, or transmit API keys and adds no model round. See
[SECURITY.md](SECURITY.md).

The Minimal persona and two tool-protocol texts come from DeepSeek Harness's
[public Minimal protocol](https://github.com/deepseek-ai/deepseek-harness). See
[LICENSE](LICENSE) and [NOTICE](NOTICE). The current implementation is based on
that public protocol, request captures made by this project, and the Project2
experiments. It is not affiliated with or endorsed by Pi, DeepSeek, OpenCode,
or OpenAI.
