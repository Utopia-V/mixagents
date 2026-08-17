import {
  STATE_ENTRY_TYPE,
  TARGET_MODEL_ID,
  TARGET_PROVIDERS,
} from "./constants.js";
import { isJsonObject } from "./protocol.js";

export type Stage = "bootstrap" | "execute";

export interface StageRecord {
  schema: 1;
  route: string;
  stage: Stage;
}

export interface LiveStage extends StageRecord {
  requestIssued: boolean;
}

export function supportedRoute(model: { provider?: unknown; id?: unknown } | undefined): string | undefined {
  if (typeof model?.provider !== "string" || typeof model.id !== "string") return undefined;
  const provider = model.provider.toLowerCase();
  const modelId = model.id.toLowerCase();
  if (modelId !== TARGET_MODEL_ID || !TARGET_PROVIDERS.some((candidate) => candidate === provider)) {
    return undefined;
  }
  return `${provider}/${modelId}`;
}

export function conversationHasStarted(entries: readonly unknown[]): boolean {
  return entries.some((entry) => isJsonObject(entry)
    && entry.type === "message"
    && isJsonObject(entry.message)
    && ["user", "assistant", "toolResult"].includes(String(entry.message.role)));
}

function completedMessage(entry: unknown): boolean {
  if (!isJsonObject(entry) || entry.type !== "message" || !isJsonObject(entry.message)) return false;
  if (entry.message.role === "toolResult") return true;
  return entry.message.role === "assistant"
    && entry.message.stopReason !== "error"
    && entry.message.stopReason !== "aborted";
}

function decodeRecord(value: unknown, route: string): StageRecord | undefined {
  if (!isJsonObject(value)
    || value.schema !== 1
    || value.route !== route
    || (value.stage !== "bootstrap" && value.stage !== "execute")) return undefined;
  return { schema: 1, route, stage: value.stage };
}

export function restoreStage(entries: readonly unknown[], route: string): LiveStage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isJsonObject(entry)
      || entry.type !== "custom"
      || entry.customType !== STATE_ENTRY_TYPE) continue;
    const record = decodeRecord(entry.data, route);
    if (record === undefined) continue;
    const stage = record.stage === "bootstrap" && entries.slice(index + 1).some(completedMessage)
      ? "execute"
      : record.stage;
    return { ...record, stage, requestIssued: false };
  }
  return undefined;
}
