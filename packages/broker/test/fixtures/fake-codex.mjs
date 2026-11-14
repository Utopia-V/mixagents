#!/usr/bin/env node

import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

function parseArguments(argv) {
  const options = { state: "", owner: "", completeAfterMs: 0 };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "app-server") {
      break;
    }
    if (argument === "--state") {
      options.state = argv[++index];
    } else if (argument === "--owner") {
      options.owner = argv[++index];
    } else if (argument === "--complete-after-ms") {
      options.completeAfterMs = Number(argv[++index]);
    }
  }
  return options;
}

const options = parseArguments(process.argv);
const stateDirectory = options.state || process.env.CODEX_HOME;
if (!stateDirectory) {
  process.stderr.write("fake-codex: --state or CODEX_HOME is required\n");
  process.exit(2);
}

mkdirSync(stateDirectory, { recursive: true });
const statePath = path.join(stateDirectory, "fake-app-server.json");
const callsPath = options.state ? path.join(stateDirectory, "calls.jsonl") : undefined;
const ownersDirectory = path.join(stateDirectory, "owners");
mkdirSync(ownersDirectory, { recursive: true });

const token = `${options.owner || "owner"}:${process.pid}`;
const ownedThreads = new Set();
let inFlightReads = 0;
let maxConcurrentReads = 0;
let readConcurrencyViolations = 0;
let nextServerRequest = 1;
const pendingServerRequests = new Map();
const observedInProgressSince = new Map();

