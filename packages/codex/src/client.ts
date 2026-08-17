// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import type { JsonValue } from "@holycodex/core";
import {
  CODEX_CLIENT_VERSION,
  DEFAULT_MAX_LINE_BYTES,
  checked,
  CodexError,
  invalidData,
  safeDetails,
  sanitizeMetadata,
  sanitizeText,
  JsonValueSchema,
} from "./common";
import type { AsyncLineTransport } from "./transport";
import {
  InitializedNotificationSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  ThreadForkParamsSchema,
  ThreadForkResultSchema,
  ThreadListParamsSchema,
  ThreadListResultSchema,
  ThreadReadParamsSchema,
  ThreadReadResultSchema,
  ThreadResumeParamsSchema,
  ThreadResumeResultSchema,
  ThreadStartParamsSchema,
  ThreadStartResultSchema,
  TurnCompletedNotificationSchema,
  TurnInterruptParamsSchema,
  TurnInterruptResultSchema,
  TurnStartParamsSchema,
  TurnStartResultSchema,
} from "./protocol";
import type {
  CodexNotification,
  InitializeParams,
  InitializeResult,
  JsonRpcNotification,
  JsonRpcResponse,
  ThreadForkParams,
  ThreadForkResult,
  ThreadListParams,
  ThreadListResult,
  ThreadReadParams,
  ThreadReadResult,
  ThreadResumeParams,
  ThreadResumeResult,
  ThreadStartParams,
  ThreadStartResult,
  TurnInterruptParams,
  TurnInterruptResult,
  TurnStartParams,
  TurnStartResult,
} from "./protocol";

const SUPPORTED_METHODS = new Set([
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/list",
  "thread/fork",
  "turn/start",
  "turn/interrupt",
]);

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: CodexError) => void;
}

export interface AppServerClientOptions {
  readonly maxLineBytes?: number;
  readonly onNotification?: (notification: CodexNotification) => void;
}

const DEFAULT_CLIENT_INFO: InitializeParams = {
  clientInfo: { name: "holycodex", version: CODEX_CLIENT_VERSION },
};

export class AppServerClient {
  private readonly transport: AsyncLineTransport;
  private readonly maxLineBytes: number;
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private readerPromise: Promise<void> | undefined;
  private initializePromise: Promise<InitializeResult> | undefined;
  private initializeAttempted = false;
  private initialized = false;
  private closed = false;

  constructor(transport: AsyncLineTransport, options: AppServerClientOptions = {}) {
    this.transport = transport;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new CodexError("invalid_external_data", "The maximum line size is invalid.");
    }
    if (options.onNotification) {
      this.notificationListeners.add(options.onNotification);
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async initialize(params: InitializeParams = DEFAULT_CLIENT_INFO): Promise<InitializeResult> {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    if (this.initializeAttempted) {
      throw new CodexError(
        "invalid_external_data",
        "The App Server initialize handshake was already attempted.",
      );
    }
    this.ensureOpen();
    const validated = checked(InitializeParamsSchema, params, "initialize parameters");
    this.initializeAttempted = true;
    this.initializePromise = this.performInitialize(validated);
    return this.initializePromise;
  }

  async startThread(params: ThreadStartParams = {}): Promise<ThreadStartResult> {
    return this.action("thread/start", ThreadStartParamsSchema, params, ThreadStartResultSchema);
  }

  async resumeThread(params: ThreadResumeParams | string): Promise<ThreadResumeResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action("thread/resume", ThreadResumeParamsSchema, input, ThreadResumeResultSchema);
  }

