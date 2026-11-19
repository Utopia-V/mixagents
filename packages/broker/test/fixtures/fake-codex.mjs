#!/usr/bin/env node

// Offline stand-in for `codex app-server --stdio`. Several processes may share
// one CODEX_HOME, as two Broker sessions over one data directory do. It
// mirrors what real App Server does there:
// - each thread is persisted in its own file, so processes do not clobber
//   each other's state;
// - a process that starts or resumes a thread holds its writer lock until the
//   process exits, idle or not; thread/resume elsewhere is refused meanwhile;
// - a thread not loaded in this process reads as notLoaded, and its unfinished
//   turn as interrupted without a completion time.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import readline from "node:readline";

const home = process.env.CODEX_HOME;
const threadsDirectory = path.join(home, "fake-threads");
const locksDirectory = path.join(home, "fake-locks");
mkdirSync(threadsDirectory, { recursive: true });
mkdirSync(locksDirectory, { recursive: true });

const loaded = new Map();
let nextId = 1;
let nextServerRequest = 1;
const pendingServerRequests = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function threadPath(threadId) {
  return path.join(threadsDirectory, `${threadId}.json`);
}

function lockPath(threadId) {
  return path.join(locksDirectory, `${threadId}.json`);
}

function persist(thread) {
  const temporary = `${threadPath(thread.id)}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(thread)}\n`, "utf8");
  renameSync(temporary, threadPath(thread.id));
}

function stored(threadId) {
  try {
    return JSON.parse(readFileSync(threadPath(threadId), "utf8"));
  } catch {
    return undefined;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Returns false while another live process holds the thread's writer lock.
function claim(threadId) {
  try {
    const holder = JSON.parse(readFileSync(lockPath(threadId), "utf8")).pid;
    if (holder !== process.pid && alive(holder)) {
      return false;
    }
  } catch {
    // No lock, or an unreadable one: treat it as free.
  }
  writeFileSync(lockPath(threadId), `${JSON.stringify({ pid: process.pid })}\n`);
  return true;
}

// On a graceful exit App Server records the unfinished turn as interrupted
// and releases the writer lock.
function shutdown() {
  for (const [threadId, thread] of loaded) {
    const turn = thread.turns.at(-1);
    if (turn?.status === "inProgress") {
      finish(thread, turn, "interrupted");
    }
    try {
      unlinkSync(lockPath(threadId));
    } catch {
      // Already gone.
    }
  }
}

// What App Server reports for a turn it does not have loaded.
function unloadedTurn(turn) {
  return turn.status === "inProgress"
    ? { ...turn, status: "interrupted", completedAt: null }
    : turn;
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
    startedAt: turn.startedAt,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.status === "inProgress" ? null : 1,
  };
}

function threadPayload(thread, { includeTurns = false, isLoaded = true } = {}) {
  const turns = isLoaded ? thread.turns : thread.turns.map(unloadedTurn);
  let status = { type: "notLoaded" };
  if (isLoaded) {
    status =
      thread.turns.at(-1)?.status === "inProgress"
        ? { type: "active", activeFlags: [] }
        : { type: "idle" };
  }
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
    status,
    path: threadPath(thread.id),
    cwd: thread.cwd,
    cliVersion: "fake",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: "mixagents_broker",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: includeTurns ? turns.map(turnPayload) : [],
  };
}

function finish(thread, turn, status) {
  turn.status = status;
  turn.completedAt = now();
  persist(thread);
}

function complete(thread, turn, text, status = "completed") {
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
  turn.error = status === "failed" ? { message: text } : null;
  finish(thread, turn, status);
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
    complete(thread, turn, approved ? "approval:approved" : "approval:declined");
  } catch (error) {
    complete(thread, turn, `approval:${error.message}`, "failed");
  }
}

