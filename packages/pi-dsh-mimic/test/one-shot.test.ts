import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import piDshAnchor, {
  BOOTSTRAP_TOOL_NAMES,
  MINIMAL_BASH_DESCRIPTION,
  MINIMAL_PERSONA,
  STATE_ENTRY_TYPE,
} from "../src/index.js";

type Handler = (event: any, context: ExtensionContext) => unknown | Promise<unknown>;

function createHarness(options?: {
  provider?: string;
  modelId?: string;
  entries?: unknown[];
}) {
  const handlers = new Map<string, Handler[]>();
  const entries = [...(options?.entries ?? [])];
  const registeredTools: any[] = [];
  const initialTools = ["read", "bash", "edit", "write", "plugin_tool"];

  const api = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerTool(tool: unknown) {
      registeredTools.push(tool);
    },
    getActiveTools: () => [...initialTools, ...registeredTools.map((tool) => tool.name)],
    getAllTools: () => [
      ...initialTools.map((name) => ({ name })),
      ...registeredTools,
    ],
    setActiveTools() {
      throw new Error("one-shot anchor must not own Pi's active catalog");
    },
    sendMessage() {
      throw new Error("one-shot anchor must not inject a synthetic message");
    },
    sendUserMessage() {
      throw new Error("the real task must remain Pi's original user message");
    },
  } as unknown as ExtensionAPI;

  const context = {
    model: {
      provider: options?.provider ?? "deepseek",
      id: options?.modelId ?? "deepseek-v4-pro",
    },
    hasUI: true,
    ui: { setStatus() {} },
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;

  piDshAnchor(api);

  async function emit(name: string, event: Record<string, unknown> = { type: name }) {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, context);
      if (next !== undefined) result = next;
    }
    return result;
  }

  return { context, entries, registeredTools, emit };
}

function payload(
  messages?: unknown[],
  toolNames = ["read", "bash", "edit", "write", "plugin_tool", "str_replace_editor"],
) {
  return {
    model: "deepseek-v4-pro",
    messages: messages ?? [
      { role: "system", content: MINIMAL_PERSONA },
      { role: "user", content: [{ type: "text", text: "repair the project" }] },
    ],
    stream: true,
    prompt_cache_key: "pi-native",
    prompt_cache_retention: "24h",
    stream_options: { include_usage: true },
    max_tokens: 256000,
    tools: toolNames.map((name) => ({
      type: "function",
      function: { name, parameters: { type: "object" }, strict: false },
    })),
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  };
}

test("the real task occupies the one-shot Minimal bootstrap request", async () => {
  const harness = createHarness();
  assert.equal(harness.registeredTools.length, 0);

  assert.equal(await harness.emit("input", {
    text: "repair the project",
    images: [],
    source: "interactive",
  }), undefined);
  assert.equal(harness.registeredTools.length, 1);
  assert.equal(harness.registeredTools[0]?.name, "str_replace_editor");
  assert.deepEqual(await harness.emit("before_agent_start", {
    prompt: "repair the project",
    systemPrompt: "full Pi prompt",
  }), { systemPrompt: MINIMAL_PERSONA });

  const first = await harness.emit("before_provider_request", {
    payload: payload([
      { role: "system", content: "late Pi prompt" },
      { role: "user", content: [{ type: "text", text: "repair the project" }] },
    ]),
  }) as any;
  assert.deepEqual(Object.keys(first), [
    "model",
    "messages",
    "stream",
    "stream_options",
    "thinking",
    "reasoning_effort",
    "tools",
    "max_tokens",
  ]);
  assert.equal(first.prompt_cache_key, undefined);
  assert.equal(first.prompt_cache_retention, undefined);
  assert.equal(first.tool_choice, undefined);
  assert.equal(first.messages[0].content, MINIMAL_PERSONA);
  assert.equal(first.messages[1].content, "repair the project");
  assert.deepEqual(first.tools.map((tool: any) => tool.function.name), BOOTSTRAP_TOOL_NAMES);
  assert.equal(first.tools[0].function.description, MINIMAL_BASH_DESCRIPTION);
  assert.deepEqual(first.tools.map((tool: any) => tool.function.strict), [false, false]);
  assert.deepEqual(harness.entries[0], {
    type: "custom",
    customType: STATE_ENTRY_TYPE,
    data: {
      schema: 1,
      route: "deepseek/deepseek-v4-pro",
      stage: "bootstrap",
    },
  });

  await harness.emit("tool_call", { toolName: "bash" });
  const native = payload();
  assert.equal(await harness.emit("before_provider_request", { payload: native }), undefined);
  assert.equal(native.prompt_cache_key, "pi-native");
  assert.equal(native.tools.length, 6);
  assert.equal((harness.entries.at(-1) as any)?.data.stage, "execute");
});

