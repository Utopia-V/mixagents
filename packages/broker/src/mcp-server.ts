import type { JsonRpcId } from "./jsonrpc.js";
import { JsonLinePeer } from "./jsonrpc.js";
import { Broker } from "./broker.js";
import { BrokerError, errorMessage } from "./errors.js";
import { resolveWorkspace } from "./config.js";
import type {
  AgentSnapshot,
  JsonObject,
  JsonValue,
  ProcessSpec,
} from "./types.js";

const SERVER_VERSION = "0.1.1";
const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

type UnknownRecord = Record<string, unknown>;

interface McpServerOptions {
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  processOverride?: ProcessSpec;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: JsonObject;
}

class McpRequestError extends Error {
  readonly jsonRpcCode: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "McpRequestError";
    this.jsonRpcCode = code;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NO_ARGUMENTS: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const TOOLS: ToolDefinition[] = [
  {
    name: "routes",
    title: "List Broker routes",
    description:
      "List configured provider/model routes, credential availability, and the selected backend. Makes no provider request.",
    inputSchema: NO_ARGUMENTS,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "spawn_agent",
    title: "Spawn cross-provider agent",
    description:
      "Create a Broker-managed App Server agent on one configured route and start its first turn. Sends the task to that provider and may incur cost.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string", description: "Configured route id." },
        task: {
          type: "string",
          description: "Complete assignment sent to the worker provider.",
        },
        cwd: {
          type: "string",
          description:
            "Absolute working directory. Broker uses a preauthorized root or asks the host to approve it for this connection.",
        },
        access: {
          type: "string",
          enum: ["read-only", "workspace-write"],
          default: "read-only",
        },
      },
      required: ["route", "task", "cwd"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "send",
    title: "Send agent input",
    description:
      "Steer a running managed agent or start a follow-up turn on the same agent thread.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        message: { type: "string" },
      },
      required: ["agentId", "message"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "wait_agent",
    title: "Wait for agents",
    description:
      "Wait for one of one to eight managed agents to finish, fail, interrupt, or request host interaction.",
    inputSchema: {
      type: "object",
      properties: {
        agentIds: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string" },
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: 120000,
          default: 30000,
        },
      },
      required: ["agentIds"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "interrupt_agent",
    title: "Interrupt agent turn",
    description:
      "Interrupt the active managed-agent turn without destroying its reusable thread. Remote provider work may continue.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "list_agents",
    title: "List managed agents",
    description: "List recoverable Broker-managed App Server agent threads.",
    inputSchema: NO_ARGUMENTS,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toolSuccess(value: unknown): JsonObject {
  const structured = asJsonValue(value);
  const structuredContent = isRecord(structured) ? structured : { value: structured };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolFailure(error: unknown): JsonObject {
  const value: JsonObject = {
    code: error instanceof BrokerError ? error.code : "broker_error",
    message: errorMessage(error),
  };
  if (error instanceof BrokerError && error.details !== undefined) {
    value.details = asJsonValue(error.details);
  }
  return {
    isError: true,
    content: [{ type: "text", text: `${value.code}: ${value.message}` }],
    structuredContent: value,
  };
}

function isWorkspaceAuthorizationError(error: unknown): error is BrokerError {
  return (
    error instanceof BrokerError &&
    (error.code === "workspace_root_required" || error.code === "workspace_denied")
  );
}

function workspaceApprovalAccepted(result: unknown): boolean {
  return (
    isRecord(result) &&
    result.action === "accept" &&
    isRecord(result.content) &&
    result.content.decision === "approve"
  );
}

function waitForWorkspaceApproval(
  request: Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(
      new BrokerError("spawn_cancelled", "spawn_agent was cancelled"),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new BrokerError("spawn_cancelled", "spawn_agent was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class BrokerMcpServer {
  readonly #peer: JsonLinePeer;
  readonly #options: McpServerOptions;
  readonly #activeCalls = new Map<JsonRpcId, AbortController>();
  readonly #approvedWorkspaceRoots = new Set<string>();
  readonly #pendingWorkspaceApprovals = new Map<string, Promise<unknown>>();
  #broker: Broker | undefined;
  #clientCapabilities: UnknownRecord = {};
  #protocolVersion = PROTOCOL_VERSION;
  #initialized = false;
  #closing = false;

  constructor(peer: JsonLinePeer, options: McpServerOptions = {}) {
    this.#peer = peer;
    this.#options = options;
    peer.setRequestHandler((method, params, id) => this.#handleRequest(method, params, id));
    peer.setNotificationHandler((method, params) => this.#handleNotification(method, params));
    peer.once("close", () => {
      void this.close();
    });
  }

  start(): void {
    this.#peer.start();
  }

  async close(): Promise<void> {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    for (const controller of this.#activeCalls.values()) {
      controller.abort();
    }
    this.#activeCalls.clear();
    this.#approvedWorkspaceRoots.clear();
    this.#pendingWorkspaceApprovals.clear();
    await this.#broker?.close();
    this.#peer.close();
  }

  async #getBroker(): Promise<Broker> {
    if (!this.#broker) {
      this.#broker = await Broker.create(this.#options);
    }
    return this.#broker;
  }

  async #handleRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    if (method === "initialize") {
      if (!isRecord(params)) {
        throw new McpRequestError(-32602, "initialize params must be an object");
      }
      this.#clientCapabilities = isRecord(params.capabilities) ? params.capabilities : {};
      const requestedVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : PROTOCOL_VERSION;
      this.#protocolVersion = negotiatedVersion;
      this.#initialized = true;
      return {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "mixagents-broker",
          title: "MixAgents Broker",
          version: SERVER_VERSION,
        },
        instructions:
          "Use routes before dispatch and pass an absolute cwd. Broker keeps provider/model fixed and returns native-sized agent results.",
      };
    }
    if (!this.#initialized) {
      throw new McpRequestError(-32002, "Server is not initialized");
    }
    if (method === "ping") {
      return {};
    }
    if (method === "tools/list") {
      return { tools: TOOLS };
    }
    if (method === "tools/call") {
      return this.#handleToolCall(params, id);
    }
    throw new McpRequestError(-32601, `Method not found: ${method}`);
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== "notifications/cancelled" || !isRecord(params)) {
      return;
    }
    const requestId = params.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      this.#activeCalls.get(requestId)?.abort();
    }
  }

  async #handleToolCall(params: unknown, requestId: JsonRpcId): Promise<JsonObject> {
    if (!isRecord(params) || typeof params.name !== "string") {
      throw new McpRequestError(-32602, "tools/call needs a tool name");
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const controller = new AbortController();
    this.#activeCalls.set(requestId, controller);
    try {
      const broker = await this.#getBroker();
      switch (params.name) {
        case "routes":
          return toolSuccess({ routes: broker.routes() });
        case "spawn_agent":
          return toolSuccess(await this.#spawnAgent(broker, args, controller.signal));
        case "send":
          return toolSuccess(await broker.send(args.agentId, args.message));
        case "wait_agent":
          const waitOptions: {
            signal: AbortSignal;
            elicit?: (request: Record<string, unknown>) => Promise<unknown>;
          } = { signal: controller.signal };
          if (this.#supportsElicitation()) {
            waitOptions.elicit = (request) => this.#elicit(request);
          }
          return toolSuccess(
            await broker.waitAgents(args.agentIds, args.timeoutMs, waitOptions),
          );
        case "interrupt_agent":
          return toolSuccess(await broker.interruptAgent(args.agentId));
        case "list_agents":
          return toolSuccess({ agents: await broker.listAgents() });
        default:
          throw new McpRequestError(-32602, `Unknown tool ${params.name}`);
      }
    } catch (error) {
      if (error instanceof McpRequestError) {
        throw error;
      }
      return toolFailure(error);
    } finally {
      this.#activeCalls.delete(requestId);
    }
  }

  #supportsElicitation(): boolean {
    return (
      (this.#protocolVersion === "2025-11-25" ||
        this.#protocolVersion === "2025-06-18") &&
      isRecord(this.#clientCapabilities.elicitation)
    );
  }

  #elicit(request: Record<string, unknown>): Promise<unknown> {
    const params = { ...request };
    if (this.#protocolVersion === "2025-06-18") {
      delete params.mode;
    }
    return this.#peer.request("elicitation/create", params, 120_000);
  }

  async #spawnAgent(
    broker: Broker,
    args: UnknownRecord,
    signal: AbortSignal,
  ): Promise<AgentSnapshot> {
    const advertisedRoots = await this.#clientRoots();
    const clientRoots = [...advertisedRoots, ...this.#approvedWorkspaceRoots];
    try {
      return await broker.spawnAgent({
        route: args.route,
        task: args.task,
        cwd: args.cwd,
        access: args.access,
        clientRoots,
      });
    } catch (error) {
      if (!isWorkspaceAuthorizationError(error) || typeof args.cwd !== "string") {
        throw error;
      }
      if (!this.#supportsElicitation()) {
        throw new BrokerError(
          error.code,
          `${error.message}; this MCP client cannot request workspace approval, so configure workspaceRoots in broker.json`,
        );
      }

      const cwd = await resolveWorkspace(args.cwd);
      const approved = await this.#approveWorkspace(cwd, signal);
      if (!approved) {
        throw new BrokerError(
          "workspace_approval_declined",
          `Workspace access was not approved for ${cwd}`,
        );
      }
      if (signal.aborted) {
        throw new BrokerError("spawn_cancelled", "spawn_agent was cancelled");
      }
      return broker.spawnAgent({
        route: args.route,
        task: args.task,
        cwd,
        access: args.access,
        clientRoots: [...advertisedRoots, ...this.#approvedWorkspaceRoots],
      });
    }
  }

  async #approveWorkspace(cwd: string, signal: AbortSignal): Promise<boolean> {
    if (this.#approvedWorkspaceRoots.has(cwd)) {
      return true;
    }
    let request = this.#pendingWorkspaceApprovals.get(cwd);
    if (!request) {
      request = (async () => {
        try {
          return await this.#elicit({
            mode: "form",
            message:
              "Allow MixAgents Broker to use this directory and its subdirectories as an agent workspace for this Codex connection?\n\n" +
              `Workspace: ${cwd}\n\n` +
              "The selected route and requested read-only or workspace-write access still apply.",
            requestedSchema: {
              type: "object",
              properties: {
                decision: {
                  type: "string",
                  title: "Workspace access",
                  enum: ["approve", "decline"],
                  enumNames: ["Allow for this connection", "Decline"],
                },
              },
              required: ["decision"],
            },
          });
        } catch (error) {
          throw new BrokerError(
            "workspace_approval_unavailable",
            `Could not request workspace access for ${cwd}: ${errorMessage(error)}`,
          );
        }
      })();
      this.#pendingWorkspaceApprovals.set(cwd, request);
      void request
        .finally(() => {
          if (this.#pendingWorkspaceApprovals.get(cwd) === request) {
            this.#pendingWorkspaceApprovals.delete(cwd);
          }
        })
        .catch(() => undefined);
    }

    const result = await waitForWorkspaceApproval(request, signal);
    const approved = workspaceApprovalAccepted(result);
    if (approved) {
      this.#approvedWorkspaceRoots.add(cwd);
    }
    return approved;
  }

  async #clientRoots(): Promise<string[]> {
    if (!isRecord(this.#clientCapabilities.roots)) {
      return [];
    }
    try {
      const result = await this.#peer.request("roots/list", {}, 10_000);
      if (!isRecord(result) || !Array.isArray(result.roots)) {
        return [];
      }
      return result.roots
        .filter(isRecord)
        .map((root) => root.uri)
        .filter((uri): uri is string => typeof uri === "string");
    } catch {
      return [];
    }
  }
}

export { TOOLS };
