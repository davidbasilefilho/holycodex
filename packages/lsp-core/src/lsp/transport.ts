// SPDX-License-Identifier: Apache-2.0

import {
  MAX_LSP_STDERR_BYTES,
  INIT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  STOP_HARD_KILL_TIMEOUT_MS,
  STOP_SIGKILL_GRACE_MS,
} from "./constants.ts";
import {
  LspConnectionClosedError,
  LspProcessExitedError,
  LspRequestTimeoutError,
} from "./errors.ts";
import { JsonRpcConnection, JsonRpcRequestTimeoutError } from "./json-rpc-connection.ts";
import { contextEnvironment } from "../request-context.ts";
import { spawnProcess, type SpawnedProcess } from "./process.ts";
import type { ResolvedServer, Diagnostic } from "./types.ts";
import { decodeLspSchema } from "./schema.ts";
import { DiagnosticSchema } from "./protocol-schemas.ts";
import * as Schema from "effect/Schema";

export interface LspClientTransportOptions {
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly processFactory?: (
    command: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> },
  ) => SpawnedProcess;
  readonly stderrLimitBytes?: number;
}

const ConfigurationSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ section: Schema.optional(Schema.String) })),
});
const DiagnosticsSchema = Schema.Struct({
  uri: Schema.String,
  diagnostics: Schema.optional(Schema.Array(DiagnosticSchema)),
});

/** Owns one language-server process and its bounded JSON-RPC connection. */
export class LspClientTransport {
  protected proc: SpawnedProcess | null = null;
  protected connection: JsonRpcConnection | null = null;
  protected processExited = false;
  protected readonly stderrBuffer: string[] = [];
  protected readonly diagnosticsStore = new Map<string, Diagnostic[]>();
  protected readonly requestTimeoutMs: number;
  protected readonly initializeTimeoutMs: number;
  private readonly processFactory: NonNullable<LspClientTransportOptions["processFactory"]>;
  private readonly stderrLimitBytes: number;

  constructor(
    protected readonly root: string,
    protected readonly server: ResolvedServer,
    options: LspClientTransportOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? INIT_TIMEOUT_MS;
    this.processFactory =
      options.processFactory ?? ((command, spawnOptions) => spawnProcess(command, spawnOptions));
    this.stderrLimitBytes = options.stderrLimitBytes ?? MAX_LSP_STDERR_BYTES;
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }
  command(): string[] {
    return [...this.server.command];
  }

  /** Starts the server process and installs protocol callbacks. */
  async start(): Promise<void> {
    if (this.proc !== null) return;
    const environment = { ...contextEnvironment(), ...this.server.env };
    this.proc = this.processFactory(this.server.command, { cwd: this.root, env: environment });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string | Buffer) =>
      this.appendStderr(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
    );
    void this.proc.exited.then(() => {
      this.processExited = true;
      this.connection?.dispose();
    });
    if (this.proc.exitCode !== null) throw this.processError();
    this.connection = new JsonRpcConnection(this.proc.stdout, this.proc.stdin);
    this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const parsed = decodeLspSchema(DiagnosticsSchema, params);
      if (parsed !== undefined)
        this.diagnosticsStore.set(parsed.uri, [...(parsed.diagnostics ?? [])]);
    });
    this.connection.onRequest("workspace/configuration", (params) => {
      const parsed = decodeLspSchema(ConfigurationSchema, params);
      return (parsed?.items ?? []).map((item) =>
        item.section === "json" ? { validate: { enable: true } } : {},
      );
    });
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onClose(() => {
      this.processExited = true;
    });
    this.connection.listen();
  }

  /** Sends a typed request, translating transport failures into actionable LSP errors. */
  protected async sendRequest<T>(
    method: string,
    schema: Schema.Schema<T>,
    params?: unknown,
    options: {
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<T> {
    if (this.connection === null)
      throw new LspConnectionClosedError(this.server.id, this.root, "LSP client is not started");
    if (this.processExited || this.proc?.exitCode !== null) throw this.processError();
    try {
      return await this.connection.sendRequest(method, schema, params, {
        timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (error instanceof JsonRpcRequestTimeoutError)
        throw new LspRequestTimeoutError(method, this.stderrTail());
      if (this.processExited || this.proc?.exitCode !== null) throw this.processError();
      if (error instanceof Error && /closed|disposed|destroyed/i.test(error.message))
        throw new LspConnectionClosedError(this.server.id, this.root, error.message);
      throw error;
    }
  }

  /** Sends a best-effort server notification. */
  protected async sendNotification(method: string, params?: unknown): Promise<void> {
    if (this.connection === null || this.processExited || this.proc?.exitCode !== null) return;
    try {
      await this.connection.sendNotification(method, params);
    } catch (error: unknown) {
      throw new LspConnectionClosedError(
        this.server.id,
        this.root,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  isAlive(): boolean {
    return this.proc !== null && !this.processExited && this.proc.exitCode === null;
  }

  /** Performs protocol shutdown and bounded process cleanup. */
  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) {
      try {
        await connection.sendRequest("shutdown", Schema.Null, undefined, {
          timeoutMs: Math.min(this.requestTimeoutMs, 2_000),
        });
      } catch {
        /* cleanup is best effort */
      }
      try {
        await connection.sendNotification("exit");
      } catch {
        /* cleanup is best effort */
      }
      connection.dispose();
    }
    const process = this.proc;
    this.proc = null;
    if (process !== null) {
      process.kill("SIGTERM");
      const completed = await Promise.race([
        process.exited.then(() => true),
        delay(STOP_HARD_KILL_TIMEOUT_MS).then(() => false),
      ]);
      if (!completed) {
        process.kill("SIGKILL");
        await Promise.race([process.exited, delay(STOP_SIGKILL_GRACE_MS)]);
      }
    }
    this.processExited = true;
    this.diagnosticsStore.clear();
  }

  /** Returns diagnostics received through publishDiagnostics notifications. */
  getStoredDiagnostics(uri: string): Diagnostic[] {
    return [...(this.diagnosticsStore.get(uri) ?? [])];
  }

  protected stderrTail(): string | undefined {
    const text = this.stderrBuffer.join("");
    return text.length === 0 ? undefined : text.slice(-2_000);
  }

  private appendStderr(chunk: string): void {
    this.stderrBuffer.push(chunk);
    let total = this.stderrBuffer.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
    while (total > this.stderrLimitBytes && this.stderrBuffer.length > 1) {
      const removed = this.stderrBuffer.shift() ?? "";
      total -= Buffer.byteLength(removed, "utf8");
    }
  }

  private processError(): LspProcessExitedError {
    return new LspProcessExitedError(
      this.server.id,
      this.root,
      this.proc?.exitCode ?? null,
      this.stderrTail(),
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createLspSpawnEnv(
  _root: string,
  input: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...input };
}
