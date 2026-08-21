// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const CommandResultSchema = Schema.Struct({
  command: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  exitCode: Schema.Number.pipe(Schema.int()),
  stdout: Schema.String,
  stderr: Schema.String,
});

export type CommandResult = typeof CommandResultSchema.Type;

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;

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
  const env = options.env === undefined ? undefined : definedEnvironment(options.env);
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
  const result = await runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout)}`,
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

export function redactDiagnostics(value: string): string {
  return value
    .replaceAll(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/giu, "$1[REDACTED]@")
    .replaceAll(
      /((?:token|secret|password|api[_-]?key|authorization)[=:])[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .replaceAll(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/gu, "[REDACTED]")
    .slice(0, 4096);
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
