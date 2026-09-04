import type { ProcessSpec } from "./types.js";
interface ResolutionOptions {
    platform?: NodeJS.Platform;
    arch?: string;
}
export interface ProcessInvocation {
    command: string;
    args: string[];
    windowsVerbatimArguments: boolean;
}
export declare function resolveCodexProcess(codexBin: string, environment?: NodeJS.ProcessEnv, options?: ResolutionOptions): ProcessSpec;
export declare function buildProcessInvocation(spec: ProcessSpec, args: string[], environment?: NodeJS.ProcessEnv): ProcessInvocation;
export {};
