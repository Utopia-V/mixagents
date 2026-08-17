import {
  BOOTSTRAP_TOOL_NAMES,
  EDITOR_DESCRIPTION,
  MINIMAL_BASH_DESCRIPTION,
  MINIMAL_PERSONA,
} from "./constants.js";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodeMinimalMessage(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  if (value.role === "system" || value.role === "developer") {
    return { ...value, content: MINIMAL_PERSONA };
  }
  if (!Array.isArray(value.content)) return value;

  const textOnly = value.content.every((part) => isJsonObject(part)
    && part.type === "text"
    && typeof part.text === "string");
  if (!textOnly) return value;
  return {
    ...value,
    content: value.content.map((part) => String((part as JsonObject).text)).join(""),
  };
}

function minimalToolSchemas(): unknown[] {
  const bash = {
    type: "function",
    function: {
      name: BOOTSTRAP_TOOL_NAMES[0],
      description: MINIMAL_BASH_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to run. Relative path is preferred in the command.",
          },
        },
        required: ["command"],
      },
      strict: false,
    },
  };
  const editor = {
    type: "function",
    function: {
      name: BOOTSTRAP_TOOL_NAMES[1],
      description: EDITOR_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
            enum: ["view", "create", "str_replace", "insert"],
          },
          path: {
            type: "string",
            description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
          },
          file_text: {
            type: "string",
            description: "Required parameter of `create` command, with the content of the file to be created.",
          },
          insert_line: {
            type: "integer",
            description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
          },
          new_str: {
            type: "string",
            description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
          },
          old_str: {
            type: "string",
            description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
          },
          view_range: {
            type: "array",
            description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
            items: { type: "integer" },
          },
        },
        required: ["command", "path"],
      },
      strict: false,
    },
  };
  return [bash, editor];
}

export function makeBootstrapRequest(source: JsonObject): JsonObject {
  const messages = Array.isArray(source.messages)
    ? source.messages.map(encodeMinimalMessage)
    : [];
  const request: JsonObject = {};
  const values: JsonObject = {
    ...source,
    messages,
    tools: minimalToolSchemas(),
  };

  for (const field of [
    "model",
    "messages",
    "stream",
    "stream_options",
    "thinking",
    "reasoning_effort",
    "tools",
    "max_tokens",
  ]) {
    if (Object.prototype.hasOwnProperty.call(values, field)) request[field] = values[field];
  }
  return request;
}

export function keepMinimalPersona(source: JsonObject): JsonObject | undefined {
  if (!Array.isArray(source.messages)) return undefined;
  let changed = false;
  const messages = source.messages.map((message) => {
    if (!isJsonObject(message)
      || (message.role !== "system" && message.role !== "developer")
      || message.content === MINIMAL_PERSONA) return message;
    changed = true;
    return { ...message, content: MINIMAL_PERSONA };
  });
  return changed ? { ...source, messages } : undefined;
}
