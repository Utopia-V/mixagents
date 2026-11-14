import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Broker } from "../plugin/mixagents-broker/dist/broker.js";
import {
  parseAgentId,
  renderRuntimeConfig,
  RuntimeManager,
  runtimeIdFor,
} from "../plugin/mixagents-broker/dist/app-server.js";
import { BrokerError } from "../plugin/mixagents-broker/dist/errors.js";
import {
  materializeCredentialEnvironment,
  parseConfig,
} from "../plugin/mixagents-broker/dist/config.js";
import {
  buildProcessInvocation,
  resolveCodexProcess,
} from "../plugin/mixagents-broker/dist/codex-process.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

const sharedRoute = {
  id: "shared-route",
  description: "Shared offline fake provider",
  provider: "fake_provider",
  providerName: "Fake Provider",
  model: "fake-model",
  baseUrl: "http://127.0.0.1:19091",
  envKey: "TEST_PROVIDER_KEY",
  envHttpHeaders: {},
  tags: ["offline"],
  maxAccess: "workspace-write",
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function sharedHarness(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mixagents-broker-shared-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "state");
  const fixtureState = path.join(root, "fixture");
  await mkdir(workspace);
  await mkdir(fixtureState);
  const environment = {
    ...process.env,
    TEST_PROVIDER_KEY: "test-secret-value",
    UNRELATED_SECRET: "must-not-reach-route-runtime",
  };
  const config = {
    path: path.join(root, "broker.json"),
    workspaceRoots: [workspace],
    dataDir,
    codexBin: "codex",
    routes: [sharedRoute],
  };
  const opened = [];
  const fixtureOverride = (owner, completeAfterMs = 0) => ({
    command: process.execPath,
    prefixArgs: [
      fixturePath,
      "--state",
      fixtureState,
      "--owner",
      owner,
      "--complete-after-ms",
      String(completeAfterMs),
    ],
  });
  const openBroker = async (owner, completeAfterMs = 0) => {
    const broker = new Broker(config, {
      environment,
      processOverride: fixtureOverride(owner, completeAfterMs),
    });
    opened.push(broker);
    return broker;
  };
  t.after(async () => {
    for (const broker of opened.reverse()) {
      try {
        await broker.close();
      } catch {
        // Best-effort cleanup; the fixture also exits when stdin closes.
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    dataDir,
    fixtureState,
    environment,
    config,
    fixtureOverride,
    openBroker,
  };
}

async function spawnShared(broker, workspace, task = "slow shared task") {
  return broker.spawnAgent({
    route: sharedRoute.id,
    task,
    cwd: workspace,
    access: "workspace-write",
  });
}

function threadIdOf(snapshot) {
  return parseAgentId(snapshot.agentId).threadId;
}

async function readFixtureCalls(fixtureState) {
  try {
    const text = await readFile(path.join(fixtureState, "calls.jsonl"), "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function fixtureCallsBy(fixtureState, owner) {
  return (await readFixtureCalls(fixtureState)).filter((call) => call.owner === owner);
}

async function patchFixtureThread(fixtureState, threadId, patch) {
  const file = path.join(fixtureState, "fake-app-server.json");
  const registry = JSON.parse(await readFile(file, "utf8"));
  Object.assign(registry.threads[threadId], patch);
  await writeFile(file, `${JSON.stringify(registry)}\n`, "utf8");
}

async function waitForOwnerRelease(fixtureState, threadId) {
  const ownerFile = path.join(fixtureState, "owners", `${threadId}.json`);
  await waitFor(async () => {
    try {
      const owner = JSON.parse(await readFile(ownerFile, "utf8"));
      return !processAlive(owner.pid);
    } catch {
      return true;
    }
  }, "owner marker was not released");
}

function brokerErrorCode(expectedCode) {
  return (error) => {
    assert.ok(
      error instanceof BrokerError,
      `expected BrokerError, got ${error?.constructor?.name ?? typeof error}: ${error?.message}`,
    );
    assert.equal(error.code, expectedCode);
    return true;
  };
}

function assertForeignRead(calls) {
  const reads = calls.filter((call) => call.method === "thread/read");
  assert.ok(reads.length >= 1, "expected thread/read");
  assert.ok(
    reads.every((call) => call.params.includeTurns === true),
    "foreign snapshots should request full turns",
  );
  assert.equal(calls.some((call) => call.method === "thread/resume"), false);
}

async function harness(routeOverrides = {}, extraRoutes = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mixagents-broker-test-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "state");
  const configPath = path.join(root, "broker.json");
  await mkdir(workspace);
  const config = {
    defaultRoute: "test-route",
    workspaceRoots: [workspace],
    dataDir,
    routes: {
      "test-route": {
        description: "Offline fake provider",
        provider: "fake_provider",
        providerName: "Fake Provider",
        model: "fake-model",
        baseUrl: "http://127.0.0.1:19091",
        envKey: "TEST_PROVIDER_KEY",
        tags: ["offline"],
        maxAccess: "workspace-write",
        ...routeOverrides,
      },
      ...extraRoutes,
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const environment = {
    ...process.env,
    TEST_PROVIDER_KEY: "test-secret-value",
    SECOND_PROVIDER_KEY: "second-test-secret-value",
    UNRELATED_SECRET: "must-not-reach-route-runtime",
  };
  const options = {
    configPath,
    environment,
    processOverride: { command: process.execPath, prefixArgs: [fixturePath] },
  };
  const broker = await Broker.create(options);
  return {
    root,
    workspace,
    dataDir,
    configPath,
    environment,
    options,
    broker,
    async close() {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("routes are offline and expose the effective provider", async () => {
  const app = await harness();
  try {
    assert.deepEqual(app.broker.routes(), [
      {
        id: "test-route",
        description: "Offline fake provider",
        provider: "fake_provider",
        model: "fake-model",
        tags: ["offline"],
        available: true,
        missingEnvironment: [],
        maxAccess: "workspace-write",
        backend: "app_server",
        selectionReason:
          "Current native Codex children cannot use a provider distinct from the controller; App Server preserves this route.",
        nativeAgentType: null,
        default: true,
      },
    ]);
  } finally {
    await app.close();
  }
});

test("a managed agent returns final text and accepts a follow-up turn", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "first task",
      cwd: app.workspace,
    });
    assert.equal(spawned.backend, "app_server");
    assert.equal(spawned.provider, "fake_provider");
    assert.equal(spawned.model, "fake-model");

    const first = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.equal(first.timedOut, false);
    assert.equal(first.agents[0].status, "completed");
    assert.equal(first.agents[0].output, "result:first task");

    const sent = await app.broker.send(spawned.agentId, "second task");
    assert.equal(sent.status, "running");
    const second = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.equal(second.agents[0].status, "completed");
    assert.equal(second.agents[0].output, "result:second task");
  } finally {
    await app.close();
  }
});

test("different provider routes run as independent agents", async () => {
  const app = await harness(
    {},
    {
      "second-route": {
        description: "Second offline provider",
        provider: "second_provider",
        model: "second-model",
        baseUrl: "http://127.0.0.1:19092",
        envKey: "SECOND_PROVIDER_KEY",
      },
    },
  );
  try {
    const [first, second] = await Promise.all([
      app.broker.spawnAgent({
        route: "test-route",
        task: "first provider",
        cwd: app.workspace,
      }),
      app.broker.spawnAgent({
        route: "second-route",
        task: "second provider",
        cwd: app.workspace,
      }),
    ]);
    assert.equal(first.provider, "fake_provider");
    assert.equal(second.provider, "second_provider");
    assert.notEqual(parseAgentId(first.agentId).runtimeId, parseAgentId(second.agentId).runtimeId);
    const waited = await app.broker.waitAgents([first.agentId, second.agentId], 2_000);
    assert.equal(waited.agents.some((agent) => agent.status === "completed"), true);
    const all = await Promise.all([
      app.broker.waitAgents([first.agentId], 2_000),
      app.broker.waitAgents([second.agentId], 2_000),
    ]);
    assert.deepEqual(
      all.map((result) => result.agents[0].output).sort(),
      ["result:first provider", "result:second provider"],
    );
  } finally {
    await app.close();
  }
});

test("interrupt ends the active turn but keeps the agent reusable", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "slow task",
      cwd: app.workspace,
    });
    const interrupted = await app.broker.interruptAgent(spawned.agentId);
    assert.equal(interrupted.previousStatus, "running");
    assert.equal(interrupted.agent.status, "interrupted");
    assert.equal(interrupted.providerMayContinue, true);

    await app.broker.send(spawned.agentId, "resume task");
    const resumed = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.equal(resumed.agents[0].output, "result:resume task");
  } finally {
    await app.close();
  }
});

test("host elicitation is relayed without adding a public pending-action state", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "approval task",
      cwd: app.workspace,
      access: "workspace-write",
    });
    let prompts = 0;
    const result = await app.broker.waitAgents([spawned.agentId], 2_000, {
      async elicit(request) {
        prompts += 1;
        assert.equal(request.mode, "form");
        return { action: "accept", content: { decision: "approve" } };
      },
    });
    assert.equal(prompts, 1);
    assert.equal(result.agents[0].status, "completed");
    assert.equal(result.agents[0].output, "approval:approved");
  } finally {
    await app.close();
  }
});

