import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { killProcessTree } from "@holycodex/mcp-stdio-core/process";

import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../../../git-bash-mcp/src/git-bash-resolver.js";
import { LspInvalidPathError, LspProcessSpawnError } from "./errors.js";

export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid: number | undefined;
  exitCode: number | null;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
  killed: boolean;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface PreparedSpawnCommand {
  command: string;
  args: string[];
  shell: false;
}

/** Validates working directory. */
export function validateCwd(cwd: string): { valid: boolean; error?: string } {
  try {
    if (!existsSync(cwd)) {
      return { valid: false, error: `Working directory does not exist: ${cwd}` };
    }
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      return { valid: false, error: `Path is not a directory: ${cwd}` };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Cannot access working directory: ${cwd} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

function wrap(proc: ChildProcess): SpawnedProcess {
  const exitedPromise = new Promise<number>((resolve) => {
    proc.once("close", (code) => resolve(code ?? 0));
    proc.once("error", () => resolve(1));
  });

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new LspProcessSpawnError("Spawned process is missing one of stdin/stdout/stderr pipes");
  }

  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    get pid() {
      return proc.pid ?? undefined;
    },
    get exitCode() {
      return proc.exitCode;
    },
    get killed() {
      return proc.killed;
    },
    exited: exitedPromise,
    kill(signal?: NodeJS.Signals) {
      killProcessTree(proc, process.platform, signal ?? "SIGTERM");
    },
  };
}

function isWindowsShellShim(command: string): boolean {
  const lowerCommand = command.toLowerCase();
  return lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
}

function splitPath(pathValue: string, platform: NodeJS.Platform): string[] {
  const separator = platform === "win32" ? ";" : delimiter;
  return pathValue.split(separator).filter(Boolean);
}

function getWindowsPathExtensions(env: Record<string, string | undefined>): string[] {
  const rawExtensions = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = rawExtensions
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
  return [...new Set([...extensions, ".exe", ".cmd", ".bat", ""])];
}

function resolveWindowsCommand(command: string, env: Record<string, string | undefined>): string {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const baseDirectories = hasPathSeparator ? [""] : splitPath(pathValue, "win32");
  const extensions = getWindowsPathExtensions(env);

  for (const baseDirectory of baseDirectories) {
    for (const extension of extensions) {
      const candidate = baseDirectory
        ? join(baseDirectory, `${command}${extension}`)
        : `${command}${extension}`;
      if (existsSync(candidate)) return candidate;
    }
  }

  return command;
}

/** Creates spawn command. */
export function createSpawnCommand(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  gitBash: GitBashResolution = resolveGitBashForCurrentProcess({ platform, env }),
): PreparedSpawnCommand {
  const [cmd, ...args] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }

  if (platform !== "win32") {
    return { command: cmd, args, shell: false };
  }

  const resolvedCommand = resolveWindowsCommand(cmd, env);
  if (!isWindowsShellShim(resolvedCommand)) {
    return { command: resolvedCommand, args, shell: false };
  }

  if (!gitBash.found || gitBash.path === null)
    throw new LspProcessSpawnError(
      "[lsp] Git Bash is required to launch Windows command shims. Install Git for Windows or set HOLYCODEX_GIT_BASH_PATH.",
    );
  return {
    command: gitBash.path,
    args: ["-lc", 'exec "$@"', "holycodex-lsp", resolvedCommand, ...args],
    shell: false,
  };
}

/** Spawns process. */
export function spawnProcess(command: string[], options: SpawnOptions): SpawnedProcess {
  const cwdValidation = validateCwd(options.cwd);
  if (!cwdValidation.valid) {
    throw new LspInvalidPathError(`[lsp] ${cwdValidation.error}`);
  }

  const [cmd] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }

  const preparedCommand = createSpawnCommand(command, process.platform, options.env);
  const proc = spawn(preparedCommand.command, preparedCommand.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: preparedCommand.shell,
    detached: process.platform !== "win32",
  });

  return wrap(proc);
}
