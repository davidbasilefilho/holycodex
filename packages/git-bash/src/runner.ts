// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { RuntimeCoreError } from "@holycodex/runtime-core";
import {
  runManagedProcess,
  type ManagedProcessRuntime,
  type ManagedProcessResult,
} from "@holycodex/runtime-core/process";
import { GitBashError } from "./errors.ts";
import {
  isRequiredGitBashExecutablePath,
  isSafeGitBashExecutablePath,
  normalizeGitBashExecutablePath,
} from "./git-bash-resolver.ts";

const DEFAULT_MAX_OUTPUT_CHARS = 256 * 1024;
const EnvironmentShapeSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const RunInputShapeSchema = Schema.Struct({
  bashPath: Schema.String.pipe(Schema.minLength(1)),
  command: Schema.String,
  timeoutMs: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  maxOutputChars: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(EnvironmentShapeSchema),
});

export type GitBashRunInput = Readonly<{
  readonly bashPath: string;
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly timeoutMs: number;
  readonly maxOutputChars?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly platform?: string | undefined;
  readonly runtime?: ManagedProcessRuntime | undefined;
  readonly isSafeExecutable?: ((path: string) => boolean) | undefined;
}>;

export type GitBashRunResult = Readonly<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly signal?: NodeJS.Signals | undefined;
  readonly aborted?: true | undefined;
  readonly outputTruncated?: true | undefined;
}>;

export type RunGitBashCommand = (input: GitBashRunInput) => Promise<GitBashRunResult>;

/** Runs one command through the verified Git Bash executable as `bash -lc`. */
export async function runGitBashCommand(input: GitBashRunInput): Promise<GitBashRunResult> {
  const platform = input.platform ?? process.platform;
  const validated = validateRunInput(input);
  const normalizedBashPath = normalizeGitBashExecutablePath(validated.bashPath, platform);
  if (normalizedBashPath === null) {
    throw new GitBashError(
      "invalid_input",
      "Git Bash executable path must be absolute, traversal-free, and name bash.",
    );
  }
  if (!isRequiredGitBashExecutablePath(normalizedBashPath, platform)) {
    throw new GitBashError(
      "invalid_input",
      "Windows Git Bash must be C:/Program Files/Git/bin/bash.exe.",
    );
  }
  const safeExecutable = validated.isSafeExecutable ?? isSafeGitBashExecutablePath;
  let executableIsSafe = false;
  try {
    executableIsSafe = safeExecutable(normalizedBashPath) === true;
  } catch (error: unknown) {
    throw new GitBashError(
      "unsafe_executable",
      "Git Bash executable safety inspection failed.",
      {},
      { cause: error },
    );
  }
  if (!executableIsSafe) {
    throw new GitBashError(
      "unsafe_executable",
      "Git Bash executable is missing, not a regular file, or is a symlink/reparse alias.",
    );
  }

  const environment = normalizeGitBashEnvironment(validated.env ?? process.env);
  let result: ManagedProcessResult;
  try {
    result = await runManagedProcess(
      {
        command: normalizedBashPath,
        args: ["-lc", validated.command],
        platform,
        timeoutMs: validated.timeoutMs,
        maxOutputChars: validated.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
        ...(validated.cwd === undefined ? {} : { cwd: validated.cwd }),
        env: environment,
        ...(validated.signal === undefined ? {} : { signal: validated.signal }),
      },
      validated.runtime,
    );
  } catch (error: unknown) {
    if (error instanceof RuntimeCoreError) {
      throw new GitBashError("invalid_input", error.message, {}, { cause: error });
    }
    throw error;
  }

  if (result.error !== undefined && !result.aborted) {
    const code = result.errorCode === "ENOENT" ? "unavailable" : "launch_failed";
    throw new GitBashError(
      code,
      `Git Bash command could not start: ${result.error}`,
      result.errorCode === undefined ? {} : { process_error_code: result.errorCode },
    );
  }
  return toRunResult(result);
}

/** Removes Windows PATH aliases and ORIGINAL_PATH before crossing into Bash. */
export function normalizeGitBashEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const decoded = Schema.decodeUnknownEither(EnvironmentShapeSchema, {
    onExcessProperty: "error",
  })(input);
  if (Either.isLeft(decoded)) {
    throw new GitBashError(
      "invalid_input",
      "Git Bash environment is invalid.",
      {},
      { cause: decoded.left },
    );
  }

  const entries = Object.entries(decoded.right);
  const exactPath = entries.find(([key, value]) => key === "PATH" && value !== undefined);
  const fallbackPath = [...entries]
    .reverse()
    .find(([key, value]) => key.toLowerCase() === "path" && value !== undefined);
  const pathEntry = exactPath ?? fallbackPath;
  const environment: NodeJS.ProcessEnv = {};

  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase();
    if (
      key.length === 0 ||
      key.includes("=") ||
      key.includes("\u0000") ||
      normalizedKey === "path" ||
      normalizedKey === "original_path" ||
      value === undefined
    ) {
      if (key.length === 0 || key.includes("=") || key.includes("\u0000")) {
        throw new GitBashError("invalid_input", "Git Bash environment keys are invalid.");
      }
      continue;
    }
    if (typeof value !== "string" || value.includes("\u0000")) {
      throw new GitBashError("invalid_input", "Git Bash environment values are invalid.");
    }
    environment[key] = value;
  }
  if (pathEntry !== undefined && typeof pathEntry[1] === "string")
    environment["PATH"] = pathEntry[1];
  return Object.freeze(environment);
}

function validateRunInput(
  input: GitBashRunInput,
): Required<Pick<GitBashRunInput, "bashPath" | "command" | "timeoutMs" | "maxOutputChars">> &
  Omit<GitBashRunInput, "bashPath" | "command" | "timeoutMs" | "maxOutputChars"> {
  const shape = {
    bashPath: input.bashPath,
    command: input.command,
    timeoutMs: input.timeoutMs,
    maxOutputChars: input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
  };
  const decoded = Schema.decodeUnknownEither(RunInputShapeSchema, {
    onExcessProperty: "error",
  })(shape);
  if (Either.isLeft(decoded)) {
    throw new GitBashError(
      "invalid_input",
      "Git Bash command input is invalid.",
      {},
      { cause: decoded.left },
    );
  }
  if (decoded.right.command.includes("\u0000")) {
    throw new GitBashError("invalid_input", "Git Bash command cannot contain NUL bytes.");
  }
  if (decoded.right.cwd !== undefined && decoded.right.cwd.length === 0) {
    throw new GitBashError("invalid_input", "Git Bash cwd must not be empty.");
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw new GitBashError("invalid_input", "Git Bash signal is not an AbortSignal.");
  }
  return {
    bashPath: decoded.right.bashPath,
    command: decoded.right.command,
    timeoutMs: decoded.right.timeoutMs,
    maxOutputChars: decoded.right.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    ...(decoded.right.cwd === undefined ? {} : { cwd: decoded.right.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.isSafeExecutable === undefined ? {} : { isSafeExecutable: input.isSafeExecutable }),
  };
}

function toRunResult(result: ManagedProcessResult): GitBashRunResult {
  return Object.freeze({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ...(result.signal === null ? {} : { signal: result.signal }),
    ...(result.aborted ? { aborted: true as const } : {}),
    ...(result.outputTruncated ? { outputTruncated: true as const } : {}),
  });
}

function isAbortSignal(value: AbortSignal): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}
