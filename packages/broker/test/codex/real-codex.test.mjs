// Drives the packaged Broker STDIO server against the real `codex` binary.
// The provider is a local mock (./mock-responses.mjs); no provider account,
// key, or network access is used. Every Codex home, Broker data directory and
// workspace is temporary, so ~/.codex is never read or written.
//
// Run with `npm run test:codex`. Set MIXAGENTS_BROKER_CODEX_BIN to test a
// specific Codex build instead of the `codex` on PATH.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startMockProvider } from "./mock-responses.mjs";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverPath = path.join(packageRoot, "plugin", "mixagents-broker", "dist", "server.js");
const WAIT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;

const ROUTES = {
  alpha: { key: "ALPHA_ROUTE_KEY", secret: "alpha-route-secret-6f1c", model: "mock-alpha-model" },
  beta: { key: "BETA_ROUTE_KEY", secret: "beta-route-secret-93ad", model: "mock-beta-model" },
};

async function findCodex() {
  const configured = process.env.MIXAGENTS_BROKER_CODEX_BIN;
  if (configured) return path.resolve(configured);
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  throw new Error(
    "No `codex` on PATH. Install it (npm install --global @openai/codex) or set MIXAGENTS_BROKER_CODEX_BIN.",
  );
}

const codexBin = await findCodex();
const codexVersion = (await promisify(execFile)(codexBin, ["--version"])).stdout.trim();
console.log(`Real Codex check against ${codexVersion} (${codexBin})`);

// Names the broken promise and the Codex build in every failure.
function promise(name, ...rest) {
  const body = rest.pop();
  const options = rest[0] ?? {};
  test(`[${codexVersion}] ${name}`, { timeout: TEST_TIMEOUT_MS, ...options }, async () => {
    try {
      await body();
    } catch (error) {
      const wrapped = new Error(
        `Broker promise broken on ${codexVersion}: ${name}\n${error?.message ?? error}`,
        { cause: error },
      );
      throw wrapped;
    }
  });
}

class McpClient {
  constructor(child) {
    this.child = child;
    this.elicitations = [];
    this.nextId = 1;
    this.pending = new Map();
    readline
      .createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on("line", (line) => this.#accept(JSON.parse(line)));
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.#send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #accept(message) {
    if (message.method === "elicitation/create") {
      // Stands in for the host approving a worker's approval request.
      this.elicitations.push(message.params);
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: { action: "accept", content: { decision: "approve" } },
      });
      return;
    }
    if (message.method && message.id !== undefined) {
      // The client advertises no roots; refuse anything else.
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unsupported client method" },
      });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
}

