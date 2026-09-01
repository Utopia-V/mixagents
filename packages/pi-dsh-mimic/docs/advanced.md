[简体中文](advanced.zh-CN.md) · [Back to the user guide](../README.md) · [Complete evidence ledger (Chinese canonical)](project2-evidence.md)

# Start V4 Pro with DSH Minimal, then return to Pi

`pi-dsh-mimic` reproduces only the most useful part of DSH: the first model
request. The real task enters a Minimal-persona environment with
`bash/str_replace_editor`, establishing a verified high-capability V4 Pro
trajectory. After the first valid response, requests return to Pi-native form
and the model regains Pi's complete tool catalog and other plugins.

There is no need to reproduce the complete DSH harness. DSH Minimal supplies
the first-request training interface; Pi continues to own sessions, tool
execution, file editing, and plugin composition. The result combines the
96–98 Project2 band observed in these experiments with Pi's mature agent
runtime.

## Experimental basis

Project2 V4.1b is a personal, self-hosted long-horizon repository-maintenance
evaluation. The model repairs a deliberately broken multi-module Python backend
and ESP32-S3 firmware project covering authentication and session privacy,
database migrations, cross-module features, backward compatibility,
Wi-Fi/MQTT/NVS/protocol and ESP-IDF contracts, and final delivery evidence. It
is not a general benchmark.

Local runs use this Project2 V4.1b task at frozen commit
`04255b55f16c4439e538239fb9783070c4165081`. When a run resumed after an
interruption, only its final submission score entered the comparison. A wrong
project root, a zero-token configuration failure, and duplicate evaluation do
not count as new samples.

`We need`, `Let me`, and reasoning-block counts identify trajectory changes.
Final judgment comes from the F3 ambient-session boundary, F6 migration, F8 ESP
contract, hidden tests, and complete delivery. Evaluator IDs and exclusions are
recorded in the [evidence ledger](project2-evidence.md).

## DSH Minimal established that the capability is reachable

External results provided a clear calibration. Under the same WSL/max/build
conditions, DSH Minimal scored 99 and 96, while Standard scored 91 and PTC
scored 92. Later Anchored Standard runs restored a 25-tool catalog after the
first tool call and scored 98 and 99.

These results establish two facts: the first request's persona and schemas can
change V4 Pro's engineering trajectory, and a complete tool catalog does not
automatically break the trajectory after it has formed. `pi-dsh-mimic` brings
both properties into Pi.

## The decisive Pi comparison

A matched local pair narrowed the main difference to the first request:

| Run | First request and later execution | Score | Key result |
| --- | --- | ---: | --- |
| Default Pi baseline | Full Pi prompt and five tools; native throughout | 92 | F3 11, F6 10, F8 6 |
| Early Minimal-mimic prototype | Real task in a Minimal two-tool request; Pi-native after the first tool call; no Pi-context replay | **98** | F3 16, F6 10, F8 7, hidden 44/45 |

Around assistant response 107, the 98-point trajectory reversed its earlier
ambient fallback. Sensitive context had to carry an explicit `session_id`, and
the voice path first resolved the current session before passing it onward.
That self-correction directly explains F3 16/16 and is more meaningful than a
first-line phrase.

## Negative results narrowed the implementation

Later runs tested the remaining explanations directly:

| Question | Experiment | Result | Implementation choice |
| --- | --- | ---: | --- |
| Is an identity warm-up required? | Zero-tool Whoami | 93 | Put the real task in request #1 |
| Is tool scarcity sufficient? | Pi-native `bash/read` | 93 | Use the DSH Minimal schemas |
| Should the model be forced to emit the fingerprint first? | Wire Think | 94; F3 16, F6 6 | Do not inject or optimize for `We need` |
| Should DSH wire normalization persist? | Persistent DSH wire | 94; F3 11 | Return to Pi-native requests after the first valid response |
| Should Pi system context be replayed after promotion? | Full context replay | 90; F6 8 | Keep the Minimal persona without replaying full Pi context |
| Is an approximate Minimal surface sufficient? | Approximate Minimal → Pi-native | 93; first line returned to `Let me` | Use the observed 98-point first request as the implementation baseline |

A same-flow replication scored 96 with F3 still at 16/16. Most of its variation
was in ESP static completeness.

## From experimental prototype to current implementation

The same request flow then reached complete Project2 endpoints in two clean
implementations:

| Implementation | Provider | Score | F3 | F6 | F8 |
| --- | --- | ---: | ---: | ---: | ---: |
| First packaged implementation | Official DeepSeek API | 96 | 16 | 8 | 7 |
| Current independent implementation | OpenCode Go | **98** | 16 | 10 | 7 |