test("App Server remains the history owner across Broker restart", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "persist me",
      cwd: app.workspace,
    });
    await app.broker.waitAgents([spawned.agentId], 2_000);
    await app.broker.close();

    const restarted = await Broker.create(app.options);
    try {
      const listed = await restarted.listAgents();
      const recovered = listed.find((agent) => agent.agentId === spawned.agentId);
      assert.equal(recovered?.status, "completed");
      assert.equal(recovered?.output, "result:persist me");

      await restarted.send(spawned.agentId, "after restart");
      const result = await restarted.waitAgents([spawned.agentId], 2_000);
      assert.equal(result.agents[0].output, "result:after restart");
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(app.root, { recursive: true, force: true });
  }
});

test("an unexpected App Server exit is recovered from persisted thread history", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "crash after persist",
      cwd: app.workspace,
    });
    const result = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.equal(result.timedOut, false);
    assert.equal(result.agents[0].status, "completed");
    assert.equal(result.agents[0].output, "result:recovered after crash");
  } finally {
    await app.close();
  }
});

test("runtime files contain provider references but never credential values", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "inspect runtime",
      cwd: app.workspace,
    });
    const { runtimeId } = parseAgentId(spawned.agentId);
    const runtimeConfig = await readFile(
      path.join(app.dataDir, "runtimes", runtimeId, "config.toml"),
      "utf8",
    );
    assert.match(runtimeConfig, /model_provider = "fake_provider"/);
    assert.match(runtimeConfig, /multi_agent = false/);
    assert.match(runtimeConfig, /plugins = false/);
    assert.match(runtimeConfig, /"TEST_PROVIDER_KEY" = "exclude"/);
    assert.doesNotMatch(runtimeConfig, /test-secret-value/);
  } finally {
    await app.close();
  }
});