test("OpenCode Go receives the same task-bearing bootstrap", async () => {
  const harness = createHarness({ provider: "opencode-go" });
  await harness.emit("input", { text: "repair the project", source: "interactive" });
  const first = await harness.emit("before_provider_request", { payload: payload() }) as any;
  assert.equal(first.messages[0].content, MINIMAL_PERSONA);
  assert.deepEqual(first.tools.map((tool: any) => tool.function.name), BOOTSTRAP_TOOL_NAMES);
  assert.deepEqual((harness.entries[0] as any)?.data, {
    schema: 1,
    route: "opencode-go/deepseek-v4-pro",
    stage: "bootstrap",
  });
});

test("a successful text response promotes without adding a synthetic turn", async () => {
  const harness = createHarness();
  await harness.emit("input", { text: "answer directly", source: "rpc" });
  await harness.emit("before_provider_request", { payload: payload() });
  await harness.emit("message_end", {
    message: { role: "assistant", stopReason: "stop", content: [] },
  });
  assert.equal((harness.entries.at(-1) as any)?.data.stage, "execute");
});

test("an API error retries the bootstrap instead of consuming it", async () => {
  const harness = createHarness();
  await harness.emit("input", { text: "task", source: "interactive" });
  await harness.emit("before_provider_request", { payload: payload() });
  await harness.emit("message_end", {
    message: { role: "assistant", stopReason: "error", content: [] },
  });
  const retry = await harness.emit("before_provider_request", { payload: payload() }) as any;
  assert.deepEqual(retry.tools.map((tool: any) => tool.function.name), BOOTSTRAP_TOOL_NAMES);
  assert.equal((harness.entries.at(-1) as any)?.data.stage, "bootstrap");
});

test("native image blocks stay in the original first task", async () => {
  const harness = createHarness();
  const image = { type: "image", data: "base64-image", mimeType: "image/png" };
  await harness.emit("input", {
    text: "inspect this image",
    images: [image],
    source: "rpc",
  });
  const first = await harness.emit("before_provider_request", {
    payload: payload([
      { role: "system", content: MINIMAL_PERSONA },
      {
        role: "user",
        content: [{ type: "text", text: "inspect this image" }, image],
      },
    ]),
  }) as any;
  assert.deepEqual(first.messages[1].content, [
    { type: "text", text: "inspect this image" },
    image,
  ]);
});

test("an execute-phase resume keeps the native Pi payload", async () => {
  const harness = createHarness({
    entries: [
      {
        type: "custom",
        customType: STATE_ENTRY_TYPE,
        data: {
          schema: 1,
          route: "deepseek/deepseek-v4-pro",
          stage: "execute",
        },
      },
      { type: "message", message: { role: "user", content: [] } },
    ],
  });
  await harness.emit("session_start");
  assert.deepEqual(await harness.emit("before_agent_start", {
    prompt: "continue",
    systemPrompt: "Pi prompt",
  }), { systemPrompt: MINIMAL_PERSONA });
  const native = payload();
  assert.equal(await harness.emit("before_provider_request", { payload: native }), undefined);
  assert.equal(native.tools.length, 6);
});

test("a crash-stale bootstrap state infers promotion from durable history", async () => {
  const harness = createHarness({
    entries: [
      {
        type: "custom",
        customType: STATE_ENTRY_TYPE,
        data: {
          schema: 1,
          route: "deepseek/deepseek-v4-pro",
          stage: "bootstrap",
        },
      },
      {
        type: "message",
        message: { role: "assistant", stopReason: "stop", content: [] },
      },
    ],
  });
  await harness.emit("session_start");
  assert.equal(await harness.emit("before_provider_request", { payload: payload() }), undefined);
  assert.equal(harness.registeredTools.length, 1);
});

test("switching to V4 Pro inside an existing conversation does not forge a bootstrap", async () => {
  const harness = createHarness({
    entries: [{ type: "message", message: { role: "user", content: [] } }],
  });
  assert.equal(await harness.emit("input", {
    text: "new request",
    source: "interactive",
  }), undefined);
  assert.equal(await harness.emit("before_agent_start", {
    prompt: "new request",
    systemPrompt: "Pi prompt",
  }), undefined);
  assert.equal(await harness.emit("before_provider_request", { payload: payload() }), undefined);
  assert.equal(harness.registeredTools.length, 0);
});

test("non-target providers and models remain byte-for-byte untouched", async () => {
  for (const [provider, modelId] of [
    ["openrouter", "deepseek-v4-pro"],
    ["deepseek", "deepseek-v4-flash"],
  ]) {
    const harness = createHarness({ provider, modelId });
    assert.equal(await harness.emit("input", { text: "task", source: "interactive" }), undefined);
    assert.equal(await harness.emit("before_agent_start", {
      prompt: "task",
      systemPrompt: "Pi prompt",
    }), undefined);
    const original = payload(undefined, ["read", "bash", "edit", "write", "plugin_tool"]);
    assert.equal(await harness.emit("before_provider_request", { payload: original }), undefined);
    assert.equal(harness.registeredTools.length, 0);
  }
});
