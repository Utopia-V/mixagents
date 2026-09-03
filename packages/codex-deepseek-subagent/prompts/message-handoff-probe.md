# Historical V2 message-only handoff probe

This diagnostic applies only to compatible Codex `0.148.x` and older builds.
Codex `0.149.0` and later inherit the parent provider before this transport can
be tested; use [MixAgents Broker](../../broker/README.md) for current
cross-provider work.

The probe bypasses the repository's legacy Hook and tests whether a task carried
only by a Multi-agent V2 collaboration message reaches the DeepSeek-backed child.

Run it only while diagnosing a Codex transport change. Do not use it as the
installation smoke test, an ordinary-delegation preflight, or a reason to vary
routing on every child call.

```text
Check the active Codex version. If it is `0.149.0` or later, or cannot be
established, stop without spawning a child or calling a provider.

Use Codex's native subagent mechanism to spawn the custom agent whose exact
agent type is v4_flash_worker.

Set fork_turns to "none". Do not stage a Hook handoff. Give the child only this
spawn message:

  Return exactly: V4_FLASH_RAW_V2_MESSAGE_OK_8F31C2

Do not place that token in a file, Hook context, inherited turn, follow-up user
message, direct API request, another CLI process, or another application. Do
not retry through a different transport if the child reports that no task was
received.

After the child finishes, report whether it returned the exact token. A missing
assignment is the expected failure signature on affected builds. It does not
mean custom-agent discovery, DeepSeek authentication, native child execution,
the one-shot Hook, or callback delivery is broken.
```

On affected Multi-agent V2 builds, the OpenAI parent emits an encrypted
collaboration argument. Codex then creates the correctly configured external-
provider child, but the child receives an empty visible `Payload:` plus opaque
encrypted content that DeepSeek cannot interpret. The merged plaintext work in
[openai/codex#35845](https://github.com/openai/codex/pull/35845) handles calls
that already carry the explicit plaintext marker; it does not repair the real
OpenAI-parent path when the model has already produced ciphertext. See
[openai/codex#36376](https://github.com/openai/codex/issues/36376) and
[openai/codex#34833](https://github.com/openai/codex/issues/34833).

The legacy runtime smoke test uses a trusted `SubagentStart` Hook to add the
assignment as ordinary developer context and spawns with `fork_turns="none"`.