The initial OpenCode Go request hit an account opt-in 403 before producing a
token. The same session resumed after opt-in, stopped naturally, and scored 98.
The run verifies that the current implementation reaches the same high band
through OpenCode Go.

Both the official DeepSeek API and OpenCode Go reached 96–98. A weaker OpenCode
model is no longer needed to explain the observed gap.

## Why Pi plugins remain available

| | Bootstrap request | Execution requests |
| --- | --- | --- |
| System persona | `You are a helpful software engineer assistant.` | unchanged |
| User history | Original task, including Pi-native image blocks | unchanged |
| Provider-visible tools | `bash`, `str_replace_editor` | Pi's complete current catalog, including plugin tools |
| Provider payload | DSH Minimal shape; Pi cache fields removed | Pi-native encoding and ordering; cache follows provider configuration |

The extension never calls `setActiveTools` and never overrides Pi's `bash`,
`read`, `edit`, or `write`. It registers one executable `str_replace_editor`
only when a fresh target session arms. From request #2, Pi again owns the
provider payload and active catalog, so tools from other packages appear
naturally.

That is the boundary between a mimic and a complete harness port: the extension
establishes a DSH Minimal first request, while Pi remains the execution runtime.

## Product behavior and evidence

| Current behavior | Main evidence |
| --- | --- |
| Arm only fresh sessions whose model id contains `deepseek-v4-pro` | Provider names do not gate activation; an existing conversation cannot reproduce a real bootstrap; isolation tests cover target and non-target models |
| Put the original task in request #1 | Early prototype 98; Whoami 93 |
| Use the Minimal persona and DSH schemas in request #1 | Pi-native `bash/read` 93; approximate Minimal 93 |
| Return to Pi-native execution after the first valid response | One-shot 96–98; persistent DSH wire 94 |
| Keep the Minimal persona without replaying full Pi system context | Context replay 90 |
| Retry bootstrap after provider error or abort | Error-retry, durable-stage, and crash-stale recovery tests |

## Trajectory and tool scale

With case-insensitive matching, the default baseline contained 156 occurrences
of `let me` across 78 reasoning blocks, while the 98-point prototype contained
one across 135 blocks. Exact case-sensitive counts are 115 and one. This quickly
shows whether the first request changed the model's reasoning habit.

The [evidence ledger](project2-evidence.md) now records assistant, reasoning,
`We need / Let me`, tool-call, tool-name, and stopReason aggregates for all 11
runs. Tool volume alone does not determine ability: persistent DSH wire made
225 tool calls and scored 94, while the early prototype made 148 and scored 98.
The current implementation used `bash/read/edit/write` 193 times and scored 98.

The persistent-wire run also contained very few `Let me` occurrences, and Wire
Think began with `We need` but scored 94. The extension observes these phrases
without injecting them into the prompt.

## Implementation verification

TypeScript typechecking and all 14 automated tests pass. Thirteen cover both
qualified providers, namespaced model ids on third-party providers, images,
error retry, text promotion, session resume, crash-stale recovery,
existing-conversation isolation, and non-target model isolation; one verifies
the session-statistics helper. Editor tests cover create, view, unique
replacement, insertion, relative-path rejection, and ambiguous-replacement
rejection.

OpenCode Go bash-first and editor-first offline loopbacks capture two requests
through Pi's real package loader and provider path with `realModelCalls=0`.
Request #2 restores `read/bash/edit/write/str_replace_editor` and carries a real
tool result. After normalizing the user task, the new request #1 matches the
historical 98-point capture in messages, key order, schemas, `strict:false`, and
serialized structure.

## Score details and reopening criteria

The 98-point prototype and the verifiable DSH Minimal 99 both passed hidden
44/45 and F3 16/16, missing the same one-point F12 rejection-reason string. The
prototype's remaining loss is a grader function-name mismatch even though the
implementation checks Wi-Fi, UID, room, and bed. The published score remains
the evaluator's original score.

The current request flow has four Project2 results in the 96–98 band. A new
task, model or service version, material provider-payload change, or new complete
task result would justify another paid run.

## Sources and attribution

The Minimal persona, bash description, editor description, and function schemas
come from DeepSeek Harness's
[public Minimal protocol](https://github.com/deepseek-ai/deepseek-harness). The
exact commit and license notices are in [LICENSE](../LICENSE) and
[NOTICE](../NOTICE). External Project2 calibration comes from
[`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) and
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard).

The current source was implemented from the DeepSeek Harness Minimal protocol,
request captures made by this project, and this project's experiments. It did
not reference or port source from
[`kxh4892636/pi-deepseek-anchor`](https://github.com/kxh4892636/pi-deepseek-anchor).
An early exploration loaded that extension to test the two-stage path in Pi, so
the evidence ledger retains that run provenance. The current implementation,
automated tests, offline loopbacks, and Project2 scores are produced by this
project.
