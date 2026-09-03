import { JsonLinePeer } from "./jsonrpc.js";
import type { JsonObject, ProcessSpec } from "./types.js";
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
declare const TOOLS: ToolDefinition[];
export declare class BrokerMcpServer {
    #private;
    constructor(peer: JsonLinePeer, options?: McpServerOptions);
    start(): void;
    close(): Promise<void>;
}
export { TOOLS };
