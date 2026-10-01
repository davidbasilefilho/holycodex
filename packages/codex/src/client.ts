// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@holycodex/core";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  CODEX_CLIENT_VERSION,
  DEFAULT_MAX_LINE_BYTES,
  checked,
  CodexError,
  invalidData,
  isValid,
  JsonValueSchema,
  safeDetails,
  sanitizeMetadata,
  sanitizeText,
} from "./common";
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
import type { AsyncLineTransport } from "./transport";

/** Handles an App Server request and returns its JSON response. */
export type ServerRequestHandler = (request: ServerRequest) => JsonValue | Promise<JsonValue>;

interface PendingRequest {
  readonly method: string;
  readonly resume: (effect: Effect.Effect<JsonValue, CodexError>) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly removeAbortListener?: () => void;
}

interface ServerRequestWork {
  active: boolean;
}

/** Options for configuring app server client. */
export interface AppServerClientOptions {
  /** Maximum accepted JSON-RPC line size in bytes. */
  readonly maxLineBytes?: number;
  /** Optional timeout for an App Server request, in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Abort signal that closes the client. */
  readonly signal?: AbortSignal;
  /** Optional callback invoked when the client receives a notification. */
  readonly onNotification?: (notification: CodexNotification) => void;
  /** Optional callback for requests initiated by the App Server. */
  readonly onServerRequest?: ServerRequestHandler;
}

const DEFAULT_CLIENT_INFO: InitializeParams = {
  clientInfo: { name: "holycodex", title: null, version: CODEX_CLIENT_VERSION },
  capabilities: null,
};

const SUPPORTED_METHODS = new Set<string>(GENERATED_SUPPORTED_CLIENT_METHODS);

/** Deterministic JSON-RPC client for the Codex app server protocol. */
export class AppServerClient {
  private readonly transport: AsyncLineTransport;
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly serverRequestWork = new Set<ServerRequestWork>();
  private readonly serverRequestTasks = new Set<Effect.Effect<void>>();
  private nextRequestId = 1;
  private readerFiber: Fiber.Fiber<void, CodexError> | undefined;
  private initializeEffect: Effect.Effect<InitializeResult, CodexError> | undefined;
  private transportCloseEffect: Effect.Effect<void> | undefined;
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

  /** Return whether the App Server handshake has completed. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Register a listener for App Server notifications. */
  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Register a handler for App Server requests. */
  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  /** Initialize the App Server connection and negotiate capabilities. */
  initialize(params: InitializeParams = DEFAULT_CLIENT_INFO): Promise<InitializeResult> {
    if (this.initializeEffect) {
      return Effect.runPromise(this.initializeEffect);
    }
    if (this.initializeAttempted) {
      return Effect.runPromise(
        Effect.fail(
          new CodexError(
            "invalid_external_data",
            "The App Server initialize handshake was already attempted.",
          ),
        ),
      );
    }
    const initialize = Effect.try({
      try: () => {
        this.ensureOpen();
        const validated = checked(InitializeParamsSchema, params, "initialize parameters");
        this.initializeAttempted = true;
        return this.performInitializeEffect(validated);
      },
      catch: (error) => asTransportError(error, "The initialize handshake failed."),
    }).pipe(Effect.flatten);
    this.initializeEffect = Effect.runSync(Effect.cached(initialize));
    return Effect.runPromise(this.initializeEffect);
  }

  /** Start a new conversation thread. */
  startThread(params: ThreadStartParams = {}): Promise<ThreadStartResult> {
    return this.action("thread/start", ThreadStartParamsSchema, params, ThreadStartResultSchema);
  }

