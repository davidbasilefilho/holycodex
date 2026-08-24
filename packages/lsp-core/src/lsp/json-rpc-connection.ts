// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import { MAX_JSON_RPC_MESSAGE_BYTES } from "./constants.ts";
import { abortError, LspError } from "./errors.ts";
import { decodeLspSchema, isRecord } from "./schema.ts";
import type { Readable, Writable } from "node:stream";

type JsonRpcId = number | string | null;
type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => unknown;

export interface JsonRpcRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export class JsonRpcProtocolError extends LspError {
  constructor(message: string) {
    super("protocol", message);
    this.name = "JsonRpcProtocolError";
  }
}

export class JsonRpcRequestTimeoutError extends JsonRpcProtocolError {
  constructor(readonly method: string) {
    super(`JSON-RPC request timed out: ${method}`);
    this.name = "JsonRpcRequestTimeoutError";
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abortHandler?: () => void;
}

/** Implements bounded Content-Length framed JSON-RPC 2.0 over Node/Bun streams. */
export class JsonRpcConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly closeHandlers: Array<() => void> = [];
  private readonly errorHandlers: Array<(error: Error) => void> = [];
  private inputBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private writeChain: Promise<void> = Promise.resolve();
  private listening = false;
  private disposed = false;
  private readonly maxMessageBytes: number;

  constructor(
    private readonly reader: Readable,
    private readonly writer: Writable,
    maxMessageBytes = MAX_JSON_RPC_MESSAGE_BYTES,
  ) {
    this.maxMessageBytes = Math.max(1024, maxMessageBytes);
  }

  /** Starts reading framed messages from the server stream. */
  listen(): void {
    if (this.listening || this.disposed) return;
    this.listening = true;
    this.reader.on("data", this.handleData);
    this.reader.on("close", this.handleClose);
    this.reader.on("end", this.handleClose);
    this.reader.on("error", this.handleStreamError);
    this.writer.on("error", this.handleStreamError);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  /** Sends a validated request and supports bounded timeout and cancellation. */
  async sendRequest<T>(
    method: string,
    schema: Schema.Schema<T>,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<T> {
    if (this.disposed) throw new JsonRpcProtocolError("JSON-RPC connection is disposed");
    if (options.signal?.aborted === true) throw abortError();
    const id = this.nextRequestId++;
    const key = String(id);
    const message =
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params };
    const response = new Promise<T>((resolve, reject) => {
      const abortHandler =
        options.signal === undefined
          ? undefined
          : (): void => {
              if (!this.pending.delete(key)) return;
              void this.sendNotification("$/cancelRequest", { id }).catch((error: unknown) =>
                this.emitError(toError(error)),
              );
              reject(abortError());
            };
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (!this.pending.delete(key)) return;
              void this.sendNotification("$/cancelRequest", { id }).catch((error: unknown) =>
                this.emitError(toError(error)),
              );
              reject(new JsonRpcRequestTimeoutError(method));
            }, options.timeoutMs);
      this.pending.set(key, {
        method,
        resolve: (result) => {
          const decoded = decodeLspSchema(schema, result);
          if (decoded === undefined)
            reject(new JsonRpcProtocolError(`Invalid result for JSON-RPC method '${method}'.`));
          else resolve(decoded);
        },
        reject,
        ...(timer === undefined ? {} : { timer }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(abortHandler === undefined ? {} : { abortHandler }),
      });
      if (abortHandler !== undefined) {
        if (options.signal?.aborted === true) abortHandler();
        else options.signal?.addEventListener("abort", abortHandler, { once: true });
      }
    });
    try {
      await this.writeMessage(message);
    } catch (error: unknown) {
      this.rejectPending(key, toError(error));
      throw error;
    }
    return response;
  }

