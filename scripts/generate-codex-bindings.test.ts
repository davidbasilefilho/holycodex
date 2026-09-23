// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import {
  assertLatestStableMatch,
  assertMiseLatestCodexConfig,
  canReuseGeneratedOutput,
  createMiseMetadataEnvironment,
  parseStableMiseCodexVersion,
} from "./generate-codex-bindings.ts";

describe("latest stable Codex generation contract", () => {
  test("requires the native Codex mise tool from its latest stable channel", () => {
    expect(() => assertMiseLatestCodexConfig('[tools]\ncodex = "latest"\n')).not.toThrow();
    expect(() => assertMiseLatestCodexConfig('[tools]\n"npm:@openai/codex" = "latest"\n')).toThrow(
      'mise.toml must resolve codex from the "latest" stable channel',
    );
  });

  test("rejects a stale cached tool against mocked latest-channel metadata", () => {
    expect(() => assertLatestStableMatch("0.153.0", "0.152.1")).toThrow(
      "installed Codex version 0.152.1 is stale",
    );
    expect(() => assertLatestStableMatch("0.153.0-dev.1", "0.153.0")).toThrow(
      "must be a stable semantic version",
    );
  });

  test("accepts a stable installed version when latest metadata is empty on either platform", () => {
    expect(() => assertLatestStableMatch("", "0.155.1")).not.toThrow();
    expect(() => assertLatestStableMatch("\r\n", "0.155.1")).not.toThrow();
    expect(() => assertLatestStableMatch(undefined, "0.155.1")).not.toThrow();
    expect(() => assertLatestStableMatch("", "0.155.1-dev.1")).toThrow(
      "the installed Codex CLI version must be a stable semantic version",
    );
  });

  test("parses Windows mise output and rejects malformed non-empty metadata", () => {
    expect(parseStableMiseCodexVersion("0.155.1\r\n")).toBe("0.155.1");
    expect(() => parseStableMiseCodexVersion("")).toThrow(
      "mise stable Codex metadata must be a stable semantic version, received .",
    );
    expect(() => parseStableMiseCodexVersion("01.2.3")).toThrow(
      "must be a stable semantic version",
    );
  });

  test("passes the read-only GitHub token only to stable metadata lookup", () => {
    const originalGithubToken = process.env["GITHUB_TOKEN"];
    const originalGhToken = process.env["GH_TOKEN"];
    process.env["GITHUB_TOKEN"] = "test-read-token";
    process.env["GH_TOKEN"] = "unrelated-token";
    try {
      const environment = createMiseMetadataEnvironment();
      expect(environment["GITHUB_TOKEN"]).toBe("test-read-token");
      expect(environment["GH_TOKEN"]).toBeUndefined();
    } finally {
      if (originalGithubToken === undefined) delete process.env["GITHUB_TOKEN"];
      else process.env["GITHUB_TOKEN"] = originalGithubToken;
      if (originalGhToken === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = originalGhToken;
    }
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
