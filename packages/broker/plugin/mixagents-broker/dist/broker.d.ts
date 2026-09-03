import { type Elicitor } from "./interactions.js";
import type { AgentSnapshot, BrokerConfig, ProcessSpec, RouteView, WaitResult } from "./types.js";
interface BrokerOptions {
    configPath?: string;
    environment?: NodeJS.ProcessEnv;
    processOverride?: ProcessSpec;
}
export declare class Broker {
    #private;
    readonly config: BrokerConfig;
    private constructor();
    static create(options?: BrokerOptions): Promise<Broker>;
    routes(): RouteView[];
    spawnAgent(input: {
        route: unknown;
        task: unknown;
        cwd: unknown;
        access?: unknown;
        clientRoots?: string[];
    }): Promise<AgentSnapshot>;
    send(agentIdInput: unknown, messageInput: unknown): Promise<AgentSnapshot>;
    interruptAgent(agentIdInput: unknown): Promise<{
        previousStatus: AgentSnapshot["status"];
        agent: AgentSnapshot;
        providerMayContinue: boolean;
    }>;
    waitAgents(agentIdsInput: unknown, timeoutInput: unknown, options?: {
        elicit?: Elicitor;
        signal?: AbortSignal;
    }): Promise<WaitResult>;
    listAgents(): Promise<AgentSnapshot[]>;
    close(): Promise<void>;
}
export {};
