import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "stress-codex.mjs");

function distEntry(value) {
  if (!value) {
    return new URL("../plugin/mixagents-broker/dist/broker.js", import.meta.url);
  }
  const absolute = path.resolve(value);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    return pathToFileURL(path.join(absolute, "broker.js"));
  }
  return pathToFileURL(absolute);
}

const brokerEntry = distEntry(process.env.BROKER_STRESS_DIST);
const { Broker } = await import(brokerEntry.href);
const { parseAgentId, runtimeIdFor } = await import(
  new URL("./app-server.js", brokerEntry).href
);

// Reports are written only when the caller explicitly selects an audit path.
// Otherwise the test emits metrics through node:test diagnostics, so the
// committed file never names a private home directory.
const auditDirectory = process.env.BROKER_STRESS_AUDIT_DIR
  ? path.resolve(process.env.BROKER_STRESS_AUDIT_DIR)
  : null;
const auditLabel = process.env.BROKER_STRESS_LABEL ?? "current";
const auditResults = [];

function routeThreadId(agentId) {
  return parseAgentId(agentId).threadId;
}

function minimalEnvironment() {
  // Deliberately not ...process.env: a test must not inherit real Broker or
  // provider credentials through MIXAGENTS_BROKER_CREDENTIALS_JSON.
  const environment = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TEST_PROVIDER_KEY: "offline-test-only-key",
  };
  if (process.env.HOME) environment.HOME = process.env.HOME;
  return environment;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round(sorted[index] * 10) / 10;
}

function latency(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null };
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.round(Math.max(...values) * 10) / 10,
  };
}

async function timed(bucket, operation) {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    bucket.push(performance.now() - started);
  }
}

class Checks {
  constructor(name) {
    this.name = name;
    this.items = [];
    this.errors = [];
  }

  ok(name, condition, detail = {}) {
    const passed = Boolean(condition);
    this.items.push({ name, passed, ...detail });
    if (!passed) this.errors.push(`${name}: ${JSON.stringify(detail)}`);
    return passed;
  }

  equal(name, actual, expected, detail = {}) {
    return this.ok(name, Object.is(actual, expected), { actual, expected, ...detail });
  }

  fail(name, error) {
    this.items.push({ name, passed: false, error: String(error?.stack ?? error) });
    this.errors.push(`${name}: ${String(error?.message ?? error)}`);
  }

  assertAll() {
    if (this.errors.length === 0) return;
    throw new AggregateError(this.errors, `${this.name} failed:\n${this.errors.join("\n")}`);
  }
}

async function capture(checks, name, operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    checks.fail(name, error);
    return { ok: false, error };
  }
}

