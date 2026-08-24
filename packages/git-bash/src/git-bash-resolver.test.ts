// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vite-plus/test";
import {
  GIT_BASH_ENV_KEY,
  normalizeGitBashExecutablePath,
  resolveGitBash,
  resolveGitBashForCurrentProcess,
} from "./git-bash-resolver.ts";

const PROGRAM_FILES_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PROGRAM_FILES_X86_GIT_BASH = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";

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

  it("uses the configured executable before fixed installations", () => {
    const configured = "D:\\Tools\\Git\\bin\\bash.exe";
    const result = resolveGitBash({
      platform: "win32",
      env: { [GIT_BASH_ENV_KEY]: configured },
      exists: (path) => path === configured,
      where: () => [],
    });

    expect(result).toMatchObject({ found: true, path: configured, source: "env" });
  });

  it("checks Program Files before Program Files x86", () => {
    const checked: string[] = [];
    const result = resolveGitBash({
      platform: "win32",
      env: {},
      exists: (path) => {
        checked.push(path);
        return path === PROGRAM_FILES_X86_GIT_BASH;
      },
      where: () => [],
    });

    expect(result).toMatchObject({
      found: true,
      path: PROGRAM_FILES_X86_GIT_BASH,
      source: "program-files-x86",
    });
    expect(checked).toEqual([PROGRAM_FILES_GIT_BASH, PROGRAM_FILES_X86_GIT_BASH]);
  });

  it("preserves PATH candidate precedence while rejecting aliases case-insensitively", () => {
    const system32 = "c:\\WINDOWS\\System32\\BASH.EXE";
    const windowsApps = "C:/Users/dev/AppData/Local/Microsoft/WindowsApps/bash.exe";
    const gitBash = "E:\\Git\\bin\\bash.exe";
    const result = resolveGitBash({
      platform: "win32",
      env: {},
      exists: (path) => path === system32 || path === gitBash,
      where: () => [system32, windowsApps, gitBash],
    });

    expect(result).toMatchObject({ found: true, path: gitBash, source: "path" });
    expect(result.found && result.checkedPaths).toEqual([
      PROGRAM_FILES_GIT_BASH,
      PROGRAM_FILES_X86_GIT_BASH,
      system32,
      windowsApps,
      gitBash,
    ]);
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
      env: { [GIT_BASH_ENV_KEY]: "D:\\Git\\bin\\bash.exe" },
      exists: () => true,
      inspect: () => "symlink",
      where: () => [],
    });
    expect(result.found).toBe(false);

    const reparse = resolveGitBash({
      platform: "win32",
      env: { [GIT_BASH_ENV_KEY]: "D:\\Git\\bin\\bash.exe" },
      exists: () => true,
      inspect: () => "reparse",
      where: () => [],
    });
    expect(reparse.found).toBe(false);
  });

  it("uses the injected current-process seams and returns not-required off Windows", () => {
    const winResult = resolveGitBashForCurrentProcess({
      platform: "win32",
      env: { Path: "D:\\Git\\bin", PATH: "C:\\shadow" },
      exists: (path) => path === "D:\\Git\\bin\\bash.exe",
      where: () => ["D:\\Git\\bin\\bash.exe"],
    });
    expect(winResult).toMatchObject({ found: true, source: "path" });

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