test("a route runtime receives its selected credential but not unrelated credentials", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "environment audit",
      cwd: app.workspace,
    });
    const result = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.deepEqual(JSON.parse(result.agents[0].output), {
      selectedCredential: true,
      unrelatedCredential: false,
    });
  } finally {
    await app.close();
  }
});

test("an App Server model substitution is rejected before the first worker turn", async () => {
  const app = await harness({ model: "force-mismatch" });
  try {
    await assert.rejects(
      app.broker.spawnAgent({
        route: "test-route",
        task: "must not be dispatched",
        cwd: app.workspace,
      }),
      (error) => error?.code === "route_mismatch",
    );
  } finally {
    await app.close();
  }
});

test("workspace realpath cannot escape an allowed root through a symlink", async () => {
  const app = await harness();
  try {
    const outside = path.join(app.root, "outside");
    const linked = path.join(app.workspace, "linked-outside");
    await mkdir(outside);
    await symlink(outside, linked, "dir");
    await assert.rejects(
      app.broker.spawnAgent({
        route: "test-route",
        task: "should not run",
        cwd: linked,
      }),
      (error) => error?.code === "workspace_denied",
    );
  } finally {
    await app.close();
  }
});

test("route configuration rejects embedded credentials", () => {
  assert.throws(
    () =>
      parseConfig(
        {
          routes: {
            unsafe: {
              description: "unsafe",
              provider: "unsafe",
              model: "unsafe-model",
              baseUrl: "https://example.com",
              apiKey: "secret",
            },
          },
        },
        "/tmp/broker.json",
      ),
    (error) => error?.code === "inline_credential_forbidden",
  );
});

