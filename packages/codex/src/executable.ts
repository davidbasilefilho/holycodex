// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import * as Schema from "effect/Schema";
import {
  canonicalJsonUtf8,
  createSha256Digest,
  domainSeparatedSha256,
  type Sha256Digest,
} from "@holycodex/core";
import { CODEX_PROTOCOL_EPOCH, checked, CodexError, sanitizeText } from "./common";
import {
  allowlistedEnvironment,
  decodeUtf8,
  readBoundedStream,
  sanitizeDiagnostic,
} from "./transport";

const EXTERNAL_COMMAND_TIMEOUT_MS = 30_000;

export interface CodexExecutableIdentity {
  readonly path: string;
  readonly version: string;
  readonly sha256: Sha256Digest;
}

export interface CodexExecutableDiscoveryOptions {
  readonly executablePath?: string;
  readonly pathValue?: string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly versionRunner?: (
    path: string,
    environment: Readonly<Record<string, string>>,
  ) => Promise<string>;
}

async function resolveExecutablePath(options: CodexExecutableDiscoveryOptions): Promise<string> {
  const candidates: string[] = [];
  if (options.executablePath !== undefined) {
    candidates.push(resolve(options.cwd ?? process.cwd(), options.executablePath));
  } else {
    const pathValue = options.pathValue ?? process.env["PATH"] ?? "";
    const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
    for (const entry of pathValue.split(delimiter).filter((item) => item.length > 0)) {
      for (const name of names) {
        candidates.push(resolve(entry, name));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isFile()) {
        continue;
      }
      if (process.platform !== "win32" && (candidateStat.mode & 0o111) === 0) {
        continue;
      }
      return await realpath(candidate);
    } catch {
      if (options.executablePath !== undefined) {
        throw new CodexError("discovery_failed", "The explicit Codex executable was not found.", {
          path: candidate,
        });
      }
    }
  }
  throw new CodexError(
    "discovery_failed",
    "No Codex executable was found on the allowlisted PATH.",
  );
}

async function runVersionCommand(
  executablePath: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const child = Bun.spawn([executablePath, "--version"], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    throw new CodexError(
      "discovery_failed",
      "The Codex version command did not expose output pipes.",
    );
  }
  try {
    const [stdout, stderr, exitCode] = await waitForChild(
      Promise.all([
        readBoundedStream(child.stdout, 16 * 1024),
        readBoundedStream(child.stderr, 16 * 1024),
        child.exited,
      ]),
      () => child.kill(),
      "The Codex version command timed out.",
    );
    const output = sanitizeText(decodeUtf8(stdout, "Codex version output"));
    if (exitCode !== 0 || output.length === 0) {
      const diagnostics = sanitizeDiagnostic(decodeUtf8(stderr, "Codex version diagnostics"));
      throw new CodexError("discovery_failed", "The Codex executable did not provide a version.", {
        exitCode,
        diagnostics,
      });
    }
    return output;
  } catch (error: unknown) {
    try {
      child.kill();
    } catch {
      // The child may already have exited.
    }
    if (error instanceof CodexError) {
      throw error;
    }
    throw new CodexError(
      "discovery_failed",
      "The Codex version command failed.",
      {},
      { cause: error },
    );
  }
}

async function digestFile(path: string): Promise<Sha256Digest> {
  const bytes = await readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const validated = createSha256Digest(hex);
  if (!validated.ok) {
    throw new CodexError("discovery_failed", "The Codex executable digest was invalid.");
  }
  return validated.value;
}

export async function discoverCodexExecutable(
  options: CodexExecutableDiscoveryOptions = {},
): Promise<CodexExecutableIdentity> {
  const path = await resolveExecutablePath(options);
  const environment = allowlistedEnvironment(options.environment);
  const version = options.versionRunner
    ? sanitizeText(await options.versionRunner(path, environment))
    : await runVersionCommand(path, environment);
  if (version.length === 0) {
    throw new CodexError("discovery_failed", "The Codex version output was empty.");
  }
  return { path, version, sha256: await digestFile(path) };
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const CommandResultSchema = Schema.Struct({
  exitCode: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value))),
  stdout: Schema.String.pipe(Schema.maxLength(1024 * 1024)),
  stderr: Schema.String.pipe(Schema.maxLength(1024 * 1024)),
});

export interface SchemaOutputProvenance {
  readonly path: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
}

