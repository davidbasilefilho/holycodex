// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vite-plus/test";
import { SafeFilesystemManifestSchema } from "./protocol.ts";

describe("safe filesystem artifact manifest", () => {
  test("accepts the platform helper names emitted by the native builder", () => {
    for (const executable of ["safe-filesystem", "safe-filesystem.exe"] as const) {
      const result = Schema.decodeUnknownEither(SafeFilesystemManifestSchema)({
        schemaVersion: "holycodex-safe-filesystem-artifact-v1",
        protocolVersion: 1,
        helperVersion: "safe-filesystem-helper-1",
        platform: executable.endsWith(".exe") ? "win32" : "linux",
        architecture: "x64",
        executable,
        sourceSha256: "a".repeat(64),
        helperSha256: "b".repeat(64),
        compiler: "cc",
        compilerVersion: "1",
        flags: ["-O2"],
      });
      expect(Either.isRight(result)).toBe(true);
    }
  });
});