function send(message) {
  // Some sandboxes drop asynchronous child stdout writes. A synchronous fd
  // write keeps the fixture deterministic there and is still ordered with the
  // request/response stream.
  writeSync(1, `${JSON.stringify(message)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function failureResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function failure(id, code, message) {
  const response = failureResponse(id, code, message);
  send(response);
  return response;
}

function logCall(method, params) {
  if (!callsPath) return;
  appendFileSync(
    callsPath,
    `${JSON.stringify({
      owner: options.owner,
      token,
      method,
      params,
      at: Date.now(),
    })}\n`,
  );
}

function logReadConcurrency() {
  if (!callsPath) return;
  appendFileSync(
    callsPath,
    `${JSON.stringify({
      owner: options.owner,
      token,
      method: "thread/read/concurrency",
      params: {
        inFlight: inFlightReads,
        maxConcurrent: maxConcurrentReads,
        violations: readConcurrencyViolations,
      },
      at: Date.now(),
    })}\n`,
  );
}

function emptyState() {
  return { nextThread: 1, nextTurn: 1, threads: {} };
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.threads) {
      return {
        nextThread: Number.isInteger(parsed.nextThread) ? parsed.nextThread : 1,
        nextTurn: Number.isInteger(parsed.nextTurn) ? parsed.nextTurn : 1,
        threads: parsed.threads,
      };
    }
  } catch {
    // A new fake runtime starts empty.
  }
  return emptyState();
}

function saveState(state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, statePath);
}

function ownerPath(threadId) {
  return path.join(ownersDirectory, `${threadId}.json`);
}

function readOwner(threadId) {
  try {
    return JSON.parse(readFileSync(ownerPath(threadId), "utf8"));
  } catch {
    return undefined;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function claim(threadId) {
  const current = readOwner(threadId);
  if (current && current.token !== token && processAlive(current.pid)) {
    return false;
  }
  if (!current || current.token !== token) {
    writeFileSync(
      ownerPath(threadId),
      `${JSON.stringify({ token, owner: options.owner, pid: process.pid })}\n`,
    );
  }
  ownedThreads.add(threadId);
  return true;
}

function textFromInput(input) {
  if (!Array.isArray(input)) return "";
  return input
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function turnPayload(turn) {
  const hasCompletedAt = Object.prototype.hasOwnProperty.call(turn, "completedAt");
  return {
    id: turn.id,
    status: turn.status,
    items: turn.items,
    itemsView: { type: "full" },
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt:
      hasCompletedAt
        ? turn.completedAt
        : turn.status === "inProgress"
          ? null
          : undefined,
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
    createdAt: thread.createdAt ?? 1,
    updatedAt: thread.updatedAt ?? 2,
    recencyAt: 2,
    status:
      thread.status ??
      (thread.turns.at(-1)?.status === "inProgress"
        ? { type: "active", activeFlags: [] }
        : { type: "idle" }),
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

function materialize(record) {
  const materialized = JSON.parse(JSON.stringify(record));
  const latest = Array.isArray(materialized.turns) ? materialized.turns.at(-1) : undefined;
  if (latest?.status === "inProgress" && options.completeAfterMs > 0) {
    const observationKey = `${record.id}:${latest.id}`;
    const firstReadAtMs = observedInProgressSince.get(observationKey) ?? Date.now();
    if (!observedInProgressSince.has(observationKey)) {
      observedInProgressSince.set(observationKey, firstReadAtMs);
    }
    if (Date.now() - firstReadAtMs >= options.completeAfterMs) {
      latest.status = "completed";
      latest.completedAt = Math.floor(Date.now() / 1000);
      latest.items = [
        {
          type: "agentMessage",
          text: `completed ${latest.id}`,
          phase: "final_answer",
        },
      ];
      materialized.status = { type: "idle" };
    }
  }
  return materialized;
}

function requireRecord(id, params) {
  const state = loadState();
  const record = state.threads[params?.threadId];
  if (!record) {
    return {
      error: failureResponse(id, -32602, `Thread ${params?.threadId ?? "unknown"} not found`),
    };
  }
  return { state, record };
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
  turn.completedAt = Math.floor(Date.now() / 1000);
  const state = loadState();
  state.threads[thread.id] = {
    ...state.threads[thread.id],
    ...thread,
    turns: [...(state.threads[thread.id]?.turns ?? []).filter((entry) => entry.id !== turn.id), turn],
  };
  saveState(state);
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
  turn.completedAt = Math.floor(Date.now() / 1000);
  const state = loadState();
  state.threads[thread.id] = {
    ...state.threads[thread.id],
    ...thread,
    status: { type: "idle" },
    turns: [...(state.threads[thread.id]?.turns ?? []).filter((entry) => entry.id !== turn.id), turn],
  };
  saveState(state);
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
    await complete(thread, turn, approved ? "approval:approved" : "approval:declined");
  } catch (error) {
    await complete(thread, turn, `approval:${error.message}`, "failed");
  }
}

function scheduleTurn(thread, turn, text) {
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
  } else if (text.includes("report cwd")) {
    setTimeout(() => void complete(thread, turn, `cwd:${thread.cwd}`), 15);
  } else if (text.includes("crash after persist")) {
    setTimeout(() => {
      void persistCompletionWithoutNotification(
        thread,
        turn,
        "result:recovered after crash",
      ).then(() => process.kill(process.pid, "SIGKILL"));
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
}

async function handle(request) {
  const { id, method, params = {} } = request;
  logCall(method, params);
  if (method === "initialize") {
    response(id, {
      userAgent: "fake-codex",
      platformFamily: "unix",
      platformOs: "linux",
    });
    return;
  }
  if (method === "thread/start") {
    const state = loadState();
    const thread = {
      id: `thread_${state.nextThread++}`,
      modelProvider: params.modelProvider,
      model: params.model === "force-mismatch" ? "substituted-model" : params.model,
      cwd: params.cwd,
      preview: "",
      status: { type: "active", activeFlags: [] },
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      turns: [],
    };
    state.threads[thread.id] = thread;
    saveState(state);
    claim(thread.id);
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
    const loaded = requireRecord(id, params);
    if (loaded.error) {
      send(loaded.error);
      return;
    }
    if (loaded.record.readError) {
      failure(id, -32600, String(loaded.record.readError));
      return;
    }
    inFlightReads += 1;
    maxConcurrentReads = Math.max(maxConcurrentReads, inFlightReads);
    if (inFlightReads > 1) {
      readConcurrencyViolations += 1;
    }
    logReadConcurrency();
    try {
      // Give a concurrently issued read time to overlap so the fixture can
      // detect accidental per-runtime parallel hydration.
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      inFlightReads -= 1;
    }
    const record = materialize(loaded.record);
    response(id, {
      thread: threadPayload(record, params.includeTurns === true),
      readState: null,
    });
    return;
  }
  if (method === "thread/list") {
    const state = loadState();
    let records = Object.values(state.threads);
    if (Array.isArray(params.modelProviders) && params.modelProviders.length > 0) {
      records = records.filter((thread) => params.modelProviders.includes(thread.modelProvider));
    }
    response(id, {
      data: records.map((thread) => threadPayload(materialize(thread))),
      nextCursor: null,
      backwardsCursor: null,
    });
    return;
  }
  if (method === "thread/resume") {
    const loaded = requireRecord(id, params);
    if (loaded.error) {
      send(loaded.error);
      return;
    }
    if (loaded.record.resumeError) {
      failure(id, -32600, String(loaded.record.resumeError));
      return;
    }
    if (!claim(loaded.record.id)) {
      failure(id, -32600, `thread ${loaded.record.id} already has an active writer`);
      return;
    }
    const record = materialize(loaded.record);
    response(id, {
      thread: threadPayload(record, true),
      model: record.model,
      modelProvider: record.modelProvider,
    });
    return;
  }
  if (method === "turn/start") {
    const loaded = requireRecord(id, params);
    if (loaded.error) {
      send(loaded.error);
      return;
    }
    if (!claim(loaded.record.id)) {
      failure(id, -32600, `thread ${loaded.record.id} already has an active writer`);
      return;
    }
    const text = textFromInput(params.input);
    const turn = {
      id: `turn_${loaded.state.nextTurn++}`,
      status: "inProgress",
      items: [],
      error: null,
      startedAtMs: Date.now(),
      startedAt: Math.floor(Date.now() / 1000),
    };
    loaded.record.turns.push(turn);
    if (!loaded.record.preview) loaded.record.preview = text;
    loaded.record.status = { type: "active", activeFlags: [] };
    loaded.record.updatedAt = Math.floor(Date.now() / 1000);
    loaded.state.threads[loaded.record.id] = loaded.record;
    saveState(loaded.state);
    response(id, { turn: turnPayload(turn) });
    queueMicrotask(() => scheduleTurn(loaded.record, turn, text));
    return;
  }
  if (method === "turn/steer") {
    const loaded = requireRecord(id, params);
    if (loaded.error) {
      send(loaded.error);
      return;
    }
    if (!claim(loaded.record.id)) {
      failure(id, -32600, `thread ${loaded.record.id} already has an active writer`);
      return;
    }
    const turn = loaded.record.turns.at(-1);
    if (!turn || turn.id !== params.expectedTurnId || turn.status !== "inProgress") {
      failure(id, -32602, "No matching active turn");
      return;
    }
    turn.startedAtMs = Date.now();
    loaded.record.status = { type: "active", activeFlags: [] };
    loaded.record.updatedAt = Math.floor(Date.now() / 1000);
    loaded.state.threads[loaded.record.id] = loaded.record;
    saveState(loaded.state);
    response(id, { turn: turnPayload(turn) });
    await complete(loaded.record, turn, `steered:${textFromInput(params.input)}`);
    return;
  }
  if (method === "turn/interrupt") {
    const loaded = requireRecord(id, params);
    if (loaded.error) {
      send(loaded.error);
      return;
    }
    if (!claim(loaded.record.id)) {
      failure(id, -32600, `thread ${loaded.record.id} already has an active writer`);
      return;
    }
    const turn = loaded.record.turns.at(-1);
    if (!turn || (params.turnId && turn.id !== params.turnId)) {
      failure(id, -32602, "No matching active turn");
      return;
    }
    turn.status = "interrupted";
    turn.completedAt = Math.floor(Date.now() / 1000);
    loaded.record.status = { type: "idle" };
    loaded.record.updatedAt = Math.floor(Date.now() / 1000);
    loaded.state.threads[loaded.record.id] = loaded.record;
    saveState(loaded.state);
    response(id, {});
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: loaded.record.id, turn: turnPayload(turn) },
    });
    return;
  }
  failure(id, -32601, `Method not found: ${method}`);
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const threadId of ownedThreads) {
    const current = readOwner(threadId);
    if (current?.token === token) {
      try {
        unlinkSync(ownerPath(threadId));
      } catch {
        // Another process may already have removed the marker.
      }
    }
  }
  ownedThreads.clear();
}

function shutdown(code = 0) {
  try {
    cleanup();
  } finally {
    process.exit(code);
  }
}

process.on("exit", cleanup);

async function acceptLine(line) {
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
}

// Some sandboxes do not surface child process.stdin/readline data. Reading fd 0
// through a file stream keeps the fixture deterministic there without changing
// the production JSON-RPC transport.
const input = createReadStream(null, { fd: 0, encoding: "utf8" });
let buffered = "";
input.on("data", (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    void acceptLine(line);
    newline = buffered.indexOf("\n");
  }
});
input.on("end", () => {
  if (buffered.trim()) void acceptLine(buffered);
});
input.on("close", () => shutdown(0));
input.on("error", () => shutdown(0));