export type CommandRunner = (
  executablePath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

async function runCommand(
  executablePath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const child = Bun.spawn([executablePath, ...args], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    throw new CodexError("transport_failure", "The Codex command did not expose output pipes.");
  }
  try {
    const [stdout, stderr, exitCode] = await waitForChild(
      Promise.all([
        readBoundedStream(child.stdout, 1024 * 1024),
        readBoundedStream(child.stderr, 1024 * 1024),
        child.exited,
      ]),
      () => child.kill(),
      "The Codex command timed out.",
    );
    return {
      exitCode,
      stdout: sanitizeText(decodeUtf8(stdout, "Codex command output"), 4096),
      stderr: sanitizeDiagnostic(decodeUtf8(stderr, "Codex command diagnostics")),
    };
  } catch (error: unknown) {
    try {
      child.kill();
    } catch {
      // The subprocess may already have exited.
    }
    if (error instanceof CodexError) {
      throw error;
    }
    throw new CodexError("transport_failure", "The Codex command failed.", {}, { cause: error });
  }
}

async function waitForChild<T>(
  operation: Promise<T>,
  kill: () => void,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try {
            kill();
          } catch {
            // The subprocess may already have exited.
          }
          reject(new CodexError("timeout", timeoutMessage));
        }, EXTERNAL_COMMAND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface SchemaGenerationOptions {
  readonly executable: CodexExecutableIdentity;
  readonly outputDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly commandRunner?: CommandRunner;
}

export interface SchemaGenerationProvenance {
  readonly executable: CodexExecutableIdentity;
  readonly protocol_epoch: typeof CODEX_PROTOCOL_EPOCH;
  readonly outputDirectory: string;
  readonly commands: readonly (readonly string[])[];
  readonly output_digest: Sha256Digest;
  readonly outputs: readonly SchemaOutputProvenance[];
}

export async function generateCodexSchemas(
  options: SchemaGenerationOptions,
): Promise<SchemaGenerationProvenance> {
  if (options.outputDirectory.length === 0 || !isAbsolute(options.outputDirectory)) {
    throw new CodexError(
      "empty_output_directory",
      "Schema generation requires an explicit absolute output directory.",
    );
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const outputStat = await lstat(options.outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new CodexError("empty_output_directory", "Schema output must be a real directory.");
  }
  if ((await readdir(options.outputDirectory)).length !== 0) {
    throw new CodexError(
      "empty_output_directory",
      "Schema generation requires an empty output directory.",
    );
  }
  const outputDirectory = await realpath(options.outputDirectory);
  await assertExecutableStable(options.executable);
  const environment = allowlistedEnvironment(options.environment);
  const runner = options.commandRunner ?? runCommand;
  const commands = [["app-server", "generate-ts", "--out", outputDirectory] as const] as const;
  for (const args of commands) {
    await assertExecutableStable(options.executable);
    const result = await runner(options.executable.path, args, environment);
    const parsedResult = checked(CommandResultSchema, result, "Codex schema generation result");
    if (parsedResult.exitCode !== 0) {
      throw new CodexError("transport_failure", `Codex schema generation failed for ${args[1]}.`, {
        exitCode: parsedResult.exitCode,
        diagnostics: sanitizeDiagnostic(parsedResult.stderr),
      });
    }
  }
  await assertExecutableStable(options.executable);
  const outputs = await collectSchemaOutputs(outputDirectory);
  if (outputs.length === 0) {
    throw new CodexError("empty_output_directory", "Schema generation produced no files.");
  }
  const outputDigest = await domainSeparatedSha256("codex-schema-output", [
    canonicalJsonUtf8(outputs),
  ]);
  return {
    executable: options.executable,
    protocol_epoch: CODEX_PROTOCOL_EPOCH,
    outputDirectory,
    commands,
    output_digest: outputDigest,
    outputs,
  };
}

async function assertExecutableStable(executable: CodexExecutableIdentity): Promise<void> {
  const observedDigest = await digestFile(executable.path);
  if (observedDigest !== executable.sha256) {
    throw new CodexError(
      "discovery_failed",
      "The Codex executable changed during schema generation.",
    );
  }
}

async function collectSchemaOutputs(root: string): Promise<readonly SchemaOutputProvenance[]> {
  const outputs: SchemaOutputProvenance[] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new CodexError("transport_failure", "Schema generation produced a symlink.");
      }
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 4 * 1024 * 1024) {
        throw new CodexError("transport_failure", "Schema generation produced an invalid file.");
      }
      total += metadata.size;
      if (total > 16 * 1024 * 1024) {
        throw new CodexError(
          "transport_failure",
          "Schema generation output exceeds its size bound.",
        );
      }
      outputs.push({
        path: relative(root, absolute).split("\\").join("/"),
        size: metadata.size,
        sha256: await digestFile(absolute),
      });
    }
  };
  await visit(root);
  return outputs.sort((left, right) => left.path.localeCompare(right.path));
}