async function createHarness({ observers = 0, control = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mixagents-broker-stress-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "state");
  const configPath = path.join(root, "broker.json");
  await mkdir(workspace);
  const route = {
    description: "Offline stress provider",
    provider: "stress_provider",
    providerName: "Stress Provider",
    model: "stress-model",
    baseUrl: "http://127.0.0.1:1",
    envKey: "TEST_PROVIDER_KEY",
    tags: ["offline", "stress"],
    maxAccess: "workspace-write",
  };
  await writeFile(
    configPath,
    `${JSON.stringify({
      defaultRoute: "stress-route",
      workspaceRoots: [workspace],
      dataDir,
      routes: { "stress-route": route },
    }, null, 2)}\n`,
    "utf8",
  );
  const environment = minimalEnvironment();
  const options = {
    configPath,
    environment,
    processOverride: { command: process.execPath, prefixArgs: [fixturePath] },
  };
  const owner = await Broker.create(options);
  const parsedRoute = owner.config.routes[0];
  const runtimeId = runtimeIdFor(parsedRoute, "read-only");
  const runtimeDirectory = path.join(dataDir, "runtimes", runtimeId);
  const controlPath = path.join(runtimeDirectory, "stress-control.json");
  await mkdir(runtimeDirectory, { recursive: true });
  let currentControl = { ...control };

  async function updateControl(patch) {
    currentControl = { ...currentControl, ...patch };
    const temporary = `${controlPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(currentControl)}\n`, "utf8");
    await rename(temporary, controlPath);
  }

  await updateControl(control);
  const observerBrokers = await Promise.all(
    Array.from({ length: observers }, () => Broker.create(options)),
  );

  async function metrics() {
    const stateDirectory = path.join(runtimeDirectory, "stress-state");
    let names = [];
    try {
      names = await readdir(stateDirectory);
    } catch {
      return [];
    }
    const events = [];
    for (const name of names) {
      if (!name.startsWith("metrics-") || !name.endsWith(".jsonl")) continue;
      const text = await readFile(path.join(stateDirectory, name), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // Ignore a torn final line if a fixture exits mid-write.
        }
      }
    }
    return events;
  }

  return {
    root,
    workspace,
    dataDir,
    route: "stress-route",
    owner,
    observers: observerBrokers,
    controlPath,
    updateControl,
    async release(map) {
      await updateControl({ release: { ...(currentControl.release ?? {}), ...map } });
    },
    async syntheticNotLoaded(threadIds) {
      await updateControl({
        syntheticNotLoaded: {
          ...(currentControl.syntheticNotLoaded ?? {}),
          ...Object.fromEntries(threadIds.map((threadId) => [threadId, true])),
        },
      });
    },
    metrics,
    async close() {
      await Promise.all([
        owner.close(),
        ...observerBrokers.map((broker) => broker.close()),
      ]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function summarizeMetrics(events) {
  const requestCounts = {};
  const observationRpcCounts = {};
  const threadStarts = [];
  const pids = new Set();
  const creatorPids = new Set();
  const maxReadByPid = new Map();
  const maxHydrationByPid = new Map();
  const resumeRequestsByPid = new Map();
  let foreignResumeAttempts = 0;
  let activeWriterRejects = 0;
  let overloadEvents = 0;
  let simulatedTimeoutEvents = 0;
  let syntheticInterruptedEvents = 0;

  for (const event of events) {
    pids.add(event.pid);
    if (event.kind === "request") {
      requestCounts[event.method] = (requestCounts[event.method] ?? 0) + 1;
      if (event.method === "thread/resume") {
        resumeRequestsByPid.set(event.pid, (resumeRequestsByPid.get(event.pid) ?? 0) + 1);
      }
      continue;
    }
    if (event.kind === "thread_start") {
      threadStarts.push(event.threadId);
      creatorPids.add(event.pid);
      continue;
    }
    if (event.kind === "synthetic_interrupted") {
      syntheticInterruptedEvents += 1;
      continue;
    }
    if (event.kind !== "rpc") continue;
    observationRpcCounts[event.method] = (observationRpcCounts[event.method] ?? 0) + 1;
    if (event.method === "thread/resume") {
      if (event.foreign) foreignResumeAttempts += 1;
      if (event.activeWriterReject) activeWriterRejects += 1;
    }
    if (event.method === "thread/read") {
      maxReadByPid.set(
        event.pid,
        Math.max(maxReadByPid.get(event.pid) ?? 0, event.concurrentRead ?? 0),
      );
    }
    if (event.method === "thread/read" || event.method === "thread/resume") {
      maxHydrationByPid.set(
        event.pid,
        Math.max(maxHydrationByPid.get(event.pid) ?? 0, event.concurrentHydration ?? 0),
      );
    }
    if (event.overload) overloadEvents += 1;
    if (event.simulatedTimeout) simulatedTimeoutEvents += 1;
  }

  const observerPids = [...pids].filter((pid) => !creatorPids.has(pid));
  return {
    requestCounts,
    requestTotal: Object.values(requestCounts).reduce((total, count) => total + count, 0),
    observationRpcCounts,
    observationRpcTotal: Object.values(observationRpcCounts).reduce(
      (total, count) => total + count,
      0,
    ),
    threadStarts,
    uniqueThreadStarts: new Set(threadStarts).size,
    pids: [...pids],
    creatorPids: [...creatorPids],
    observerPids,
    maxReadByPid: Object.fromEntries(maxReadByPid),
    maxHydrationByPid: Object.fromEntries(maxHydrationByPid),
    foreignResumeAttempts,
    foreignResumeRequests: observerPids.reduce(
      (total, pid) => total + (resumeRequestsByPid.get(pid) ?? 0),
      0,
    ),
    activeWriterRejects,
    overloadEvents,
    simulatedTimeoutEvents,
    syntheticInterruptedEvents,
  };
}

function apiTotal(api) {
  return Object.values(api).reduce((total, count) => total + count, 0);
}

async function writeAudit(slug, payload) {
  if (!auditDirectory) return;
  try {
    await mkdir(auditDirectory, { recursive: true });
    const file = path.join(auditDirectory, `stress-${auditLabel}-${slug}.json`);
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Audit output is best effort; assertions still carry the evidence.
  }
}

function emitDiagnostic(context, result) {
  if (auditDirectory) return;
  const line = JSON.stringify({
      scenario: result.scenario,
      scale: result.scale,
      apiOperations: result.apiOperations,
      jsonRpc: {
        requestTotal: result.jsonRpc.requestTotal,
        requestCounts: result.jsonRpc.requestCounts,
        observationRpcTotal: result.jsonRpc.observationRpcTotal,
      },
      latency: result.latency,
      failedChecks: result.checks.filter((check) => !check.passed).length,
    });
  context.diagnostic(line);
  console.log(`STRESS_METRICS ${line}`);
}

async function waitAll(owner, ids, timeoutMs, api, bucket) {
  const pending = new Set(ids);
  const results = new Map();
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const batch = [...pending].slice(0, 8);
    api.wait += 1;
    const waited = await timed(bucket, () => owner.waitAgents(batch, remaining));
    for (const agent of waited.agents) {
      results.set(agent.agentId, agent);
      if (!["running", "starting"].includes(agent.status)) pending.delete(agent.agentId);
    }
    if (waited.timedOut && Date.now() >= deadline) break;
  }
  return results;
}

function clientProcessChecks(checks, summary, clients, observers) {
  checks.ok("fake App Server process count below 8", summary.pids.length < 8, {
    pids: summary.pids,
  });
  checks.equal("fake App Server process count", summary.pids.length, clients);
  checks.equal("observer process count", summary.observerPids.length, observers);
  checks.equal(
    "foreign observation resume requests (request events)",
    summary.foreignResumeRequests,
    0,
  );
}

async function warmObservers(observers, ids, api, latencies) {
  const outcomes = [];
  for (const [index, observer] of observers.entries()) {
    api.wait += 1;
    const started = performance.now();
    try {
      await observer.waitAgents([ids[0]], 0);
      outcomes.push({ observer: index, ok: true });
    } catch (error) {
      outcomes.push({ observer: index, ok: false, error: String(error?.message ?? error) });
    }
    latencies.wait.push(performance.now() - started);
  }
  return outcomes;
}

function setupChecks(checks, outcomes) {
  checks.equal(
    "observer runtime setup errors",
    outcomes.filter((outcome) => !outcome.ok).length,
    0,
    { outcomes },
  );
}

function observerReadChecks(checks, summary, limit) {
  checks.ok(
    "observer clients performed thread/read",
    summary.observerPids.length > 0 &&
      summary.observerPids.every((pid) => summary.maxReadByPid[pid] !== undefined),
    { observerPids: summary.observerPids, maxReadByPid: summary.maxReadByPid },
  );
  for (const pid of summary.observerPids) {
    const maximum = summary.maxReadByPid[pid];
    checks.ok(`client ${pid} thread/read concurrency <= ${limit}`, maximum !== undefined && maximum <= limit, {
      pid,
      maximum,
      limit,
    });
  }
  for (const pid of summary.observerPids) {
    const maximum = summary.maxHydrationByPid[pid];
    checks.ok(
      `client ${pid} hydration (read/resume) concurrency <= ${limit}`,
      maximum !== undefined && maximum <= limit,
      { pid, maximum, limit },
    );
  }
}

after(async () => {
  if (!auditDirectory) return;
  const summary = {
    label: auditLabel,
    brokerEntry: brokerEntry.href,
    createdAt: new Date().toISOString(),
    scenarios: auditResults,
  };
  try {
    await mkdir(auditDirectory, { recursive: true });
    await writeFile(
      path.join(auditDirectory, `stress-${auditLabel}-summary.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    const lines = [
      `# Broker stress ${auditLabel}`,
      "",
      `- Broker entry: \`${brokerEntry.pathname}\``,
      `- Created: ${summary.createdAt}`,
      "",
      "| Scenario | Threads | Clients | API ops | JSON-RPC ops | Checks | Failed |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...auditResults.map((result) => {
        const failed = result.checks.filter((check) => !check.passed).length;
        return `| ${result.scenario} | ${result.scale.threads} | ${result.scale.clients} | ${result.apiOperations.total} | ${result.jsonRpc.requestTotal} | ${result.checks.length} | ${failed} |`;
      }),
      "",
      "Per-scenario JSON files contain every assertion, API/RPC operation count, and latency p50/p95/max.",
      "",
    ];
    await writeFile(
      path.join(auditDirectory, `stress-${auditLabel}-summary.md`),
      lines.join("\n"),
      "utf8",
    );
  } catch {
    // Best effort.
  }
});

test("A: 96-thread active writer observation, serial hydration, no cache, followup", { timeout: 90_000 }, async (t) => {
  const checks = new Checks("A");
  const api = { spawn: 0, send: 0, wait: 0, list: 0 };
  const latencies = { spawn: [], send: [], wait: [], list: [] };
  let harness;
  let metrics = [];
  let setup = [];
  try {
    harness = await createHarness({
      observers: 4,
      control: { readDelayMs: 20, completeDelayMs: 25, holdMaxMs: 10_000 },
    });
    const threads = 96;
    const spawned = await Promise.all(
      Array.from({ length: threads }, async (_, index) => {
        api.spawn += 1;
        return timed(latencies.spawn, () =>
          harness.owner.spawnAgent({
            route: harness.route,
            task: `stress hold a-${index}`,
            cwd: harness.workspace,
          }),
        );
      }),
    );
    const ids = spawned.map((agent) => agent.agentId);
    checks.equal("created 96 unique agents", new Set(ids).size, threads);
    checks.ok(
      "spawn returned no terminal error",
      spawned.every((agent) => ["starting", "running", "completed"].includes(agent.status)),
      { statuses: [...new Set(spawned.map((agent) => agent.status))] },
    );

    api.wait += 1;
    const active = await timed(latencies.wait, () =>
      harness.owner.waitAgents(ids.slice(0, 8), 150),
    );
    checks.ok(
      "owner sees active held threads before release",
      active.timedOut === true &&
        active.agents.every((agent) => ["starting", "running"].includes(agent.status)),
      { timedOut: active.timedOut, statuses: active.agents.map((agent) => agent.status) },
    );
    setup = await warmObservers(harness.observers, ids, api, latencies);

    const expected = Object.fromEntries(
      ids.map((agentId, index) => [routeThreadId(agentId), `release-a-${index}`]),
    );
    const expectedByAgentId = new Map(
      ids.map((agentId, index) => [agentId, `release-a-${index}`]),
    );
    const releaseTimer = setTimeout(() => {
      void harness.release(Object.fromEntries(Object.entries(expected).slice(0, threads / 2)));
    }, 250);
    const unreleased = new Set(ids.slice(threads / 2));
    const lists = await Promise.all(
      harness.observers.map(async (observer, index) => {
        api.list += 1;
        return capture(checks, `observer ${index} list during active/half-release`, () =>
          timed(latencies.list, () => observer.listAgents()),
        );
      }),
    );
    clearTimeout(releaseTimer);

    for (const [index, result] of lists.entries()) {
      if (!result.ok) continue;
      const listed = result.value;
      checks.equal(`observer ${index} saw all 96 threads`, listed.length, threads);
      checks.equal(
        `observer ${index} returned only known agent ids`,
        listed.every((agent) => ids.includes(agent.agentId)),
        true,
      );
      checks.ok(
        `observer ${index} never reported terminal for active owner threads`,
        listed.every((agent) => ["starting", "running", "completed"].includes(agent.status)),
        { statuses: [...new Set(listed.map((agent) => agent.status))] },
      );
      checks.ok(
        `observer ${index} observed at least one still-active thread`,
        listed.some((agent) => ["starting", "running"].includes(agent.status)),
        { statuses: [...new Set(listed.map((agent) => agent.status))] },
      );
      checks.ok(
        `observer ${index} completed outputs match release by agentId`,
        listed
          .filter((agent) => agent.status === "completed")
          .every((agent) => agent.output === expectedByAgentId.get(agent.agentId)),
        { completed: listed.filter((agent) => agent.status === "completed").length },
      );
      checks.ok(
        `observer ${index} did not complete unreleased second half`,
        listed
          .filter((agent) => unreleased.has(agent.agentId))
          .every((agent) => ["starting", "running"].includes(agent.status)),
        {
          statuses: listed
            .filter((agent) => unreleased.has(agent.agentId))
            .map((agent) => agent.status),
        },
      );
    }

    await harness.release(expected);
    const completed = await waitAll(harness.owner, ids, 15_000, api, latencies.wait);
    checks.equal("owner waitAll completed every released thread", completed.size, threads);
    for (const agentId of ids) {
      const agent = completed.get(agentId);
      checks.ok(`agent ${agentId} completed`, agent?.status === "completed", {
        status: agent?.status,
      });
      checks.equal(
        `agent ${agentId} release output exact`,
        agent?.output,
        expectedByAgentId.get(agentId),
      );
    }

    const followups = await Promise.all(
      ids.map(async (agentId, index) => {
        api.send += 1;
        return timed(latencies.send, () => harness.owner.send(agentId, `followup:a-${index}`));
      }),
    );
    checks.ok(
      "same-thread followups accepted as running",
      followups.every((agent) => agent.status === "running"),
      { statuses: [...new Set(followups.map((agent) => agent.status))] },
    );
    checks.ok(
      "followups kept the original agent identities",
      followups.every((agent, index) => agent.agentId === ids[index]),
    );

    const followupDone = await waitAll(harness.owner, ids, 15_000, api, latencies.wait);
    checks.equal("owner waitAll completed every followup", followupDone.size, threads);
    for (const [index, agentId] of ids.entries()) {
      checks.equal(
        `followup ${index} output exact`,
        followupDone.get(agentId)?.output,
        `result:followup:a-${index}`,
      );
    }

    metrics = await harness.metrics();
  } catch (error) {
    checks.fail("scenario execution", error);
  } finally {
    if (harness) {
      if (metrics.length === 0) {
        try {
          metrics = await harness.metrics();
        } catch {
          // Keep the failure evidence already recorded.
        }
      }
      await harness.close();
    }
  }

  const summary = summarizeMetrics(metrics);
  if (harness) {
    checks.equal("thread/start RPC count (no duplicates)", summary.threadStarts.length, 96);
    checks.equal("unique thread/start ids", summary.uniqueThreadStarts, 96);
    checks.equal("foreign observation resume attempts", summary.foreignResumeAttempts, 0);
    checks.equal("active-writer rejections", summary.activeWriterRejects, 0);
    checks.equal("overload events", summary.overloadEvents, 0);
    checks.equal("simulated timeout events", summary.simulatedTimeoutEvents, 0);
    checks.equal("synthetic interrupted events", summary.syntheticInterruptedEvents, 0);
    observerReadChecks(checks, summary, 1);
    clientProcessChecks(checks, summary, 5, 4);
    setupChecks(checks, setup);
  }

  const result = {
    scenario: "A-active-observe-followup",
    scale: { threads: 96, clients: 5, owner: 1, observers: 4 },
    apiOperations: { ...api, total: apiTotal(api) },
    jsonRpc: summary,
    latency: {
      spawnMs: latency(latencies.spawn),
      sendMs: latency(latencies.send),
      waitMs: latency(latencies.wait),
      listMs: latency(latencies.list),
    },
    checks: checks.items,
  };
  auditResults.push(result);
  await writeAudit("A-active-observe-followup", result);
  emitDiagnostic(t, result);
  checks.assertAll();
});

test("B: list hydration is serial per runtime client", { timeout: 90_000 }, async (t) => {
  const checks = new Checks("B");
  const api = { spawn: 0, wait: 0, list: 0 };
  const latencies = { spawn: [], wait: [], list: [] };
  let harness;
  let metrics = [];
  let setup = [];
  try {
    harness = await createHarness({
      observers: 4,
      control: { readDelayMs: 20, completeDelayMs: 20 },
    });
    const threads = 96;
    const ids = [];
    for (let offset = 0; offset < threads; offset += 16) {
      const batch = await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          api.spawn += 1;
          return timed(latencies.spawn, () =>
            harness.owner.spawnAgent({
              route: harness.route,
              task: `serial b-${offset + index}`,
              cwd: harness.workspace,
            }),
          );
        }),
      );
      ids.push(...batch.map((agent) => agent.agentId));
    }
    const setupWait = await waitAll(harness.owner, ids, 15_000, api, latencies.wait);
    checks.equal("setup waitAll completed every thread", setupWait.size, threads);
    setup = await warmObservers(harness.observers, ids, api, latencies);

    const lists = await Promise.all(
      harness.observers.map(async (observer, index) => {
        api.list += 1;
        return capture(checks, `observer ${index} list`, () =>
          timed(latencies.list, () => observer.listAgents()),
        );
      }),
    );
    for (const [index, result] of lists.entries()) {
      if (!result.ok) continue;
      checks.equal(`observer ${index} listed all threads`, result.value.length, threads);
      checks.ok(
        `observer ${index} completed snapshots carry output`,
        result.value.every(
          (agent) => agent.status === "completed" && typeof agent.output === "string",
        ),
        { statuses: [...new Set(result.value.map((agent) => agent.status))] },
      );
    }
    metrics = await harness.metrics();
  } catch (error) {
    checks.fail("scenario execution", error);
  } finally {
    if (harness) {
      if (metrics.length === 0) {
        try {
          metrics = await harness.metrics();
        } catch {
          // Keep evidence.
        }
      }
      await harness.close();
    }
  }

  const summary = summarizeMetrics(metrics);
  if (harness) {
    checks.equal("thread/start RPC count", summary.threadStarts.length, 96);
    checks.equal("foreign observation resume attempts", summary.foreignResumeAttempts, 0);
    checks.equal("overload events", summary.overloadEvents, 0);
    checks.equal("simulated timeout events", summary.simulatedTimeoutEvents, 0);
    observerReadChecks(checks, summary, 1);
    clientProcessChecks(checks, summary, 5, 4);
    setupChecks(checks, setup);
  }

  const result = {
    scenario: "B-list-serial",
    scale: { threads: 96, clients: 5, owner: 1, observers: 4 },
    apiOperations: { ...api, total: apiTotal(api) },
    jsonRpc: summary,
    latency: {
      spawnMs: latency(latencies.spawn),
      waitMs: latency(latencies.wait),
      listMs: latency(latencies.list),
    },
    checks: checks.items,
  };
  auditResults.push(result);
  await writeAudit("B-list-serial", result);
  emitDiagnostic(t, result);
  checks.assertAll();
});

