// SPDX-License-Identifier: Apache-2.0

import {
  AppServerClient,
  BunStdioTransport,
  discoverCodexExecutable,
  type AccountRateLimitsReadResult,
  type ConsumeAccountRateLimitResetCreditResult,
} from "@holycodex/codex";
import * as Effect from "effect/Effect";

/** Minimal account API used by the auto-reset CLI and its transport-mocked tests. */
export interface AutoResetAccountClient {
  /** Read fresh usage windows and banked reset-credit details. */
  readonly readAccountRateLimits: () => Promise<AccountRateLimitsReadResult>;
  /** Consume one selected banked reset credit with a stable idempotency key. */
  readonly consumeAccountRateLimitResetCredit: (input: {
    readonly idempotencyKey: string;
    readonly creditId: string;
  }) => Promise<ConsumeAccountRateLimitResetCreditResult>;
  /** Close the local App Server connection. */
  readonly close: () => Promise<void>;
}

/**
 * Open the supported local Codex App Server adapter used for current account usage and reset RPCs.
 * Initialization reads no model output and never consumes a reset credit.
 */
export function openAutoResetAccountClient(): Effect.Effect<AutoResetAccountClient, unknown> {
  return Effect.gen(function* () {
    const executable = yield* Effect.tryPromise({
      try: () => discoverCodexExecutable(),
      catch: (error) => error,
    });
    const transport = yield* Effect.try({
      try: () => new BunStdioTransport({ executablePath: executable.path }),
      catch: (error) => error,
    });
    const client = new AppServerClient(transport, { requestTimeoutMs: 30_000 });
    yield* Effect.tryPromise({
      try: () => client.initialize(),
      catch: (error) => error,
    }).pipe(
      Effect.onError(() =>
        Effect.tryPromise({ try: () => client.close(), catch: (error) => error }).pipe(
          Effect.ignore,
        ),
      ),
    );
    return {
      readAccountRateLimits: () => client.readAccountRateLimits(),
      consumeAccountRateLimitResetCredit: (input) =>
        client.consumeAccountRateLimitResetCredit(input),
      close: () => client.close(),
    } satisfies AutoResetAccountClient;
  });
}

/** Run one account operation against a supplied or production local App Server client. */
export function withAutoResetAccountClient<A>(
  suppliedClient: AutoResetAccountClient | undefined,
  use: (client: AutoResetAccountClient) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  const acquire =
    suppliedClient === undefined ? openAutoResetAccountClient() : Effect.succeed(suppliedClient);
  return Effect.acquireUseRelease(acquire, use, (client) =>
    Effect.tryPromise({ try: () => client.close(), catch: (error) => error }).pipe(Effect.ignore),
  );
}
