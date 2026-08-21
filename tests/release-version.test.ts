// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { devReleaseIdentity, stableVersionFromTag } from "../scripts/release-version.ts";

describe("release identity", () => {
  test("derives unique dev npm and non-v tags", () => {
    expect(devReleaseIdentity("0.15.0", "42", "abcdef0123456789")).toEqual({
      version: "0.15.0-dev.42.abcdef012345",
      tag: "dev-0.15.0.42.abcdef012345",
    });
  });

  test("accepts an exact stable tag and canonical version", () => {
    expect(stableVersionFromTag("v0.15.0", "0.15.0")).toBe("0.15.0");
  });

  test("rejects malformed or mismatched stable tags", () => {
    expect(() => stableVersionFromTag("dev-0.15.0", "0.15.0")).toThrow();
    expect(() => stableVersionFromTag("v0.15.1", "0.15.0")).toThrow();
    expect(() => stableVersionFromTag("v0.15.0-beta.1", "0.15.0")).toThrow();
  });
});