  /** Sends a notification without creating a pending request. */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    if (this.disposed) return;
    await this.writeMessage(
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
    );
  }

  /** Releases listeners and rejects every outstanding request. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reader.off("data", this.handleData);
    this.reader.off("close", this.handleClose);
    this.reader.off("end", this.handleClose);
    this.reader.off("error", this.handleStreamError);
    this.writer.off("error", this.handleStreamError);
    for (const [key, pending] of this.pending) {
      this.clearPending(pending);
      pending.reject(new JsonRpcProtocolError("JSON-RPC connection disposed"));
      this.pending.delete(key);
    }
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.inputBuffer = Buffer.concat([this.inputBuffer, next]);
    if (this.inputBuffer.length > this.maxMessageBytes + 64 * 1024) {
      this.emitError(new JsonRpcProtocolError("JSON-RPC input exceeded the configured bound."));
      this.inputBuffer = Buffer.alloc(0);
      return;
    }
    this.drainInputBuffer();
  };

  private readonly handleClose = (): void => {
    for (const handler of this.closeHandlers) handler();
    for (const [key, pending] of this.pending) {
      this.clearPending(pending);
      pending.reject(new JsonRpcProtocolError("JSON-RPC stream closed"));
      this.pending.delete(key);
    }
  };

  private readonly handleStreamError = (error: Error): void => {
    this.emitError(error);
  };

  private drainInputBuffer(): void {
    while (true) {
      const headerEnd = this.inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headers = this.inputBuffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(headers);
      if (contentLength === null || contentLength > this.maxMessageBytes) {
        this.emitError(
          new JsonRpcProtocolError(
            contentLength === null
              ? "JSON-RPC message is missing a valid Content-Length header."
              : "JSON-RPC message exceeded the configured bound.",
          ),
        );
        this.inputBuffer = this.inputBuffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.inputBuffer.length < bodyEnd) return;
      const body = this.inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.inputBuffer = this.inputBuffer.subarray(bodyEnd);
      this.dispatchBody(body);
    }
  }

  private dispatchBody(body: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error: unknown) {
      void this.writeError(
        null,
        -32700,
        error instanceof Error ? error.message : "Parse error",
      ).catch((writeError: unknown) => this.emitError(toError(writeError)));
      return;
    }
    if (!isRecord(parsed) || parsed["jsonrpc"] !== "2.0") {
      void this.writeError(null, -32600, "Invalid JSON-RPC message").catch((error: unknown) =>
        this.emitError(toError(error)),
      );
      return;
    }
    const id = readId(parsed["id"]);
    if (
      Object.hasOwn(parsed, "id") &&
      (Object.hasOwn(parsed, "result") || Object.hasOwn(parsed, "error"))
    ) {
      if (id !== undefined) this.handleResponse(id, parsed);
      return;
    }
    const method = parsed["method"];
    if (typeof method !== "string" || method.length === 0) {
      void this.writeError(id ?? null, -32600, "Invalid JSON-RPC method").catch((error: unknown) =>
        this.emitError(toError(error)),
      );
      return;
    }
    if (Object.hasOwn(parsed, "id")) this.handleRequest(id, method, parsed["params"]);
    else this.handleNotification(method, parsed["params"]);
  }

  private handleResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const key = String(id);
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    this.clearPending(pending);
    if (Object.hasOwn(message, "error")) {
      const value = message["error"];
      const parsed = isRecord(value) && typeof value["code"] === "number" ? value : undefined;
      pending.reject(
        parsed === undefined
          ? new JsonRpcProtocolError("Malformed JSON-RPC error response.")
          : new JsonRpcProtocolError(
              typeof parsed["message"] === "string"
                ? parsed["message"]
                : `JSON-RPC error ${String(parsed["code"])}`,
            ),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  private handleNotification(method: string, params: unknown): void {
    const handler = this.notificationHandlers.get(method);
    if (handler === undefined) return;
    try {
      handler(params);
    } catch (error: unknown) {
      this.emitError(toError(error));
    }
  }

  private handleRequest(id: JsonRpcId | undefined, method: string, params: unknown): void {
    if (id === undefined) {
      void this.writeError(null, -32600, "Invalid JSON-RPC id").catch((error: unknown) =>
        this.emitError(toError(error)),
      );
      return;
    }
    const handler = this.requestHandlers.get(method);
    if (handler === undefined) {
      void this.writeError(id, -32601, `Method not found: ${method}`).catch((error: unknown) =>
        this.emitError(toError(error)),
      );
      return;
    }
    Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => this.writeMessage({ jsonrpc: "2.0", id, result }),
        (error: unknown) => this.writeError(id, -32603, toError(error).message),
      )
      .catch((error: unknown) => this.emitError(toError(error)));
  }

  private async writeError(id: JsonRpcId, code: number, message: string): Promise<void> {
    await this.writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private writeMessage(message: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body, "utf8") > this.maxMessageBytes)
      return Promise.reject(
        new JsonRpcProtocolError("JSON-RPC output exceeded the configured bound."),
      );
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    const write = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.writer.write(payload, (error?: Error | null) =>
            error === null || error === undefined ? resolve() : reject(error),
          );
        }),
    );
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private rejectPending(key: string, error: Error): void {
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    this.clearPending(pending);
    pending.reject(error);
  }

  private clearPending(pending: PendingRequest): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.abortHandler !== undefined && pending.signal !== undefined)
      pending.signal.removeEventListener("abort", pending.abortHandler);
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }
}

function parseContentLength(headers: string): number | null {
  for (const line of headers.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== "content-length")
      continue;
    const value = Number.parseInt(line.slice(separator + 1).trim(), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

function readId(value: unknown): JsonRpcId | undefined {
  return value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
