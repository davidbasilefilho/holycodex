// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import {
  canReuseGeneratedOutput,
  codexExecutableCommand,
  codexPlatformTarget,
} from "./generate-codex-bindings.ts";

describe("workspace-owned Codex generation contract", () => {
  test("invokes the root-locked Codex package through Bun rather than an ambient launcher", () => {
    const [runtime, entrypoint] = codexExecutableCommand();
    expect(runtime).toBe("bun");
    expect(entrypoint?.replaceAll("\\", "/")).toEndWith("/node_modules/@openai/codex/bin/codex.js");
  });

  test("maps every locked native Codex package to its platform binary", () => {
    expect(codexPlatformTarget("win32", "x64")).toEqual({
      packageName: "@openai/codex-win32-x64",
      targetTriple: "x86_64-pc-windows-msvc",
    });
    expect(codexPlatformTarget("win32", "arm64")).toEqual({
      packageName: "@openai/codex-win32-arm64",
      targetTriple: "aarch64-pc-windows-msvc",
    });
    expect(codexPlatformTarget("darwin", "x64")).toEqual({
      packageName: "@openai/codex-darwin-x64",
      targetTriple: "x86_64-apple-darwin",
    });
    expect(codexPlatformTarget("darwin", "arm64")).toEqual({
      packageName: "@openai/codex-darwin-arm64",
      targetTriple: "aarch64-apple-darwin",
    });
    expect(codexPlatformTarget("linux", "x64")).toEqual({
      packageName: "@openai/codex-linux-x64",
      targetTriple: "x86_64-unknown-linux-musl",
    });
    expect(codexPlatformTarget("android", "arm64")).toEqual({
      packageName: "@openai/codex-linux-arm64",
      targetTriple: "aarch64-unknown-linux-musl",
    });
    expect(() => codexPlatformTarget("linux", "riscv64")).toThrow(
      "Codex has no native package for linux/riscv64.",
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
