// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vite-plus/test";
import {
  GIT_BASH_ENV_KEY,
  normalizeGitBashExecutablePath,
  resolveGitBash,
  resolveGitBashForCurrentProcess,
} from "./git-bash-resolver.ts";

const PROGRAM_FILES_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

describe("Git Bash resolution", () => {
  it("keeps an explicitly configured invalid path fail-closed", () => {
    const result = resolveGitBash({
      platform: "win32",
      env: { [GIT_BASH_ENV_KEY]: "C:\\missing\\bash.exe" },
      exists: () => false,
      where: () => ["D:\\Git\\bin\\bash.exe"],
    });

    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.checkedPaths).toEqual(["C:\\missing\\bash.exe"]);
      expect(result.installHint).toContain("refusing fallback");
    }
  });

  it("accepts an explicit spelling of the required executable", () => {
    const configured = "C:/Program Files/Git/bin/bash.exe";
    const result = resolveGitBash({
      platform: "win32",
      env: { [GIT_BASH_ENV_KEY]: configured },
      exists: (path) => path === configured,
      where: () => [],
    });

    expect(result).toMatchObject({
      found: true,
      path: PROGRAM_FILES_GIT_BASH,
      source: "env",
    });
  });

  it("checks only the required Program Files installation", () => {
    const checked: string[] = [];
    const result = resolveGitBash({
      platform: "win32",
      env: {},
      exists: (path) => {
        checked.push(path);
        return path === PROGRAM_FILES_GIT_BASH;
      },
      where: () => [],
    });

    expect(result).toMatchObject({
      found: true,
      path: PROGRAM_FILES_GIT_BASH,
      source: "program-files",
    });
    expect(checked).toEqual([PROGRAM_FILES_GIT_BASH]);
  });

  it("does not fall back to PATH candidates", () => {
    const result = resolveGitBash({
      platform: "win32",
      env: {},
      exists: (path) => path === "E:\\Git\\bin\\bash.exe",
      where: () => ["E:\\Git\\bin\\bash.exe"],
    });

    expect(result).toMatchObject({ found: false, checkedPaths: [PROGRAM_FILES_GIT_BASH] });
  });

  it("rejects traversal, aliases, and wrong executable names before probing", () => {
    expect(normalizeGitBashExecutablePath("C:\\Git\\..\\bash.exe", "win32")).toBeNull();
    expect(normalizeGitBashExecutablePath("C:\\Windows\\System32\\bash.exe", "win32")).toBeNull();
    expect(normalizeGitBashExecutablePath("C:\\WindowsApps\\bash.exe", "win32")).toBeNull();
    expect(normalizeGitBashExecutablePath("C:\\Git\\bin\\not-bash.exe", "win32")).toBeNull();
  });

  it("rejects symlink and reparse probes without resolving them", () => {
    const result = resolveGitBash({
      platform: "win32",
      env: { [GIT_BASH_ENV_KEY]: PROGRAM_FILES_GIT_BASH },
      exists: () => true,
      inspect: () => "symlink",
      where: () => [],
    });
    expect(result.found).toBe(false);

    const reparse = resolveGitBash({
      platform: "win32",
      env: { [GIT_BASH_ENV_KEY]: PROGRAM_FILES_GIT_BASH },
      exists: () => true,
      inspect: () => "reparse",
      where: () => [],
    });
    expect(reparse.found).toBe(false);
  });

  it("uses the injected current-process seams and returns not-required off Windows", () => {
    const winResult = resolveGitBashForCurrentProcess({
      platform: "win32",
      env: {},
      exists: (path) => path === PROGRAM_FILES_GIT_BASH,
      where: () => [],
    });
    expect(winResult).toMatchObject({ found: true, source: "program-files" });

    const unixResult = resolveGitBashForCurrentProcess({
      platform: "linux",
      env: {},
      exists: () => false,
      where: () => [],
    });
    expect(unixResult).toEqual({
      found: true,
      path: null,
      source: "not-required",
      checkedPaths: [],
    });
  });
});