test("the generic plugin credential map is expanded in memory with direct values winning", () => {
  const environment = materializeCredentialEnvironment({
    MIXAGENTS_BROKER_CREDENTIALS_JSON: JSON.stringify({
      FIRST_KEY: "from-map",
      SECOND_KEY: "second",
    }),
    FIRST_KEY: "direct",
  });
  assert.equal(environment.FIRST_KEY, "direct");
  assert.equal(environment.SECOND_KEY, "second");
  assert.throws(
    () =>
      materializeCredentialEnvironment({
        MIXAGENTS_BROKER_CREDENTIALS_JSON: "not-json",
      }),
    (error) => error?.code === "invalid_credential_environment",
  );
});

test("runtime config rendering is deterministic", () => {
  const route = parseConfig(
    {
      routes: {
        sample: {
          description: "sample",
          provider: "sample_provider",
          model: "sample-model",
          baseUrl: "https://example.com/v1",
          envKey: "SAMPLE_TOKEN",
        },
      },
    },
    "/tmp/broker.json",
  ).routes[0];
  assert.equal(renderRuntimeConfig(route), renderRuntimeConfig(route));
  assert.equal(
    runtimeIdFor(route, "read-only"),
    runtimeIdFor(
      { ...route, description: "new description", tags: ["new-tag"] },
      "read-only",
    ),
  );
  assert.notEqual(
    runtimeIdFor(route, "read-only"),
    runtimeIdFor({ ...route, model: "different-model" }, "read-only"),
  );
});

test("Windows uses the native executable from the npm-managed Codex package", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mixagents-codex-process-test-"));
  try {
    const managedRoot = path.join(root, "node_modules", "@openai", "codex");
    const platformRoot = path.join(
      managedRoot,
      "node_modules",
      "@openai",
      "codex-win32-x64",
    );
    const executable = path.join(
      platformRoot,
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(path.join(managedRoot, "package.json"), '{"name":"@openai/codex"}\n');
    await writeFile(
      path.join(platformRoot, "package.json"),
      '{"name":"@openai/codex-win32-x64"}\n',
    );
    await writeFile(executable, "fixture");

    assert.deepEqual(
      resolveCodexProcess(
        "codex",
        { CODEX_MANAGED_PACKAGE_ROOT: managedRoot },
        { platform: "win32", arch: "x64" },
      ),
      { command: executable, prefixArgs: [] },
    );
    assert.deepEqual(
      resolveCodexProcess(
        "D:\\Tools\\Codex\\codex.exe",
        { CODEX_MANAGED_PACKAGE_ROOT: managedRoot },
        { platform: "win32", arch: "x64" },
      ),
      { command: "D:\\Tools\\Codex\\codex.exe", prefixArgs: [] },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows command shims use an explicit cmd invocation", () => {
  assert.deepEqual(
    buildProcessInvocation(
      {
        command: "C:\\Program Files\\Codex\\codex.cmd",
        prefixArgs: [],
        launcher: "windows-command-script",
      },
      ["app-server", "--stdio"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\Codex\\codex.cmd" app-server --stdio"',
      ],
      windowsVerbatimArguments: true,
    },
  );
});

test("snapshotFor observes a foreign thread with full turns and never caches it", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace, "slow owner task");
  const threadId = threadIdOf(spawned);
  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("b"),
  );
  try {
    const { runtime } = await manager.forAgent(spawned.agentId);
    assert.equal(runtime.isAgentOwned(threadId), false);
    const first = await runtime.snapshotFor(threadId);
    assert.equal(first.status, "running");
    assert.equal(runtime.isAgentOwned(threadId), false);
    const second = await runtime.snapshotFor(threadId);
    assert.equal(second.status, "running");
    assert.equal(runtime.isAgentOwned(threadId), false);
  } finally {
    await manager.close();
  }
  const calls = await fixtureCallsBy(app.fixtureState, "b");
  assertForeignRead(calls);
  assert.equal(calls.filter((call) => call.method === "thread/read").length, 2);
});

