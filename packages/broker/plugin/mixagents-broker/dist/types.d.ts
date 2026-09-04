export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export type Access = "read-only" | "workspace-write";
export type AgentStatus = "starting" | "running" | "interrupted" | "completed" | "failed" | "not_found";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export interface RouteConfig {
    id: string;
    description: string;
    provider: string;
    providerName: string;
    model: string;
    contextWindow?: number;
    baseUrl: string;
    envKey?: string;
    envHttpHeaders: Record<string, string>;
    tags: string[];
    maxAccess: Access;
    reasoningEffort?: ReasoningEffort;
}
export interface BrokerConfig {
    path: string;
    defaultRoute?: string;
    workspaceRoots: string[];
    dataDir: string;
    codexBin: string;
    routes: RouteConfig[];
}
export interface RouteView {
    id: string;
    description: string;
    provider: string;
    model: string;
    contextWindow?: number;
    tags: string[];
    available: boolean;
    missingEnvironment: string[];
    maxAccess: Access;
    backend: "app_server";
    selectionReason: string;
    nativeAgentType: null;
    default: boolean;
}
export interface AgentSnapshot {
    agentId: string;
    route: string;
    provider: string;
    model: string;
    backend: "app_server";
    status: AgentStatus;
    output?: string;
    error?: string;
}
export interface WaitResult {
    timedOut: boolean;
    agents: AgentSnapshot[];
}
export interface RuntimeMetadata {
    version: 1;
    runtimeId: string;
    access: Access;
    route: RouteConfig;
    createdAt: string;
}
export interface ProcessSpec {
    command: string;
    prefixArgs: string[];
    launcher?: "windows-command-script";
}
export interface ThreadTurn {
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    items?: unknown[];
    error?: unknown;
}
export interface ThreadRecord {
    id: string;
    modelProvider?: string;
    cwd?: string;
    status?: unknown;
    turns?: ThreadTurn[];
}
export interface PendingInteraction {
    method: string;
    params: Record<string, unknown>;
    access: Access;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}
