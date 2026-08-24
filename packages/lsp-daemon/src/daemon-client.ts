// SPDX-License-Identifier: Apache-2.0

import { connect, type Socket } from "node:net";
import { messageFromError } from "./errors.ts";
import { ensureDaemonRunning } from "./ensure-daemon.ts";
import { daemonNoncePath, daemonPaths, type DaemonPaths } from "./paths.ts";
import { CONTEXT_KEY } from "./request-routing.ts";
import { createLineDecoder, encodeJsonLine } from "./socket-json.ts";
import { lstatSync, readFileSync } from "node:fs";
import type { ToolExecutionResult } from "@holycodex/lsp-core/tools";
import { decodeLspSchema } from "@holycodex/lsp-core";
import * as Schema from "effect/Schema";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ResponseSchema = Schema.Struct({
  id: Schema.Union(Schema.String, Schema.Number),
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    isError: Schema.optional(Schema.Boolean),
    details: Schema.optional(Schema.Unknown),
  }),
});

export class DaemonRequestError extends Error {
  constructor(
    message: string,
    readonly requestWritten: boolean,
  ) {
    super(message);
    this.name = "DaemonRequestError";
  }
}
export interface DaemonToolContext {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}
export interface CallToolOptions {
  readonly context?: DaemonToolContext;
  readonly paths?: DaemonPaths;
  readonly requestTimeoutMs?: number;
  readonly ensure?: (paths: DaemonPaths) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Calls a daemon tool with bounded ensure/retry behavior and structured failure output. */
export async function callToolViaDaemon(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<ToolExecutionResult> {
  const paths = options.paths ?? daemonPaths();
  const ensure = options.ensure ?? ensureDaemonRunning;
  const requestArgs = withContext(args, options.context);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensure(paths);
      return await sendToolCall(
        paths,
        name,
        requestArgs,
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        options.signal,
      );
    } catch (error: unknown) {
      lastError = error;
      if (error instanceof DaemonRequestError && error.requestWritten) break;
    }
  }
  return daemonUnreachableResult(paths, lastError);
}

/** Calls the canonical diagnostics command through the daemon. */
export function callDiagnosticsViaDaemon(
  filePath: string,
  options: CallToolOptions = {},
): Promise<ToolExecutionResult> {
  return callToolViaDaemon("diagnostics", { filePath, severity: "error" }, options);
}

const FORWARDED_ENV_KEYS = [
  "HOLYCODEX_LSP_PROJECT_CONFIG",
  "HOLYCODEX_LSP_USER_CONFIG",
  "HOLYCODEX_LSP_INSTALL_DECISIONS",
] as const;
/** Captures only request-scoped context keys allowed across the daemon boundary. */
export function currentRequestContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DaemonToolContext {
  const forwarded: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) forwarded[key] = value;
  }
  return { cwd: process.cwd(), env: forwarded };
}
function withContext(
  args: Record<string, unknown>,
  context: DaemonToolContext | undefined,
): Record<string, unknown> {
  return context === undefined || (context.cwd === undefined && context.env === undefined)
    ? args
    : { ...args, [CONTEXT_KEY]: context };
}

function daemonUnreachableResult(paths: DaemonPaths, error: unknown): ToolExecutionResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `LSP daemon unreachable: ${messageFromError(error)}.`,
          "The CLI client never runs language servers in-process.",
          `Socket: ${paths.socket}`,
          `Logs: ${paths.log}`,
          "The daemon is auto-started on demand and will be retried on the next request.",
        ].join("\n"),
      },
    ],
    isError: true,
  };
}

function readNonce(paths: DaemonPaths): string | undefined {
  try {
    if (lstatSync(daemonNoncePath(paths)).isSymbolicLink()) return undefined;
    const value = readFileSync(daemonNoncePath(paths), "utf8").trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function sendToolCall(
  paths: DaemonPaths,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolExecutionResult> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(paths.socket);
    const requestWritten = { value: false };
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      run();
    };
    const onAbort = (): void =>
      finish(() => reject(new DaemonRequestError("daemon request aborted", requestWritten.value)));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new DaemonRequestError("daemon request timed out", requestWritten.value)),
        ),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    const decoder = createLineDecoder(
      (message) => {
        const parsed = decodeLspSchema(ResponseSchema, message);
        if (parsed === undefined || parsed.id !== 1)
          finish(() =>
            reject(new DaemonRequestError("invalid daemon response", requestWritten.value)),
          );
        else finish(() => resolve(parsed.result));
      },
      () =>
        finish(() =>
          reject(new DaemonRequestError("malformed daemon response", requestWritten.value)),
        ),
    );
    socket.once("connect", () => {
      requestWritten.value = true;
      socket.write(
        encodeJsonLine({
          id: 1,
          method: "lsp/call",
          params: {
            command: name,
            arguments: args,
            ...(readNonce(paths) === undefined ? {} : { auth: readNonce(paths) }),
          },
        }),
      );
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.once("error", (error: Error) =>
      finish(() => reject(new DaemonRequestError(error.message, requestWritten.value))),
    );
    socket.once("close", () =>
      finish(() =>
        reject(new DaemonRequestError("daemon connection closed", requestWritten.value)),
      ),
    );
  });
}
