import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  constructor(child, workspace) {
    this.child = child;
    this.workspace = workspace;
    this.nextId = 1;
    this.pending = new Map();
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.accept(JSON.parse(line)));
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  accept(message) {
    if (message.method && message.id !== undefined) {
      if (message.method === "roots/list") {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { roots: [{ uri: new URL(`file://${this.workspace}`).href }] },
        });
        return;
      }
      if (message.method === "elicitation/create") {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { action: "accept", content: { decision: "approve" } },
        });
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

test("the packaged STDIO server exposes the native-sized workflow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mixagents-broker-mcp-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "state");
  const configPath = path.join(root, "broker.json");
  const fakeBin = path.join(root, "fake-codex");
  await mkdir(workspace);
  await writeFile(
    fakeBin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} "$@"\n`,
    "utf8",
  );
  await chmod(fakeBin, 0o755);
  await writeFile(
    configPath,
    `${JSON.stringify({
      workspaceRoots: [],
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
  const client = new Client(child, workspace);

  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "broker-test", version: "1" },
    });
    assert.equal(initialized.serverInfo.name, "mixagents-broker");
    client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const listedTools = await client.request("tools/list");
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name),
      ["routes", "spawn_agent", "send", "wait_agent", "interrupt_agent", "list_agents"],
    );

    const routes = await client.request("tools/call", {
      name: "routes",
      arguments: {},
    });
    assert.equal(routes.structuredContent.routes[0].provider, "fake_provider");

    const spawned = await client.request("tools/call", {
      name: "spawn_agent",
      arguments: {
        route: "mcp",
        task: "approval through mcp",
        cwd: workspace,
        access: "workspace-write",
      },
    });
    assert.equal(spawned.isError, undefined);
    assert.equal(spawned.structuredContent.status, "running");

    const waited = await client.request("tools/call", {
      name: "wait_agent",
      arguments: {
        agentIds: [spawned.structuredContent.agentId],
        timeoutMs: 2_000,
      },
    });
    assert.equal(waited.structuredContent.agents[0].status, "completed");
    assert.equal(waited.structuredContent.agents[0].output, "approval:approved");
  } finally {
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
  }
  assert.equal(stderr.join(""), "");
});
