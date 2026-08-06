import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { killProcessTree } from "@holycodex/runtime-core";
import type { AgentExecutor, AgentOptions, JsonValue } from "@holycodex/workflow-runtime";

export type AgentRoute = {
  readonly agent?: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly serviceTier?: string;
};

export type AppServerPolicy = {
  readonly cwd?: string | undefined;
  readonly sandboxPolicy?: JsonValue | undefined;
  readonly approvalPolicy?: string | undefined;
  readonly serviceTier?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly lowVerbosity?: boolean | undefined;
  readonly configOverride?: Readonly<Record<string, JsonValue>> | undefined;
};

export type AppServerTransport = {
  readonly send?: (line: string) => void | Promise<void>;
  readonly write?: (line: string) => void | Promise<void>;
  readonly onMessage?: (listener: (message: unknown) => void) => (() => void) | void;
  readonly onLine?: (listener: (line: string) => void) => (() => void) | void;
  readonly close?: () => void | Promise<void>;
  readonly kill?: () => void;
};

export type CodexAppServerOptions = {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly transport?: AppServerTransport;
  readonly policy?: AppServerPolicy;
  readonly clientInfo?: {
    readonly name?: string;
    readonly title?: string;
    readonly version?: string;
  };
  readonly requestTimeoutMs?: number;
};

export type AppServerResponse = {
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: unknown;
};

export type AgentUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type AgentExecution = {
  readonly result: JsonValue;
  readonly usage: AgentUsage;
  readonly threadId?: string;
  readonly turnId?: string;
};

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
};

const LOW_VERBOSITY_CONFIG = "model_verbosity";

/** JSONL Codex App Server client with explicit policy injection and cancellation. */
export class CodexAppServerClient {
  private readonly options: CodexAppServerOptions;
  private child: ChildProcessWithoutNullStreams | undefined;
  private input: NodeJS.WritableStream | undefined;
  private readline: Interface | undefined;
  private unsubscribe: (() => void) | undefined;
  private nextId = 1;
  private readonly pending = new Map<string | number, Pending>();
  private readonly notifications = new Set<(message: Record<string, unknown>) => void>();
  private started = false;
  private initialized = false;
  private initialization: Promise<unknown> | undefined;

  public constructor(options: CodexAppServerOptions) {
    this.options = { ...options, args: options.args ?? [] };
  }

  /** Starts the caller-selected executable transport when needed. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.options.transport !== undefined) {
      const transport = this.options.transport;
      if (transport.onMessage !== undefined) {
        const unsubscribe = transport.onMessage((message) => {
          const record = asRecord(message);
          if (record !== undefined) this.receiveMessage(record);
        });
        if (typeof unsubscribe === "function") this.unsubscribe = unsubscribe;
      } else if (transport.onLine !== undefined) {
        const unsubscribe = transport.onLine((line) => this.receiveLine(line));
        if (typeof unsubscribe === "function") this.unsubscribe = unsubscribe;
      }
      return;
    }
    try {
      this.child = spawn(this.options.executable, [...(this.options.args ?? [])], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: "pipe",
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      this.started = false;
      throw error;
    }
    this.input = this.child.stdin;
    this.readline = createInterface({ input: this.child.stdout });
    this.readline.on("line", (line) => this.receiveLine(line));
    this.child.stderr.on("data", () => undefined);
    this.child.once("error", (error) => this.rejectPending(error));
    this.child.once("close", () => this.rejectPending(new Error("Codex App Server exited.")));
  }

  /** Initializes the app-server protocol session. */
  public async initialize(): Promise<unknown> {
    if (this.initialized) return {};
    this.initialization ??= (async () => {
      await this.start();
      const result = await this.request("initialize", {
        clientInfo: {
          name: this.options.clientInfo?.name ?? "holycodex-workflow-host",
          title: this.options.clientInfo?.title ?? "HolyCodex Workflow Host",
          version: this.options.clientInfo?.version ?? "0.12.2",
        },
      });
      await this.notify("initialized", {});
      this.initialized = true;
      return result;
    })();
    try {
      return await this.initialization;
    } finally {
      if (!this.initialized) this.initialization = undefined;
    }
  }

