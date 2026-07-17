import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveGitBashForCurrentProcess } from "./git-bash-resolver";
import { runGitBashCommand } from "./runner";

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

describe("Git Bash runner", () => {
  it.skipIf(process.platform !== "win32")(
    "preserves native Windows PATH conversion for Bash",
    async () => {
      const resolution = resolveGitBashForCurrentProcess();
      if (!resolution.found || resolution.path === null) throw new Error("Git Bash not found");

      const result = await runGitBashCommand({
        bashPath: resolution.path,
        command: "printf '%s' \"$PATH\"",
        timeoutMs: 15_000,
        env: {
          ...process.env,
          PATH: String.raw`C:\Tools;D:\Programs\bin;\\server\share\tools`,
          ORIGINAL_PATH: String.raw`C:\stale`,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(";");
      expect(result.stdout).toContain("/c/Tools:/d/Programs/bin://server/share/tools");
      expect(result.stdout).not.toContain("stale");
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "#given fake bash executable #when command runs #then invokes bash with -lc and command payload",
    async () => {
      const directory = createTemporaryDirectory("holycodex-git-bash-runner-");
      const argvPath = join(directory, "argv.txt");
      const envPath = join(directory, "env.txt");
      const fakeBashPath = join(directory, "bash");
      const fakeBashScript = [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$FAKE_BASH_ARGV_PATH"',
        'printf \'%s|%s\' "${ORIGINAL_PATH-unset}" "$PORTABLE_VALUE" > "$FAKE_BASH_ENV_PATH"',
        "printf 'fake stdout\\n'",
        "printf 'fake stderr\\n' >&2",
        "exit 7",
        "",
      ].join("\n");
      writeFileSync(fakeBashPath, fakeBashScript);
      chmodSync(fakeBashPath, 0o755);

      const result = await runGitBashCommand({
        bashPath: fakeBashPath,
        command: "printf ok",
        cwd: directory,
        timeoutMs: 5000,
        env: {
          ...process.env,
          FAKE_BASH_ARGV_PATH: argvPath,
          FAKE_BASH_ENV_PATH: envPath,
          ORIGINAL_PATH: "stale",
          PORTABLE_VALUE: "kept",
        },
      });

      expect(readFileSync(argvPath, "utf8").replace(/\r\n/g, "\n")).toBe("-lc\nprintf ok\n");
      expect(readFileSync(envPath, "utf8")).toBe("unset|kept");
      expect(result).toEqual({
        exitCode: 7,
        stdout: "fake stdout\n",
        stderr: "fake stderr\n",
        timedOut: false,
      });
    },
  );
});
