// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { type ChildProcess, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";
import { RuntimeCoreError } from "./errors.ts";

const TRUNCATED_MARKER = "\n... diagnostic output truncated ...\n";
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));

const ManagedProcessInputShapeSchema = Schema.Struct({
  command: Schema.String.pipe(Schema.minLength(1)),
  args: Schema.Array(Schema.String),
  platform: Schema.String.pipe(Schema.minLength(1)),
  timeoutMs: PositiveIntegerSchema,
  maxOutputChars: PositiveIntegerSchema,
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  stdin: Schema.optional(Schema.String),
});

export type ManagedProcessInput = Readonly<{
  readonly command: string;
  readonly args: readonly string[];
  readonly platform: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}>;

export type ManagedProcessRuntime = Readonly<{
  readonly terminationGraceMs?: number | undefined;
  readonly spawnChild?: typeof spawn | undefined;
  readonly kill?:
    | ((child: ChildProcess, platform: string, signal: NodeJS.Signals) => void)
    | undefined;
}>;

export type ManagedProcessResult = Readonly<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputTruncated: boolean;
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
}>;

type OutputState = Readonly<{
  readonly head: string;
  readonly tail: string;
  readonly truncated: boolean;
}>;

const defaultManagedProcessRuntime: ManagedProcessRuntime = Object.freeze({
  terminationGraceMs: 2_000,
  kill: killProcessTree,
});

/** Runs one bounded child process with cancellation and process-tree cleanup. */
export async function runManagedProcess(
  input: ManagedProcessInput,
  runtime: ManagedProcessRuntime = defaultManagedProcessRuntime,
): Promise<ManagedProcessResult> {
  const validated = validateInput(input);
  const terminationGraceMs = validateTerminationGrace(runtime.terminationGraceMs);
  const kill = runtime.kill ?? killProcessTree;

  if (validated.signal?.aborted) {
    return abortedResult("The managed process was aborted before spawn.", "ABORT_ERR");
  }

  let child: ChildProcess;
  try {
    child = (runtime.spawnChild ?? spawn)(validated.command, [...validated.args], {
      ...(validated.cwd === undefined ? {} : { cwd: validated.cwd }),
      ...(validated.env === undefined ? {} : { env: validated.env }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: validated.platform !== "win32",
    });
  } catch (error: unknown) {
    return processErrorResult(error);
  }

  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdin === null || childStdout === null || childStderr === null) {
    safeKill(kill, child, validated.platform, "SIGTERM");
    return processErrorResult(
      new RuntimeCoreError(
        "invalid_input",
        "Managed process did not expose piped standard streams.",
      ),
    );
  }

  let stdout: OutputState = emptyOutput();
  let stderr: OutputState = emptyOutput();
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let forceKillTimeout: NodeJS.Timeout | undefined;
  let finalResolutionTimeout: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  return await new Promise<ManagedProcessResult>((resolve) => {
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
      errorCode?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
      if (finalResolutionTimeout !== undefined) clearTimeout(finalResolutionTimeout);
      if (abortListener !== undefined && validated.signal !== undefined) {
        validated.signal.removeEventListener("abort", abortListener);
      }
      resolve({
        exitCode,
        signal,
        stdout: outputText(stdout),
        stderr: outputText(stderr),
        timedOut,
        aborted,
        outputTruncated: stdout.truncated || stderr.truncated,
        ...(error === undefined ? {} : { error }),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    };

    const terminate = (): void => {
      if (forceKillTimeout !== undefined || settled) return;
      safeKill(kill, child, validated.platform, "SIGTERM");
      if (settled) return;
      forceKillTimeout = setTimeout(() => {
        safeKill(kill, child, validated.platform, "SIGKILL");
      }, terminationGraceMs);
      unrefTimer(forceKillTimeout);
      finalResolutionTimeout = setTimeout(
        () =>
          finish(child.exitCode, child.signalCode ?? null, "Managed process did not emit close."),
        Math.max(terminationGraceMs * 2, 50),
      );
      unrefTimer(finalResolutionTimeout);
    };

    const onOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (stream === "stdout") {
        stdout = appendOutput(stdout, chunk.toString(), validated.maxOutputChars);
      } else {
        stderr = appendOutput(stderr, chunk.toString(), validated.maxOutputChars);
      }
    };

    childStdout.on("data", (chunk: Buffer | string) => onOutput("stdout", chunk));
    childStderr.on("data", (chunk: Buffer | string) => onOutput("stderr", chunk));
    child.once("error", (error: Error & { readonly code?: unknown }) => {
      finish(null, null, error.message, errorCode(error));
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code, signal);
    });

    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, validated.timeoutMs);
    unrefTimer(timeout);

    if (validated.signal !== undefined) {
      abortListener = () => {
        aborted = true;
        terminate();
      };
      validated.signal.addEventListener("abort", abortListener, { once: true });
      if (validated.signal.aborted) abortListener();
    }

    try {
      if (validated.stdin === undefined) childStdin.end();
      else childStdin.end(validated.stdin);
    } catch (error: unknown) {
      finish(null, null, errorMessage(error), errorCode(error));
    }
  });
}

