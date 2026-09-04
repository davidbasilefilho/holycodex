// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

const CommandResultSchema = Schema.Struct({
  command: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  exitCode: Schema.Number.pipe(Schema.int()),
  stdout: Schema.String,
  stderr: Schema.String,
});

export type CommandResult = typeof CommandResultSchema.Type;

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

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SENSITIVE_ENVIRONMENT_KEY_PATTERN =
  /(?:^|_)(?:ACCESS[_-]?KEY|API[_-]?KEY|AUTH(?:ORIZATION)?|CERT(?:IFICATE)?|COOKIE|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:$|_)/iu;

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
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid subprocess environment key: ${key}`);
    }
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

export async function runCommand(
  command: readonly string[],
  options: Readonly<{
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxOutputBytes?: number;
  }> = {},
): Promise<CommandResult> {
  if (command.length === 0 || command.some((part) => part.length === 0)) {
    throw new Error("A subprocess command must contain non-empty arguments.");
  }
  const env =
    options.env === undefined
      ? allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS)
      : definedEnvironment(options.env);
  const child = Bun.spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(env === undefined ? {} : { env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    throw new Error("The subprocess did not expose bounded output streams.");
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout, maxOutputBytes),
    readStream(child.stderr, maxOutputBytes),
    child.exited,
  ]);
  const candidate = { command: [...command], exitCode, stdout, stderr };
  const parsed = Schema.decodeUnknownEither(CommandResultSchema, {
    onExcessProperty: "error",
  })(candidate);
  if (Either.isLeft(parsed)) {
    throw new Error(`The subprocess result failed validation: ${String(parsed.left)}`);
  }
  return parsed.right;
}

export async function runChecked(
  command: readonly string[],
  options: Readonly<{
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly maxOutputBytes?: number;
  }> = {},
): Promise<CommandResult> {
  const environment =
    options.env === undefined
      ? allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS)
      : definedEnvironment(options.env);
  const result = await runCommand(command, { ...options, env: environment });
  if (result.exitCode !== 0) {
    throw new Error(
      `${redactDiagnostics(command.join(" "), environment)} failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
    );
  }
  return result;
}

export async function withTemporaryDirectory<T>(
  prefix: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/u.test(prefix)) {
    throw new Error("Temporary directory prefixes must be short, lowercase identifiers.");
  }
  const directory = assertTemporaryPath(
    await mkdtemp(join(tmpdir(), `${prefix}-`)),
    "temporary directory",
  );
  try {
    return await operation(directory);
  } finally {
    await rm(assertTemporaryPath(directory, "temporary directory"), {
      recursive: true,
      force: true,
    });
  }
}

export function assertTemporaryPath(path: string, label: string): string {
  const resolved = resolve(path);
  const root = resolve(tmpdir());
  const relativePath = relative(root, resolved);
  if (
    resolved === root ||
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} must remain below the system temporary directory.`);
  }
  return resolved;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function redactDiagnostics(
  value: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
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
  return boundDiagnostic(redacted);
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
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function readStream(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Subprocess output limits must be positive safe integers.");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > limit) {
        throw new Error("Subprocess output exceeded its bounded diagnostic limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
