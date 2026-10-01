// SPDX-License-Identifier: Apache-2.0

import * as Effect from "effect/Effect";

import { CodexError } from "../src/common";
import { verifyGeneratedArtifact } from "../src/generated-artifact";

const verification = Effect.tryPromise({
  try: () => verifyGeneratedArtifact(),
  catch: (error) => error,
}).pipe(
  Effect.matchEffect({
    onSuccess: (result) =>
      Effect.sync(() =>
        console.log(
          JSON.stringify({
            status: "verified",
            protocol_epoch: result.protocol_epoch,
            codex_cli_version: result.codex_cli_version,
            artifact_count: result.inventory.count,
            artifact_digest: result.inventory.digest,
            multi_agent_v2_lifecycle: result.multi_agent_v2_lifecycle,
          }),
        ),
      ),
    onFailure: (error) =>
      Effect.sync(() => {
        const failure = error instanceof CodexError ? error : undefined;
        console.error(
          JSON.stringify({
            status: "failed",
            code: failure?.code ?? "protocol_mismatch",
            message: failure?.message ?? "The generated artifact verification failed.",
            details: failure?.details ?? {},
          }),
        );
        process.exitCode = 1;
      }),
  }),
);

if (import.meta.main) {
  await Effect.runPromise(verification);
}