test("concurrent forAgent calls for one runtime share its runtime and process", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const first = await spawnShared(owner, app.workspace, "slow first task");
  const second = await spawnShared(owner, app.workspace, "slow second task");
  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("b"),
  );
  try {
    const [firstTarget, secondTarget] = await Promise.all([
      manager.forAgent(first.agentId),
      manager.forAgent(second.agentId),
    ]);
    assert.equal(firstTarget.runtime, secondTarget.runtime);
    const snapshots = await Promise.all([
      firstTarget.runtime.snapshotFor(firstTarget.threadId),
      secondTarget.runtime.snapshotFor(secondTarget.threadId),
    ]);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.status), [
      "running",
      "running",
    ]);
  } finally {
    await manager.close();
  }

  const calls = await fixtureCallsBy(app.fixtureState, "b");
  assertForeignRead(calls);
  const tokens = new Set(calls.map((call) => call.token));
  assert.equal(tokens.size, 1, "same-runtime targets must share one process");
  const observerPid = Number([...tokens][0].split(":")[1]);
  assert.ok(Number.isInteger(observerPid) && observerPid > 0);
  await waitFor(
    () => !processAlive(observerPid),
    "shared observer process did not exit after close",
  );
});

test("list_agents observes foreign threads without resuming them", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const observer = await app.openBroker("b");

  const before = (await fixtureCallsBy(app.fixtureState, "b")).length;
  const agents = await observer.listAgents();

  assert.equal(agents.length, 1);
  assert.equal(agents[0].agentId, spawned.agentId);
  assert.equal(agents[0].status, "running");
  assertForeignRead((await fixtureCallsBy(app.fixtureState, "b")).slice(before));

  const observed = await observer.waitAgents([spawned.agentId], 0);
  assert.equal(observed.timedOut, true);
  assert.equal(observed.agents[0].status, "running");
});

test("owner can continue after foreign send/interrupt attempts, and follow-up survives owner shutdown", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const observer = await app.openBroker("b");
  const spawned = await spawnShared(owner, app.workspace, "slow owner task");
  const threadId = threadIdOf(spawned);

  const before = (await fixtureCallsBy(app.fixtureState, "b")).length;
  await assert.rejects(
    () => observer.send(spawned.agentId, "steal the thread"),
    (error) => {
      assert.equal(brokerErrorCode("agent_owned_elsewhere")(error), true);
      assert.doesNotMatch(error.message, /still computing|provider/i);
      return true;
    },
  );
  await assert.rejects(
    () => observer.interruptAgent(spawned.agentId),
    brokerErrorCode("agent_owned_elsewhere"),
  );

  const intruderCalls = (await fixtureCallsBy(app.fixtureState, "b")).slice(before);
  assert.ok(intruderCalls.some((call) => call.method === "thread/resume"));
  assert.equal(
    intruderCalls.some((call) =>
      ["turn/start", "turn/steer", "turn/interrupt"].includes(call.method),
    ),
    false,
  );

  const ownerMarker = JSON.parse(
    await readFile(path.join(app.fixtureState, "owners", `${threadId}.json`), "utf8"),
  );
  assert.equal(ownerMarker.owner, "a");

  const continued = await owner.send(spawned.agentId, "continue while active");
  assert.equal(continued.status, "running");
  const finished = await owner.waitAgents([spawned.agentId], 2_000);
  assert.equal(finished.timedOut, false);
  assert.equal(finished.agents[0].status, "completed");
  assert.equal(finished.agents[0].output, "steered:continue while active");

  await owner.close();
  await waitForOwnerRelease(app.fixtureState, threadId);

  const recovered = await observer.waitAgents([spawned.agentId], 2_000);
  assert.equal(recovered.timedOut, false);
  assert.equal(recovered.agents[0].status, "completed");
  assert.equal(recovered.agents[0].output, "steered:continue while active");

  const followUp = await observer.send(spawned.agentId, "after owner shutdown");
  assert.equal(followUp.status, "running");
  const result = await observer.waitAgents([spawned.agentId], 2_000);
  assert.equal(result.timedOut, false);
  assert.equal(result.agents[0].status, "completed");
  assert.equal(result.agents[0].output, "result:after owner shutdown");
});

test("a foreign wait polls until the owner-reported completion", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const observer = await app.openBroker("b", 700);

  const before = (await fixtureCallsBy(app.fixtureState, "b")).length;
  const startedAt = Date.now();
  const result = await observer.waitAgents([spawned.agentId], 5_000);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, false);
  assert.equal(result.agents[0].status, "completed");
  assert.match(result.agents[0].output, /^completed turn_/);
  assert.ok(elapsed < 4_000, `foreign wait took ${elapsed}ms`);

  const calls = (await fixtureCallsBy(app.fixtureState, "b")).slice(before);
  assert.ok(calls.filter((call) => call.method === "thread/read").length >= 2);
  assertForeignRead(calls);
});

