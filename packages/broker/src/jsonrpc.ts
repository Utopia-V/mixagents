import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { errorMessage } from "./errors.js";

export type JsonRpcId = string | number;

interface JsonRpcSuccess {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type RequestHandler = (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => Promise<void> | void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcRemoteError";
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

export class JsonLinePeer extends EventEmitter {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #requestPrefix: string;
  readonly #bareMessages: boolean;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextRequestId = 0;
  #requestHandler: RequestHandler | undefined;
  #notificationHandler: NotificationHandler | undefined;
  #closed = false;

  constructor(
    input: Readable,
    output: Writable,
    requestPrefix = "request",
    options: { bareMessages?: boolean } = {},
  ) {
    super();
    this.#input = input;
    this.#output = output;
    this.#requestPrefix = requestPrefix;
    this.#bareMessages = options.bareMessages ?? false;
  }

  setRequestHandler(handler: RequestHandler): void {
    this.#requestHandler = handler;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.#notificationHandler = handler;
  }

  start(): void {
    const lines = createInterface({ input: this.#input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.trim() === "") {
        return;
      }
      void this.#acceptLine(line);
    });
    lines.on("close", () => this.close(new Error("JSON-RPC input closed")));
    this.#input.on("error", (error) => this.close(error));
    this.#output.on("error", (error) => this.close(error));
  }

  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) {
      throw new Error("JSON-RPC peer is closed");
    }
    const id = `${this.#requestPrefix}-${++this.#nextRequestId}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.timeout.unref();
      }
      this.#pending.set(id, pending);
    });
    this.#write(
      this.#bareMessages
        ? { id, method, params }
        : { jsonrpc: "2.0", id, method, params },
    );
    return result;
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.#closed) {
      this.#write(
        this.#bareMessages ? { method, params } : { jsonrpc: "2.0", method, params },
      );
    }
  }

  close(reason = new Error("JSON-RPC peer closed")): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(reason);
    }
    this.#pending.clear();
    this.emit("close", reason);
  }

  #write(message: unknown): void {
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  async #acceptLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emit("protocolError", new Error(`Invalid JSON-RPC line: ${errorMessage(error)}`));
      return;
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        this.#write({
          jsonrpc: "2.0",
          id: 0,
          error: { code: -32600, message: "Invalid Request" },
        });
        return;
      }
      const responses = (
        await Promise.all(parsed.map((message) => this.#processMessage(message)))
      ).filter((message): message is JsonRpcSuccess | JsonRpcFailure => message !== null);
      if (responses.length > 0) {
        this.#write(responses);
      }
      return;
    }

    const response = await this.#processMessage(parsed);
    if (response) {
      this.#write(response);
    }
  }

  async #processMessage(value: unknown): Promise<JsonRpcSuccess | JsonRpcFailure | null> {
    if (
      !isObject(value) ||
      (!this.#bareMessages && value.jsonrpc !== "2.0") ||
      (this.#bareMessages && value.jsonrpc !== undefined && value.jsonrpc !== "2.0")
    ) {
      return {
        ...(this.#bareMessages ? {} : { jsonrpc: "2.0" as const }),
        id: 0,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    if (typeof value.method === "string") {
      if (!isId(value.id)) {
        try {
          await this.#notificationHandler?.(value.method, value.params);
        } catch (error) {
          this.emit("protocolError", error);
        }
        return null;
      }
      if (!this.#requestHandler) {
        return {
          ...(this.#bareMessages ? {} : { jsonrpc: "2.0" as const }),
          id: value.id,
          error: { code: -32601, message: `Method not found: ${value.method}` },
        };
      }
      try {
        const result = await this.#requestHandler(value.method, value.params, value.id);
        return {
          ...(this.#bareMessages ? {} : { jsonrpc: "2.0" as const }),
          id: value.id,
          result,
        } as JsonRpcSuccess;
      } catch (error) {
        const code =
          isObject(error) && typeof error.jsonRpcCode === "number"
            ? error.jsonRpcCode
            : -32000;
        return {
          ...(this.#bareMessages ? {} : { jsonrpc: "2.0" as const }),
          id: value.id,
          error: { code, message: errorMessage(error) },
        };
      }
    }

    if (isId(value.id) && ("result" in value || "error" in value)) {
      const pending = this.#pending.get(value.id);
      if (!pending) {
        return null;
      }
      this.#pending.delete(value.id);
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      if (isObject(value.error)) {
        const code = typeof value.error.code === "number" ? value.error.code : -32000;
        const message =
          typeof value.error.message === "string" ? value.error.message : "JSON-RPC error";
        pending.reject(new JsonRpcRemoteError(code, message, value.error.data));
      } else {
        pending.resolve(value.result);
      }
      return null;
    }

    return {
      ...(this.#bareMessages ? {} : { jsonrpc: "2.0" as const }),
      id: 0,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
}
