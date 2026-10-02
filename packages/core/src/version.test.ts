// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { readPublicManifest } from "../../cli/src/manifest.ts";
import { readSourceManifest } from "../../plugin/src/schemas.ts";
import { BaseVersionSchema, DevelopmentVersionSchema, ReleaseVersionSchema } from "./version.ts";

describe("release version schemas", () => {
  test("accepts stable and development releases", () => {
    expect(Schema.decodeUnknownSync(ReleaseVersionSchema)("0.16.11")).toBe("0.16.11");
    expect(Schema.decodeUnknownSync(ReleaseVersionSchema)("0.16.11-dev.76.1")).toBe(
      "0.16.11-dev.76.1",
    );
  });

  test("rejects invalid versions and non-string values through schema results", () => {
    for (const version of ["0.16.011", "0.16.11-dev.0.1", Symbol.for("invalid"), 42]) {
      const result = Schema.decodeUnknownResult(ReleaseVersionSchema)(version);
      expect(Result.isFailure(result)).toBe(true);
    }
  });

  test("keeps specific schemas rejecting the other release forms", () => {
    expect(Schema.decodeUnknownSync(DevelopmentVersionSchema)("0.16.11-dev.76.1")).toBe(
      "0.16.11-dev.76.1",
    );
    expect(Result.isFailure(Schema.decodeUnknownResult(BaseVersionSchema)("0.16.11-dev.1.1"))).toBe(
      true,
    );
    expect(Result.isFailure(Schema.decodeUnknownResult(DevelopmentVersionSchema)("0.16.11"))).toBe(
      true,
    );
  });

  test("decodes the checked-in CLI and plugin manifests", async () => {
    const [cliManifest, pluginManifest] = await Promise.all([
      readPublicManifest(),
      readSourceManifest(fileURLToPath(new URL("../../plugin/assets/", import.meta.url))),
    ]);

    expect(Schema.decodeUnknownSync(ReleaseVersionSchema)(cliManifest["version"])).toBe(
      cliManifest["version"],
    );
    expect(pluginManifest.version).toBeDefined();
  });
});