test("a foreign wait re-reads at the deadline and returns completion", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const observer = await app.openBroker("b", 250);

  const startedAt = Date.now();
  const result = await observer.waitAgents([spawned.agentId], 400);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, false);
  assert.equal(result.agents[0].status, "completed");
  assert.ok(elapsed >= 300, `expected a deadline re-read, got ${elapsed}ms`);
  assert.ok(elapsed < 2_000, `deadline re-read took ${elapsed}ms`);
});

test("a foreign wait over two same-runtime agents returns real owner steer completions", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const observer = await app.openBroker("b");
  const first = await spawnShared(owner, app.workspace, "slow first task");
  const second = await spawnShared(owner, app.workspace, "slow second task");

  const waiting = observer.waitAgents([first.agentId, second.agentId], 5_000);
  await waitFor(async () => {
    const reads = (await fixtureCallsBy(app.fixtureState, "b")).filter(
      (call) => call.method === "thread/read",
    );
    return reads.length >= 2;
  }, "observer did not begin reading both agents");

  const firstSend = await owner.send(first.agentId, "owner first result");
  const secondSend = await owner.send(second.agentId, "owner second result");
  assert.equal(firstSend.status, "running");
  assert.equal(secondSend.status, "running");

  const waitAny = await waiting;
  assert.equal(waitAny.timedOut, false);
  assert.equal(waitAny.agents.length, 2);
  assert.deepEqual(
    waitAny.agents.map((agent) => agent.agentId).sort(),
    [first.agentId, second.agentId].sort(),
  );
  assert.ok(
    waitAny.agents.some(
      (agent) => agent.status === "completed" && agent.output !== undefined,
    ),
    "waitAny should return a material completion",
  );

  const firstResult = await observer.waitAgents([first.agentId], 2_000);
  assert.equal(firstResult.timedOut, false);
  assert.equal(firstResult.agents[0].agentId, first.agentId);
  assert.equal(firstResult.agents[0].status, "completed");
  assert.equal(firstResult.agents[0].output, "steered:owner first result");

  const secondResult = await observer.waitAgents([second.agentId], 2_000);
  assert.equal(secondResult.timedOut, false);
  assert.equal(secondResult.agents[0].agentId, second.agentId);
  assert.equal(secondResult.agents[0].status, "completed");
  assert.equal(secondResult.agents[0].output, "steered:owner second result");

  const calls = await fixtureCallsBy(app.fixtureState, "b");
  assertForeignRead(calls);
  assert.equal(
    calls.some((call) =>
      ["thread/resume", "turn/start", "turn/steer", "turn/interrupt"].includes(
        call.method,
      ),
    ),
    false,
  );
  const observations = calls
    .filter((call) => call.method === "thread/read/concurrency")
    .map((call) => call.params);
  assert.ok(
    Math.max(...observations.map((entry) => entry.maxConcurrent)) >= 2,
    "the two same-runtime foreign reads should overlap without rejection",
  );
  const tokens = new Set(calls.map((call) => call.token));
  assert.equal(tokens.size, 1, "cold multiwait must use one observer process");
  const observerCount = new Set(calls.map((call) => call.owner));
  assert.deepEqual([...observerCount], ["b"]);
  const observerPid = Number([...tokens][0].split(":")[1]);
  assert.ok(Number.isInteger(observerPid) && observerPid > 0);

  await observer.close();
  await waitFor(
    () => !processAlive(observerPid),
    "observer process did not exit after close",
  );
});