test("C: foreign wait observes completion by polling", { timeout: 60_000 }, async (t) => {
  const checks = new Checks("C");
  const api = { spawn: 0, wait: 0 };
  const latencies = { spawn: [], wait: [] };
  let harness;
  let metrics = [];
  let setup = [];
  let releaseTimer;
  let ids = [];
  let pollingWindowStart = 0;
  try {
    harness = await createHarness({
      observers: 2,
      control: { readDelayMs: 20, completeDelayMs: 25, holdMaxMs: 10_000 },
    });
    const threads = 4;
    const spawned = await Promise.all(
      Array.from({ length: threads }, async (_, index) => {
        api.spawn += 1;
        return timed(latencies.spawn, () =>
          harness.owner.spawnAgent({
            route: harness.route,
            task: `stress hold c-${index}`,
            cwd: harness.workspace,
          }),
        );
      }),
    );
    ids = spawned.map((agent) => agent.agentId);
    api.wait += 1;
    const active = await timed(latencies.wait, () => harness.owner.waitAgents(ids, 100));
    checks.ok("owner confirms held threads are running", active.timedOut === true, {
      timedOut: active.timedOut,
    });
    setup = await warmObservers(harness.observers, ids, api, latencies);

    const release = Object.fromEntries(
      ids.map((agentId, index) => [routeThreadId(agentId), `release-c-${index}`]),
    );
    const expectedByAgentId = new Map(
      ids.map((agentId, index) => [agentId, `release-c-${index}`]),
    );
    releaseTimer = setTimeout(() => {
      void harness.release(release).catch(() => undefined);
    }, 700);

    pollingWindowStart = Date.now();
    const waitDurations = [];
    const waits = await Promise.all(
      harness.observers.map(async (observer, index) => {
        api.wait += 1;
        const started = performance.now();
        const result = await capture(checks, `observer ${index} foreign wait`, () =>
          timed(latencies.wait, () => observer.waitAgents(ids, 8_000)),
        );
        waitDurations[index] = performance.now() - started;
        return result;
      }),
    );
    for (const [index, result] of waits.entries()) {
      if (!result.ok) continue;
      const waited = result.value;
      checks.equal(`observer ${index} foreign wait did not time out`, waited.timedOut, false);
      checks.ok(
        `observer ${index} foreign wait returned before 3s`,
        waitDurations[index] < 3_000,
        { durationMs: Math.round(waitDurations[index]) },
      );
      checks.ok(
        `observer ${index} saw all foreign agents complete`,
        waited.agents.every((agent) => agent.status === "completed"),
        { statuses: waited.agents.map((agent) => agent.status) },
      );
      checks.ok(
        `observer ${index} saw exact foreign outputs`,
        waited.agents.every((agent) => agent.output === expectedByAgentId.get(agent.agentId)),
        { outputs: waited.agents.map((agent) => agent.output) },
      );
    }
    metrics = await harness.metrics();
  } catch (error) {
    checks.fail("scenario execution", error);
  } finally {
    clearTimeout(releaseTimer);
    if (harness) {
      if (metrics.length === 0) {
        try {
          metrics = await harness.metrics();
        } catch {
          // Keep evidence.
        }
      }
      await harness.close();
    }
  }

  const summary = summarizeMetrics(metrics);
  if (harness) {
    checks.equal("foreign observation resume attempts", summary.foreignResumeAttempts, 0);
    checks.equal("overload events", summary.overloadEvents, 0);
    checks.equal("simulated timeout events", summary.simulatedTimeoutEvents, 0);
    const threadIds = ids.map(routeThreadId);
    for (const pid of summary.observerPids) {
      for (const threadId of threadIds) {
        const reads = (metrics ?? []).filter(
          (event) =>
            event.pid === pid &&
            event.kind === "rpc" &&
            event.method === "thread/read" &&
            event.threadId === threadId &&
            event.ts >= pollingWindowStart,
        );
        const beforeRelease = reads.filter(
          (event) => event.ts < pollingWindowStart + 700,
        ).length;
        checks.ok(
          `foreign waiter ${pid} re-read ${threadId} before release`,
          beforeRelease >= 2,
          { pid, threadId, beforeRelease, reads: reads.length },
        );
        checks.ok(
          `foreign waiter ${pid} polled ${threadId} at least three times`,
          reads.length >= 3,
          { pid, threadId, reads: reads.length },
        );
      }
      const maximum = summary.maxReadByPid[pid];
      checks.ok(`foreign waiter ${pid} read concurrency within wait fan-out`, maximum !== undefined && maximum <= 8, {
        pid,
        maximum,
        limit: 8,
      });
    }
    clientProcessChecks(checks, summary, 3, 2);
    setupChecks(checks, setup);
  }

  const result = {
    scenario: "C-foreign-wait-poll",
    scale: { threads: 4, clients: 3, owner: 1, observers: 2 },
    apiOperations: { ...api, total: apiTotal(api) },
    jsonRpc: summary,
    latency: { spawnMs: latency(latencies.spawn), waitMs: latency(latencies.wait) },
    checks: checks.items,
  };
  auditResults.push(result);
  await writeAudit("C-foreign-wait-poll", result);
  emitDiagnostic(t, result);
  checks.assertAll();
});

