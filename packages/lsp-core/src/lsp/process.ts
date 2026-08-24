// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type Readable, type Writable } from "node:stream";

import { LspInvalidPathError, LspProcessSpawnError } from "./errors.ts";

export interface GitBashResolution {
  readonly found: boolean;
  readonly path?: string | null;
  readonly source?: string;
  readonly checkedPaths?: readonly string[];
  readonly installHint?: string;
}

export interface SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface PreparedSpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false;
}

/** Validates an LSP workspace directory before a child process is started. */
export function validateCwd(cwd: string): { readonly valid: boolean; readonly error?: string } {
  try {
    if (!existsSync(cwd))
      return { valid: false, error: `Working directory does not exist: ${cwd}` };
    if (!statSync(cwd).isDirectory())
      return { valid: false, error: `Path is not a directory: ${cwd}` };
    return { valid: true };
  } catch (error: unknown) {
    return {
      valid: false,
      error: `Cannot access working directory: ${cwd} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function windowsPathExtensions(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const raw = environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD;.PS1";
  return [...new Set(["", ...raw.split(";").filter(Boolean), ".exe", ".cmd", ".bat", ".ps1"])].map(
    (value) => (value === "" || value.startsWith(".") ? value : `.${value}`),
  );
}

function resolveWindowsCommand(
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const explicit = command.includes("/") || command.includes("\\");
  const directories = explicit
    ? [""]
    : (environment["PATH"] ?? environment["Path"] ?? "").split(";").filter(Boolean);
  for (const directory of directories) {
    for (const suffix of windowsPathExtensions(environment)) {
      const candidate =
        directory === "" ? `${command}${suffix}` : join(directory, `${command}${suffix}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* try next candidate */
      }
    }
  }
  return command;
}

/** Creates a portable, shell-free spawn command, including Windows shim handling. */
export function createSpawnCommand(
  command: readonly string[],
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  gitBash: GitBashResolution = { found: false, checkedPaths: [], installHint: "Install Git Bash." },
): PreparedSpawnCommand {
  const executable = command[0];
  if (!executable) throw new LspProcessSpawnError("[lsp] empty command");
  if (platform !== "win32") return { command: executable, args: command.slice(1), shell: false };
  const resolved = resolveWindowsCommand(executable, environment);
  const shim = /\.(?:cmd|bat)$/iu.test(resolved);
  if (!shim) return { command: resolved, args: command.slice(1), shell: false };
  if (!gitBash.found || gitBash.path === null || gitBash.path === undefined) {
    throw new LspProcessSpawnError(
      "[lsp] Git Bash is required to launch Windows command shims. Install Git for Windows or set HOLYCODEX_GIT_BASH_PATH.",
    );
  }
  return {
    command: gitBash.path,
    args: ["-lc", 'exec "$@"', "holycodex-lsp", resolved, ...command.slice(1)],
    shell: false,
  };
}

function wrap(child: ChildProcess): SpawnedProcess {
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new LspProcessSpawnError("Spawned process is missing one of stdin/stdout/stderr pipes");
  }
  const exited = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 0));
    child.once("error", () => resolve(1));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    get pid() {
      return child.pid ?? undefined;
    },
    get exitCode() {
      return child.exitCode;
    },
    get killed() {
      return child.killed;
    },
    exited,
    kill(signal = "SIGTERM") {
      child.kill(signal);
    },
  };
}

/** Starts an LSP process with no shell interpolation and a validated workspace root. */
export function spawnProcess(command: readonly string[], options: SpawnOptions): SpawnedProcess {
  const cwd = validateCwd(options.cwd);
  if (!cwd.valid) throw new LspInvalidPathError(`[lsp] ${cwd.error}`);
  const prepared = createSpawnCommand(command, process.platform, options.env);
  return wrap(
    spawn(prepared.command, [...prepared.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: prepared.shell,
      detached: process.platform !== "win32",
    }),
  );
}

/** Resolves an executable using the same platform rules as process spawning. */
export function splitExecutablePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return value.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
}
