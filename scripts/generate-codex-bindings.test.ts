// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";

import { assertLatestStableMatch, canReuseGeneratedOutput } from "./generate-codex-bindings.ts";

describe("latest stable Codex generation contract", () => {
  test("rejects a stale cached tool against mocked latest-channel metadata", () => {
    expect(() => assertLatestStableMatch("0.153.0", "0.152.1")).toThrow(
      "installed Codex version 0.152.1 is stale",
    );
    expect(() => assertLatestStableMatch("0.153.0-dev.1", "0.153.0")).toThrow(
      "must be a stable semantic version",
    );
  });

  test("reuses a generated cache only for the current version and executable digest", () => {
    const current = { codexCliVersion: "codex-cli 0.153.0", codexCliDigest: "digest-current" };
    expect(canReuseGeneratedOutput(current, current)).toBe(true);
    expect(
      canReuseGeneratedOutput({ ...current, codexCliVersion: "codex-cli 0.152.1" }, current),
    ).toBe(false);
    expect(canReuseGeneratedOutput({ ...current, codexCliDigest: "digest-stale" }, current)).toBe(
      false,
    );
  });
});
