#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const statePath = path.join(process.env.CODEX_HOME, "fake-app-server.json");
await mkdir(process.env.CODEX_HOME, { recursive: true });

let state = { nextThread: 1, nextTurn: 1, threads: {} };
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch {
  // A new fake runtime starts empty.
}

let nextServerRequest = 1;
const pendingServerRequests = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function persist() {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, "utf8");
  await rename(temporary, statePath);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textFromInput(input) {
  if (!Array.isArray(input)) return "";
  return input
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function turnPayload(turn) {
  return {
    id: turn.id,
    status: turn.status,
    items: turn.items,
    itemsView: { type: "full" },
    error: turn.error,
    startedAt: 1,
    completedAt: turn.status === "inProgress" ? null : 2,
    durationMs: turn.status === "inProgress" ? null : 1,
  };
}

function threadPayload(thread, includeTurns = false) {
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: thread.preview,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: thread.modelProvider,
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status:
      thread.turns.at(-1)?.status === "inProgress"
        ? { type: "active", activeFlags: [] }
        : { type: "idle" },
    path: statePath,
    cwd: thread.cwd,
    cliVersion: "fake",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: "mixagents_broker",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: includeTurns ? thread.turns.map(turnPayload) : [],
  };
}

function currentTurn(thread) {
  return thread.turns.at(-1);
}

async function complete(thread, turn, text, status = "completed") {
  if (turn.status !== "inProgress") return;
  const item = {
    type: "agentMessage",
    id: `message_${turn.id}`,
    text,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
  };
  turn.items.push(item);
  turn.status = status;
  turn.error = status === "failed" ? { message: text } : null;
  await persist();
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: 2 },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: thread.id, turn: turnPayload(turn) },
  });
}

async function persistCompletionWithoutNotification(thread, turn, text) {
  const item = {
    type: "agentMessage",
    id: `message_${turn.id}`,
    text,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
  };
  turn.items.push(item);
  turn.status = "completed";
  turn.error = null;
  await persist();
}

async function askApproval(thread, turn) {
  const id = `approval-${nextServerRequest++}`;
  const result = new Promise((resolve, reject) => {
    pendingServerRequests.set(id, { resolve, reject });
  });
  send({
    jsonrpc: "2.0",
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command",
      threadId: thread.id,
      turnId: turn.id,
      itemId: `command_${turn.id}`,
      startedAtMs: 1,
      environmentId: null,
      reason: "Fake approval test",
      command: "printf approved",
      cwd: thread.cwd,
      commandActions: null,
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ["accept", "decline", "cancel"],
    },
  });
  try {
    const approval = await result;
    const approved = approval?.decision === "accept";
    await complete(thread, turn, approved ? "approval:approved" : "approval:declined");
  } catch (error) {
    await complete(thread, turn, `approval:${error.message}`, "failed");
  }
}

async function startTurn(thread, text) {
  const turn = {
    id: `turn_${state.nextTurn++}`,
    status: "inProgress",
    items: [],
    error: null,
  };
  thread.turns.push(turn);
  if (!thread.preview) thread.preview = text;
  await persist();
  queueMicrotask(() => {
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: thread.id, turn: turnPayload(turn) },
    });
    if (text.includes("environment audit")) {
      const audit = JSON.stringify({
        selectedCredential: Boolean(process.env.TEST_PROVIDER_KEY),
        unrelatedCredential: Boolean(process.env.UNRELATED_SECRET),
      });
      setTimeout(() => void complete(thread, turn, audit), 15);
    } else if (text.includes("crash after persist")) {
      setTimeout(() => {
        void persistCompletionWithoutNotification(
          thread,
          turn,
          "result:recovered after crash",
        ).then(() => process.exit(77));
      }, 15);
    } else if (text.includes("approval")) {
      void askApproval(thread, turn);
    } else if (text.includes("slow")) {
      // Stay active until interrupted.
    } else if (text.includes("fail")) {
      setTimeout(() => void complete(thread, turn, "fake provider failure", "failed"), 15);
    } else {
      setTimeout(() => void complete(thread, turn, `result:${text}`), 15);
    }
  });
  return turn;
}

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === "initialize") {
    response(id, {
      userAgent: "fake-codex",
      platformFamily: "unix",
      platformOs: "linux",
    });
    return;
  }
  if (method === "thread/start") {
    const thread = {
      id: `thread_${state.nextThread++}`,
      modelProvider: params.modelProvider,
      model: params.model === "force-mismatch" ? "substituted-model" : params.model,
      cwd: params.cwd,
      preview: "",
      turns: [],
    };
    state.threads[thread.id] = thread;
    await persist();
    response(id, {
      thread: threadPayload(thread),
      model: thread.model,
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: [thread.cwd],
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly", access: { type: "fullAccess" } },
      activePermissionProfile: null,
      reasoningEffort: null,
      multiAgentMode: "explicitRequestOnly",
    });
    return;
  }
  if (method === "thread/resume" || method === "thread/read") {
    const thread = state.threads[params.threadId];
    if (!thread) {
      failure(id, -32602, `Thread ${params.threadId} not found`);
      return;
    }
    response(id, {
      thread: threadPayload(thread, true),
      model: thread.model,
      modelProvider: thread.modelProvider,
    });
    return;
  }
  if (method === "thread/list") {
    response(id, {
      data: Object.values(state.threads).map((thread) => threadPayload(thread)),
      nextCursor: null,
      backwardsCursor: null,
    });
    return;
  }
  if (method === "turn/start") {
    const thread = state.threads[params.threadId];
    if (!thread) {
      failure(id, -32602, `Thread ${params.threadId} not found`);
      return;
    }
    const turn = await startTurn(thread, textFromInput(params.input));
    response(id, { turn: turnPayload(turn) });
    return;
  }
  if (method === "turn/steer") {
    const thread = state.threads[params.threadId];
    const turn = thread && currentTurn(thread);
    if (!turn || turn.id !== params.expectedTurnId || turn.status !== "inProgress") {
      failure(id, -32602, "No matching active turn");
      return;
    }
    response(id, { turnId: turn.id });
    await complete(thread, turn, `steered:${textFromInput(params.input)}`);
    return;
  }
  if (method === "turn/interrupt") {
    const thread = state.threads[params.threadId];
    const turn = thread && currentTurn(thread);
    if (!turn || turn.id !== params.turnId) {
      failure(id, -32602, "No matching active turn");
      return;
    }
    turn.status = "interrupted";
    await persist();
    response(id, {});
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: thread.id, turn: turnPayload(turn) },
    });
    return;
  }
  failure(id, -32601, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method && message.id !== undefined) {
    void handle(message);
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const pending = pendingServerRequests.get(message.id);
    if (!pending) return;
    pendingServerRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
});