function startTurn(thread, text) {
  const turn = {
    id: `turn_${process.pid}_${nextId++}`,
    status: "inProgress",
    items: [],
    error: null,
    startedAt: now(),
  };
  thread.turns.push(turn);
  if (!thread.preview) thread.preview = text;
  persist(thread);
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
      setTimeout(() => complete(thread, turn, audit), 15);
    } else if (text.includes("report cwd")) {
      setTimeout(() => complete(thread, turn, `cwd:${thread.cwd}`), 15);
    } else if (text.includes("crash after persist")) {
      setTimeout(() => {
        // Persist the completion, then die before notifying.
        turn.items.push({
          type: "agentMessage",
          id: `message_${turn.id}`,
          text: "result:recovered after crash",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
        });
        finish(thread, turn, "completed");
        process.exit(77);
      }, 15);
    } else if (text.includes("approval")) {
      void askApproval(thread, turn);
    } else if (text.includes("slow")) {
      // Stay active until interrupted.
    } else if (text.includes("delayed")) {
      setTimeout(() => complete(thread, turn, `result:${text}`), 700);
    } else if (text.includes("fail")) {
      setTimeout(() => complete(thread, turn, "fake provider failure", "failed"), 15);
    } else {
      setTimeout(() => complete(thread, turn, `result:${text}`), 15);
    }
  });
  return turn;
}

function loadedThread(id, threadId) {
  const thread = loaded.get(threadId);
  if (!thread) {
    failure(id, -32600, `thread not found: ${threadId}`);
  }
  return thread;
}

function handle(request) {
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
      id: `thread_${process.pid}_${nextId++}`,
      modelProvider: params.modelProvider,
      model: params.model === "force-mismatch" ? "substituted-model" : params.model,
      cwd: params.cwd,
      preview: "",
      turns: [],
    };
    persist(thread);
    claim(thread.id);
    loaded.set(thread.id, thread);
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
  if (method === "thread/read") {
    const thread = loaded.get(params.threadId) ?? stored(params.threadId);
    if (!thread) {
      failure(id, -32602, `Thread ${params.threadId} not found`);
      return;
    }
    response(id, {
      thread: threadPayload(thread, {
        includeTurns: params.includeTurns === true,
        isLoaded: loaded.has(thread.id),
      }),
    });
    return;
  }
  if (method === "thread/resume") {
    let thread = loaded.get(params.threadId);
    if (!thread) {
      const record = stored(params.threadId);
      if (!record) {
        failure(id, -32602, `Thread ${params.threadId} not found`);
        return;
      }
      if (!claim(record.id)) {
        appendFileSync(path.join(home, "fake-resume-refusals.log"), `${record.id}\n`);
        failure(id, -32600, `thread ${record.id} already has an active writer`);
        return;
      }
      thread = { ...record, turns: record.turns.map(unloadedTurn) };
      loaded.set(thread.id, thread);
    }
    response(id, {
      thread: threadPayload(thread, { includeTurns: true }),
      model: thread.model,
      modelProvider: thread.modelProvider,
    });
    return;
  }
  if (method === "thread/list") {
    const providers = Array.isArray(params.modelProviders) ? params.modelProviders : [];
    const data = readdirSync(threadsDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => stored(name.slice(0, -".json".length)))
      .filter((thread) => thread && (providers.length === 0 || providers.includes(thread.modelProvider)))
      .map((thread) =>
        threadPayload(loaded.get(thread.id) ?? thread, { isLoaded: loaded.has(thread.id) }),
      );
    response(id, { data, nextCursor: null, backwardsCursor: null });
    return;
  }
  if (method === "turn/start") {
    const thread = loadedThread(id, params.threadId);
    if (!thread) return;
    const turn = startTurn(thread, textFromInput(params.input));
    response(id, { turn: turnPayload(turn) });
    return;
  }
  if (method === "turn/steer") {
    const thread = loadedThread(id, params.threadId);
    if (!thread) return;
    const turn = thread.turns.at(-1);
    if (!turn || turn.id !== params.expectedTurnId || turn.status !== "inProgress") {
      failure(id, -32602, "No matching active turn");
      return;
    }
    response(id, { turnId: turn.id });
    complete(thread, turn, `steered:${textFromInput(params.input)}`);
    return;
  }
  if (method === "turn/interrupt") {
    const thread = loadedThread(id, params.threadId);
    if (!thread) return;
    const turn = thread.turns.at(-1);
    if (!turn || turn.id !== params.turnId) {
      failure(id, -32602, "No matching active turn");
      return;
    }
    finish(thread, turn, "interrupted");
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

// After a crash (SIGKILL) the locks go stale and the next claimant sees that
// their holder is dead.
process.on("exit", shutdown);
process.on("SIGTERM", () => process.exit(0));

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
    handle(message);
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
