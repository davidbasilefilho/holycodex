// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import * as Effect from "effect/Effect";

import { runPackageBuild } from "./package-build.ts";
import { createReleaseArtifact } from "./package-release.ts";
import { withTemporaryDirectory } from "./process.ts";
import { baseVersionFromRelease, readCanonicalVersion } from "./release-version.ts";

describe("release package boundary", () => {
  test("verifies a development artifact with its stable install-record base", async () => {
    await Effect.runPromise(runPackageBuild());
    const canonicalVersion = await Effect.runPromise(readCanonicalVersion());
    const baseVersion = baseVersionFromRelease(canonicalVersion);
    const releaseVersion = `${baseVersion}-dev.76.1`;
    const metadata = await withTemporaryDirectory(
      "package-release-test",
      async (output) =>
        await createReleaseArtifact(output, {
          version: releaseVersion,
          channel: "dev",
          sourceSha: "a".repeat(40),
        }),
    );

    expect(metadata.baseVersion).toBe(baseVersion);
    expect(metadata.version).toBe(releaseVersion);
  }, 900_000);
});