  async readThread(params: ThreadReadParams | string): Promise<ThreadReadResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action("thread/read", ThreadReadParamsSchema, input, ThreadReadResultSchema);
  }

  async listThreads(params: ThreadListParams = {}): Promise<ThreadListResult> {
    return this.action("thread/list", ThreadListParamsSchema, params, ThreadListResultSchema);
  }

  async forkThread(params: ThreadForkParams | string): Promise<ThreadForkResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action("thread/fork", ThreadForkParamsSchema, input, ThreadForkResultSchema);
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.action("turn/start", TurnStartParamsSchema, params, TurnStartResultSchema);
  }

  async interruptTurn(
    params: TurnInterruptParams | string,
    turnId?: string,
  ): Promise<TurnInterruptResult> {
    const input = typeof params === "string" ? { threadId: params, turnId: turnId ?? "" } : params;
    return this.action(
      "turn/interrupt",
      TurnInterruptParamsSchema,
      input,
      TurnInterruptResultSchema,
    );
  }

  async call(method: string, params: JsonValue = {}): Promise<JsonValue> {
    switch (method) {
      case "initialize":
        return await this.initialize(
          checked(InitializeParamsSchema, params, "initialize parameters"),
        );
      case "thread/start":
        return await this.action(
          "thread/start",
          ThreadStartParamsSchema,
          params,
          ThreadStartResultSchema,
        );
      case "thread/resume":
        return await this.action(
          "thread/resume",
          ThreadResumeParamsSchema,
          params,
          ThreadResumeResultSchema,
        );
      case "thread/read":
        return await this.action(
          "thread/read",
          ThreadReadParamsSchema,
          params,
          ThreadReadResultSchema,
        );
      case "thread/list":
        return await this.action(
          "thread/list",
          ThreadListParamsSchema,
          params,
          ThreadListResultSchema,
        );
      case "thread/fork":
        return await this.action(
          "thread/fork",
          ThreadForkParamsSchema,
          params,
          ThreadForkResultSchema,
        );
      case "turn/start":
        return await this.action(
          "turn/start",
          TurnStartParamsSchema,
          params,
          TurnStartResultSchema,
        );
      case "turn/interrupt":
        return await this.action(
          "turn/interrupt",
          TurnInterruptParamsSchema,
          params,
          TurnInterruptResultSchema,
        );
      default:
        throw new CodexError("method_unsupported", `Unsupported App Server method: ${method}.`, {
          method,
        });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new CodexError("closed", "The App Server client is closed.");
    this.rejectPending(error);
    await this.transport.close();
  }

  private async performInitialize(params: InitializeParams): Promise<InitializeResult> {
    try {
      const result = await this.request("initialize", params);
      const initializeResult = checked(InitializeResultSchema, result, "initialize result");
      const initializedNotification = { jsonrpc: "2.0", method: "initialized" } as const;
      const validatedNotification = checked(
        InitializedNotificationSchema,
        initializedNotification,
        "initialized notification",
      );
      await this.transport.writeLine(JSON.stringify(validatedNotification));
      this.initialized = true;
      return initializeResult;
    } catch (error: unknown) {
      this.closed = true;
      this.rejectPending(
        error instanceof CodexError
          ? error
          : new CodexError(
              "transport_failure",
              "The initialize handshake failed.",
              {},
              { cause: error },
            ),
      );
      await this.transport.close().catch(() => undefined);
      throw error;
    }
  }

  private async action<T>(
    method: string,
    paramsSchema: (input: unknown) => unknown,
    params: unknown,
    resultSchema: (input: unknown) => T | InstanceType<typeof type.errors>,
  ): Promise<T> {
    const validatedParams = paramsSchema(params);
    if (validatedParams instanceof type.errors) {
      throw invalidData(`${method} parameters`, params, validatedParams.summary);
    }
    const jsonParams = checked(JsonValueSchema, validatedParams, `${method} parameters`);
    const result = await this.request(method, jsonParams);
    return checked(resultSchema, result, `${method} result`);
  }

  private async request(method: string, params: JsonValue): Promise<JsonValue> {
    this.ensureOpen();
    if (method !== "initialize" && !this.initialized) {
      throw new CodexError(
        "invalid_external_data",
        `The ${method} action requires an initialized App Server client.`,
      );
    }
    if (!SUPPORTED_METHODS.has(method)) {
      throw new CodexError("method_unsupported", `Unsupported App Server method: ${method}.`, {
        method,
      });
    }
    this.startReader();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request = { jsonrpc: "2.0", id, method, params };
    const line = JSON.stringify(request);
    return new Promise<JsonValue>((resolveRequest, rejectRequest) => {
      const pending: PendingRequest = {
        method,
        resolve: resolveRequest,
        reject: rejectRequest,
      };
      this.pending.set(id, pending);
      void this.transport.writeLine(line).catch((error: unknown) => {
        this.pending.delete(id);
        rejectRequest(
          new CodexError(
            "transport_failure",
            "The App Server request could not be written.",
            {},
            {
              cause: error,
            },
          ),
        );
      });
    });
  }

  private startReader(): void {
    if (!this.readerPromise) {
      this.readerPromise = this.readLoop();
    }
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const line = await this.transport.readLine();
        if (line === null) {
          if (!this.closed) {
            throw new CodexError("transport_closed", "The App Server transport closed.");
          }
          return;
        }
        if (new TextEncoder().encode(line).byteLength > this.maxLineBytes) {
          throw new CodexError("invalid_transport_line", "An App Server line exceeded the limit.");
        }
        this.handleLine(line);
      }
    } catch (error: unknown) {
      const failureError =
        error instanceof CodexError
          ? error
          : new CodexError(
              "transport_failure",
              "The App Server transport failed.",
              {},
              {
                cause: error,
              },
            );
      this.rejectPending(failureError);
      if (!this.closed) {
        this.closed = true;
        await this.transport.close().catch(() => undefined);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      // JSON.parse is the receiving boundary; the value is immediately ArkType-validated.
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      throw new CodexError(
        "invalid_transport_line",
        "The App Server emitted invalid JSON.",
        {},
        {
          cause: error,
        },
      );
    }

    const response = JsonRpcResponseSchema(parsed);
    if (!(response instanceof type.errors)) {
      this.handleResponse(response);
      return;
    }
    const notification = JsonRpcNotificationSchema(parsed);
    if (!(notification instanceof type.errors)) {
      this.handleNotification(notification);
      return;
    }
    const request = JsonRpcRequestSchema(parsed);
    if (!(request instanceof type.errors)) {
      throw new CodexError(
        "server_request_unsupported",
        `The App Server sent an unsupported request: ${request.method}.`,
        { method: request.method },
      );
    }
    throw invalidData("JSON-RPC message", parsed, response.summary);
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id === null) {
      throw new CodexError(
        "unexpected_response",
        "The App Server returned an uncorrelatable response id.",
      );
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      throw new CodexError(
        "unexpected_response",
        "The App Server returned an unknown request id.",
        {
          id: response.id,
        },
      );
    }
    this.pending.delete(response.id);
    if ("error" in response) {
      const retryable = response.error.code === -32001;
      pending.reject(
        new CodexError(
          "server_error",
          `The App Server rejected ${pending.method}: ${sanitizeText(response.error.message)}.`,
          {
            method: pending.method,
            serverCode: response.error.code,
            retryable,
            ...(response.error.data === undefined
              ? {}
              : { data: sanitizeMetadata(response.error.data) }),
          },
          { retryable },
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "turn/completed") {
      const params = checked(
        TurnCompletedNotificationSchema,
        notification.params,
        "turn/completed notification",
      );
      const event: CodexNotification = {
        kind: "turn_completed",
        method: "turn/completed",
        params,
      };
      this.emitNotification(event);
      return;
    }
    const event: CodexNotification = {
      kind: "unknown",
      method: notification.method,
      metadata: safeDetails({ params: sanitizeMetadata(notification.params) }),
    };
    this.emitNotification(event);
  }

  private emitNotification(notification: CodexNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        // Notification observers cannot corrupt request correlation or transport state.
      }
    }
  }

  private rejectPending(error: CodexError): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new CodexError("closed", "The App Server client is closed.");
    }
  }
}
