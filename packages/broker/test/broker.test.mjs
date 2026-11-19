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
  runtimeIdFor,
} from "../plugin/mixagents-broker/dist/app-server.js";
import {
  materializeCredentialEnvironment,
  parseConfig,
} from "../plugin/mixagents-broker/dist/config.js";
import {
  buildProcessInvocation,
  resolveCodexProcess,
} from "../plugin/mixagents-broker/dist/codex-process.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

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
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    await rm(app.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

// Two Broker sessions over one data directory share each runtime's App Server
// home, as two Codex chats do. The fake App Server keeps writer locks there.

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function writerPid(app, agentId) {
  const { runtimeId, threadId } = parseAgentId(agentId);
  const lock = path.join(app.dataDir, "runtimes", runtimeId, "fake-locks", `${threadId}.json`);
  return JSON.parse(await readFile(lock, "utf8")).pid;
}

async function untilExited(pid) {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    assert.ok(Date.now() < deadline, `process ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function crashWriter(app, agentId) {
  const pid = await writerPid(app, agentId);
  process.kill(pid, "SIGKILL");
  await untilExited(pid);
}

async function resumeRefusals(app, agentId) {
  const { runtimeId } = parseAgentId(agentId);
  try {
    const log = await readFile(
      path.join(app.dataDir, "runtimes", runtimeId, "fake-resume-refusals.log"),
      "utf8",
    );
    return log.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("wait_agent rejects a timeout above 120000 ms instead of shortening it", async () => {
  const app = await harness();
  try {
    await assert.rejects(app.broker.waitAgents(["broker:missing:thread"], 120_001), {
      code: "invalid_input",
      message: /timeoutMs must be at most 120000/,
    });
  } finally {
    await app.close();
  }
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("idleMs grows while the worker is silent and resets when App Server sends anything", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "quiet then delta",
      cwd: app.workspace,
    });
    const startedAt = Date.now();
    const idle = async () => (await app.broker.waitAgents([spawned.agentId], 0)).agents[0].idleMs;

    await pause(200);
    const first = await idle();
    await pause(200);
    const second = await idle();
    // Nothing arrives before 600 ms, so idleMs grows with real time.
    assert.ok(second - first >= 190, `idleMs went from ${first} to ${second}`);

    // The delta is due at 600 ms; by 1500 ms it has reset the measurement,
    // even if the fake's timer ran late.
    await pause(1_500 - (Date.now() - startedAt));
    const elapsed = Date.now() - startedAt;
    const afterDelta = await idle();
    assert.ok(afterDelta <= elapsed - 500, `idleMs ${afterDelta} after ${elapsed} ms`);
  } finally {
    await app.close();
  }
});

test("idleMs is absent on finished turns and on workers owned by another session", async () => {
  const app = await harness();
  const other = await Broker.create(app.options);
  try {
    const finished = await app.broker.spawnAgent({
      route: "test-route",
      task: "quick task",
      cwd: app.workspace,
    });
    const completed = await app.broker.waitAgents([finished.agentId], 2_000);
    assert.equal(completed.agents[0].status, "completed");
    assert.equal(completed.agents[0].idleMs, undefined);

    const running = await app.broker.spawnAgent({
      route: "test-route",
      task: "slow task",
      cwd: app.workspace,
    });
    const owned = await app.broker.waitAgents([running.agentId], 0);
    assert.equal(typeof owned.agents[0].idleMs, "number");
    const observed = await other.waitAgents([running.agentId], 0);
    assert.equal(observed.agents[0].status, "running");
    assert.equal(observed.agents[0].idleMs, undefined);
  } finally {
    await other.close();
    await app.close();
  }
});

test("another session observes a running worker without taking it over", async () => {
  const app = await harness();
  const other = await Broker.create(app.options);
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "slow task",
      cwd: app.workspace,
    });
    const listed = await other.listAgents();
    assert.equal(listed.find((agent) => agent.agentId === spawned.agentId)?.status, "running");
    const waited = await other.waitAgents([spawned.agentId], 1_200);
    assert.equal(waited.timedOut, true);
    assert.equal(waited.agents[0].status, "running");
    // One writer-lock probe for the list and one for the whole polling wait.
    assert.equal(await resumeRefusals(app, spawned.agentId), 2);

    const interrupted = await app.broker.interruptAgent(spawned.agentId);
    assert.equal(interrupted.agent.status, "interrupted");
    const observed = await other.waitAgents([spawned.agentId], 2_000);
    assert.equal(observed.timedOut, false);
    assert.equal(observed.agents[0].status, "interrupted");
  } finally {
    await other.close();
    await app.close();
  }
});

test("a wait from another session returns the owner's result and follow-up", async () => {
  const app = await harness();
  const other = await Broker.create(app.options);
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "delayed first",
      cwd: app.workspace,
    });
    const first = await other.waitAgents([spawned.agentId], 5_000);
    assert.equal(first.timedOut, false);
    assert.equal(first.agents[0].status, "completed");
    assert.equal(first.agents[0].output, "result:delayed first");

    await app.broker.send(spawned.agentId, "delayed second");
    const second = await other.waitAgents([spawned.agentId], 5_000);
    assert.equal(second.agents[0].status, "completed");
    assert.equal(second.agents[0].output, "result:delayed second");
  } finally {
    await other.close();
    await app.close();
  }
});

test("send and interrupt from another session are refused until the owner exits", async () => {
  const app = await harness();
  const other = await Broker.create(app.options);
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "slow task",
      cwd: app.workspace,
    });
    await assert.rejects(other.send(spawned.agentId, "take it"), {
      code: "agent_owned_elsewhere",
    });
    await assert.rejects(other.interruptAgent(spawned.agentId), {
      code: "agent_owned_elsewhere",
    });

    await app.broker.send(spawned.agentId, "owner steer");
    const owned = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.equal(owned.agents[0].output, "steered:owner steer");

    const owner = await writerPid(app, spawned.agentId);
    await app.broker.close();
    await untilExited(owner);
    assert.equal((await other.send(spawned.agentId, "after takeover")).status, "running");
    const taken = await other.waitAgents([spawned.agentId], 2_000);
    assert.equal(taken.agents[0].output, "result:after takeover");
  } finally {
    await other.close();
    await app.close();
  }
});

test("another session reads a crashed owner's turn as interrupted and can continue it", async () => {
  const app = await harness();
  const other = await Broker.create(app.options);
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "slow task",
      cwd: app.workspace,
    });
    await crashWriter(app, spawned.agentId);
    const waited = await other.waitAgents([spawned.agentId], 2_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.agents[0].status, "interrupted");

    await other.send(spawned.agentId, "continue");
    const continued = await other.waitAgents([spawned.agentId], 2_000);
    assert.equal(continued.agents[0].output, "result:continue");
  } finally {
    await other.close();
    await app.close();
  }
});

test("a turn reads as interrupted after this session's App Server crashes", async () => {
  const app = await harness();
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "slow task",
      cwd: app.workspace,
    });
    await crashWriter(app, spawned.agentId);
    const waited = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.agents[0].status, "interrupted");

    await app.broker.send(spawned.agentId, "again");
    const resumed = await app.broker.waitAgents([spawned.agentId], 2_000);
    assert.equal(resumed.agents[0].output, "result:again");
  } finally {
    await app.close();
  }
});

test("listing finished workers leaves them free for any session to continue", async () => {
  const app = await harness();
  const sessions = [];
  try {
    const spawned = await app.broker.spawnAgent({
      route: "test-route",
      task: "first task",
      cwd: app.workspace,
    });
    await app.broker.waitAgents([spawned.agentId], 2_000);
    const owner = await writerPid(app, spawned.agentId);
    await app.broker.close();
    await untilExited(owner);

    const observer = await Broker.create(app.options);
    sessions.push(observer);
    const listed = await observer.listAgents();
    assert.equal(listed[0].status, "completed");
    assert.equal(listed[0].output, "result:first task");

    const third = await Broker.create(app.options);
    sessions.push(third);
    await third.send(spawned.agentId, "from third");
    const continued = await third.waitAgents([spawned.agentId], 2_000);
    assert.equal(continued.agents[0].output, "result:from third");
  } finally {
    for (const session of sessions) await session.close();
    await app.close();
  }
});

test("concurrent lookups in a fresh session share one runtime", async () => {
  const app = await harness();
  const other = await Broker.create(app.options);
  try {
    const first = await app.broker.spawnAgent({
      route: "test-route",
      task: "first task",
      cwd: app.workspace,
    });
    const second = await app.broker.spawnAgent({
      route: "test-route",
      task: "second task",
      cwd: app.workspace,
    });
    await app.broker.waitAgents([first.agentId], 2_000);
    await app.broker.waitAgents([second.agentId], 2_000);
    const owner = await writerPid(app, first.agentId);
    await app.broker.close();
    await untilExited(owner);

    const waited = await other.waitAgents([first.agentId, second.agentId], 2_000);
    assert.deepEqual(
      waited.agents.map((agent) => agent.status),
      ["completed", "completed"],
    );
    await other.send(first.agentId, "first again");
    await other.send(second.agentId, "second again");
    assert.equal(
      await writerPid(app, first.agentId),
      await writerPid(app, second.agentId),
    );
  } finally {
    await other.close();
    await app.close();
  }
});
