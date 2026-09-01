// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@holycodex/core";
import * as Schema from "effect/Schema";
import {
  CODEX_CLIENT_VERSION,
  DEFAULT_MAX_LINE_BYTES,
  checked,
  CodexError,
  invalidData,
  JsonValueSchema,
  safeDetails,
  sanitizeMetadata,
  sanitizeText,
} from "./common";
import type { AsyncLineTransport } from "./transport";
import {
  GENERATED_APPROVAL_REQUEST_METHODS,
  GENERATED_INITIALIZED_NOTIFICATION,
  GENERATED_PERMISSION_REQUEST_METHODS,
  GENERATED_SUPPORTED_CLIENT_METHODS,
  GENERATED_TURN_COMPLETED_NOTIFICATION_METHOD,
} from "./generated-wire";
import {
  classifyServerRequest,
  ConfigReadParamsSchema,
  ConfigReadResultSchema,
  InitializedNotificationSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  ModelListParamsSchema,
  ModelListResultSchema,
  ModelProviderCapabilitiesParamsSchema,
  ModelProviderCapabilitiesResultSchema,
  PermissionProfileListParamsSchema,
  PermissionProfileListResultSchema,
  ServerRequestSchema,
  ServerResponseSchema,
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
  ThreadUnsubscribeParamsSchema,
  ThreadUnsubscribeResultSchema,
  TurnCompletedNotificationSchema,
  TurnInterruptParamsSchema,
  TurnInterruptResultSchema,
  TurnStartParamsSchema,
  TurnStartResultSchema,
  TurnSteerParamsSchema,
  TurnSteerResultSchema,
} from "./protocol";
import type {
  CodexNotification,
  ConfigReadParams,
  ConfigReadResult,
  InitializeParams,
  InitializeResult,
  ModelListParams,
  ModelListResult,
  ModelProviderCapabilitiesParams,
  ModelProviderCapabilitiesResult,
  PermissionProfileListParams,
  PermissionProfileListResult,
  JsonRpcRequest,
  JsonRpcResponse,
  RequestId,
  ServerRequest,
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
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResult,
  TurnInterruptParams,
  TurnInterruptResult,
  TurnStartParams,
  TurnStartResult,
  TurnSteerParams,
  TurnSteerResult,
} from "./protocol";

export type ServerRequestHandler = (request: ServerRequest) => JsonValue | Promise<JsonValue>;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: CodexError) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly removeAbortListener?: () => void;
}

interface ServerRequestWork {
  active: boolean;
}

export interface AppServerClientOptions {
  readonly maxLineBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onNotification?: (notification: CodexNotification) => void;
  readonly onServerRequest?: ServerRequestHandler;
}

const DEFAULT_CLIENT_INFO: InitializeParams = {
  clientInfo: { name: "holycodex", title: null, version: CODEX_CLIENT_VERSION },
  capabilities: null,
};

const SUPPORTED_METHODS = new Set<string>(GENERATED_SUPPORTED_CLIENT_METHODS);

export class AppServerClient {
  private readonly transport: AsyncLineTransport;
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly serverRequestWork = new Set<ServerRequestWork>();
  private readonly serverRequestTasks = new Set<Promise<void>>();
  private nextRequestId = 1;
  private readerPromise: Promise<void> | undefined;
  private initializePromise: Promise<InitializeResult> | undefined;
  private transportClosePromise: Promise<void> | undefined;
  private initializeAttempted = false;
  private initialized = false;
  private closed = false;

