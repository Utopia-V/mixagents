import { EventEmitter } from "node:events";
import type { Access, AgentSnapshot, PendingInteraction, ProcessSpec, RouteConfig, RuntimeMetadata, ThreadRecord } from "./types.js";
interface RuntimeSpec {
    metadata: RuntimeMetadata;
    directory: string;
    process: ProcessSpec;
    stallTimeoutMs: number;
}
interface InternalAgent {
    threadId: string;
    cwd: string;
    status: AgentSnapshot["status"];
    activeTurnId?: string;
    output?: string;
    error?: string;
    lastActivityAt: number;
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
    snapshotFor(threadId: string): Promise<AgentSnapshot>;
    /**
     * Re-read durable thread state so a turn that finished without a delivered
     * `turn/completed` notification can still be observed. This never throws:
     * when the durable read is unavailable the last known snapshot is returned.
     *
     * `thread/resume` is the heavier fallback for App Server builds that do not
     * serve turns from `thread/read`. It is only used when the caller asks for
     * it, so a periodic refresh cannot hammer a live thread with resume calls.
     */
    refresh(threadId: string, options?: {
        allowResumeFallback?: boolean;
    }): Promise<AgentSnapshot>;
    takeInteraction(threadId: string): PendingInteraction | undefined;
    listThreads(): Promise<ThreadRecord[]>;
}
export declare class RuntimeManager {
    #private;
    constructor(dataDir: string, codexBin: string, stallTimeoutMs: number, environment?: NodeJS.ProcessEnv, processOverride?: ProcessSpec);
    forRoute(route: RouteConfig, access: Access): Promise<AppServerRuntime>;
    forAgent(agentId: string): Promise<{
        runtime: AppServerRuntime;
        threadId: string;
    }>;
    all(): Promise<AppServerRuntime[]>;
    close(): Promise<void>;
}
export {};
