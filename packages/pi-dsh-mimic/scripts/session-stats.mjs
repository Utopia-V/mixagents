#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function increment(counter, key) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function orderedCounts(counter) {
  return Object.fromEntries(
    [...counter.entries()].sort(([leftName, leftCount], [rightName, rightCount]) =>
      rightCount - leftCount || leftName.localeCompare(rightName)),
  );
}

export function summarizeSession(serialized, label = "session.jsonl") {
  const stopReasons = new Map();
  const tools = new Map();
  let assistantMessages = 0;
  let successfulAssistantResponses = 0;
  let reasoningBlocks = 0;
  let exactWeNeed = 0;
  let exactLetMe = 0;
  let normalizedWeNeed = 0;
  let normalizedLetMe = 0;
  let toolCalls = 0;
  let lastSerializedAssistantStopReason = null;

  const lines = serialized.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`${label}:${index + 1}: invalid JSON: ${error.message}`);
    }

    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const message = entry.message;
    assistantMessages += 1;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "unknown";
    increment(stopReasons, stopReason);
    lastSerializedAssistantStopReason = stopReason;
    if (stopReason === "toolUse" || stopReason === "stop") {
      successfulAssistantResponses += 1;
    }

    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "thinking") {
        reasoningBlocks += 1;
        const reasoning = typeof block.thinking === "string"
          ? block.thinking
          : typeof block.text === "string"
            ? block.text
            : "";
        exactWeNeed += countOccurrences(reasoning, "We need");
        exactLetMe += countOccurrences(reasoning, "Let me");
        const normalized = reasoning.toLowerCase();
        normalizedWeNeed += countOccurrences(normalized, "we need");
        normalizedLetMe += countOccurrences(normalized, "let me");
      }

      if (block?.type === "toolCall") {
        toolCalls += 1;
        increment(tools, typeof block.name === "string" ? block.name : "unknown");
      }
    }
  }

  return {
    file: label,
    assistantMessages,
    successfulAssistantResponses,
    reasoningBlocks,
    phrases: {
      exact: { "We need": exactWeNeed, "Let me": exactLetMe },
      normalized: { "we need": normalizedWeNeed, "let me": normalizedLetMe },
    },
    toolCalls,
    tools: orderedCounts(tools),
    stopReasons: orderedCounts(stopReasons),
    lastSerializedAssistantStopReason,
  };
}

function main(paths) {
  if (paths.length === 0) {
    process.stderr.write("Usage: node scripts/session-stats.mjs <pi-session.jsonl> [...]\n");
    process.exitCode = 2;
    return;
  }

  const summaries = paths.map((path) =>
    summarizeSession(readFileSync(path, "utf8"), basename(path)));
  process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
