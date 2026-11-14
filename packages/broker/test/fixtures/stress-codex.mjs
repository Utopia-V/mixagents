#!/usr/bin/env node

// Offline App Server protocol fixture for the Broker stress test.
// It uses only stdio JSON-RPC and per-thread files under CODEX_HOME so that
// several fake App Server processes can observe one another without clobbering
// state. No provider, network, credential, or real Codex code is involved.

import { appendFileSync, read, writeSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const codexHome = process.env.CODEX_HOME;
if (!codexHome) {
  process.stderr.write("stress-codex requires CODEX_HOME\n");
  process.exit(2);
}

const stateDirectory = path.join(codexHome, "stress-state");
const threadsDirectory = path.join(stateDirectory, "threads");
const controlPath = path.join(codexHome, "stress-control.json");
const metricsPath = path.join(stateDirectory, `metrics-${process.pid}.jsonl`);
await mkdir(threadsDirectory, { recursive: true });

const defaults = {
  readDelayMs: 25,
  completeDelayMs: 25,
  overloadThreshold: 8,
  overloadPenaltyMs: 10,
  overloadMaxPenaltyMs: 200,
  timeoutRiskThreshold: 32,
  simulatedTimeoutMs: 250,
  holdMaxMs: 6_000,
  release: {},
  syntheticNotLoaded: {},
};

let controlCache = { mtimeMs: -1, value: defaults };
let nextThread = 0;
const nextTurn = new Map();
let inFlightRead = 0;
let inFlightHydration = 0;

function metric(event) {
  try {
    appendFileSync(
      metricsPath,
      `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...event })}\n`,
      "utf8",
    );
  } catch {
    // Metrics must never break protocol behavior.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readControl() {
  try {
    const info = await stat(controlPath);
    if (info.mtimeMs !== controlCache.mtimeMs) {
      controlCache = {
        mtimeMs: info.mtimeMs,
        value: { ...defaults, ...JSON.parse(await readFile(controlPath, "utf8")) },
      };
    }
  } catch {
    // Missing or partially replaced control file keeps the last good value.
  }
  return controlCache.value;
}

function send(message) {
  // A synchronous fd write keeps framing intact under nested-pipe sandboxes
  // where an async process.stdout.write can be dropped when the child exits.
  writeSync(1, `${JSON.stringify(message)}\n`);
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

function threadPath(threadId) {
  return path.join(threadsDirectory, `${threadId}.json`);
}

async function readThread(threadId) {
  if (!/^thread_[A-Za-z0-9_-]+$/.test(threadId)) return null;
  try {
    return JSON.parse(await readFile(threadPath(threadId), "utf8"));
  } catch {
    return null;
  }
}

async function writeThread(thread) {
  const temporary = `${threadPath(thread.id)}.${process.pid}.${nextThread}.tmp`;
  await writeFile(temporary, `${JSON.stringify(thread)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, threadPath(thread.id));
}

async function listThreads() {
  let names = [];
  try {
    names = await readdir(threadsDirectory);
  } catch {
    return [];
  }
  const threads = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const thread = await readThread(name.slice(0, -5));
    if (thread) threads.push(thread);
  }
  threads.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  return threads;
}

function turnPayload(turn, syntheticInterrupted = false) {
  const status = syntheticInterrupted ? "interrupted" : turn.status;
  let completedAt;
  if (status === "inProgress" || syntheticInterrupted || turn.completedAt === null) {
    completedAt = null;
  } else if (typeof turn.completedAt === "number") {
    completedAt = turn.completedAt;
  } else {
    completedAt = 2;
  }
  return {
    id: turn.id,
    status,
    items: turn.items,
    itemsView: { type: "full" },
    error: status === "failed" ? turn.error ?? { message: "fake failure" } : null,
    startedAt: turn.startedAt ?? 1,
    completedAt,
    durationMs: completedAt === null ? null : Math.max(1, completedAt - (turn.startedAt ?? 1)),
  };
}

function isSyntheticFor(control, thread, foreign) {
  const latest = thread.turns.at(-1);
  return Boolean(
    foreign &&
      latest &&
      latest.status === "inProgress" &&
      control.syntheticNotLoaded?.[thread.id],
  );
}

function threadPayload(thread, includeTurns, synthetic = false) {
  const latest = thread.turns.at(-1);
  const status = synthetic
    ? { type: "notLoaded" }
    : latest?.status === "inProgress"
      ? { type: "active", activeFlags: [] }
      : { type: "idle" };
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
    recencyAt: thread.updatedAt ?? 2,
    status,
    path: threadPath(thread.id),
    cwd: thread.cwd,
    cliVersion: "stress-fake",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: "mixagents_broker",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: includeTurns
      ? thread.turns.map((turn) => turnPayload(turn, synthetic && turn.id === latest?.id))
      : [],
  };
}

async function completeTurn(threadId, turnId, text, status = "completed") {
  const thread = await readThread(threadId);
  const turn = thread?.turns.find((candidate) => candidate.id === turnId);
  if (!thread || !turn || turn.status !== "inProgress") return;
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
  turn.completedAt = Date.now();
  thread.updatedAt = Date.now();
  await writeThread(thread);
  metric({ kind: "turn_complete", threadId, turnId, output: text, status });
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId, turnId, item, completedAtMs: Date.now() },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId, turn: turnPayload(turn) },
  });
}

async function holdOrComplete(threadId, turnId, text, control) {
  const deadline = Date.now() + (control.holdMaxMs ?? defaults.holdMaxMs);
  while (Date.now() < deadline) {
    const current = await readControl();
    const released = current.release?.[threadId];
    if (typeof released === "string") {
      await completeTurn(threadId, turnId, released);
      return;
    }
    await sleep(25);
  }
  await completeTurn(threadId, turnId, `result:${text}`);
}

async function hydration(method, threadId, foreign, work) {
  inFlightHydration += 1;
  const concurrentHydration = inFlightHydration;
  const isRead = method === "thread/read";
  if (isRead) inFlightRead += 1;
  const concurrentRead = inFlightRead;
  const control = await readControl();
  const overload = concurrentHydration > (control.overloadThreshold ?? 8);
  const timeoutRisk = concurrentHydration > (control.timeoutRiskThreshold ?? 32);
  const extraDelay = overload
    ? Math.min(
        (concurrentHydration - (control.overloadThreshold ?? 8)) *
          (control.overloadPenaltyMs ?? 10),
        control.overloadMaxPenaltyMs ?? 200,
      )
    : 0;
  const started = Date.now();
  let simulatedTimeout = false;
  try {
    if (timeoutRisk) {
      await sleep(control.simulatedTimeoutMs ?? 250);
      simulatedTimeout = true;
      throw new Error(
        `simulated App Server request timeout after 30000ms budget; ${method} concurrency ${concurrentHydration}`,
      );
    }
    await sleep((control.readDelayMs ?? 25) + extraDelay);
    return await work();
  } finally {
    if (isRead) inFlightRead -= 1;
    inFlightHydration -= 1;
    metric({
      kind: "rpc",
      method,
      threadId,
      foreign,
      concurrentRead,
      concurrentHydration,
      overload,
      simulatedTimeout,
      durationMs: Date.now() - started,
    });
  }
}

async function startTurn(thread, text) {
  const serial = (nextTurn.get(thread.id) ?? 0) + 1;
  nextTurn.set(thread.id, serial);
  const turn = {
    id: `turn_${thread.id}_${serial}`,
    status: "inProgress",
    items: [],
    error: null,
    startedAt: Date.now(),
    completedAt: null,
  };
  thread.turns.push(turn);
  if (!thread.preview) thread.preview = text;
  thread.updatedAt = Date.now();
  await writeThread(thread);
  metric({ kind: "turn_start", threadId: thread.id, turnId: turn.id });
  send({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId: thread.id, turn: turnPayload(turn) },
  });
  const control = await readControl();
  if (/\bhold\b|\bstale\b|\bsynthetic\b/.test(text)) {
    void holdOrComplete(thread.id, turn.id, text, control);
  } else {
    setTimeout(() => {
      void completeTurn(thread.id, turn.id, `result:${text}`);
    }, control.completeDelayMs ?? 25);
  }
  return turn;
}

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === "initialize") {
    response(id, { userAgent: "stress-codex", platformFamily: "unix", platformOs: "linux" });
    return;
  }
  if (method === "thread/start") {
    const threadId = `thread_${process.pid}_${++nextThread}`;
    const thread = {
      id: threadId,
      modelProvider: params.modelProvider,
      model: params.model,
      cwd: params.cwd,
      preview: "",
      ownerPid: process.pid,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };
    await writeThread(thread);
    metric({ kind: "thread_start", threadId });
    response(id, {
      thread: threadPayload(thread, false),
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
  if (method === "thread/resume") {
    const thread = await readThread(params.threadId);
    if (!thread) {
      failure(id, -32602, `Thread ${params.threadId} not found`);
      return;
    }
    const foreign = thread.ownerPid !== process.pid;
    const active = thread.turns.at(-1)?.status === "inProgress";
    if (foreign && active) {
      metric({
        kind: "rpc",
        method,
        threadId: thread.id,
        foreign,
        resumeAttempt: true,
        activeWriterReject: true,
        concurrentRead: 0,
        concurrentHydration: 0,
        overload: false,
        simulatedTimeout: false,
        durationMs: 0,
      });
      failure(id, -32002, `active writer: thread ${thread.id} is owned by another App Server`);
      return;
    }
    try {
      await hydration(method, thread.id, foreign, async () => {
        response(id, {
          thread: threadPayload(thread, true),
          model: thread.model,
          modelProvider: thread.modelProvider,
        });
      });
    } catch (error) {
      failure(id, -32001, error.message);
    }
    return;
  }
  if (method === "thread/read") {
    const thread = await readThread(params.threadId);
    if (!thread) {
      failure(id, -32602, `Thread ${params.threadId} not found`);
      return;
    }
    const foreign = thread.ownerPid !== process.pid;
    const control = await readControl();
    const synthetic = isSyntheticFor(control, thread, foreign);
    if (synthetic) {
      metric({ kind: "synthetic_interrupted", threadId: thread.id, foreign });
    }
    try {
      await hydration(method, thread.id, foreign, async () => {
        response(id, {
          thread: threadPayload(thread, params.includeTurns === true, synthetic),
          model: thread.model,
          modelProvider: thread.modelProvider,
        });
      });
    } catch (error) {
      failure(id, -32001, error.message);
    }
    return;
  }
  if (method === "thread/list") {
    const started = Date.now();
    const control = await readControl();
    await sleep(control.readDelayMs ?? 25);
    const threads = await listThreads();
    const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 100;
    const offset = Number.parseInt(params.cursor ?? "0", 10) || 0;
    const page = threads.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    metric({
      kind: "rpc",
      method,
      threadId: null,
      foreign: true,
      concurrentRead: inFlightRead,
      concurrentHydration: inFlightHydration,
      overload: false,
      simulatedTimeout: false,
      durationMs: Date.now() - started,
    });
    response(id, {
      data: page.map((thread) =>
        threadPayload(thread, false, isSyntheticFor(control, thread, true)),
      ),
      nextCursor: nextOffset < threads.length ? String(nextOffset) : null,
      backwardsCursor: null,
    });
    return;
  }
  if (method === "turn/start") {
    const thread = await readThread(params.threadId);
    if (!thread) {
      failure(id, -32602, `Thread ${params.threadId} not found`);
      return;
    }
    if (thread.ownerPid !== process.pid && thread.turns.at(-1)?.status === "inProgress") {
      failure(id, -32002, `active writer: thread ${thread.id} is owned by another App Server`);
      return;
    }
    const turn = await startTurn(thread, textFromInput(params.input));
    response(id, { turn: turnPayload(turn) });
    return;
  }
  if (method === "turn/steer") {
    const thread = await readThread(params.threadId);
    const turn = thread?.turns.at(-1);
    if (!thread || !turn || turn.id !== params.expectedTurnId || turn.status !== "inProgress") {
      failure(id, -32602, "No matching active turn");
      return;
    }
    response(id, { turnId: turn.id });
    const control = await readControl();
    setTimeout(() => {
      void completeTurn(thread.id, turn.id, `result:steered:${textFromInput(params.input)}`);
    }, control.completeDelayMs ?? 25);
    return;
  }
  if (method === "turn/interrupt") {
    const thread = await readThread(params.threadId);
    const turn = thread?.turns.at(-1);
    if (!thread || !turn || turn.id !== params.turnId) {
      failure(id, -32602, "No matching active turn");
      return;
    }
    turn.status = "interrupted";
    turn.completedAt = Date.now();
    thread.updatedAt = Date.now();
    await writeThread(thread);
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

const decoder = new StringDecoder("utf8");
let pendingInput = "";

function dispatch(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method && message.id !== undefined) {
    metric({ kind: "request", method: message.method });
    void handle(message);
  }
}

function consume(chunk) {
  pendingInput += chunk;
  let newline = pendingInput.indexOf("\n");
  while (newline >= 0) {
    const line = pendingInput.slice(0, newline);
    pendingInput = pendingInput.slice(newline + 1);
    dispatch(line);
    newline = pendingInput.indexOf("\n");
  }
}

function readInput() {
  const buffer = Buffer.alloc(65_536);
  read(0, buffer, 0, buffer.length, null, (error, bytes) => {
    if (error || bytes === 0) return;
    consume(decoder.write(buffer.subarray(0, bytes)));
    readInput();
  });
}

readInput();
