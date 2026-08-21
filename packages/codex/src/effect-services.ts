// SPDX-License-Identifier: Apache-2.0

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexError, type CodexResult } from "./common";
import {
  discoverCodexExecutable,
  type CodexExecutableDiscoveryOptions,
  type CodexExecutableIdentity,
} from "./executable";
import { AppServerClient } from "./client";
import {
  BunStdioTransport,
  type AsyncLineTransport,
  type BunStdioTransportOptions,
} from "./transport";

export const PROMISE_ADAPTER_EXCEPTIONS = Object.freeze([
  {
    boundary: "ExecutableDiscovery.discover",
    operation: "discoverCodexExecutable",
    adaptation: "unknown rejection -> CodexError(discovery_failed)",
  },
  {
    boundary: "Subprocess.spawn",
    operation: "BunStdioTransport construction and close",
    adaptation: "unknown rejection -> CodexError(subprocess_failed)",
  },
  {
    boundary: "AppServer.initialize",
    operation: "initialize handshake and shutdown",
    adaptation: "unknown rejection -> CodexError(transport_failure)",
  },
  {
    boundary: "AppServer.request",
    operation: "newline request/response correlation and server callbacks",
    adaptation: "unknown rejection -> typed transport/server failure",
  },
  {
    boundary: "AgentExecution.execute",
    operation: "assignment turn completion waiter",
    adaptation: "unknown rejection -> CodexError(execution_failed) or preserved typed failure",
  },
] as const);

function adaptError(
  error: unknown,
  code: "discovery_failed" | "subprocess_failed" | "transport_failure",
): CodexError {
  if (error instanceof CodexError) {
    return error;
  }
  return new CodexError(code, "The Codex Effect boundary failed.", {}, { cause: error });
}

export interface ExecutableDiscoveryService {
  readonly discover: (
    options?: CodexExecutableDiscoveryOptions,
  ) => Effect.Effect<CodexExecutableIdentity, CodexError>;
}

export class ExecutableDiscovery extends Context.Tag("@holycodex/codex/ExecutableDiscovery")<
  ExecutableDiscovery,
  ExecutableDiscoveryService
>() {}

export const ExecutableDiscoveryLive = Layer.succeed(ExecutableDiscovery, {
  discover: (options: CodexExecutableDiscoveryOptions = {}) =>
    Effect.tryPromise({
      try: () => discoverCodexExecutable(options),
      catch: (error) => adaptError(error, "discovery_failed"),
    }),
});

export interface SubprocessService {
  readonly spawn: (
    options: BunStdioTransportOptions,
  ) => Effect.Effect<AsyncLineTransport, CodexError, import("effect/Scope").Scope>;
}

export class Subprocess extends Context.Tag("@holycodex/codex/Subprocess")<
  Subprocess,
  SubprocessService
>() {}

export const SubprocessLive = Layer.succeed(Subprocess, {
  spawn: (options: BunStdioTransportOptions) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => new BunStdioTransport(options),
        catch: (error) => adaptError(error, "subprocess_failed"),
      }),
      (transport) =>
        Effect.tryPromise({
          try: () => transport.close(),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
});

export interface AppServerService {
  readonly client: AppServerClient;
  readonly transport: AsyncLineTransport;
  readonly executable: CodexExecutableIdentity;
}

export class AppServer extends Context.Tag("@holycodex/codex/AppServer")<
  AppServer,
  AppServerService
>() {}

export interface AppServerLiveOptions {
  readonly executable: CodexExecutableIdentity;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maxLineBytes?: number;
  readonly maxDiagnosticBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export const AppServerLive = (options: AppServerLiveOptions): Layer.Layer<AppServer, CodexError> =>
  Layer.scoped(
    AppServer,
    Effect.gen(function* () {
      const subprocess = yield* Subprocess;
      const transport = yield* subprocess.spawn({
        executablePath: options.executable.path,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
        ...(options.maxDiagnosticBytes === undefined
          ? {}
          : { maxDiagnosticBytes: options.maxDiagnosticBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const client = yield* Effect.tryPromise({
        try: async () => {
          const appServer = new AppServerClient(transport, {
            ...(options.requestTimeoutMs === undefined
              ? {}
              : { requestTimeoutMs: options.requestTimeoutMs }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          await appServer.initialize();
          return appServer;
        },
        catch: (error) => adaptError(error, "transport_failure"),
      });
      return { client, transport, executable: options.executable };
    }),
  ).pipe(Layer.provide(SubprocessLive));

export function codexResultToEffect<T>(result: CodexResult<T>): Effect.Effect<T, CodexError> {
  return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
}
