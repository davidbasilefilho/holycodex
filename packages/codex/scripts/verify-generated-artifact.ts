// SPDX-License-Identifier: Apache-2.0

import { verifyGeneratedArtifact } from "../src/generated-artifact";
import { CodexError } from "../src/common";

try {
  const verification = await verifyGeneratedArtifact();
  console.log(
    JSON.stringify({
      status: "verified",
      protocol_epoch: verification.protocol_epoch,
      binary_version: verification.executable.version,
      binary_sha256: verification.executable.sha256,
      artifact_count: verification.inventory.count,
      artifact_digest: verification.inventory.digest,
      multi_agent_v2_lifecycle: verification.multi_agent_v2_lifecycle,
    }),
  );
} catch (error: unknown) {
  const failure = error instanceof CodexError ? error : undefined;
  console.error(
    JSON.stringify({
      status: "failed",
      code: error instanceof CodexError ? error.code : "protocol_mismatch",
      message: failure?.message ?? "The generated artifact verification failed.",
      details: failure?.details ?? {},
    }),
  );
  process.exitCode = 1;
}
