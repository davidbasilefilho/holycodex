// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const CommandResultSchema = Schema.Struct({
  command: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  exitCode: Schema.Number.check(Schema.isInt()),
  stdout: Schema.String,
  stderr: Schema.String,
});
const CommandSchema = Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
  Schema.isMinLength(1),
);
const EnvironmentKeySchema = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u));
const TemporaryDirectoryPrefixSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,48}$/u),
);
const OutputLimitSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.makeFilter(Number.isSafeInteger),
);

/** Captured output and exit status from a completed subprocess. */
export type CommandResult = typeof CommandResultSchema.Type;

/** Controls whether a failed subprocess exposes bounded or complete redacted diagnostics. */
export type FailureDiagnosticMode = "compact" | "full";

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DIAGNOSTIC_LIMIT = 4096;
const DIAGNOSTIC_ELLIPSIS = "\n...[diagnostic truncated]...\n";

/**
 * Environment names that are safe and useful for ordinary local tooling.
 *
 * Callers must opt in to any additional name (for example GH_TOKEN for a read-only GitHub lookup).
 * In particular, this is intentionally not a copy of process.env: credentials and local
 * configuration must not flow into package/build/release subprocesses by accident.
 */
export const DEFAULT_COMMAND_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "BUN_INSTALL",
  "BUN_TMPDIR",
  "MISE_DATA_DIR",
  "MISE_CACHE_DIR",
  "MSYS_NO_PATHCONV",
  "GITHUB_ACTIONS",
  "GITHUB_API_URL",
  "GITHUB_GRAPHQL_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REF_TYPE",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_RUN_ATTEMPT",
  "RUNNER_TEMP",
  "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_NOSYSTEM",
] as const;

const SENSITIVE_ENVIRONMENT_KEY_PATTERN =
  /(?:^|_)(?:ACCESS[_-]?KEY|API[_-]?KEY|AUTH(?:ORIZATION)?|CERT(?:IFICATE)?|COOKIE|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:$|_)/iu;

/** Return whether an environment key conventionally carries sensitive data. */
export function isSensitiveEnvironmentKey(key: string): boolean {
  return SENSITIVE_ENVIRONMENT_KEY_PATTERN.test(key);
}

/**
 * Select only the environment names needed by one operation.
 *
 * Overrides are explicit operation inputs and may include a credential when the native command
 * genuinely requires one. Such values are still passed to the central diagnostic redactor by
 * runChecked.
 */
export function allowlistedEnvironment(
  keys: readonly string[],
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [...keys, ...Object.keys(overrides)]) {
    Schema.decodeUnknownSync(EnvironmentKeySchema)(key);
  }
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    } else {
      delete result[key];
    }
  }
  return result;
}

/** Run a subprocess with bounded output and an allowlisted environment. */
export async function runCommand(
  command: readonly string[],
  options: Readonly<{
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxOutputBytes?: number;
  }> = {},
): Promise<CommandResult> {
  return await Effect.runPromise(runCommandEffect(command, options));
}

/** Run a subprocess inside an Effect workflow without crossing the Promise adapter. */
export function runCommandEffect(
  command: readonly string[],
  options: Readonly<{
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxOutputBytes?: number;
  }> = {},
): Effect.Effect<CommandResult, unknown> {
  return Effect.gen(function* () {
    const validatedCommand = Schema.decodeUnknownSync(CommandSchema)(command);
    const env =
      options.env === undefined
        ? allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS)
        : definedEnvironment(options.env);
    const child = yield* Effect.try({
      try: () =>
        Bun.spawn([...validatedCommand], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(env === undefined ? {} : { env }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (error) => error,
    });
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      return yield* Effect.fail(new Error("The subprocess did not expose bounded output streams."));
    }
    const maxOutputBytes = Schema.decodeUnknownSync(OutputLimitSchema)(
      options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT,
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        readStreamEffect(child.stdout, maxOutputBytes),
        readStreamEffect(child.stderr, maxOutputBytes),
        Effect.tryPromise({
          try: () => child.exited,
          catch: (error) => error,
        }),
      ],
      { concurrency: 3 },
    );
    const candidate = { command: [...validatedCommand], exitCode, stdout, stderr };
    const parsed = Schema.decodeUnknownResult(CommandResultSchema, {
      onExcessProperty: "error",
    })(candidate);
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(
        new Error(`The subprocess result failed validation: ${String(parsed.failure)}`),
      );
    }
    return parsed.success;
  });
}

/** Run a subprocess and throw a redacted error when it exits unsuccessfully. */
export async function runChecked(
  command: readonly string[],
  options: Readonly<{
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxOutputBytes?: number;
    readonly failureDiagnostics?: FailureDiagnosticMode;
  }> = {},
): Promise<CommandResult> {
  return await Effect.runPromise(runCheckedEffect(command, options));
}

