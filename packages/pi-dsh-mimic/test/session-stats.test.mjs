import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeSession } from "../scripts/session-stats.mjs";

test("session stats aggregate reasoning, phrases, tools, and stop reasons", () => {
  const serialized = [
    { type: "message", message: { role: "user", content: [] } },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "We need inspect. let me check. Let me continue." },
          { type: "toolCall", name: "bash" },
        ],
      },
    },
    {
      type: "message",
      message: { role: "assistant", stopReason: "error", content: [] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "we need finish." }],
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n");

  assert.deepEqual(summarizeSession(serialized, "fixture.jsonl"), {
    file: "fixture.jsonl",
    assistantMessages: 3,
    successfulAssistantResponses: 2,
    reasoningBlocks: 2,
    phrases: {
      exact: { "We need": 1, "Let me": 1 },
      normalized: { "we need": 2, "let me": 2 },
    },
    toolCalls: 1,
    tools: { bash: 1 },
    stopReasons: { error: 1, stop: 1, toolUse: 1 },
    lastSerializedAssistantStopReason: "stop",
  });
});
