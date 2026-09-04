import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildProcessInvocation, resolveCodexProcess } from "./codex-process.js";
import { BrokerError, errorMessage } from "./errors.js";
import { JsonLinePeer, JsonRpcRemoteError } from "./jsonrpc.js";
const RUNTIME_METADATA_FILE = "runtime.json";
const RUNTIME_CONFIG_FILE = "config.toml";
const AGENT_PREFIX = "broker";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function environmentValue(environment, name) {
    if (environment[name] || process.platform !== "win32") {
        return environment[name];
    }
    return Object.entries(environment).find(([key, value]) => key.toLowerCase() === name.toLowerCase() && value)?.[1];
}
function stableValue(value) {
    if (Array.isArray(value)) {
        return value.map(stableValue);
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stableValue(item)]));
    }
    return value;
}
function tomlString(value) {
    return JSON.stringify(value);
}
function tomlInlineStringMap(values) {
    const entries = Object.entries(values).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`);
    return `{ ${entries.join(", ")} }`;
}
export function renderRuntimeConfig(route) {
    const lines = [
        `model = ${tomlString(route.model)}`,
        `model_provider = ${tomlString(route.provider)}`,
        'approval_policy = "on-request"',
    ];
    if (route.reasoningEffort) {
        lines.push(`model_reasoning_effort = ${tomlString(route.reasoningEffort)}`);
    }
    if (route.contextWindow !== undefined) {
        lines.push(`model_context_window = ${route.contextWindow}`);
    }
    lines.push("", "[features]", "multi_agent = false", "multi_agent_v2 = false", "plugins = false", "", `[model_providers.${route.provider}]`, `name = ${tomlString(route.providerName)}`, `base_url = ${tomlString(route.baseUrl)}`, 'wire_api = "responses"', "requires_openai_auth = false");
    if (route.envKey) {
        lines.push(`env_key = ${tomlString(route.envKey)}`);
        lines.push(`env_key_instructions = ${tomlString(`Set ${route.envKey} outside Codex before starting Broker.`)}`);
    }
    if (Object.keys(route.envHttpHeaders).length > 0) {
        lines.push(`env_http_headers = ${tomlInlineStringMap(route.envHttpHeaders)}`);
    }
    lines.push("", "[shell_environment_policy]", 'inherit = "core"', "ignore_default_excludes = false");
    const secretNames = [
        ...(route.envKey ? [route.envKey] : []),
        ...Object.values(route.envHttpHeaders),
    ];
    const shellExcludes = [...secretNames, "*_PROXY", "NO_PROXY"];
    if (shellExcludes.length > 0) {
        lines.push("", "[shell_environment_policy.filters]");
        for (const name of [...new Set(shellExcludes)].sort()) {
            lines.push(`${tomlString(name)} = "exclude"`);
        }
    }
    lines.push("");
    return lines.join("\n");
}
export function runtimeIdFor(route, access) {
    const fingerprint = createHash("sha256")
        .update(JSON.stringify(stableValue({
        provider: route.provider,
        model: route.model,
        contextWindow: route.contextWindow ?? null,
        baseUrl: route.baseUrl,
        envKey: route.envKey ?? null,
        envHttpHeaders: route.envHttpHeaders,
        reasoningEffort: route.reasoningEffort ?? null,
        access,
    })))
        .digest("hex")
        .slice(0, 16);
    const accessName = access === "read-only" ? "ro" : "rw";
    return `${route.id}-${accessName}-${fingerprint}`;
}
export function encodeAgentId(runtimeId, threadId) {
    if (runtimeId.includes(":") || threadId.includes(":")) {
        throw new BrokerError("invalid_agent", "runtime and thread ids must not contain colons");
    }
    return `${AGENT_PREFIX}:${runtimeId}:${threadId}`;
}
export function parseAgentId(agentId) {
    const parts = agentId.split(":");
    if (parts.length !== 3 ||
        parts[0] !== AGENT_PREFIX ||
        !parts[1] ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(parts[1]) ||
        !parts[2] ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parts[2])) {
        throw new BrokerError("invalid_agent", `Invalid Broker agent id ${agentId}`);
    }
    return { runtimeId: parts[1], threadId: parts[2] };
}
function filteredChildEnvironment(route, runtimeDirectory, environment) {
    const result = { CODEX_HOME: runtimeDirectory };
    const safeNames = [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_RUNTIME_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "JAVA_HOME",
        "GOPATH",
        "GOROOT",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "NVM_BIN",
        "NVM_DIR",
        "PYENV_ROOT",
        "VIRTUAL_ENV",
        "CONDA_PREFIX",
        "PKG_CONFIG_PATH",
        "CODEX_MANAGED_PACKAGE_ROOT",
    ];
    for (const name of safeNames) {
        const value = environmentValue(environment, name);
        if (value) {
            result[name] = value;
        }
    }
    const credentialNames = [
        ...(route.envKey ? [route.envKey] : []),
        ...Object.values(route.envHttpHeaders),
    ];
    for (const name of credentialNames) {
        const value = environmentValue(environment, name);
        if (value) {
            result[name] = value;
        }
    }
    return result;
}
async function atomicWrite(filePath, contents, mode = 0o600) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode });
    await rename(temporaryPath, filePath);
}
function extractTurnOutput(turn) {
    if (!turn?.items || !Array.isArray(turn.items)) {
        return undefined;
    }
    const messages = turn.items.filter((item) => isRecord(item) && item.type === "agentMessage" && typeof item.text === "string");
    const finalMessage = [...messages]
        .reverse()
        .find((item) => item.phase === "final_answer");
    const selected = finalMessage ?? messages.at(-1);
    return typeof selected?.text === "string" ? selected.text : undefined;
}
function extractTurnError(turn) {
    if (!turn?.error) {
        return undefined;
    }
    if (typeof turn.error === "string") {
        return turn.error;
    }
    if (isRecord(turn.error) && typeof turn.error.message === "string") {
        return turn.error.message;
    }
    return errorMessage(turn.error);
}
function statusFromTurn(turn) {
    switch (turn?.status) {
        case "inProgress":
            return "running";
        case "interrupted":
            return "interrupted";
        case "failed":
            return "failed";
        case "completed":
            return "completed";
        default:
            return "starting";
    }
}
function threadFromResult(result) {
    if (!isRecord(result) || !isRecord(result.thread) || typeof result.thread.id !== "string") {
        throw new BrokerError("app_server_protocol", "App Server returned no thread identity");
    }
    return result.thread;
}
function turnFromResult(result) {
    if (!isRecord(result) || !isRecord(result.turn) || typeof result.turn.id !== "string") {
        throw new BrokerError("app_server_protocol", "App Server returned no turn identity");
    }
    return result.turn;
}
export class AppServerRuntime extends EventEmitter {
    spec;
    #environment;
    #agents = new Map();
    #child;
    #peer;
    #starting;
    #stopping = false;
    #revision = 0;
    constructor(spec, environment = process.env) {
        super();
        this.spec = spec;
        this.#environment = environment;
    }
    get runtimeId() {
        return this.spec.metadata.runtimeId;
    }
    get route() {
        return this.spec.metadata.route;
    }
    get access() {
        return this.spec.metadata.access;
    }
    get revision() {
        return this.#revision;
    }
    #updated() {
        this.#revision += 1;
        this.emit("update");
    }
    async start() {
        if (this.#peer) {
            return;
        }
        if (this.#starting) {
            return this.#starting;
        }
        this.#starting = this.#startProcess();
        try {
            await this.#starting;
        }
        finally {
            this.#starting = undefined;
        }
    }
    async #startProcess() {
        await mkdir(this.spec.directory, { recursive: true, mode: 0o700 });
        await chmod(this.spec.directory, 0o700).catch(() => undefined);
        await atomicWrite(path.join(this.spec.directory, RUNTIME_CONFIG_FILE), renderRuntimeConfig(this.route));
        await atomicWrite(path.join(this.spec.directory, RUNTIME_METADATA_FILE), `${JSON.stringify(this.spec.metadata, null, 2)}\n`);
        await chmod(path.join(this.spec.directory, RUNTIME_CONFIG_FILE), 0o600).catch(() => undefined);
        await chmod(path.join(this.spec.directory, RUNTIME_METADATA_FILE), 0o600).catch(() => undefined);
        const args = [
            ...this.spec.process.prefixArgs,
            "app-server",
            "--stdio",
            "--strict-config",
            "--disable",
            "multi_agent",
            "--disable",
            "multi_agent_v2",
            "--disable",
            "plugins",
        ];
        const invocation = buildProcessInvocation(this.spec.process, args, this.#environment);
        const child = spawn(invocation.command, invocation.args, {
            env: filteredChildEnvironment(this.route, this.spec.directory, this.#environment),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
        this.#child = child;
        try {
            await once(child, "spawn");
        }
        catch (error) {
            this.#child = undefined;
            const windowsHint = process.platform === "win32"
                ? " Configure codexBin in broker.json or MIXAGENTS_BROKER_CODEX_BIN with the full path to codex.exe."
                : "";
            throw new BrokerError("runtime_start_failed", `Cannot launch App Server for route ${this.route.id}: ${errorMessage(error)}.${windowsHint}`);
        }
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            if (this.#environment.MIXAGENTS_BROKER_DEBUG === "1") {
                process.stderr.write(`[broker:${this.runtimeId}] ${chunk}`);
            }
        });
        child.once("exit", (code, signal) => {
            const reason = new Error(`App Server ${this.runtimeId} exited (${code ?? signal ?? "unknown"})`);
            this.#peer?.close(reason);
            this.#peer = undefined;
            this.#child = undefined;
            if (!this.#stopping) {
                for (const agent of this.#agents.values()) {
                    for (const interaction of agent.interactions.splice(0)) {
                        interaction.reject(reason);
                    }
                }
                this.#agents.clear();
                this.#updated();
            }
        });
        const peer = new JsonLinePeer(child.stdout, child.stdin, `app-${this.runtimeId}`, {
            bareMessages: true,
        });
        peer.setRequestHandler((method, params) => this.#queueServerRequest(method, params));
        peer.setNotificationHandler((method, params) => this.#handleNotification(method, params));
        peer.start();
        this.#peer = peer;
        try {
            await peer.request("initialize", {
                clientInfo: {
                    name: "mixagents_broker",
                    title: "MixAgents Broker",
                    version: "0.1.1",
                },
                capabilities: null,
            }, 15_000);
            peer.notify("initialized", {});
        }
        catch (error) {
            child.kill();
            this.#peer = undefined;
            this.#child = undefined;
            throw new BrokerError("runtime_start_failed", `Cannot start App Server for route ${this.route.id}: ${errorMessage(error)}`);
        }
    }
    async stop() {
        this.#stopping = true;
        this.#peer?.close(new Error("Broker is stopping"));
        this.#peer = undefined;
        if (this.#child && this.#child.exitCode === null) {
            this.#child.kill();
        }
        this.#child = undefined;
    }
    #request(method, params, timeoutMs = 30_000) {
        if (!this.#peer) {
            throw new BrokerError("runtime_unavailable", `Runtime ${this.runtimeId} is not running`);
        }
        return this.#peer.request(method, params, timeoutMs);
    }
    async startAgent(task, cwd) {
        await this.start();
        const response = await this.#request("thread/start", {
            model: this.route.model,
            modelProvider: this.route.provider,
            allowProviderModelFallback: false,
            cwd,
            approvalPolicy: "on-request",
            sandbox: this.access,
            serviceName: "mixagents_broker",
            developerInstructions: "You are a Broker-managed worker. Complete the assigned task in the supplied workspace and return a concise final result to the controller. Do not spawn subagents or invoke Broker.",
            ephemeral: false,
        });
        const thread = threadFromResult(response);
        const effectiveProvider = isRecord(response) && typeof response.modelProvider === "string"
            ? response.modelProvider
            : thread.modelProvider;
        const effectiveModel = isRecord(response) && typeof response.model === "string" ? response.model : undefined;
        if (effectiveProvider !== this.route.provider || effectiveModel !== this.route.model) {
            throw new BrokerError("route_mismatch", `App Server created ${effectiveProvider ?? "unknown"}/${effectiveModel ?? "unknown"}, expected ${this.route.provider}/${this.route.model}`);
        }
        const agent = {
            threadId: thread.id,
            cwd,
            status: "starting",
            ignoredTurnIds: new Set(),
            interactions: [],
        };
        this.#agents.set(thread.id, agent);
        this.#updated();
        try {
            const turnResponse = await this.#request("turn/start", {
                threadId: thread.id,
                input: [{ type: "text", text: task }],
            });
            const turn = turnFromResult(turnResponse);
            agent.activeTurnId = turn.id;
            agent.status = statusFromTurn(turn);
            if (agent.status === "starting") {
                agent.status = "running";
            }
        }
        catch (error) {
            agent.status = "failed";
            agent.error = errorMessage(error);
        }
        this.#updated();
        return this.snapshot(agent);
    }
    async recover(threadId) {
        const existing = this.#agents.get(threadId);
        if (existing) {
            return existing;
        }
        await this.start();
        try {
            const response = await this.#request("thread/resume", {
                threadId,
                model: this.route.model,
                modelProvider: this.route.provider,
            });
            const thread = threadFromResult(response);
            if (thread.modelProvider && thread.modelProvider !== this.route.provider) {
                throw new BrokerError("route_mismatch", `Stored thread uses ${thread.modelProvider}, expected ${this.route.provider}`);
            }
            const turns = Array.isArray(thread.turns) ? thread.turns : [];
            const latest = turns.at(-1);
            const agent = {
                threadId,
                cwd: typeof thread.cwd === "string" ? thread.cwd : "",
                status: statusFromTurn(latest),
                ignoredTurnIds: new Set(),
                interactions: [],
            };
            if (latest?.status === "inProgress") {
                agent.activeTurnId = latest.id;
            }
            const output = extractTurnOutput(latest);
            const turnError = extractTurnError(latest);
            if (output !== undefined) {
                agent.output = output;
            }
            if (turnError !== undefined) {
                agent.error = turnError;
            }
            this.#agents.set(threadId, agent);
            return agent;
        }
        catch (error) {
            if (error instanceof JsonRpcRemoteError &&
                /not found|unknown thread/i.test(error.message)) {
                const missing = {
                    threadId,
                    cwd: "",
                    status: "not_found",
                    ignoredTurnIds: new Set(),
                    interactions: [],
                };
                this.#agents.set(threadId, missing);
                return missing;
            }
            throw error;
        }
    }
    async send(threadId, message) {
        const agent = await this.recover(threadId);
        if (agent.status === "not_found") {
            return this.snapshot(agent);
        }
        if (agent.interactions.length > 0) {
            throw new BrokerError("interaction_pending", "The worker is waiting for host interaction; call wait_agent first");
        }
        delete agent.output;
        delete agent.error;
        try {
            if (agent.status === "running" && agent.activeTurnId) {
                await this.#request("turn/steer", {
                    threadId,
                    input: [{ type: "text", text: message }],
                    expectedTurnId: agent.activeTurnId,
                });
            }
            else {
                const response = await this.#request("turn/start", {
                    threadId,
                    input: [{ type: "text", text: message }],
                });
                const turn = turnFromResult(response);
                agent.activeTurnId = turn.id;
            }
            agent.status = "running";
        }
        catch (error) {
            agent.status = "failed";
            agent.error = errorMessage(error);
        }
        this.#updated();
        return this.snapshot(agent);
    }
    async interrupt(threadId) {
        const agent = await this.recover(threadId);
        const previousStatus = agent.status;
        if (agent.status === "running" && agent.activeTurnId) {
            const interruptedTurnId = agent.activeTurnId;
            await this.#request("turn/interrupt", {
                threadId,
                turnId: interruptedTurnId,
            });
            agent.ignoredTurnIds.add(interruptedTurnId);
            delete agent.activeTurnId;
            agent.status = "interrupted";
            delete agent.output;
            delete agent.error;
            this.#updated();
        }
        return { previousStatus, agent: this.snapshot(agent) };
    }
    snapshot(agent) {
        const snapshot = {
            agentId: encodeAgentId(this.runtimeId, agent.threadId),
            route: this.route.id,
            provider: this.route.provider,
            model: this.route.model,
            backend: "app_server",
            status: agent.status,
        };
        if (agent.output !== undefined && agent.status === "completed") {
            snapshot.output = agent.output;
        }
        if (agent.error !== undefined && agent.status === "failed") {
            snapshot.error = agent.error;
        }
        return snapshot;
    }
    async snapshotFor(threadId) {
        return this.snapshot(await this.recover(threadId));
    }
    takeInteraction(threadId) {
        return this.#agents.get(threadId)?.interactions.shift();
    }
    async listThreads() {
        await this.start();
        const threads = [];
        let cursor = null;
        do {
            const response = await this.#request("thread/list", {
                cursor,
                limit: 100,
                sortKey: "updated_at",
                sortDirection: "desc",
                modelProviders: [this.route.provider],
            });
            if (!isRecord(response) || !Array.isArray(response.data)) {
                throw new BrokerError("app_server_protocol", "Invalid thread/list response");
            }
            for (const item of response.data) {
                if (isRecord(item) && typeof item.id === "string") {
                    threads.push(item);
                }
            }
            cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
        } while (cursor);
        return threads;
    }
    #queueServerRequest(method, params) {
        if (!isRecord(params) || typeof params.threadId !== "string") {
            throw new BrokerError("unsupported_interaction", `App Server request ${method} has no worker thread identity`);
        }
        const agent = this.#agents.get(params.threadId);
        if (!agent) {
            throw new BrokerError("unknown_interaction", `App Server requested ${method} for an unknown Broker thread`);
        }
        return new Promise((resolve, reject) => {
            agent.interactions.push({
                method,
                params,
                access: this.access,
                resolve,
                reject,
            });
            this.#updated();
        });
    }
    #handleNotification(method, params) {
        if (!isRecord(params) || typeof params.threadId !== "string") {
            return;
        }
        const agent = this.#agents.get(params.threadId);
        if (!agent) {
            return;
        }
        if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
            agent.activeTurnId = params.turn.id;
            agent.status = "running";
            delete agent.output;
            delete agent.error;
            this.#updated();
            return;
        }
        if (method === "item/completed" && isRecord(params.item)) {
            const item = params.item;
            if (item.type === "agentMessage" && typeof item.text === "string") {
                agent.output = item.text;
            }
            return;
        }
        if (method === "turn/completed" && isRecord(params.turn) && typeof params.turn.id === "string") {
            const turn = params.turn;
            if (agent.ignoredTurnIds.has(turn.id)) {
                return;
            }
            delete agent.activeTurnId;
            agent.status = statusFromTurn(turn);
            const output = extractTurnOutput(turn) ?? agent.output;
            const turnError = extractTurnError(turn);
            if (output !== undefined) {
                agent.output = output;
            }
            if (turnError !== undefined) {
                agent.error = turnError;
            }
            this.#updated();
        }
    }
}
export class RuntimeManager {
    #dataDir;
    #process;
    #environment;
    #runtimes = new Map();
    constructor(dataDir, codexBin, environment = process.env, processOverride) {
        this.#dataDir = dataDir;
        this.#process = processOverride ?? resolveCodexProcess(codexBin, environment);
        this.#environment = environment;
    }
    async forRoute(route, access) {
        const runtimeId = runtimeIdFor(route, access);
        const existing = this.#runtimes.get(runtimeId);
        if (existing) {
            return existing;
        }
        const directory = path.join(this.#dataDir, "runtimes", runtimeId);
        const metadata = {
            version: 1,
            runtimeId,
            access,
            route,
            createdAt: new Date().toISOString(),
        };
        const runtime = new AppServerRuntime({ metadata, directory, process: this.#process }, this.#environment);
        this.#runtimes.set(runtimeId, runtime);
        return runtime;
    }
    async forAgent(agentId) {
        const { runtimeId, threadId } = parseAgentId(agentId);
        let runtime = this.#runtimes.get(runtimeId);
        if (!runtime) {
            runtime = await this.#loadRuntime(runtimeId);
            this.#runtimes.set(runtimeId, runtime);
        }
        return { runtime, threadId };
    }
    async all() {
        const root = path.join(this.#dataDir, "runtimes");
        let entries = [];
        try {
            entries = await readdir(root);
        }
        catch {
            return [...this.#runtimes.values()];
        }
        for (const runtimeId of entries) {
            if (this.#runtimes.has(runtimeId)) {
                continue;
            }
            try {
                this.#runtimes.set(runtimeId, await this.#loadRuntime(runtimeId));
            }
            catch {
                // Ignore incomplete or foreign directories rather than granting them authority.
            }
        }
        return [...this.#runtimes.values()];
    }
    async #loadRuntime(runtimeId) {
        const directory = path.join(this.#dataDir, "runtimes", runtimeId);
        const metadataPath = path.join(directory, RUNTIME_METADATA_FILE);
        let metadata;
        try {
            metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        }
        catch (error) {
            throw new BrokerError("runtime_not_found", `Cannot read runtime ${runtimeId}: ${errorMessage(error)}`);
        }
        if (metadata.version !== 1 ||
            metadata.runtimeId !== runtimeId ||
            (metadata.access !== "read-only" && metadata.access !== "workspace-write") ||
            !metadata.route ||
            runtimeIdFor(metadata.route, metadata.access) !== runtimeId) {
            throw new BrokerError("invalid_runtime", `Runtime metadata ${runtimeId} is invalid`);
        }
        return new AppServerRuntime({ metadata, directory, process: this.#process }, this.#environment);
    }
    async close() {
        await Promise.all([...this.#runtimes.values()].map((runtime) => runtime.stop()));
        this.#runtimes.clear();
    }
}