// Writes a two-route Broker configuration. Both routes point at the mock, on
// different base paths, so every request shows which route sent it.
async function prepareInstallation(mock) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "mixagents-broker-codex-")));
  const installation = {
    root,
    home: path.join(root, "home"),
    codexHome: path.join(root, "codex-home"),
    dataDir: path.join(root, "state"),
    workspace: path.join(root, "workspace"),
    configPath: path.join(root, "broker.json"),
  };
  await Promise.all(
    [installation.home, installation.codexHome, installation.workspace].map((directory) =>
      mkdir(directory),
    ),
  );
  const routes = {};
  for (const [id, route] of Object.entries(ROUTES)) {
    routes[id] = {
      description: `Mock route ${id}`,
      provider: `mock_${id}`,
      providerName: `Mock ${id}`,
      model: route.model,
      baseUrl: `${mock.origin}/${id}/v1`,
      envKey: route.key,
      maxAccess: "read-only",
    };
  }
  await writeFile(
    installation.configPath,
    `${JSON.stringify(
      {
        workspaceRoots: [installation.workspace],
        dataDir: installation.dataDir,
        codexBin,
        routes,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return installation;
}

// Starts one Broker MCP server over an installation. Two servers over one
// installation share its data directory.
async function launchBroker(installation) {
  const environment = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    HOME: installation.home,
    USERPROFILE: installation.home,
    CODEX_HOME: installation.codexHome,
    MIXAGENTS_BROKER_CONFIG: installation.configPath,
    MIXAGENTS_BROKER_CREDENTIALS_JSON: JSON.stringify(
      Object.fromEntries(Object.values(ROUTES).map((route) => [route.key, route.secret])),
    ),
    // Any request that is not for the local mock goes to a closed port, so
    // nothing leaves the machine even if Codex tries to reach a service.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  for (const name of Object.keys(environment)) {
    if (environment[name] === undefined) delete environment[name];
  }
  const child = spawn(process.execPath, [serverPath], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const client = new McpClient(child);
  await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: {} },
    clientInfo: { name: "broker-codex-check", version: "1" },
  });
  client.notify("notifications/initialized");

  async function call(name, args = {}) {
    const result = await client.request("tools/call", { name, arguments: args });
    if (result.isError) {
      throw new Error(
        `${name} returned an error: ${JSON.stringify(result.structuredContent ?? result.content)}` +
          (stderr.length ? `\nBroker stderr:\n${stderr.join("")}` : ""),
      );
    }
    return result.structuredContent;
  }

  const handle = {
    pid: child.pid,
    call,
    // Returns the error a tool reports instead of throwing it.
    async refusal(name, args = {}) {
      const result = await client.request("tools/call", { name, arguments: args });
      assert.equal(result.isError, true, `${name} succeeded: ${JSON.stringify(result.structuredContent)}`);
      return result.structuredContent;
    },
    elicitations: client.elicitations,
    spawn(route, task) {
      return call("spawn_agent", { route, task, cwd: installation.workspace });
    },
    async wait(agentId) {
      const result = await call("wait_agent", { agentIds: [agentId], timeoutMs: WAIT_MS });
      return result.agents[0];
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  openBrokers.add(handle);
  return handle;
}

// Every Broker started by this file, so `after` can stop them all.
const openBrokers = new Set();

// The processes below a Broker server: Codex App Server and any wrapper.
// Linux only, from /proc.
async function descendants(pid) {
  const parents = new Map();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      parents.set(Number(entry), parent);
    } catch {
      // The process exited while we looked.
    }
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [child, parent] of parents) {
      if (parent === current) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function describeRequests(requests) {
  return requests
    .map((record) => `${record.method} ${record.path} auth=${record.authorization ? "set" : "none"}`)
    .join("\n");
}

let mock;
let installation;
let broker;
const agents = {};

before(async () => {
  mock = await startMockProvider();
  installation = await prepareInstallation(mock);
  broker = await launchBroker(installation);
});

after(async () => {
  for (const open of openBrokers) await open.close();
  await mock?.close();
  if (installation) await rm(installation.root, { recursive: true, force: true });
});

describe("one Broker process", () => {
  promise("routes reports configured routes as available without calling the provider", async () => {
    const { routes } = await broker.call("routes");
    for (const id of Object.keys(ROUTES)) {
      const route = routes.find((candidate) => candidate.id === id);
      assert.ok(route, `route ${id} is missing from routes`);
      assert.equal(route.available, true, `route ${id} should be available`);
      assert.equal(route.model, ROUTES[id].model);
    }
    assert.equal(mock.requests.length, 0, "routes must not contact the provider");
  });

  promise("spawn_agent and wait_agent return the worker's final text", async () => {
    const spawned = await broker.spawn("alpha", "First task. [[reply:alpha-first]]");
    assert.ok(["starting", "running"].includes(spawned.status), `spawn status ${spawned.status}`);
    assert.equal(spawned.model, ROUTES.alpha.model);
    agents.followUp = spawned.agentId;

    const waited = await broker.wait(spawned.agentId);
    assert.equal(waited.status, "completed", JSON.stringify(waited));
    assert.equal(waited.output, "mock final: alpha-first");
  });

  promise("only the selected route's endpoint, model and credential are used", async () => {
    const requests = mock.responseRequests();
    assert.ok(requests.length > 0, "the provider saw no request");
    for (const record of requests) {
      assert.ok(record.path.startsWith("/alpha/"), `request went to ${record.path}`);
      assert.equal(record.authorization, `Bearer ${ROUTES.alpha.secret}`);
      assert.equal(record.body?.model, ROUTES.alpha.model);
    }
    for (const record of mock.requests) {
      assert.ok(!record.path.startsWith("/beta/"), `unused route beta was contacted: ${record.path}`);
      const seen = `${record.authorization ?? ""}\n${record.rawBody}`;
      assert.ok(!seen.includes(ROUTES.beta.secret), "route beta's credential reached the provider");
    }
  });

  promise("workers are offered no Broker or multi-agent delegation tools", async () => {
    const first = mock.responseRequests()[0];
    assert.ok(first, "the provider saw no request");
    const delegation = first.tools.filter((name) => /agent|broker/i.test(name));
    assert.deepEqual(delegation, [], `worker tools: ${first.tools.join(", ")}`);
  });

  promise("send to a completed agent starts a follow-up turn on the same thread", async () => {
    const before = mock.responseRequests().length;
    const sent = await broker.call("send", {
      agentId: agents.followUp,
      message: "Second task. [[reply:alpha-second]]",
    });
    assert.equal(sent.agentId, agents.followUp);
    const waited = await broker.wait(agents.followUp);
    assert.equal(waited.status, "completed", JSON.stringify(waited));
    assert.equal(waited.output, "mock final: alpha-second");

    const followUp = mock.responseRequests().slice(before).at(0);
    assert.ok(followUp, "the follow-up turn made no provider request");
    assert.match(
      followUp.rawBody,
      /\[\[reply:alpha-first\]\]/,
      "the follow-up request does not carry the first turn, so it is not the same thread",
    );
  });

  promise("a provider failure surfaces as failed with an error", async () => {
    const spawned = await broker.spawn("alpha", "This one fails. [[mock:fail]]");
    agents.failed = spawned.agentId;
    const waited = await broker.wait(spawned.agentId);
    assert.equal(waited.status, "failed", JSON.stringify(waited));
    assert.equal(typeof waited.error, "string");
    assert.notEqual(waited.error.trim(), "", "a failed turn must carry an error");
  });

  promise("interrupt_agent stops an open turn and the thread accepts a later send", async () => {
    const task = "Hold this one open. [[mock:hold]] [[reply:held]]";
    const spawned = await broker.spawn("alpha", task);
    agents.interrupted = spawned.agentId;
    await mock.waitFor((record) => record.userText.includes("[[mock:hold]]"), WAIT_MS, "the held turn");

    const interrupted = await broker.call("interrupt_agent", { agentId: spawned.agentId });
    assert.equal(interrupted.previousStatus, "running");
    assert.equal(interrupted.agent.status, "interrupted");
    const waited = await broker.wait(spawned.agentId);
    assert.equal(waited.status, "interrupted", JSON.stringify(waited));

    await broker.call("send", {
      agentId: spawned.agentId,
      message: "Continue normally. [[reply:after-interrupt]]",
    });
    const resumed = await broker.wait(spawned.agentId);
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    assert.equal(resumed.output, "mock final: after-interrupt");

    // Leave one agent interrupted for the restart check.
    const left = await broker.spawn("alpha", "Hold this one too. [[mock:hold]] [[reply:left]]");
    agents.leftInterrupted = left.agentId;
    await mock.waitFor((record) => record.userText.includes("[[reply:left]]"), WAIT_MS, "the second held turn");
    const stopped = await broker.call("interrupt_agent", { agentId: left.agentId });
    assert.equal(stopped.agent.status, "interrupted");
  });

  promise("the route credential is not visible to a worker shell command", async () => {
    const spawned = await broker.spawn("alpha", "Print the environment. [[mock:env]]");
    agents.environment = spawned.agentId;
    const first = await mock.waitFor(
      (record) => record.userText.includes("[[mock:env]]"),
      WAIT_MS,
      "the environment turn",
    );
    const waited = await broker.wait(spawned.agentId);
    assert.equal(waited.status, "completed", JSON.stringify(waited));
    assert.notEqual(
      waited.output,
      "mock: no shell tool",
      `no known shell tool in this build; tools offered: ${first.tools.join(", ")}`,
    );
    assert.ok(
      broker.elicitations.some((request) => /run a command outside its sandbox/.test(request.message)),
      "the escalated command's approval request did not reach the host",
    );

    const outputs = mock
      .responseRequests()
      .flatMap((record) => record.functionOutputs)
      .filter((item) => /^call_env_/.test(item.call_id));
    assert.equal(outputs.length, 1, "Codex did not return the shell command's output");
    const text = typeof outputs[0].output === "string"
      ? outputs[0].output
      : JSON.stringify(outputs[0].output);
    // The command must actually have run, or the absence below proves nothing.
    assert.match(text, /\bPATH=/, `the shell command did not run:\n${text.slice(0, 800)}`);
    for (const route of Object.values(ROUTES)) {
      assert.ok(!text.includes(route.secret), `${route.key}'s value is visible to worker commands`);
      assert.ok(!text.includes(`${route.key}=`), `${route.key} is set in worker commands`);
    }
  });
});