/** Terminates a process tree using taskkill on Windows and a process group elsewhere. */
export function killProcessTree(
  child: ChildProcess,
  platform: string,
  signal: NodeJS.Signals = "SIGTERM",
  runTaskkill: (command: string, args: readonly string[]) => SpawnSyncReturns<Buffer> = (
    command,
    args,
  ) =>
    spawnSync(command, [...args], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 2_000,
      killSignal: "SIGKILL",
    }),
): void {
  if (platform === "win32" && child.pid !== undefined) {
    try {
      const result = runTaskkill("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
      if (result.error === undefined && result.status === 0) return;
    } catch {
      // Fall through to direct child termination when taskkill is unavailable.
    }
  }
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child termination when process-group cleanup is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited; cleanup is idempotent.
  }
}

function validateInput(input: ManagedProcessInput): ManagedProcessInput {
  const shape = {
    command: input.command,
    args: input.args,
    platform: input.platform,
    timeoutMs: input.timeoutMs,
    maxOutputChars: input.maxOutputChars,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
  };
  const decoded = Schema.decodeUnknownEither(ManagedProcessInputShapeSchema, {
    onExcessProperty: "error",
  })(shape);
  if (Either.isLeft(decoded)) {
    throw new RuntimeCoreError("invalid_input", "Invalid managed process input.", {
      cause: decoded.left,
    });
  }

  const value = decoded.right;
  if (value.maxOutputChars > MAX_OUTPUT_CHARS) {
    throw new RuntimeCoreError("invalid_input", "Managed process output limit is too large.");
  }
  if (
    value.command.includes("\u0000") ||
    value.args.some((argument) => argument.includes("\u0000"))
  ) {
    throw new RuntimeCoreError(
      "invalid_input",
      "Managed process command arguments cannot contain NUL bytes.",
    );
  }
  if (value.cwd !== undefined && !isAbsolutePath(value.cwd, value.platform)) {
    throw new RuntimeCoreError("invalid_input", "Managed process cwd must be an absolute path.");
  }
  const env = value.env === undefined ? undefined : validateEnvironment(value.env);
  if (env !== undefined && Object.values(env).some((entry) => entry?.includes("\u0000") === true)) {
    throw new RuntimeCoreError(
      "invalid_input",
      "Managed process environment values cannot contain NUL bytes.",
    );
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw new RuntimeCoreError("invalid_input", "Managed process signal is not an AbortSignal.");
  }

  return {
    command: value.command,
    args: value.args,
    platform: value.platform,
    timeoutMs: value.timeoutMs,
    maxOutputChars: value.maxOutputChars,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(env === undefined ? {} : { env }),
    ...(value.stdin === undefined ? {} : { stdin: value.stdin }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function validateEnvironment(input: Readonly<Record<string, unknown>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.length === 0 || key.includes("=") || key.includes("\u0000")) {
      throw new RuntimeCoreError("invalid_input", "Managed process environment keys are invalid.");
    }
    if (value !== undefined && typeof value !== "string") {
      throw new RuntimeCoreError(
        "invalid_input",
        "Managed process environment values must be text.",
      );
    }
    environment[key] = value;
  }
  return environment;
}

function isAbsolutePath(value: string, platform: string): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : posix.isAbsolute(value);
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

function validateTerminationGrace(value: number | undefined): number {
  if (value === undefined) return 2_000;
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new RuntimeCoreError("invalid_input", "Managed process termination grace is invalid.");
  }
  return value;
}

function processErrorResult(error: unknown): ManagedProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    error: errorMessage(error),
    ...(errorCode(error) === undefined ? {} : { errorCode: errorCode(error) }),
  };
}

function abortedResult(message: string, code: string): ManagedProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: true,
    outputTruncated: false,
    error: message,
    errorCode: code,
  };
}

function safeKill(
  kill: (child: ChildProcess, platform: string, signal: NodeJS.Signals) => void,
  child: ChildProcess,
  platform: string,
  signal: NodeJS.Signals,
): void {
  try {
    kill(child, platform, signal);
  } catch {
    // A process can exit between the graceful and forceful cleanup attempts.
  }
}

function appendOutput(state: OutputState, chunk: string, limit: number): OutputState {
  if (!state.truncated && state.head.length + chunk.length <= limit) {
    return { head: state.head + chunk, tail: "", truncated: false };
  }
  const headLimit = Math.ceil(limit / 2);
  const tailLimit = Math.floor(limit / 2);
  const combined = state.truncated ? state.tail + chunk : state.head + chunk;
  return {
    head: state.truncated ? state.head : combined.slice(0, headLimit),
    tail: combined.slice(-tailLimit),
    truncated: true,
  };
}

function emptyOutput(): OutputState {
  return { head: "", tail: "", truncated: false };
}

function outputText(state: OutputState): string {
  return state.truncated ? `${state.head}${TRUNCATED_MARKER}${state.tail}` : state.head;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function unrefTimer(timer: NodeJS.Timeout): void {
  timer.unref();
}
