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
