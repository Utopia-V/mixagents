import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
export type JsonRpcId = string | number;
type RequestHandler = (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => Promise<void> | void;
export declare class JsonRpcRemoteError extends Error {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown);
}
export declare class JsonLinePeer extends EventEmitter {
    #private;
    constructor(input: Readable, output: Writable, requestPrefix?: string, options?: {
        bareMessages?: boolean;
    });
    setRequestHandler(handler: RequestHandler): void;
    setNotificationHandler(handler: NotificationHandler): void;
    start(): void;
    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params?: unknown): void;
    close(reason?: Error): void;
}
export {};
