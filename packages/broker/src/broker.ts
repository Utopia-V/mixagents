import type { EventEmitter } from "node:events";

import { RuntimeManager } from "./app-server.js";
import {
  loadConfig,
  materializeCredentialEnvironment,
  requireAccess,
  requireRoute,
  routeView,
  validateWorkspace,
} from "./config.js";
import { BrokerError } from "./errors.js";
import { resolveInteraction, type Elicitor } from "./interactions.js";
import type {
  AgentSnapshot,
  BrokerConfig,
  ProcessSpec,
  RouteView,
  WaitResult,
} from "./types.js";

interface BrokerOptions {
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  processOverride?: ProcessSpec;
}

interface WaitTarget {
  runtime: Awaited<ReturnType<RuntimeManager["forAgent"]>>["runtime"];
  threadId: string;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrokerError("invalid_input", `${label} must be a non-empty string`);
  }
  return value;
}

function clampTimeout(value: unknown): number {
  if (value === undefined) {
    return 30_000;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BrokerError("invalid_input", "timeoutMs must be a non-negative integer");
  }
  return Math.min(value as number, 120_000);
}

async function waitForRuntimeUpdate(
  runtimes: Array<EventEmitter & { revision: number }>,
  baselines: Map<EventEmitter & { revision: number }, number>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"update" | "timeout" | "aborted"> {
  if (timeoutMs <= 0) {
    return "timeout";
  }
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: "update" | "timeout" | "aborted") => {
      for (const runtime of runtimes) {
        runtime.off("update", onUpdate);
      }
      signal?.removeEventListener("abort", onAbort);
      if (timer) {
        clearTimeout(timer);
      }
      resolve(outcome);
    };
    const onUpdate = () => finish("update");
    const onAbort = () => finish("aborted");
    for (const runtime of runtimes) {
      runtime.once("update", onUpdate);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (runtimes.some((runtime) => runtime.revision !== baselines.get(runtime))) {
      finish("update");
      return;
    }
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref();
  });
}

export class Broker {
  readonly config: BrokerConfig;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runtimes: RuntimeManager;

  private constructor(config: BrokerConfig, options: BrokerOptions) {
    this.config = config;
    this.#environment = options.environment ?? process.env;
    this.#runtimes = new RuntimeManager(
      config.dataDir,
      config.codexBin,
      this.#environment,
      options.processOverride,
    );
  }

  static async create(options: BrokerOptions = {}): Promise<Broker> {
    const environment = materializeCredentialEnvironment(
      options.environment ?? process.env,
    );
    const config = await loadConfig(options.configPath, environment);
    return new Broker(config, { ...options, environment });
  }

  routes(): RouteView[] {
    return this.config.routes.map((route) => routeView(route, this.config, this.#environment));
  }

  async spawnAgent(input: {
    route: unknown;
    task: unknown;
    cwd: unknown;
    access?: unknown;
    clientRoots?: string[];
  }): Promise<AgentSnapshot> {
    const routeId = nonEmptyString(input.route, "route");
    const task = nonEmptyString(input.task, "task");
    const cwdInput = nonEmptyString(input.cwd, "cwd");
    const route = requireRoute(this.config, routeId);
    const view = routeView(route, this.config, this.#environment);
    if (!view.available) {
      throw new BrokerError(
        "credential_missing",
        `Route ${route.id} is missing environment variables: ${view.missingEnvironment.join(", ")}`,
      );
    }
    const access = requireAccess(route, input.access);
    const cwd = await validateWorkspace(
      cwdInput,
      this.config.workspaceRoots,
      input.clientRoots ?? [],
    );
    const runtime = await this.#runtimes.forRoute(route, access);
    return runtime.startAgent(task, cwd);
  }

  async send(agentIdInput: unknown, messageInput: unknown): Promise<AgentSnapshot> {
    const agentId = nonEmptyString(agentIdInput, "agentId");
    const message = nonEmptyString(messageInput, "message");
    const { runtime, threadId } = await this.#runtimes.forAgent(agentId);
    return runtime.send(threadId, message);
  }

  async interruptAgent(agentIdInput: unknown): Promise<{
    previousStatus: AgentSnapshot["status"];
    agent: AgentSnapshot;
    providerMayContinue: boolean;
  }> {
    const agentId = nonEmptyString(agentIdInput, "agentId");
    const { runtime, threadId } = await this.#runtimes.forAgent(agentId);
    let interaction = runtime.takeInteraction(threadId);
    while (interaction) {
      await resolveInteraction(interaction);
      interaction = runtime.takeInteraction(threadId);
    }
    const result = await runtime.interrupt(threadId);
    return {
      ...result,
      providerMayContinue: result.previousStatus === "running",
    };
  }

  async waitAgents(
    agentIdsInput: unknown,
    timeoutInput: unknown,
    options: { elicit?: Elicitor; signal?: AbortSignal } = {},
  ): Promise<WaitResult> {
    if (
      !Array.isArray(agentIdsInput) ||
      agentIdsInput.length < 1 ||
      agentIdsInput.length > 8 ||
      !agentIdsInput.every((id) => typeof id === "string" && id.trim() !== "")
    ) {
      throw new BrokerError("invalid_input", "agentIds must contain one to eight ids");
    }
    const agentIds = [...new Set(agentIdsInput as string[])];
    const timeoutMs = clampTimeout(timeoutInput);
    const targets: WaitTarget[] = await Promise.all(
      agentIds.map(async (agentId) => this.#runtimes.forAgent(agentId)),
    );
    const deadline = Date.now() + timeoutMs;

    while (true) {
      let handledInteraction = false;
      for (const target of targets) {
        let interaction = target.runtime.takeInteraction(target.threadId);
        while (interaction) {
          handledInteraction = true;
          await resolveInteraction(interaction, options.elicit);
          interaction = target.runtime.takeInteraction(target.threadId);
        }
      }

      const runtimes = [...new Set(targets.map((target) => target.runtime))];
      const baselines = new Map(runtimes.map((runtime) => [runtime, runtime.revision]));
      const agents = await Promise.all(
        targets.map((target) => target.runtime.snapshotFor(target.threadId)),
      );
      if (agents.some((agent) => agent.status !== "running" && agent.status !== "starting")) {
        return { timedOut: false, agents };
      }
      if (options.signal?.aborted) {
        throw new BrokerError("wait_cancelled", "wait_agent was cancelled");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { timedOut: true, agents };
      }
      if (handledInteraction) {
        continue;
      }
      const outcome = await waitForRuntimeUpdate(
        runtimes,
        baselines,
        remaining,
        options.signal,
      );
      if (outcome === "aborted") {
        throw new BrokerError("wait_cancelled", "wait_agent was cancelled");
      }
      if (outcome === "timeout") {
        const current = await Promise.all(
          targets.map((target) => target.runtime.snapshotFor(target.threadId)),
        );
        return { timedOut: true, agents: current };
      }
    }
  }

  async listAgents(): Promise<AgentSnapshot[]> {
    const runtimes = await this.#runtimes.all();
    const groups = await Promise.all(
      runtimes.map(async (runtime) => {
        const threads = await runtime.listThreads();
        return Promise.all(threads.map((thread) => runtime.snapshotFor(thread.id)));
      }),
    );
    return groups.flat();
  }

  async close(): Promise<void> {
    await this.#runtimes.close();
  }
}