test("D: notLoaded synthetic interrupted history is not terminal", { timeout: 60_000 }, async (t) => {
  const checks = new Checks("D");
  const api = { spawn: 0, wait: 0, list: 0 };
  const latencies = { spawn: [], wait: [], list: [] };
  let harness;
  let metrics = [];
  let setup = [];
  try {
    harness = await createHarness({
      observers: 2,
      control: { readDelayMs: 20, completeDelayMs: 25, holdMaxMs: 10_000 },
    });
    const threads = 4;
    const spawned = await Promise.all(
      Array.from({ length: threads }, async (_, index) => {
        api.spawn += 1;
        return timed(latencies.spawn, () =>
          harness.owner.spawnAgent({
            route: harness.route,
            task: `stress synthetic d-${index}`,
            cwd: harness.workspace,
          }),
        );
      }),
    );
    const ids = spawned.map((agent) => agent.agentId);
    api.wait += 1;
    await timed(latencies.wait, () => harness.owner.waitAgents(ids, 100));
    setup = await warmObservers(harness.observers, ids, api, latencies);

    const before = await Promise.all(
      harness.observers.map(async (observer, index) => {
        api.list += 1;
        return capture(checks, `observer ${index} list before synthetic`, () =>
          timed(latencies.list, () => observer.listAgents()),
        );
      }),
    );
    for (const [index, result] of before.entries()) {
      if (!result.ok) continue;
      checks.ok(
        `observer ${index} saw running before synthetic response`,
        result.value.every((agent) => ["starting", "running"].includes(agent.status)),
        { statuses: result.value.map((agent) => agent.status) },
      );
    }

    await harness.syntheticNotLoaded(ids.map(routeThreadId));
    const during = await Promise.all(
      harness.observers.map(async (observer, index) => {
        api.list += 1;
        return capture(checks, `observer ${index} list during synthetic response`, () =>
          timed(latencies.list, () => observer.listAgents()),
        );
      }),
    );
    for (const [index, result] of during.entries()) {
      if (!result.ok) continue;
      checks.ok(
        `observer ${index} did not report synthetic interrupted as terminal`,
        result.value.every((agent) => ["starting", "running"].includes(agent.status)),
        { statuses: result.value.map((agent) => agent.status) },
      );
      checks.ok(
        `observer ${index} suppressed stale output/error on synthetic response`,
        result.value.every((agent) => agent.output === undefined && agent.error === undefined),
        {
          outputs: result.value.map((agent) => agent.output),
          errors: result.value.map((agent) => agent.error),
        },
      );
    }

    const release = Object.fromEntries(
      ids.map((agentId, index) => [routeThreadId(agentId), `release-d-${index}`]),
    );
    const expectedByAgentId = new Map(
      ids.map((agentId, index) => [agentId, `release-d-${index}`]),
    );
    await harness.release(release);
    const completed = await waitAll(harness.owner, ids, 15_000, api, latencies.wait);
    checks.equal("owner completed synthetic-held threads", completed.size, threads);
    checks.ok(
      "owner saw real completion outputs",
      ids.every((agentId) => completed.get(agentId)?.output === expectedByAgentId.get(agentId)),
      { outputs: ids.map((agentId) => completed.get(agentId)?.output) },
    );

    const afterCompletion = await Promise.all(
      harness.observers.map(async (observer, index) => {
        api.list += 1;
        return capture(checks, `observer ${index} list after real completion`, () =>
          timed(latencies.list, () => observer.listAgents()),
        );
      }),
    );
    for (const [index, result] of afterCompletion.entries()) {
      if (!result.ok) continue;
      checks.ok(
        `observer ${index} returned real completed status after synthetic cleared`,
        result.value.every((agent) => agent.status === "completed"),
        { statuses: result.value.map((agent) => agent.status) },
      );
      checks.ok(
        `observer ${index} returned real completion outputs`,
        result.value.every((agent) => agent.output === expectedByAgentId.get(agent.agentId)),
        { outputs: result.value.map((agent) => agent.output) },
      );
    }
    metrics = await harness.metrics();
  } catch (error) {
    checks.fail("scenario execution", error);
  } finally {
    if (harness) {
      if (metrics.length === 0) {
        try {
          metrics = await harness.metrics();
        } catch {
          // Keep evidence.
        }
      }
      await harness.close();
    }
  }

  const summary = summarizeMetrics(metrics);
  if (harness) {
    checks.ok(
      "synthetic notLoaded interrupted response was actually exercised",
      summary.syntheticInterruptedEvents > 0,
      { syntheticInterruptedEvents: summary.syntheticInterruptedEvents },
    );
    checks.equal("foreign observation resume attempts", summary.foreignResumeAttempts, 0);
    checks.equal("overload events", summary.overloadEvents, 0);
    checks.equal("simulated timeout events", summary.simulatedTimeoutEvents, 0);
    observerReadChecks(checks, summary, 1);
    clientProcessChecks(checks, summary, 3, 2);
    setupChecks(checks, setup);
  }

  const result = {
    scenario: "D-synthetic-notloaded",
    scale: { threads: 4, clients: 3, owner: 1, observers: 2 },
    apiOperations: { ...api, total: apiTotal(api) },
    jsonRpc: summary,
    latency: {
      spawnMs: latency(latencies.spawn),
      waitMs: latency(latencies.wait),
      listMs: latency(latencies.list),
    },
    checks: checks.items,
  };
  auditResults.push(result);
  await writeAudit("D-synthetic-notloaded", result);
  emitDiagnostic(t, result);
  checks.assertAll();
});