/** Run a checked subprocess inside an Effect workflow. */
export function runCheckedEffect(
  command: readonly string[],
  options: Readonly<{
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxOutputBytes?: number;
    readonly failureDiagnostics?: FailureDiagnosticMode;
  }> = {},
): Effect.Effect<CommandResult, unknown> {
  return Effect.gen(function* () {
    const environment =
      options.env === undefined
        ? allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS)
        : definedEnvironment(options.env);
    const result = yield* runCommandEffect(command, { ...options, env: environment });
    if (result.exitCode !== 0) {
      if (options.failureDiagnostics === "full") {
        const diagnostic = redactUnboundedDiagnostics(formatCommandOutput(result), environment);
        if (diagnostic.length > 0) {
          yield* Effect.sync(() =>
            console.error(`[holycodex] full subprocess diagnostics:\n${diagnostic}`),
          );
        }
      }
      return yield* Effect.fail(
        new Error(
          `${redactDiagnostics(command.join(" "), environment)} failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
        ),
      );
    }
    return result;
  });
}

/** Run an operation inside a temporary directory and remove it afterward. */
export async function withTemporaryDirectory<T>(
  prefix: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  return await Effect.runPromise(
    withTemporaryDirectoryEffect(prefix, (directory) =>
      Effect.tryPromise({
        try: () => operation(directory),
        catch: (error) => error,
      }),
    ),
  );
}

/** Run an Effect workflow in a temporary directory and remove it afterward. */
export function withTemporaryDirectoryEffect<T, E>(
  prefix: string,
  operation: (directory: string) => Effect.Effect<T, E>,
): Effect.Effect<T, unknown> {
  Schema.decodeUnknownSync(TemporaryDirectoryPrefixSchema)(prefix);
  return Effect.gen(function* () {
    const directory = assertTemporaryPath(
      yield* Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), `${prefix}-`)),
        catch: (error) => error,
      }),
      "temporary directory",
    );
    return yield* operation(directory).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () =>
            rm(assertTemporaryPath(directory, "temporary directory"), {
              recursive: true,
              force: true,
            }),
          catch: (error) => error,
        }).pipe(Effect.orDie),
      ),
    );
  });
}

/** Assert that a path remains below the system temporary directory. */
export function assertTemporaryPath(path: string, label: string): string {
  const resolved = resolve(path);
  const root = resolve(tmpdir());
  const relativePath = relative(root, resolved);
  const pathSchema = Schema.String.check(
    Schema.makeFilter(
      () =>
        resolved !== root &&
        relativePath !== "" &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${sep}`),
      { message: `${label} must remain below the system temporary directory.` },
    ),
  );
  return Schema.decodeUnknownSync(pathSchema)(resolved);
}

/** Write one JSON value with a terminal newline and restrictive file mode. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 }),
      catch: (error) => error,
    }),
  );
}

/** Redact sensitive values from diagnostics and bound the resulting text. */
export function redactDiagnostics(
  value: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return boundDiagnostic(redactUnboundedDiagnostics(value, environment));
}

function redactUnboundedDiagnostics(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let redacted = value;
  const sensitiveValues = Object.entries(environment)
    .filter(
      (entry): entry is [string, string] =>
        isSensitiveEnvironmentKey(entry[0]) && entry[1] !== undefined && entry[1].length >= 4,
    )
    .map(([, candidate]) => candidate)
    .sort((left, right) => right.length - left.length);
  for (const secret of sensitiveValues) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  redacted = redacted
    .replaceAll(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/giu, "$1[REDACTED]@")
    .replaceAll(
      /((?:[A-Za-z][A-Za-z0-9_-]*_)?(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key)(?:[A-Za-z0-9_-]*)[\s]*[=:][\s]*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replaceAll(
      /((?:--?)(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
      "$1[REDACTED]",
    )
    .replaceAll(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/gu, "[REDACTED]");
  return redacted;
}

function formatCommandOutput(result: CommandResult): string {
  if (result.stdout.length === 0) return result.stderr;
  if (result.stderr.length === 0) return result.stdout;
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

/** Keeps both the command failure header and terminal diagnostics observable within the bound. */
function boundDiagnostic(value: string): string {
  if (value.length <= DIAGNOSTIC_LIMIT) return value;
  const available = DIAGNOSTIC_LIMIT - DIAGNOSTIC_ELLIPSIS.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  let safeHeadLength = headLength;
  let safeTailStart = value.length - tailLength;
  if (isSurrogatePair(value, safeHeadLength - 1)) {
    safeHeadLength -= 1;
  }
  if (isSurrogatePair(value, safeTailStart - 1)) {
    safeTailStart -= 1;
  }
  return `${value.slice(0, safeHeadLength)}${DIAGNOSTIC_ELLIPSIS}${value.slice(safeTailStart)}`;
}

function isSurrogatePair(value: string, highIndex: number): boolean {
  return (
    highIndex >= 0 &&
    highIndex + 1 < value.length &&
    value.charCodeAt(highIndex) >= 0xd800 &&
    value.charCodeAt(highIndex) <= 0xdbff &&
    value.charCodeAt(highIndex + 1) >= 0xdc00 &&
    value.charCodeAt(highIndex + 1) <= 0xdfff
  );
}

function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    Schema.decodeUnknownSync(EnvironmentKeySchema)(key);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function readStreamEffect(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Effect.Effect<string, unknown> {
  Schema.decodeUnknownSync(OutputLimitSchema)(limit);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const read = Effect.gen(function* () {
    while (true) {
      const next = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (error) => error,
      });
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > limit) {
        return yield* Effect.fail(
          new Error("Subprocess output exceeded its bounded diagnostic limit."),
        );
      }
      chunks.push(next.value);
    }
  });
  return read.pipe(
    Effect.map(() => {
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }),
    Effect.ensuring(Effect.sync(() => reader.releaseLock())),
  );
}
