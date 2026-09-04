import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = path.join(
  packageRoot,
  "plugin",
  "mixagents-broker",
  "dist",
  "server.js",
);
const fixturePath = path.join(packageRoot, "test", "fixtures", "fake-codex.mjs");

class Client {
  constructor(child, { roots = [], onElicitation } = {}) {
    this.child = child;
    this.roots = roots;
    this.onElicitation = onElicitation;
    this.elicitationRequests = [];
    this.nextId = 1;
    this.pending = new Map();
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => void this.accept(JSON.parse(line)));
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.lastRequestId = id;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  async accept(message) {
    if (message.method && message.id !== undefined) {
      if (message.method === "roots/list") {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            roots: this.roots.map((root) => ({ uri: pathToFileURL(root).href })),
          },
        });
        return;
      }
      if (message.method === "elicitation/create" && this.onElicitation) {
        this.elicitationRequests.push(message.params);
        try {
          const result = await this.onElicitation(message.params);
          this.send({ jsonrpc: "2.0", id: message.id, result });
        } catch (error) {
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: error.message },
          });
        }
        return;
      }
      this.send({
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

function resolvePaths(value, context) {
  return typeof value === "function" ? value(context) : (value ?? []);
}

async function launchServer(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mixagents-broker-mcp-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "state");
  const configPath = path.join(root, "broker.json");
  const fakeBin = path.join(
    root,
    process.platform === "win32" ? "fake-codex.cmd" : "fake-codex",
  );
  await mkdir(workspace);
  if (process.platform === "win32") {
    await writeFile(
      fakeBin,
      `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`,
      "utf8",
    );
  } else {
    await writeFile(
      fakeBin,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} "$@"\n`,
      "utf8",
    );
    await chmod(fakeBin, 0o755);
  }

  const context = { root, workspace, dataDir, configPath, fakeBin };
  const workspaceRoots = resolvePaths(options.workspaceRoots, context);
  await writeFile(
    configPath,
    `${JSON.stringify({
      workspaceRoots,
      dataDir,
      codexBin: fakeBin,
      routes: {
        mcp: {
          description: "MCP integration fixture",
          provider: "fake_provider",
          model: "fake-model",
          baseUrl: "http://127.0.0.1:19091",
          envKey: "TEST_PROVIDER_KEY",
          maxAccess: "workspace-write",
        },
      },
    })}\n`,
    "utf8",
  );

  const serverEnvironment = {
    ...process.env,
    MIXAGENTS_BROKER_CONFIG: configPath,
    MIXAGENTS_BROKER_CREDENTIALS_JSON: JSON.stringify({
      TEST_PROVIDER_KEY: "mcp-test-secret",
    }),
  };
  delete serverEnvironment.TEST_PROVIDER_KEY;
  const child = spawn(process.execPath, [serverPath], {
    env: serverEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const advertisedRoots =
    options.clientRoots === undefined
      ? undefined
      : resolvePaths(options.clientRoots, context);
  const client = new Client(child, {
    roots: advertisedRoots,
    onElicitation: options.onElicitation,
  });
  const capabilities = {};
  if (advertisedRoots !== undefined) {
    capabilities.roots = {};
  }
  if (options.onElicitation) {
    capabilities.elicitation = {};
  }
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities,
    clientInfo: { name: "broker-test", version: "1" },
  });
  client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  return {
    ...context,
    child,
    client,
    initialized,
    async close() {
      child.stdin.end();
      let forced = false;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          forced = true;
          child.kill();
          resolve();
        }, 1_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
      assert.equal(forced, false, "MCP server should stop its App Server children on stdin close");
      assert.equal(stderr.join(""), "");
    },
  };
}

function approve() {
  return { action: "accept", content: { decision: "approve" } };
}

function spawnAgent(client, cwd, task = "simple workspace task") {
  return client.request("tools/call", {
    name: "spawn_agent",
    arguments: {
      route: "mcp",
      task,
      cwd,
      access: "workspace-write",
    },
  });
}

test("the packaged STDIO server exposes the native-sized workflow", async () => {
  const app = await launchServer({
    clientRoots: ({ workspace }) => [workspace],
    onElicitation: approve,
  });
  try {
    assert.equal(app.initialized.serverInfo.name, "mixagents-broker");

    const listedTools = await app.client.request("tools/list");
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name),
      ["routes", "spawn_agent", "send", "wait_agent", "interrupt_agent", "list_agents"],
    );

    const routes = await app.client.request("tools/call", {
      name: "routes",
      arguments: {},
    });
    assert.equal(routes.structuredContent.routes[0].provider, "fake_provider");

    const spawned = await spawnAgent(app.client, app.workspace, "approval through mcp");
    assert.equal(spawned.isError, undefined);
    assert.equal(spawned.structuredContent.status, "running");

    const waited = await app.client.request("tools/call", {
      name: "wait_agent",
      arguments: {
        agentIds: [spawned.structuredContent.agentId],
        timeoutMs: 2_000,
      },
    });
    assert.equal(waited.structuredContent.agents[0].status, "completed");
    assert.equal(waited.structuredContent.agents[0].output, "approval:approved");
    assert.equal(app.client.elicitationRequests.length, 1);
    assert.match(
      app.client.elicitationRequests[0].message,
      /worker requests command approval/,
    );
  } finally {
    await app.close();
  }
});

test("an approved workspace is reused for descendants during the MCP connection", async () => {
  const app = await launchServer({
    workspaceRoots: [packageRoot],
    onElicitation: approve,
  });
  try {
    const first = await spawnAgent(app.client, app.workspace);
    assert.equal(first.isError, undefined);
    assert.equal(app.client.elicitationRequests.length, 1);
    assert.match(
      app.client.elicitationRequests[0].message,
      new RegExp((await realpath(app.workspace)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const nested = path.join(app.workspace, "nested");
    await mkdir(nested);
    const second = await spawnAgent(app.client, nested);
    assert.equal(second.isError, undefined);
    assert.equal(app.client.elicitationRequests.length, 1);
  } finally {
    await app.close();
  }
});

test("declining workspace access fails before an App Server starts", async () => {
  const app = await launchServer({
    onElicitation: () => ({ action: "decline", content: null }),
  });
  try {
    const result = await spawnAgent(app.client, app.workspace);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "workspace_approval_declined");
    await assert.rejects(access(app.dataDir), (error) => error?.code === "ENOENT");
  } finally {
    await app.close();
  }
});

test("cancelling workspace approval starts no worker and stores no grant", async () => {
  let releaseApproval;
  let approvalRequested;
  const requested = new Promise((resolve) => {
    approvalRequested = resolve;
  });
  const app = await launchServer({
    onElicitation: () => {
      approvalRequested();
      return new Promise((resolve) => {
        releaseApproval = resolve;
      });
    },
  });
  try {
    const spawned = spawnAgent(app.client, app.workspace);
    const requestId = app.client.lastRequestId;
    await requested;
    app.client.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    });
    releaseApproval(approve());

    const result = await spawned;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "spawn_cancelled");
    await assert.rejects(access(app.dataDir), (error) => error?.code === "ENOENT");

    app.client.onElicitation = approve;
    const retried = await spawnAgent(app.client, app.workspace);
    assert.equal(retried.isError, undefined);
    assert.equal(app.client.elicitationRequests.length, 2);
  } finally {
    await app.close();
  }
});

test("a client without elicitation must use a preauthorized workspace root", async () => {
  const denied = await launchServer();
  try {
    const result = await spawnAgent(denied.client, denied.workspace);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "workspace_root_required");
    assert.match(result.structuredContent.message, /configure workspaceRoots/);
    await assert.rejects(access(denied.dataDir), (error) => error?.code === "ENOENT");
  } finally {
    await denied.close();
  }

  const allowed = await launchServer({
    workspaceRoots: ({ workspace }) => [workspace],
  });
  try {
    const result = await spawnAgent(allowed.client, allowed.workspace);
    assert.equal(result.isError, undefined);
  } finally {
    await allowed.close();
  }
});

test("workspace approval stays bound to the canonical directory", async () => {
  let link;
  let alternate;
  const app = await launchServer({
    onElicitation: async () => {
      await unlink(link);
      await symlink(alternate, link, "dir");
      return approve();
    },
  });
  try {
    const approved = path.join(app.root, "approved");
    alternate = path.join(app.root, "alternate");
    link = path.join(app.root, "workspace-link");
    await mkdir(approved);
    await mkdir(alternate);
    await symlink(approved, link, "dir");
    const canonical = await realpath(approved);

    const spawned = await spawnAgent(app.client, link, "report cwd");
    assert.equal(spawned.isError, undefined);
    const waited = await app.client.request("tools/call", {
      name: "wait_agent",
      arguments: { agentIds: [spawned.structuredContent.agentId], timeoutMs: 2_000 },
    });
    assert.equal(waited.structuredContent.agents[0].output, `cwd:${canonical}`);
    assert.equal(await realpath(link), await realpath(alternate));
  } finally {
    await app.close();
  }
});
