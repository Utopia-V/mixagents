export declare class BrokerError extends Error {
    readonly code: string;
    readonly details?: unknown;
    constructor(code: string, message: string, details?: unknown);
}
export declare function errorMessage(error: unknown): string;
