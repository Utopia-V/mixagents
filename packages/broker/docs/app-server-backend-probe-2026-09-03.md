# Codex App Server backend probe — 2026-09-03

> Status: decision evidence for Broker maintainers, not an accepted architecture
> or a compatibility promise. The later implementation was rechecked against
> the same local App Server build; re-run or retire this record when Broker
> changes its minimum Codex version.

## Question

Can Broker reuse Codex App Server as a provider-neutral worker runtime instead
of implementing its own Agent harness, while retaining truthful provider
routing, concurrency, status, interruption, failure, result, and recovery
semantics?

## Scope and method

The probe ran on Ubuntu 24.04 x64 with the Codex Desktop bundled runtime
`codex-cli 0.151.0-alpha.7.2`. It generated that binary's experimental App
Server JSON schemas, then drove `codex app-server --stdio` through JSONL.

Two paths on one local HTTP server acted as independent Responses providers. Each
route had a distinct provider id, model name, base URL, and dummy environment
credential. The servers returned deterministic SSE events for success, delay,
and failure. No external model, credential, private data, or paid endpoint was
used. Temporary schemas, sessions, and probe code were kept outside the
repository.

The probe covered two different composition paths:

1. a native Codex parent spawning a custom agent role configured for another
   provider;
2. an external controller creating ordinary App Server threads with an
   explicit session-level `modelProvider`.

## Observations

| Scenario | Observed result | Meaning for Broker |
| --- | --- | --- |
| Native custom role | The role declared provider `mock_b`, but the child thread and HTTP request used parent provider `mock_a`; the native parent/child activity link remained present | Current native subagents retain Codex lifecycle integration but cannot supply cross-provider routing |
| Explicit App Server providers | Turns on threads created for `mock_a` and `mock_b` reached `/a/v1/responses` and `/b/v1/responses`; each request used only the credential configured for its actual route | App Server can route independent worker threads across configured providers without changing an outside controller |
| Unknown provider | `thread/start` failed before any HTTP request with `Model provider \`missing_provider\` not found` | Provider discovery can fail closed without a fallback request |
| Provider failure | A `response.failed` event produced terminal turn status `failed` with an error | Broker can preserve an explicit provider failure rather than translating it into completion |
| Parallel workers | Both mock providers were active concurrently and returned distinct results | One App Server process can run independent provider threads concurrently |
| Local interruption | `turn/interrupt` returned after terminal turn status became `interrupted` | App Server owns a reliable local turn-interruption signal |
| Provider work after interruption | At the moment interruption was acknowledged, the mock provider request was still active; the stream stayed connected and ran to its normal completion | `interrupted` does not prove provider-side cancellation or stopped billing; Broker needs a separate remote-cancellation state if a provider can confirm one |
| Durable recovery | A durable `mock_b` thread retained `modelProvider = mock_b` across App Server restart; `thread/resume` sent the next turn back to `/b/v1/responses` | App Server can own worker conversation persistence and provider restoration |

The current App Server subscription did not emit `thread/started` for the
native child. It did emit `subAgentActivity` with the child thread id, and
`thread/read` returned the child's effective provider. This is sufficient for
diagnosis but should not be generalized to other versions or client
subscriptions without another check.

## Live OpenCode Go check

A later user-authorized smoke test exercised one real provider route on the
same Codex `0.151.0-alpha.7.2` build. The credential was supplied only through
an ephemeral process environment and was neither printed nor written to the
repository or Broker state. Both requests used synthetic exact-output prompts
and an empty temporary workspace.

1. A direct request to OpenCode Go's documented
   `https://opencode.ai/zen/go/v1/chat/completions` endpoint selected
   `deepseek-v4-flash`, returned HTTP 200 and the requested marker, and reported
   92 prompt plus 24 completion tokens.
2. Broker selected `provider = opencode_go`, `model = deepseek-v4-flash`, and
   `backend = app_server`. Its App Server turn completed and returned the
   requested marker through the Responses wire path.
3. A second Broker turn required exactly one harmless shell command that
   printed a synthetic marker. The Agent completed with that stdout, and the
   persisted App Server history independently contained one `exec_command`
   call plus one matching function-call output. The command ran inside the
   read-only sandbox without an approval prompt.

The second result establishes observed Responses compatibility for this
OpenCode Go model and tested build even though OpenCode's public endpoint table
lists DeepSeek V4 Flash under Chat Completions. It is provider-specific runtime
evidence, not an OpenCode compatibility promise. No follow-up, write-access,
cancellation, or other OpenCode model was exercised; tool coverage is limited
to the single stdout-only shell call described above.

## Disposition

The accepted [backend and lifecycle policy](backend-and-lifecycle-policy.md)
prefers a qualified native Codex child and uses App Server as the current
fallback worker runtime. App Server already owns the model loop, tool
execution, thread and turn identity, streamed results, local interruption,
persisted history, and provider-specific authentication. A Broker frontend can
therefore focus on cross-provider route selection and mapping managed Agents
onto App Server threads and turns.

The later accepted [controller contract](controller-contract.md) places that
fallback behind a local STDIO MCP server while the routing Skill continues to
use native collaboration tools directly when they qualify. The implemented
adapter was subsequently exercised end to end against this Codex build and a
loopback Responses provider: MCP creation produced an App Server thread on the
configured provider/model and returned its final assistant text. A second
offline composition check installed the built plugin into an isolated local
marketplace, had an outer Codex App Server invoke its MCP tools, started a
Broker-managed fake worker App Server, and relayed one command approval back
through the outer host. No real provider or credential was used.

This does not make App Server workers native children of the controller.
Broker exposes a truthful `app_server` identity and native-sized turn outcomes:
running, completed with final text, failed with an error, or locally
interrupted. The public contract states that interruption may leave provider
compute and billing active instead of adding a second provider-cancellation
state machine.

The implemented Codex plugin now uses MCP as its controller-facing transport.
It chooses a clean App Server runtime per route and access class, passes only
that route's credential variables, and filters them from worker shell commands.

The native backend remains worth revisiting if Codex accepts a trusted
per-subagent provider allowlist. Until then, repackaging the old Hook cannot
restore provider selection, and implementing a separate model/tool loop would
duplicate lifecycle behavior that App Server already provides.

## Sources

- [OpenAI Docs: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Docs: Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- [Provider inheritance change](https://github.com/openai/codex/pull/39299)
- [Upstream cross-provider tracking issue](https://github.com/openai/codex/issues/40858)