describe("Broker restart on the same data directory", () => {
  promise("a fresh Broker process recovers agents from App Server history", async () => {
    await broker.close();
    const providerRequests = mock.requests.length;
    broker = await launchBroker(installation);

    const { agents: listed } = await broker.call("list_agents");
    const expected = [
      ["follow-up agent", agents.followUp, "completed"],
      ["failed agent", agents.failed, "failed"],
      ["interrupted then resumed agent", agents.interrupted, "completed"],
      ["interrupted agent", agents.leftInterrupted, "interrupted"],
      ["shell agent", agents.environment, "completed"],
    ];
    assert.ok(agents.followUp, "no agent was created earlier in this run");
    for (const [label, agentId, status] of expected) {
      if (!agentId) continue; // Its own check already failed.
      const found = listed.find((agent) => agent.agentId === agentId);
      assert.ok(found, `list_agents does not include the ${label}`);
      assert.equal(found.status, status, `list_agents status of the ${label}`);
    }

    const recovered = await broker.wait(agents.followUp);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.output, "mock final: alpha-second");
    assert.equal(
      mock.requests.length,
      providerRequests,
      `recovery must not call the provider:\n${describeRequests(mock.requests.slice(providerRequests))}`,
    );
  });
});

// Two Codex chats each start their own Broker over one data directory. The
// Broker that started a worker owns it through its App Server's writer lock;
// the other reads the thread and must not take it over while that lock is
// held. This depends on how real Codex reports a thread loaded in another
// process and on the wording of its writer-lock refusal.
describe("two Broker processes on one data directory", () => {
  let shared;
  let owner;
  let observer;
  let held;

  before(async () => {
    shared = await prepareInstallation(mock);
    owner = await launchBroker(shared);
    observer = await launchBroker(shared);
  });

  after(async () => {
    await owner?.close();
    await observer?.close();
    if (shared) await rm(shared.root, { recursive: true, force: true });
  });

  async function spawnHeld(by, label) {
    const spawned = await by.call("spawn_agent", {
      route: "alpha",
      task: `Hold this open. [[mock:hold]] [[reply:${label}]]`,
      cwd: shared.workspace,
    });
    await mock.waitFor(
      (record) => record.userText.includes(`[[reply:${label}]]`),
      WAIT_MS,
      `the held turn ${label}`,
    );
    return spawned.agentId;
  }

  promise("another chat lists and waits on a running worker without an error", async () => {
    held = await spawnHeld(owner, "shared-held");
    const { agents: listed } = await observer.call("list_agents");
    assert.equal(listed.find((agent) => agent.agentId === held)?.status, "running");
    const waited = await observer.call("wait_agent", { agentIds: [held], timeoutMs: 1_500 });
    assert.equal(waited.timedOut, true);
    assert.equal(waited.agents[0].status, "running");
  });

  promise("another chat's send and interrupt_agent are refused as agent_owned_elsewhere", async () => {
    assert.ok(held, "no running worker from the previous check");
    const sent = await observer.refusal("send", { agentId: held, message: "take it" });
    assert.equal(sent.code, "agent_owned_elsewhere", JSON.stringify(sent));
    const interrupted = await observer.refusal("interrupt_agent", { agentId: held });
    assert.equal(interrupted.code, "agent_owned_elsewhere", JSON.stringify(interrupted));
  });

  promise("another chat sees the owner's interrupt", async () => {
    assert.ok(held, "no running worker from the previous check");
    const stopped = await owner.call("interrupt_agent", { agentId: held });
    assert.equal(stopped.agent.status, "interrupted");
    const waited = await observer.call("wait_agent", { agentIds: [held], timeoutMs: 10_000 });
    assert.equal(waited.timedOut, false, JSON.stringify(waited));
    assert.equal(waited.agents[0].status, "interrupted");
  });

  promise("after the owner's Broker exits, another chat continues the thread", async () => {
    assert.ok(held, "no worker from the previous checks");
    await owner.close();
    const before = mock.responseRequests().length;
    await observer.call("send", { agentId: held, message: "Carry on. [[reply:taken-over]]" });
    const waited = await observer.wait(held);
    assert.equal(waited.status, "completed", JSON.stringify(waited));
    assert.equal(waited.output, "mock final: taken-over");
    const continued = mock.responseRequests().slice(before).at(0);
    assert.match(
      continued?.rawBody ?? "",
      /\[\[reply:shared-held\]\]/,
      "the continued turn does not carry the owner's history",
    );
  });

  promise(
    "after the owner's App Server is killed, another chat sees interrupted and continues",
    { skip: process.platform !== "linux" && "finds App Server processes through /proc" },
    async () => {
      owner = await launchBroker(shared);
      const crashed = await spawnHeld(owner, "crashed-held");
      const victims = await descendants(owner.pid);
      assert.ok(victims.length > 0, "found no App Server process under the owner's Broker");
      for (const pid of victims) process.kill(pid, "SIGKILL");
      const deadline = Date.now() + 10_000;
      while (victims.some(isAlive)) {
        assert.ok(Date.now() < deadline, "the owner's App Server did not exit");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const waited = await observer.call("wait_agent", { agentIds: [crashed], timeoutMs: 10_000 });
      assert.equal(waited.timedOut, false, JSON.stringify(waited));
      assert.equal(waited.agents[0].status, "interrupted");
      await observer.call("send", { agentId: crashed, message: "Carry on. [[reply:after-crash]]" });
      const continued = await observer.wait(crashed);
      assert.equal(continued.status, "completed", JSON.stringify(continued));
      assert.equal(continued.output, "mock final: after-crash");
    },
  );
});
