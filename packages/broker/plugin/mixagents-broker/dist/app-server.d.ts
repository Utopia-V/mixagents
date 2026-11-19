import { EventEmitter } from "node:events";
import type { Access, AgentSnapshot, PendingInteraction, ProcessSpec, RouteConfig, RuntimeMetadata, ThreadRecord } from "./types.js";
interface RuntimeSpec {
    metadata: RuntimeMetadata;
    directory: string;
    process: ProcessSpec;
}
interface InternalAgent {
    threadId: string;
    cwd: string;
    status: AgentSnapshot["status"];
    activeTurnId?: string;
    output?: string;
    error?: string;
    ignoredTurnIds: Set<string>;
    interactions: PendingInteraction[];
}
export declare function renderRuntimeConfig(route: RouteConfig): string;
export declare function runtimeIdFor(route: RouteConfig, access: Access): string;
export declare function encodeAgentId(runtimeId: string, threadId: string): string;
export declare function parseAgentId(agentId: string): {
    runtimeId: string;
    threadId: string;
};
export declare class AppServerRuntime extends EventEmitter {
    #private;
    readonly spec: RuntimeSpec;
    constructor(spec: RuntimeSpec, environment?: NodeJS.ProcessEnv);
    get runtimeId(): string;
    get route(): RouteConfig;
    get access(): Access;
    get revision(): number;
    start(): Promise<void>;
    stop(): Promise<void>;
    startAgent(task: string, cwd: string): Promise<AgentSnapshot>;
    recover(threadId: string): Promise<InternalAgent>;
    send(threadId: string, message: string): Promise<AgentSnapshot>;
    interrupt(threadId: string): Promise<{
        previousStatus: AgentSnapshot["status"];
        agent: AgentSnapshot;
    }>;
    snapshot(agent: InternalAgent): AgentSnapshot;
    /**
     * Observes a thread without taking writer control from a live owner. A
     * thread this process does not own is read, not resumed. Only an unsettled
     * turn is probed with thread/resume: a live owner refuses it, and otherwise
     * the owner is gone and this process takes over the thread. `liveOwners`
     * keeps the threads found owned elsewhere during one tool call, so a polling
     * wait probes each of them once.
     */
    snapshotFor(threadId: string, liveOwners?: Set<string>): Promise<AgentSnapshot>;
    isAgentOwned(threadId: string): boolean;
    takeInteraction(threadId: string): PendingInteraction | undefined;
    listThreads(): Promise<ThreadRecord[]>;
}
export declare class RuntimeManager {
    #private;
    constructor(dataDir: string, codexBin: string, environment?: NodeJS.ProcessEnv, processOverride?: ProcessSpec);
    forRoute(route: RouteConfig, access: Access): Promise<AppServerRuntime>;
    forAgent(agentId: string): Promise<{
        runtime: AppServerRuntime;
        threadId: string;
    }>;
    all(): Promise<AppServerRuntime[]>;
    close(): Promise<void>;
}
export {};
