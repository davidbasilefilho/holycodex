// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GitBashError } from "./errors.ts";
import { GIT_BASH_EXECUTABLE_PATH } from "./git-bash-resolver.ts";
import { normalizeGitBashEnvironment, runGitBashCommand } from "./runner.ts";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Git Bash environment", () => {
  it("uses exact PATH precedence, Path fallback, and removes ORIGINAL_PATH", () => {
    const exact = normalizeGitBashEnvironment({
      PATH: "exact-path",
      Path: "fallback-path",
      ORIGINAL_PATH: "stale",
      portable: "kept",
    });
    expect(exact).toEqual({ PATH: "exact-path", portable: "kept" });

    const fallback = normalizeGitBashEnvironment({
      Path: "fallback-path",
      ORIGINAL_PATH: "stale",
      portable: "kept",
    });
    expect(fallback).toEqual({ PATH: "fallback-path", portable: "kept" });
  });
});

describe("Git Bash runner", () => {
  it("rejects alternate Windows Bash executables", async () => {
    await expect(
      runGitBashCommand({
        bashPath: "D:\\Git\\bin\\bash.exe",
        command: "true",
        timeoutMs: 1_000,
        platform: "win32",
        isSafeExecutable: () => true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it.skipIf(process.platform === "win32")(
    "invokes bash -lc with cwd, env, stderr, and exit code",
    async () => {
      const directory = createTemporaryDirectory("holycodex-git-bash-runner-");
      const argvPath = join(directory, "argv.txt");
      const envPath = join(directory, "env.txt");
      const cwdPath = join(directory, "cwd.txt");
      const fakeBashPath = join(directory, "bash");
      writeFileSync(
        fakeBashPath,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$@" > "$FAKE_BASH_ARGV_PATH"',
          'printf "%s|%s|%s|%s" "${ORIGINAL_PATH-unset}" "$PORTABLE_VALUE" "${Path-unset}" "${PATH-unset}" > "$FAKE_BASH_ENV_PATH"',
          'printf "%s" "$PWD" > "$FAKE_BASH_CWD_PATH"',
          'exec /bin/sh -c "$2"',
          "",
        ].join("\n"),
      );
      chmodSync(fakeBashPath, 0o755);

      const result = await runGitBashCommand({
        bashPath: fakeBashPath,
        command: "printf 'fake stdout'; printf 'fake stderr' >&2; exit 7",
        cwd: directory,
        timeoutMs: 5_000,
        env: {
          FAKE_BASH_ARGV_PATH: argvPath,
          FAKE_BASH_ENV_PATH: envPath,
          FAKE_BASH_CWD_PATH: cwdPath,
          ORIGINAL_PATH: "stale",
          PATH: "portable-path",
          Path: "shadow-path",
          PORTABLE_VALUE: "kept",
        },
      });

      expect(readFileSync(argvPath, "utf8").replace(/\r\n/g, "\n")).toBe(
        "-lc\nprintf 'fake stdout'; printf 'fake stderr' >&2; exit 7\n",
      );
      expect(readFileSync(envPath, "utf8")).toBe("unset|kept|unset|portable-path");
      expect(readFileSync(cwdPath, "utf8")).toBe(directory);
      expect(result).toEqual({
        exitCode: 7,
        stdout: "fake stdout",
        stderr: "fake stderr",
        timedOut: false,
      });
    },
  );

  it.skipIf(process.platform === "win32")("bounds output and reports a timeout", async () => {
    const directory = createTemporaryDirectory("holycodex-git-bash-limit-");
    const fakeBashPath = join(directory, "bash");
    writeFileSync(fakeBashPath, '#!/bin/sh\nexec /bin/sh -c "$2"\n');
    chmodSync(fakeBashPath, 0o755);

    const output = await runGitBashCommand({
      bashPath: fakeBashPath,
      command: "printf 'START'; printf '%04096d' 0; printf 'END'",
      timeoutMs: 5_000,
      maxOutputChars: 128,
    });
    expect(output.outputTruncated).toBe(true);
    expect(output.stdout).toContain("START");
    expect(output.stdout).toContain("END");

    const timedOut = await runGitBashCommand({
      bashPath: fakeBashPath,
      command: "sleep 10",
      timeoutMs: 30,
    });
    expect(timedOut.timedOut).toBe(true);

    const controller = new AbortController();
    const abortedPromise = runGitBashCommand({
      bashPath: fakeBashPath,
      command: "sleep 10",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30).unref();
    await expect(abortedPromise).resolves.toMatchObject({ aborted: true, timedOut: false });
  });

  it("fails with a typed error for an unsafe executable", async () => {
    const directory = createTemporaryDirectory("holycodex-git-bash-invalid-");
    await expect(
      runGitBashCommand({
        bashPath: join(directory, process.platform === "win32" ? "bash.exe" : "bash"),
        command: "true",
        timeoutMs: 1_000,
        isSafeExecutable: () => false,
      }),
    ).rejects.toBeInstanceOf(GitBashError);
  });

  it("fails with a typed unavailable result when launch cannot find the executable", async () => {
    await expect(
      runGitBashCommand({
        bashPath: GIT_BASH_EXECUTABLE_PATH,
        command: "true",
        timeoutMs: 1_000,
        platform: "win32",
        isSafeExecutable: () => true,
        runtime: {
          spawnChild: () => {
            const error = new Error("spawn ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          },
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