test("E: foreign snapshots are not cached across same-thread followup", { timeout: 60_000 }, async (t) => {
  const checks = new Checks("E");
  const api = { spawn: 0, send: 0, wait: 0, list: 0 };
  const latencies = { spawn: [], send: [], wait: [], list: [] };
  let harness;
  let metrics = [];
  let setup = [];
  try {
    harness = await createHarness({
      observers: 1,
      control: { readDelayMs: 15, completeDelayMs: 20, holdMaxMs: 10_000 },
    });
    const threads = 8;
    const spawned = await Promise.all(
      Array.from({ length: threads }, async (_, index) => {
        api.spawn += 1;
        return timed(latencies.spawn, () =>
          harness.owner.spawnAgent({
            route: harness.route,
            task: `initial e-${index}`,
            cwd: harness.workspace,
          }),
        );
      }),
    );
    const ids = spawned.map((agent) => agent.agentId);
    const first = await waitAll(harness.owner, ids, 15_000, api, latencies.wait);
    checks.equal("initial owner completion", first.size, threads);
    const initialByAgentId = new Map(
      ids.map((agentId, index) => [agentId, `result:initial e-${index}`]),
    );
    setup = await warmObservers(harness.observers, ids, api, latencies);

    api.list += 1;
    const initial = await capture(checks, "observer initial list", () =>
      timed(latencies.list, () => harness.observers[0].listAgents()),
    );
    if (initial.ok) {
      checks.ok(
        "observer initially saw completed outputs",
        initial.value.every(
          (agent) =>
            agent.status === "completed" && agent.output === initialByAgentId.get(agent.agentId),
        ),
        { statuses: initial.value.map((agent) => agent.status) },
      );
    }

    await Promise.all(
      ids.map(async (agentId, index) => {
        api.send += 1;
        return timed(latencies.send, () =>
          harness.owner.send(agentId, `hold stale e-${index}`),
        );
      }),
    );
    await sleep(80);
    api.list += 1;
    const during = await capture(checks, "observer list during followup", () =>
      timed(latencies.list, () => harness.observers[0].listAgents()),
    );
    if (during.ok) {
      checks.ok(
        "observer did not serve stale completed snapshot during followup",
        during.value.every((agent) => ["starting", "running"].includes(agent.status)),
        { statuses: during.value.map((agent) => agent.status) },
      );
      checks.ok(
        "observer did not expose pre-followup output during followup",
        during.value.every((agent) => agent.output === undefined),
        { outputs: during.value.map((agent) => agent.output) },
      );
    }

    const release = Object.fromEntries(
      ids.map((agentId, index) => [routeThreadId(agentId), `followup-stale e-${index}`]),
    );
    const followupByAgentId = new Map(
      ids.map((agentId, index) => [agentId, `followup-stale e-${index}`]),
    );
    await harness.release(release);
    const finalOwner = await waitAll(harness.owner, ids, 15_000, api, latencies.wait);
    checks.equal("owner followup waitAll completed", finalOwner.size, threads);
    checks.ok(
      "owner followup outputs exact",
      ids.every((agentId) => finalOwner.get(agentId)?.output === followupByAgentId.get(agentId)),
      { outputs: ids.map((agentId) => finalOwner.get(agentId)?.output) },
    );

    api.list += 1;
    const final = await capture(checks, "observer final list", () =>
      timed(latencies.list, () => harness.observers[0].listAgents()),
    );
    if (final.ok) {
      checks.ok(
        "observer read final followup outputs without stale cache",
        final.value.every(
          (agent) =>
            agent.status === "completed" && agent.output === followupByAgentId.get(agent.agentId),
        ),
        { outputs: final.value.map((agent) => agent.output) },
      );
    }
    metrics = await harness.metrics();
  } catch (error) {
    checks.fail("scenario execution", error);
  } finally {
    if (harness) {
      if (metrics.length === 0) {
        try {
          metrics = await harness.metrics();
        } catch {
          // Keep evidence.
        }
      }
      await harness.close();
    }
  }

  const summary = summarizeMetrics(metrics);
  if (harness) {
    checks.equal("thread/start RPC count (followup did not create threads)", summary.threadStarts.length, 8);
    checks.equal("foreign observation resume attempts", summary.foreignResumeAttempts, 0);
    checks.equal("overload events", summary.overloadEvents, 0);
    checks.equal("simulated timeout events", summary.simulatedTimeoutEvents, 0);
    observerReadChecks(checks, summary, 1);
    clientProcessChecks(checks, summary, 2, 1);
    setupChecks(checks, setup);
  }

  const result = {
    scenario: "E-foreign-no-cache",
    scale: { threads: 8, clients: 2, owner: 1, observers: 1 },
    apiOperations: { ...api, total: apiTotal(api) },
    jsonRpc: summary,
    latency: {
      spawnMs: latency(latencies.spawn),
      sendMs: latency(latencies.send),
      waitMs: latency(latencies.wait),
      listMs: latency(latencies.list),
    },
    checks: checks.items,
  };
  auditResults.push(result);
  await writeAudit("E-foreign-no-cache", result);
  emitDiagnostic(t, result);
  checks.assertAll();
});