  /** Creates a Codex thread with the exact route and policy values. */
  public async threadStart(policy: AppServerPolicy = {}): Promise<unknown> {
    await this.initialize();
    return await this.request("thread/start", this.policyParams(policy));
  }

  /** Starts a turn on an existing Codex thread. */
  public async turnStart(
    threadId: string,
    prompt: string,
    policy: AppServerPolicy = {},
  ): Promise<unknown> {
    await this.initialize();
    return await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      ...this.policyParams(policy),
    });
  }

  /** Requests cancellation of a turn. */
  public async turnInterrupt(threadId: string, turnId?: string): Promise<unknown> {
    await this.initialize();
    return await this.request("turn/interrupt", {
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  /** Reads the public items for a thread. */
  public async threadRead(threadId: string): Promise<unknown> {
    await this.initialize();
    return await this.request("thread/read", { threadId });
  }

  /** Reopens a persisted Codex thread. */
  public async threadReopen(threadId: string, policy: AppServerPolicy = {}): Promise<unknown> {
    await this.initialize();
    return await this.request("thread/resume", { threadId, ...this.policyParams(policy) });
  }

  /** Subscribes to concise public server notifications. */
  public onNotification(listener: (message: Record<string, unknown>) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  /** Runs one agent call and returns only its final public value and usage. */
  public async execute(
    prompt: string,
    options: AgentOptions &
      AppServerPolicy & {
        readonly route?: AgentRoute | undefined;
        readonly signal?: AbortSignal | undefined;
      } = {},
  ): Promise<AgentExecution> {
    if (typeof prompt !== "string") throw new TypeError("Agent prompt must be a string.");
    const route = options.route;
    const policy: AppServerPolicy = {
      ...options,
      ...(route === undefined
        ? {}
        : {
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            serviceTier: route.serviceTier,
          }),
    };
    const started = (await withAbort(this.threadStart(policy), options.signal)) as Record<
      string,
      unknown
    >;
    const thread = asRecord(started.thread) ?? started;
    const threadId = stringValue(thread.id ?? thread.threadId);
    if (threadId === undefined) throw new Error("Codex App Server did not return a thread id.");
    if (isAborted(options.signal)) throw new Error("Agent call cancelled.");
    let turnId: string | undefined;
    const abort = (): void => {
      void this.turnInterrupt(threadId, turnId).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (isAborted(options.signal)) {
        abort();
        throw new Error("Agent call cancelled.");
      }
      const completionController = new AbortController();
      const cancelCompletion = (): void => completionController.abort();
      options.signal?.addEventListener("abort", cancelCompletion, { once: true });
      const completion = this.waitForTurnCompletion(threadId, completionController.signal);
      let turnResponse: Record<string, unknown>;
      try {
        turnResponse = (await withAbort(
          this.turnStart(threadId, agentPrompt(prompt, options), policy),
          options.signal,
        )) as Record<string, unknown>;
      } catch (error) {
        completionController.abort();
        await completion.catch(() => undefined);
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", cancelCompletion);
      }
      const turn = asRecord(turnResponse.turn) ?? turnResponse;
      turnId = stringValue(turn.id ?? turn.turnId);
      if (isAborted(options.signal)) throw new Error("Agent call cancelled.");
      const completed = await completion;
      const read = (await withAbort(this.threadRead(threadId), options.signal)) as Record<
        string,
        unknown
      >;
      return extractExecution({ ...read, ...completed }, threadId, turnId);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /** Creates an AgentExecutor bridge for runWorkflow. */
  public asExecutor(
    defaults: AppServerPolicy & {
      readonly route?: AgentRoute | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): AgentExecutor {
    return async (prompt, options) => {
      const execution = await this.execute(prompt, { ...defaults, ...options });
      return execution.result;
    };
  }

  /** Closes streams and terminates the complete app-server process tree. */
  public async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.readline?.close();
    this.readline = undefined;
    if (this.child !== undefined) killProcessTree(this.child, process.platform, "SIGTERM");
    this.options.transport?.kill?.();
    await this.options.transport?.close?.();
    this.input = undefined;
    this.child = undefined;
    this.started = false;
    this.initialized = false;
    this.initialization = undefined;
    this.rejectPending(new Error("Codex App Server client closed."));
  }

  private policyParams(policy: AppServerPolicy): Record<string, unknown> {
    const merged = { ...this.options.policy, ...policy };
    const params: Record<string, unknown> = {};
    if (merged.cwd !== undefined) params.cwd = merged.cwd;
    if (merged.model !== undefined) params.model = merged.model;
    if (merged.reasoningEffort !== undefined) params.effort = merged.reasoningEffort;
    if (merged.serviceTier !== undefined) params.serviceTier = merged.serviceTier;
    if (merged.sandboxPolicy !== undefined) params.sandboxPolicy = merged.sandboxPolicy;
    if (merged.approvalPolicy !== undefined) params.approvalPolicy = merged.approvalPolicy;
    if (merged.lowVerbosity === true || merged.configOverride !== undefined) {
      params.config = {
        ...merged.configOverride,
        ...(merged.lowVerbosity === true ? { [LOW_VERBOSITY_CONFIG]: "low" } : {}),
      };
    }
    return params;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    await this.start();
    if (this.options.transport !== undefined) {
      const send = this.options.transport.send ?? this.options.transport.write;
      if (send === undefined) throw new Error("App-server transport does not provide send/write.");
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = this.requestTimer(id, method, reject);
        this.pending.set(id, { resolve, reject, ...(timer === undefined ? {} : { timer }) });
        Promise.resolve(send(payload)).catch((error: unknown) => {
          this.pending.delete(id);
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        });
      });
      return result;
    }
    if (this.input === undefined) throw new Error("Codex App Server transport is not available.");
    return await new Promise<unknown>((resolve, reject) => {
      const timer = this.requestTimer(id, method, reject);
      this.pending.set(id, { resolve, reject, ...(timer === undefined ? {} : { timer }) });
      this.input?.write(payload);
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ method, params })}\n`;
    const send = this.options.transport?.send ?? this.options.transport?.write;
    if (send !== undefined) {
      await send(line);
      return;
    }
    this.input?.write(line);
  }

  private async waitForTurnCompletion(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const listener = (message: Record<string, unknown>): void => {
        if (
          message.method !== "turn/completed" &&
          message.method !== "turn/failed" &&
          message.method !== "turn/interrupted"
        )
          return;
        const params = asRecord(message.params);
        const turn = asRecord(params?.turn);
        if (params === undefined || stringValue(params.threadId ?? turn?.threadId) !== threadId)
          return;
        cleanup();
        const status = stringValue(params.status ?? turn?.status);
        if (message.method === "turn/failed" || status === "failed")
          reject(new Error("Codex turn failed."));
        else if (message.method === "turn/interrupted" || status === "interrupted")
          reject(new Error("Agent call cancelled."));
        else resolve(params);
      };
      const abort = (): void => {
        cleanup();
        reject(new Error("Agent call cancelled."));
      };
      const cleanup = (): void => {
        this.notifications.delete(listener);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.notifications.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
      if (this.options.requestTimeoutMs !== undefined)
        timer = setTimeout(() => {
          cleanup();
          reject(new Error("Codex turn timed out."));
        }, this.options.requestTimeoutMs);
    });
  }

  private requestTimer(
    id: number,
    method: string,
    reject: (error: Error) => void,
  ): ReturnType<typeof setTimeout> | undefined {
    if (this.options.requestTimeoutMs === undefined) return undefined;
    return setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`Codex App Server request timed out: ${method}`));
    }, this.options.requestTimeoutMs);
  }

  private receiveLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const message = asRecord(parsed);
    if (message === undefined) return;
    this.receiveMessage(message);
  }

  private receiveMessage(message: Record<string, unknown>): void {
    const id = stringValue(message.id) ?? numberValue(message.id);
    if (id !== undefined && this.pending.has(id)) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending === undefined) return;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error(publicError(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const method = stringValue(message.method);
    if (id !== undefined && method !== undefined) {
      this.respondToServerRequest(id, method);
      return;
    }
    for (const listener of this.notifications) listener(message);
  }

  private respondToServerRequest(id: string | number, method: string): void {
    let result: Record<string, unknown> | undefined;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    )
      result = { decision: "decline" };
    else if (method === "item/permissions/requestApproval") result = { permissions: {} };
    else if (method === "mcpServer/elicitation/request")
      result = { action: "decline", content: null };
    const message =
      result === undefined
        ? { id, error: { code: -32_601, message: "Unsupported server request." } }
        : { id, result };
    const line = `${JSON.stringify(message)}\n`;
    const send = this.options.transport?.send ?? this.options.transport?.write;
    if (send !== undefined) {
      void Promise.resolve(send(line)).catch(() => undefined);
      return;
    }
    this.input?.write(line);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Convenience factory for an agent executor backed by an app-server client. */
export function createCodexAgentExecutor(
  client: CodexAppServerClient,
  defaults: AppServerPolicy & {
    readonly route?: AgentRoute | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): AgentExecutor {
  return client.asExecutor(defaults);
}

function extractExecution(
  value: Record<string, unknown>,
  threadId: string,
  turnId: string | undefined,
): AgentExecution {
  const items = collectItems(value);
  let final: unknown;
  let usage: AgentUsage = {};
  for (const item of items) {
    const record = asRecord(item);
    if (record === undefined) continue;
    if (record.usage !== undefined) usage = extractUsage(record.usage);
    const type = stringValue(record.type);
    if (
      type === "agentMessage" ||
      type === "agent_message" ||
      type === "assistant_message" ||
      type === "message"
    )
      final = record.text ?? record.content;
  }
  usage = { ...usage, ...extractUsage(value.usage) };
  const result = sanitizeFinalResult(final ?? value.result ?? null);
  return { result, usage, threadId, ...(turnId === undefined ? {} : { turnId }) };
}

function collectItems(value: Record<string, unknown>): unknown[] {
  const items: unknown[] = [];
  const add = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    for (const item of candidate) {
      const record = asRecord(item);
      if (record === undefined) continue;
      if (Array.isArray(record.items)) add(record.items);
      else items.push(item);
    }
  };
  add(value.items);
  add(value.turns);
  const turn = asRecord(value.turn);
  add(turn?.items);
  add(turn?.turns);
  const thread = asRecord(value.thread);
  add(thread?.items);
  add(thread?.turns);
  return items;
}

function extractUsage(value: unknown): AgentUsage {
  const record = asRecord(value);
  if (record === undefined) return {};
  const inputTokens = numberValue(record.inputTokens ?? record.input_tokens);
  const outputTokens = numberValue(record.outputTokens ?? record.output_tokens);
  const totalTokens = numberValue(record.totalTokens ?? record.total_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function sanitizeFinalResult(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isJsonValue(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  return isJsonValue(value) ? value : null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every(isJsonValue);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw new Error("Agent call cancelled.");
  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    abort = (): void => reject(new Error("Agent call cancelled."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}
function publicError(value: unknown): string {
  if (typeof value === "string") return value;
  const message = asRecord(value)?.message;
  return typeof message === "string" ? message : "Codex App Server request failed.";
}

function agentPrompt(prompt: string, options: AgentOptions): string {
  const additions: string[] = [];
  if (options.context !== undefined)
    additions.push(`Context (JSON data):\n${JSON.stringify(options.context)}`);
  if (options.schema !== undefined)
    additions.push(`Return only JSON matching this schema:\n${JSON.stringify(options.schema)}`);
  return additions.length === 0 ? prompt : `${prompt}\n\n${additions.join("\n\n")}`;
}