  constructor(transport: AsyncLineTransport, options: AppServerClientOptions = {}) {
    this.transport = transport;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.signal = options.signal;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new CodexError("invalid_external_data", "The maximum line size is invalid.");
    }
    if (
      this.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1)
    ) {
      throw new CodexError("invalid_external_data", "The request timeout is invalid.");
    }
    if (options.onNotification) {
      this.notificationListeners.add(options.onNotification);
    }
    if (options.onServerRequest) {
      this.serverRequestHandlers.add(options.onServerRequest);
    }
    if (this.signal?.aborted) {
      void this.close();
    } else if (this.signal) {
      this.signal.addEventListener("abort", () => void this.close(), { once: true });
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
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

  async unsubscribeThread(
    params: ThreadUnsubscribeParams | string,
  ): Promise<ThreadUnsubscribeResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action(
      "thread/unsubscribe",
      ThreadUnsubscribeParamsSchema,
      input,
      ThreadUnsubscribeResultSchema,
    );
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.action("turn/start", TurnStartParamsSchema, params, TurnStartResultSchema);
  }

  async steerTurn(params: TurnSteerParams): Promise<TurnSteerResult> {
    return this.action("turn/steer", TurnSteerParamsSchema, params, TurnSteerResultSchema);
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

  async listModels(params: ModelListParams = {}): Promise<ModelListResult> {
    return this.action("model/list", ModelListParamsSchema, params, ModelListResultSchema);
  }

  async readModelProviderCapabilities(
    params: ModelProviderCapabilitiesParams = {},
  ): Promise<ModelProviderCapabilitiesResult> {
    return this.action(
      "modelProvider/capabilities/read",
      ModelProviderCapabilitiesParamsSchema,
      params,
      ModelProviderCapabilitiesResultSchema,
    );
  }

  async readConfig(params: ConfigReadParams = {}): Promise<ConfigReadResult> {
    return this.action("config/read", ConfigReadParamsSchema, params, ConfigReadResultSchema);
  }

  async listPermissionProfiles(
    params: PermissionProfileListParams = {},
  ): Promise<PermissionProfileListResult> {
    return this.action(
      "permissionProfile/list",
      PermissionProfileListParamsSchema,
      params,
      PermissionProfileListResultSchema,
    );
  }

  async call(method: string, params: JsonValue = {}): Promise<JsonValue> {
    if (method === "initialize") {
      const result = await this.initialize(
        checked(InitializeParamsSchema, params, "initialize parameters"),
      );
      return checked(JsonValueSchema, result, "initialize result");
    }
    const request = checked(JsonRpcRequestSchema, { id: 1, method, params }, "App Server method");
    if (!SUPPORTED_METHODS.has(request.method)) {
      throw new CodexError("method_unsupported", `Unsupported App Server method: ${method}.`, {
        method,
      });
    }
    return this.request(request.method, request.params === undefined ? {} : request.params);
  }

  async close(): Promise<void> {
    await this.closeWithError(new CodexError("closed", "The App Server client is closed."));
  }

  private async performInitialize(params: InitializeParams): Promise<InitializeResult> {
    try {
      const result = await this.request(
        "initialize",
        checked(JsonValueSchema, params, "initialize parameters"),
      );
      const initializeResult = checked(InitializeResultSchema, result, "initialize result");
      const initializedNotification = checked(
        InitializedNotificationSchema,
        GENERATED_INITIALIZED_NOTIFICATION,
        "initialized notification",
      );
      await this.transport.writeLine(JSON.stringify(initializedNotification));
      this.initialized = true;
      return initializeResult;
    } catch (error: unknown) {
      const failureError =
        error instanceof CodexError
          ? error
          : new CodexError(
              "transport_failure",
              "The initialize handshake failed.",
              {},
              { cause: error },
            );
      await this.closeWithError(failureError);
      throw failureError;
    }
  }

  private async action<P, T>(
    method: string,
    paramsSchema: Schema.Schema<P>,
    params: P,
    resultSchema: Schema.Schema<T>,
  ): Promise<T> {
    const validatedParams = checked(paramsSchema, params, `${method} parameters`);
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
    this.startReader();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request = checked(JsonRpcRequestSchema, { id, method, params }, `${method} request`);
    return new Promise<JsonValue>((resolveRequest, rejectRequest) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removeAbortListener: (() => void) | undefined;
      const rejectOnce = (error: CodexError): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(id);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        removeAbortListener?.();
        rejectRequest(error);
      };
      if (this.requestTimeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            rejectOnce(new CodexError("timeout", `The ${method} request timed out.`, { method })),
          this.requestTimeoutMs,
        );
      }
      if (this.signal) {
        const abort = (): void =>
          rejectOnce(
            new CodexError("cancellation", `The ${method} request was cancelled.`, { method }),
          );
        this.signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => this.signal?.removeEventListener("abort", abort);
      }
      const pending: PendingRequest = {
        method,
        resolve: (value) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          removeAbortListener?.();
          resolveRequest(value);
        },
        reject: rejectOnce,
        ...(timer === undefined ? {} : { timer }),
        ...(removeAbortListener === undefined ? {} : { removeAbortListener }),
      };
      this.pending.set(id, pending);
      void this.transport.writeLine(JSON.stringify(request)).catch((error: unknown) => {
        rejectOnce(
          error instanceof CodexError
            ? error
            : new CodexError(
                "transport_failure",
                "The App Server request could not be written.",
                {},
                { cause: error },
              ),
        );
      });
    });
  }

  private startReader(): void {
    if (!this.readerPromise) {
      this.readerPromise = this.readLoop()
        .catch((error: unknown) => this.handleReaderFailure(error))
        .catch(() => undefined);
    }
  }

  private async readLoop(): Promise<void> {
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
  }

  private async handleReaderFailure(error: unknown): Promise<void> {
    const failureError =
      error instanceof CodexError
        ? error
        : new CodexError(
            "transport_failure",
            "The App Server transport failed.",
            {},
            { cause: error },
          );
    await this.closeWithError(failureError);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      throw new CodexError(
        "invalid_transport_line",
        "The App Server emitted invalid JSON.",
        {},
        { cause: error },
      );
    }

    const response = this.tryDecode(JsonRpcResponseSchema, parsed);
    if (response !== undefined) {
      this.handleResponse(response);
      return;
    }
    const request = this.tryDecode(JsonRpcRequestSchema, parsed);
    if (request !== undefined) {
      this.handleServerRequest(request);
      return;
    }
    const notification = this.tryDecode(JsonRpcNotificationSchema, parsed);
    if (notification !== undefined) {
      this.handleNotification(notification);
      return;
    }
    throw invalidData("JSON-RPC message", parsed);
  }

  private tryDecode<T>(schema: Schema.Schema<T>, input: unknown): T | undefined {
    try {
      return checked(schema, input, "JSON-RPC message");
    } catch {
      return undefined;
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      throw new CodexError(
        "unexpected_response",
        "The App Server returned an unknown request id.",
        { id: response.id },
      );
    }
    this.pending.delete(response.id);
    if ("error" in response) {
      const retryable = response.error.code === -32001;
      const errorCode = serverErrorCode(pending.method);
      pending.reject(
        new CodexError(
          errorCode,
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

  private handleServerRequest(request: JsonRpcRequest): void {
    const params = request.params ?? {};
    const serverRequest = checked(
      ServerRequestSchema,
      { ...request, params, category: classifyServerRequest(request.method) },
      "server request",
    );
    this.emitNotification({ kind: "server_request", method: request.method, params });
    const handlers = [...this.serverRequestHandlers];
    if (handlers.length === 0) {
      this.trackServerRequestTask(
        this.writeServerError(request.id, -32601, `No handler for ${request.method}.`),
      );
      return;
    }
    const handler = handlers[0];
    if (handler === undefined) {
      this.trackServerRequestTask(
        this.writeServerError(request.id, -32601, `No handler for ${request.method}.`),
      );
      return;
    }
    const work: ServerRequestWork = { active: true };
    this.serverRequestWork.add(work);
    let result: JsonValue | Promise<JsonValue>;
    try {
      result = handler(serverRequest);
    } catch (error: unknown) {
      this.completeServerRequest(work, () =>
        this.writeServerError(request.id, -32000, sanitizeText(String(error))),
      );
      return;
    }
    if (result instanceof Promise) {
      this.trackServerRequestTask(
        result.then(
          (value) =>
            this.completeServerRequest(work, () =>
              this.writeValidatedServerResult(request.id, value),
            ),
          (error: unknown) =>
            this.completeServerRequest(work, () =>
              this.writeServerError(request.id, -32000, sanitizeText(String(error))),
            ),
        ),
      );
      return;
    }
    this.completeServerRequest(work, () => this.writeValidatedServerResult(request.id, result));
  }

  private writeValidatedServerResult(id: RequestId, value: JsonValue): Promise<void> {
    try {
      const result = checked(ServerResponseSchema, value, "server response");
      return this.writeServerResult(id, result);
    } catch (error: unknown) {
      return this.writeServerError(id, -32000, sanitizeText(String(error)));
    }
  }

  private completeServerRequest(
    work: ServerRequestWork,
    createResponse: () => Promise<void>,
  ): void {
    if (!work.active) {
      return;
    }
    work.active = false;
    this.serverRequestWork.delete(work);
    try {
      this.trackServerRequestTask(createResponse());
    } catch {
      // The response task owns and observes asynchronous transport failures.
    }
  }

  private trackServerRequestTask(task: Promise<void>): void {
    const observed = task.catch(() => undefined);
    this.serverRequestTasks.add(observed);
    void observed.then(
      () => this.serverRequestTasks.delete(observed),
      () => this.serverRequestTasks.delete(observed),
    );
  }

  private async writeServerResult(id: RequestId, result: JsonValue): Promise<void> {
    const response = checked(JsonRpcResponseSchema, { id, result }, "server response");
    await this.transport.writeLine(JSON.stringify(response));
  }

  private async writeServerError(id: RequestId, code: number, message: string): Promise<void> {
    const response = checked(
      JsonRpcResponseSchema,
      { id, error: { code, message: TextSchemaValue(message) } },
      "server error response",
    );
    await this.transport.writeLine(JSON.stringify(response));
  }

  private handleNotification(notification: {
    readonly method: string;
    readonly params?: JsonValue | undefined;
  }): void {
    const params = notification.params;
    if (notification.method === GENERATED_TURN_COMPLETED_NOTIFICATION_METHOD) {
      const completed = checked(
        TurnCompletedNotificationSchema,
        params,
        "turn/completed notification",
      );
      this.emitNotification({
        kind: "turn_completed",
        method: notification.method,
        params: completed,
      });
      return;
    }
    if (notification.method.includes("agent") || notification.method.includes("subagent")) {
      this.emitNotification({
        kind: "multi_agent",
        method: notification.method,
        ...(params === undefined ? {} : { params }),
      });
      return;
    }
    this.emitNotification({
      kind: "unknown",
      method: notification.method,
      metadata: safeDetails({ params: sanitizeMetadata(params) }),
    });
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

  private async closeWithError(error: CodexError): Promise<void> {
    if (this.transportClosePromise !== undefined) {
      await this.transportClosePromise;
      return;
    }
    this.closed = true;
    this.rejectPending(error);
    for (const work of this.serverRequestWork) {
      work.active = false;
    }
    this.serverRequestWork.clear();
    this.serverRequestTasks.clear();
    this.transportClosePromise = Promise.resolve()
      .then(() => this.transport.close())
      .catch(() => undefined);
    await this.transportClosePromise;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new CodexError("closed", "The App Server client is closed.");
    }
  }
}

function TextSchemaValue(value: string): string {
  const normalized = sanitizeText(value);
  return normalized.length > 0 ? normalized : "server request failed";
}

function serverErrorCode(
  method: string,
): "approval_required" | "permission_denied" | "cancellation" | "turn_failed" | "server_error" {
  if (GENERATED_PERMISSION_REQUEST_METHODS.some((candidate) => candidate === method)) {
    return "permission_denied";
  }
  if (GENERATED_APPROVAL_REQUEST_METHODS.some((candidate) => candidate === method)) {
    return "approval_required";
  }
  if (method === "turn/interrupt") {
    return "cancellation";
  }
  if (method.startsWith("turn/")) {
    return "turn_failed";
  }
  return "server_error";
}