test("a foreign wait times out when the thread never completes", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const observer = await app.openBroker("b");

  const startedAt = Date.now();
  const result = await observer.waitAgents([spawned.agentId], 600);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(result.agents[0].status, "running");
  assert.ok(elapsed >= 500, `expected a real timeout, got ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `timeout took ${elapsed}ms`);
  assertForeignRead(await fixtureCallsBy(app.fixtureState, "b"));
});

test("list_agents hydrates foreign threads serially within each runtime", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = [];
  for (let index = 0; index < 4; index += 1) {
    spawned.push(await spawnShared(owner, app.workspace));
  }
  const observer = await app.openBroker("b");

  const before = (await fixtureCallsBy(app.fixtureState, "b")).length;
  const agents = await observer.listAgents();
  assert.equal(agents.length, 4);
  assert.deepEqual(
    agents.map((agent) => agent.agentId).sort(),
    spawned.map((agent) => agent.agentId).sort(),
  );

  const calls = (await fixtureCallsBy(app.fixtureState, "b")).slice(before);
  assertForeignRead(calls);
  const observations = calls
    .filter((call) => call.method === "thread/read/concurrency")
    .map((call) => call.params);
  assert.equal(observations.length, 4);
  assert.equal(Math.max(...observations.map((entry) => entry.maxConcurrent)), 1);
  assert.equal(Math.max(...observations.map((entry) => entry.violations)), 0);
});

test("a foreign thread from another provider is rejected instead of resumed", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const threadId = threadIdOf(spawned);
  await patchFixtureThread(app.fixtureState, threadId, { modelProvider: "other-provider" });

  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("b"),
  );
  try {
    const runtime = await manager.forRoute(sharedRoute, "workspace-write");
    await assert.rejects(
      runtime.snapshotFor(threadId),
      brokerErrorCode("route_mismatch"),
    );
  } finally {
    await manager.close();
  }
  const calls = await fixtureCallsBy(app.fixtureState, "b");
  assertForeignRead(calls);
});

test("a foreign thread missing its provider identity is rejected without resume", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const threadId = threadIdOf(spawned);
  await patchFixtureThread(app.fixtureState, threadId, { modelProvider: undefined });

  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("b"),
  );
  try {
    const runtime = await manager.forRoute(sharedRoute, "workspace-write");
    assert.equal(runtime.isAgentOwned(threadId), false);
    await assert.rejects(
      runtime.snapshotFor(threadId),
      brokerErrorCode("route_mismatch"),
    );
    assert.equal(runtime.isAgentOwned(threadId), false);
  } finally {
    await manager.close();
  }
  const calls = await fixtureCallsBy(app.fixtureState, "b");
  assertForeignRead(calls);
});

test("foreign not-found and read failures do not fall back to resume", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const threadId = threadIdOf(spawned);
  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("b"),
  );
  try {
    const runtime = await manager.forRoute(sharedRoute, "workspace-write");
    const missing = await runtime.snapshotFor("missing-thread");
    assert.equal(missing.status, "not_found");

    await patchFixtureThread(app.fixtureState, threadId, {
      readError: "storage backend unavailable",
    });
    await assert.rejects(runtime.snapshotFor(threadId), /storage backend unavailable/);
  } finally {
    await manager.close();
  }
  const calls = await fixtureCallsBy(app.fixtureState, "b");
  assert.equal(calls.some((call) => call.method === "thread/resume"), false);
});

test("active-writer wording outside real contention propagates unchanged", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const threadId = threadIdOf(spawned);
  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("b"),
  );
  const lockMessage = "failed to open active writer lock: permission denied";
  const assertNotOwnedElsewhere = (error) => {
    assert.notEqual(error?.code, "agent_owned_elsewhere");
    assert.match(error.message, /permission denied/);
    return true;
  };
  try {
    const runtime = await manager.forRoute(sharedRoute, "workspace-write");
    await patchFixtureThread(app.fixtureState, threadId, { readError: lockMessage });
    await assert.rejects(runtime.snapshotFor(threadId), assertNotOwnedElsewhere);

    await patchFixtureThread(app.fixtureState, threadId, {
      readError: null,
      resumeError: lockMessage,
    });
    await assert.rejects(runtime.recover(threadId), assertNotOwnedElsewhere);
  } finally {
    await manager.close();
  }
  const ownerMarker = JSON.parse(
    await readFile(path.join(app.fixtureState, "owners", `${threadId}.json`), "utf8"),
  );
  assert.equal(ownerMarker.owner, "a");
  const calls = await fixtureCallsBy(app.fixtureState, "b");
  assert.equal(
    calls.some((call) =>
      ["turn/start", "turn/steer", "turn/interrupt"].includes(call.method),
    ),
    false,
  );
});

test("foreign incomplete interrupts stay conservative while known completion survives", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);
  const threadId = threadIdOf(spawned);
  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("b"),
  );

  const interruptedTurn = (completedAt, includeTimestamp) => ({
    id: `turn-incomplete-${String(completedAt)}`,
    status: "interrupted",
    startedAt: 1794658698,
    ...(includeTimestamp ? { completedAt } : {}),
    items: [
      {
        type: "agentMessage",
        text: "stale output",
        phase: "final_answer",
      },
    ],
    error: { message: "stale error" },
  });

  try {
    const runtime = await manager.forRoute(sharedRoute, "workspace-write");

    await patchFixtureThread(app.fixtureState, threadId, {
      status: { type: "idle" },
      turns: [],
    });
    const idle = await runtime.snapshotFor(threadId);
    assert.equal(idle.status, "starting");
    assert.notEqual(idle.status, "completed");

    const incomplete = [
      { label: "null", completedAt: null, includeTimestamp: true },
      { label: "missing", includeTimestamp: false },
      { label: "zero", completedAt: 0, includeTimestamp: true },
      { label: "NaN", completedAt: "NaN", includeTimestamp: true },
      { label: "Infinity", completedAt: "Infinity", includeTimestamp: true },
    ];
    for (const entry of incomplete) {
      await patchFixtureThread(app.fixtureState, threadId, {
        status: { type: "notLoaded" },
        turns: [interruptedTurn(entry.completedAt, entry.includeTimestamp)],
      });
      const snapshot = await runtime.snapshotFor(threadId);
      assert.equal(snapshot.status, "starting", `${entry.label} must not be terminal`);
      assert.equal(snapshot.output, undefined, `${entry.label} must clear stale output`);
      assert.equal(snapshot.error, undefined, `${entry.label} must clear stale error`);
      assert.equal(runtime.isAgentOwned(threadId), false);
    }

    await patchFixtureThread(app.fixtureState, threadId, {
      status: { type: "notLoaded" },
      turns: [interruptedTurn(Math.floor(Date.now() / 1000), true)],
    });
    const terminal = await runtime.snapshotFor(threadId);
    assert.equal(terminal.status, "interrupted");
    assert.equal(terminal.output, undefined);
    assert.equal(terminal.error, undefined);

    await patchFixtureThread(app.fixtureState, threadId, {
      status: { type: "notLoaded" },
      turns: [
        {
          id: "turn-known-completed",
          status: "completed",
          completedAt: Math.floor(Date.now() / 1000),
          items: [
            {
              type: "agentMessage",
              text: "known final output",
              phase: "final_answer",
            },
          ],
        },
      ],
    });
    const completed = await runtime.snapshotFor(threadId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.output, "known final output");
  } finally {
    await manager.close();
  }
  assertForeignRead(await fixtureCallsBy(app.fixtureState, "b"));
});

test("an owned interrupted agent stays terminal without a foreign read", async (t) => {
  const app = await sharedHarness(t);
  const owner = await app.openBroker("a");
  const spawned = await spawnShared(owner, app.workspace);

  const interrupted = await owner.interruptAgent(spawned.agentId);
  assert.equal(interrupted.agent.status, "interrupted");

  const before = (await fixtureCallsBy(app.fixtureState, "a")).length;
  const agents = await owner.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, "interrupted");
  const waited = await owner.waitAgents([spawned.agentId], 1_000);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.agents[0].status, "interrupted");
  const calls = (await fixtureCallsBy(app.fixtureState, "a")).slice(before);
  assert.equal(
    calls.some((call) => call.method === "thread/read" || call.method === "thread/resume"),
    false,
  );
});

test("snapshotFor takes the owned fast path without read or resume", async (t) => {
  const app = await sharedHarness(t);
  const manager = new RuntimeManager(
    app.dataDir,
    app.config.codexBin,
    app.environment,
    app.fixtureOverride("a"),
  );
  try {
    const runtime = await manager.forRoute(sharedRoute, "workspace-write");
    const spawned = await runtime.startAgent("slow owned task", app.workspace);
    const threadId = threadIdOf(spawned);
    assert.equal(runtime.isAgentOwned(threadId), true);

    const before = (await fixtureCallsBy(app.fixtureState, "a")).length;
    const snapshot = await runtime.snapshotFor(threadId);
    assert.equal(snapshot.status, "running");
    const calls = (await fixtureCallsBy(app.fixtureState, "a")).slice(before);
    assert.equal(
      calls.some((call) => call.method === "thread/read" || call.method === "thread/resume"),
      false,
    );
  } finally {
    await manager.close();
  }
});