  /** Resume an existing conversation thread. */
  resumeThread(params: ThreadResumeParams | string): Promise<ThreadResumeResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action("thread/resume", ThreadResumeParamsSchema, input, ThreadResumeResultSchema);
  }

  /** Read an existing conversation thread. */
  readThread(params: ThreadReadParams | string): Promise<ThreadReadResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action("thread/read", ThreadReadParamsSchema, input, ThreadReadResultSchema);
  }

  /** List conversation threads visible to the App Server. */
  listThreads(params: ThreadListParams = {}): Promise<ThreadListResult> {
    return this.action("thread/list", ThreadListParamsSchema, params, ThreadListResultSchema);
  }

  /** Fork an existing conversation thread. */
  forkThread(params: ThreadForkParams | string): Promise<ThreadForkResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action("thread/fork", ThreadForkParamsSchema, input, ThreadForkResultSchema);
  }

  /** Stop receiving updates for a conversation thread. */
  unsubscribeThread(params: ThreadUnsubscribeParams | string): Promise<ThreadUnsubscribeResult> {
    const input = typeof params === "string" ? { threadId: params } : params;
    return this.action(
      "thread/unsubscribe",
      ThreadUnsubscribeParamsSchema,
      input,
      ThreadUnsubscribeResultSchema,
    );
  }

  /** Start a model turn in a conversation thread. */
  startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.action("turn/start", TurnStartParamsSchema, params, TurnStartResultSchema);
  }

  /** Steer an active model turn. */
  steerTurn(params: TurnSteerParams): Promise<TurnSteerResult> {
    return this.action("turn/steer", TurnSteerParamsSchema, params, TurnSteerResultSchema);
  }

  /** Interrupt an active model turn. */
  interruptTurn(
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

  /** List models available from the App Server. */
  listModels(params: ModelListParams = {}): Promise<ModelListResult> {
    return this.action("model/list", ModelListParamsSchema, params, ModelListResultSchema);
  }

  /** Read capabilities reported by a model provider. */
  readModelProviderCapabilities(
    params: ModelProviderCapabilitiesParams = {},
  ): Promise<ModelProviderCapabilitiesResult> {
    return this.action(
      "modelProvider/capabilities/read",
      ModelProviderCapabilitiesParamsSchema,
      params,
      ModelProviderCapabilitiesResultSchema,
    );
  }

  /** Read the active App Server configuration. */
  readConfig(params: ConfigReadParams = {}): Promise<ConfigReadResult> {
    return this.action("config/read", ConfigReadParamsSchema, params, ConfigReadResultSchema);
  }

  /** List permission profiles available to the App Server. */
  listPermissionProfiles(
    params: PermissionProfileListParams = {},
  ): Promise<PermissionProfileListResult> {
    return this.action(
      "permissionProfile/list",
      PermissionProfileListParamsSchema,
      params,
      PermissionProfileListResultSchema,
    );
  }

  /** Call a supported App Server method by name. */
  call(method: string, params: JsonValue = {}): Promise<JsonValue> {
    return Effect.runPromise(
      Effect.try({
        try: () => this.callEffect(method, params),
        catch: (error) => asTransportError(error, "The App Server method failed."),
      }).pipe(Effect.flatten),
    );
  }

  private callEffect(method: string, params: JsonValue): Effect.Effect<JsonValue, CodexError> {
    if (method === "initialize") {
      return Effect.map(
        Effect.tryPromise({
          try: () =>
            this.initialize(checked(InitializeParamsSchema, params, "initialize parameters")),
          catch: (error) => asTransportError(error, "The initialize handshake failed."),
        }),
        (result) => checked(JsonValueSchema, result, "initialize result"),
      );
    }
    const request = checked(JsonRpcRequestSchema, { id: 1, method, params }, "App Server method");
    if (!SUPPORTED_METHODS.has(request.method)) {
      throw new CodexError("method_unsupported", `Unsupported App Server method: ${method}.`, {
        method,
      });
    }
    return this.requestEffect(request.method, request.params === undefined ? {} : request.params);
  }

  /** Close the App Server connection. */
  close(): Promise<void> {
    return Effect.runPromise(
      this.closeWithErrorEffect(new CodexError("closed", "The App Server client is closed.")),
    );
  }

  private performInitializeEffect(
    params: InitializeParams,
  ): Effect.Effect<InitializeResult, CodexError> {
    const handshake = Effect.gen({ self: this }, function* () {
      const initializeParams = yield* this.decodeEffect(
        InitializeParamsSchema,
        params,
        "initialize parameters",
      );
      const jsonParams = yield* this.decodeEffect(
        JsonValueSchema,
        initializeParams,
        "initialize parameters",
      );
      const result = yield* this.requestEffect("initialize", jsonParams);
      const initializeResult = yield* this.decodeEffect(
        InitializeResultSchema,
        result,
        "initialize result",
      );
      const initializedNotification = yield* this.decodeEffect(
        InitializedNotificationSchema,
        GENERATED_INITIALIZED_NOTIFICATION,
        "initialized notification",
      );
      yield* this.transportWriteEffect(JSON.stringify(initializedNotification));
      this.initialized = true;
      return initializeResult;
    });
    return Effect.catchIf(
      handshake,
      () => true,
      (error) =>
        Effect.gen({ self: this }, function* () {
          const failureError = asTransportError(error, "The initialize handshake failed.");
          yield* this.closeWithErrorEffect(failureError);
          return yield* Effect.fail(failureError);
        }),
    );
  }

  private action<P, T>(
    method: string,
    paramsSchema: Schema.Codec<P, unknown>,
    params: P,
    resultSchema: Schema.Codec<T, unknown>,
  ): Promise<T> {
    return Effect.runPromise(
      Effect.try({
        try: () => this.actionEffect(method, paramsSchema, params, resultSchema),
        catch: (error) => asTransportError(error, `The ${method} action failed.`),
      }).pipe(Effect.flatten),
    );
  }

  private actionEffect<P, T>(
    method: string,
    paramsSchema: Schema.Codec<P, unknown>,
    params: P,
    resultSchema: Schema.Codec<T, unknown>,
  ): Effect.Effect<T, CodexError> {
    return Effect.gen({ self: this }, function* () {
      const validatedParams = yield* this.decodeEffect(
        paramsSchema,
        params,
        `${method} parameters`,
      );
      const jsonParams = yield* this.decodeEffect(
        JsonValueSchema,
        validatedParams,
        `${method} parameters`,
      );
      const result = yield* this.requestEffect(method, jsonParams);
      return yield* this.decodeEffect(resultSchema, result, `${method} result`);
    });
  }

  private decodeEffect<T>(
    schema: Schema.Codec<T, unknown>,
    input: unknown,
    label: string,
  ): Effect.Effect<T, CodexError> {
    return Effect.try({
      try: () => checked(schema, input, label),
      catch: (error) => asTransportError(error, `Invalid ${label}.`),
    });
  }

  private requestEffect(method: string, params: JsonValue): Effect.Effect<JsonValue, CodexError> {
    if (this.closed)
      return Effect.fail(new CodexError("closed", "The App Server client is closed."));
    if (method !== "initialize" && !this.initialized) {
      return Effect.fail(
        new CodexError(
          "invalid_external_data",
          `The ${method} action requires an initialized App Server client.`,
        ),
      );
    }
    this.startReader();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return Effect.flatMap(
      this.decodeEffect(JsonRpcRequestSchema, { id, method, params }, `${method} request`),
      (request) =>
        Effect.callback<JsonValue, CodexError>((resume, effectSignal) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let removeAbortListener: (() => void) | undefined;
          const abort = (): void =>
            rejectOnce(
              new CodexError("cancellation", `The ${method} request was cancelled.`, { method }),
            );
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
            resume(Effect.fail(error));
          };
          if (this.requestTimeoutMs !== undefined) {
            timer = setTimeout(
              () =>
                rejectOnce(
                  new CodexError("timeout", `The ${method} request timed out.`, { method }),
                ),
              this.requestTimeoutMs,
            );
          }
          if (this.signal) {
            this.signal.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => this.signal?.removeEventListener("abort", abort);
            if (this.signal.aborted) abort();
          }
          const pending: PendingRequest = {
            method,
            resume,
            ...(timer === undefined ? {} : { timer }),
            ...(removeAbortListener === undefined ? {} : { removeAbortListener }),
          };
          this.pending.set(id, pending);
          effectSignal.addEventListener("abort", abort, { once: true });
          const write = this.transportWriteEffect(JSON.stringify(request)).pipe(
            Effect.catchIf(
              () => true,
              (error) => Effect.sync(() => rejectOnce(error)),
            ),
          );
          Effect.runFork(write);
          return Effect.sync(() => {
            if (timer !== undefined) clearTimeout(timer);
            removeAbortListener?.();
            effectSignal.removeEventListener("abort", abort);
            this.pending.delete(id);
          });
        }),
    );
  }

  private transportWriteEffect(line: string): Effect.Effect<void, CodexError> {
    return Effect.tryPromise({
      try: () => this.transport.writeLine(line),
      catch: (error) => asTransportError(error, "The App Server request could not be written."),
    });
  }

  private startReader(): void {
    if (!this.readerFiber) {
      const readLoop = this.readLoopEffect().pipe(
        Effect.catchIf(
          () => true,
          (error) => this.handleReaderFailureEffect(error),
        ),
      );
      this.readerFiber = Effect.runFork(readLoop);
    }
  }

  private readLoopEffect(): Effect.Effect<void, CodexError> {
    return Effect.gen({ self: this }, function* () {
      while (!this.closed) {
        const line = yield* Effect.tryPromise({
          try: () => this.transport.readLine(),
          catch: (error) => asTransportError(error, "The App Server stdout could not be read."),
        });
        if (line === null) {
          if (!this.closed) {
            return yield* Effect.fail(
              new CodexError("transport_closed", "The App Server transport closed."),
            );
          }
          return;
        }
        if (new TextEncoder().encode(line).byteLength > this.maxLineBytes) {
          return yield* Effect.fail(
            new CodexError("invalid_transport_line", "An App Server line exceeded the limit."),
          );
        }
        yield* Effect.try({
          try: () => this.handleLine(line),
          catch: (error) => asTransportError(error, "The App Server emitted an invalid message."),
        });
      }
    });
  }

  private handleReaderFailureEffect(error: unknown): Effect.Effect<void> {
    const failureError =
      error instanceof CodexError
        ? error
        : new CodexError(
            "transport_failure",
            "The App Server transport failed.",
            {},
            { cause: error },
          );
    return this.closeWithErrorEffect(failureError);
  }

  private handleLine(line: string): void {
    const parsed = Effect.runSync(
      Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: (error) =>
          new CodexError(
            "invalid_transport_line",
            "The App Server emitted invalid JSON.",
            {},
            { cause: error },
          ),
      }),
    );

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

  private tryDecode<T>(schema: Schema.Codec<T, unknown>, input: unknown): T | undefined {
    return isValid(schema, input) ? checked(schema, input, "JSON-RPC message") : undefined;
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
      this.resumePending(
        pending,
        Effect.fail(
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
        ),
      );
      return;
    }
    this.resumePending(pending, Effect.succeed(response.result));
  }

  private resumePending(
    pending: PendingRequest,
    result: Effect.Effect<JsonValue, CodexError>,
  ): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    pending.resume(result);
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
        this.writeServerErrorEffect(request.id, -32601, `No handler for ${request.method}.`),
      );
      return;
    }
    const handler = handlers[0];
    if (handler === undefined) {
      this.trackServerRequestTask(
        this.writeServerErrorEffect(request.id, -32601, `No handler for ${request.method}.`),
      );
      return;
    }
    const work: ServerRequestWork = { active: true };
    this.serverRequestWork.add(work);
    const response = Effect.matchEffect({
      onFailure: (error: unknown) =>
        this.writeServerErrorEffect(request.id, -32000, sanitizeText(String(error))),
      onSuccess: (value: JsonValue) => this.writeValidatedServerResultEffect(request.id, value),
    })(
      Effect.tryPromise({
        try: () => Promise.resolve(handler(serverRequest)),
        catch: (error) => error,
      }),
    );
    this.completeServerRequest(work, response);
  }

  private writeValidatedServerResultEffect(
    id: RequestId,
    value: JsonValue,
  ): Effect.Effect<void, CodexError> {
    return isValid(ServerResponseSchema, value)
      ? this.writeServerResultEffect(id, checked(ServerResponseSchema, value, "server response"))
      : this.writeServerErrorEffect(id, -32000, "Invalid server response.");
  }

  private completeServerRequest(
    work: ServerRequestWork,
    response: Effect.Effect<void, CodexError>,
  ): void {
    if (!work.active) {
      return;
    }
    work.active = false;
    this.serverRequestWork.delete(work);
    this.trackServerRequestTask(response);
  }

  private trackServerRequestTask(task: Effect.Effect<void, CodexError>): void {
    const observed = Effect.ignore(task);
    this.serverRequestTasks.add(observed);
    Effect.runFork(
      Effect.ensuring(
        observed,
        Effect.sync(() => this.serverRequestTasks.delete(observed)),
      ),
    );
  }

  private writeServerResultEffect(
    id: RequestId,
    result: JsonValue,
  ): Effect.Effect<void, CodexError> {
    return Effect.flatMap(
      this.decodeEffect(JsonRpcResponseSchema, { id, result }, "server response"),
      (response) => this.transportWriteEffect(JSON.stringify(response)),
    );
  }

  private writeServerErrorEffect(
    id: RequestId,
    code: number,
    message: string,
  ): Effect.Effect<void, CodexError> {
    return Effect.flatMap(
      this.decodeEffect(
        JsonRpcResponseSchema,
        { id, error: { code, message: TextSchemaValue(message) } },
        "server error response",
      ),
      (response) => this.transportWriteEffect(JSON.stringify(response)),
    );
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
      Effect.runSync(
        Effect.ignore(Effect.try({ try: () => listener(notification), catch: () => undefined })),
      );
    }
  }

  private rejectPending(error: CodexError): void {
    for (const pending of this.pending.values()) {
      this.resumePending(pending, Effect.fail(error));
    }
    this.pending.clear();
  }

  private closeWithErrorEffect(error: CodexError): Effect.Effect<void> {
    if (this.transportCloseEffect === undefined) {
      this.closed = true;
      this.rejectPending(error);
      for (const work of this.serverRequestWork) {
        work.active = false;
      }
      this.serverRequestWork.clear();
      this.serverRequestTasks.clear();
      this.transportCloseEffect = Effect.runSync(
        Effect.cached(
          Effect.ignore(
            Effect.tryPromise({ try: () => this.transport.close(), catch: () => undefined }),
          ),
        ),
      );
    }
    return this.transportCloseEffect;
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

function asTransportError(error: unknown, message: string): CodexError {
  return error instanceof CodexError
    ? error
    : new CodexError("transport_failure", message, {}, { cause: error });
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
