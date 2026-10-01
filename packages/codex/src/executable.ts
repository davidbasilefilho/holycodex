// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import {
  canonicalJsonUtf8,
  createSha256Digest,
  domainSeparatedSha256,
  type Sha256Digest,
} from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CODEX_PROTOCOL_EPOCH, checked, CodexError, sanitizeText } from "./common";
import {
  allowlistedEnvironment,
  decodeUtf8,
  readBoundedStream,
  sanitizeDiagnostic,
} from "./transport";

const EXTERNAL_COMMAND_TIMEOUT_MS = 30_000;

/** Data contract for codex executable identity. */
export interface CodexExecutableIdentity {
  /** Filesystem path associated with the value. */
  readonly path: string;
  /** Version reported for the executable or plugin. */
  readonly version: string;
  /** SHA-256 digest of the value. */
  readonly sha256: Sha256Digest;
}

/** Options for configuring codex executable discovery. */
export interface CodexExecutableDiscoveryOptions {
  /** Executable path in the codex executable discovery options contract. */
  readonly executablePath?: string;
  /** Path value in the codex executable discovery options contract. */
  readonly pathValue?: string;
  /** Working directory used to resolve relative paths. */
  readonly cwd?: string;
  /** Environment variables passed to the process. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Version runner in the codex executable discovery options contract. */
  readonly versionRunner?: (
    path: string,
    environment: Readonly<Record<string, string>>,
  ) => Promise<string>;
}

function resolveExecutablePath(
  options: CodexExecutableDiscoveryOptions,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const candidates: string[] = [];
    if (options.executablePath !== undefined) {
      candidates.push(resolve(options.cwd ?? process.cwd(), options.executablePath));
    } else {
      const pathValue =
        options.pathValue ?? options.environment?.["PATH"] ?? process.env["PATH"] ?? "";
      const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
      for (const entry of pathValue.split(delimiter).filter((item) => item.length > 0)) {
        for (const name of names) {
          candidates.push(resolve(entry, name));
        }
      }
    }
    for (const candidate of candidates) {
      const candidateStat = yield* Effect.catchIf(
        Effect.tryPromise({ try: () => stat(candidate), catch: (error) => error }),
        () => true,
        (error) =>
          options.executablePath !== undefined
            ? Effect.fail(
                new CodexError(
                  "discovery_failed",
                  "The explicit Codex executable was not found.",
                  { path: candidate },
                  { cause: error },
                ),
              )
            : Effect.succeed(undefined),
      );
      if (candidateStat === undefined) continue;
      if (!candidateStat.isFile()) {
        continue;
      }
      if (process.platform !== "win32" && (candidateStat.mode & 0o111) === 0) {
        continue;
      }
      return yield* Effect.tryPromise({
        try: () => realpath(candidate),
        catch: (error) =>
          new CodexError(
            "discovery_failed",
            "The explicit Codex executable could not be resolved.",
            { path: candidate },
            { cause: error },
          ),
      });
    }
    return yield* Effect.fail(
      new CodexError("discovery_failed", "No Codex executable was found on the allowlisted PATH."),
    );
  });
}

function runVersionCommand(
  executablePath: string,
  environment: Readonly<Record<string, string>>,
): Effect.Effect<string, unknown> {
  const child = Bun.spawn([executablePath, "--version"], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    return Effect.fail(
      new CodexError("discovery_failed", "The Codex version command did not expose output pipes."),
    );
  }
  return Effect.gen(function* () {
    const [stdout, stderr, exitCode] = yield* waitForChild(
      Effect.all(
        [
          Effect.tryPromise({
            try: () => readBoundedStream(child.stdout, 16 * 1024),
            catch: (error) => error,
          }),
          Effect.tryPromise({
            try: () => readBoundedStream(child.stderr, 16 * 1024),
            catch: (error) => error,
          }),
          Effect.tryPromise({ try: () => child.exited, catch: (error) => error }),
        ],
        { concurrency: "unbounded" },
      ),
      () => child.kill(),
      "The Codex version command timed out.",
    );
    const output = sanitizeText(decodeUtf8(stdout, "Codex version output"));
    if (exitCode !== 0 || output.length === 0) {
      const diagnostics = sanitizeDiagnostic(decodeUtf8(stderr, "Codex version diagnostics"));
      return yield* Effect.fail(
        new CodexError("discovery_failed", "The Codex executable did not provide a version.", {
          exitCode,
          diagnostics,
        }),
      );
    }
    return output;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CodexError
        ? error
        : new CodexError(
            "discovery_failed",
            "The Codex version command failed.",
            {},
            { cause: error },
          ),
    ),
    Effect.ensuring(Effect.sync(() => child.kill())),
  );
}

function digestFile(path: string): Effect.Effect<Sha256Digest, unknown> {
  return Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: (error) => error });
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", bytes),
      catch: (error) => error,
    });
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const validated = createSha256Digest(hex);
    if (!validated.ok) {
      return yield* Effect.fail(
        new CodexError("discovery_failed", "The Codex executable digest was invalid."),
      );
    }
    return validated.value;
  });
}

/** Discover, version, and digest the Codex executable selected by the caller's options. */
export function discoverCodexExecutable(
  options: CodexExecutableDiscoveryOptions = {},
): Promise<CodexExecutableIdentity> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* resolveExecutablePath(options);
      const environment = allowlistedEnvironment(options.environment);
      const version = options.versionRunner
        ? yield* Effect.tryPromise({
            try: () => options.versionRunner!(path, environment),
            catch: (error) => error,
          }).pipe(Effect.map(sanitizeText))
        : yield* runVersionCommand(path, environment);
      if (version.length === 0) {
        return yield* Effect.fail(
          new CodexError("discovery_failed", "The Codex version output was empty."),
        );
      }
      return { path, version, sha256: yield* digestFile(path) };
    }),
  );
}

/** Result returned by the command operation. */
export interface CommandResult {
  /** Exit code returned by the process. */
  readonly exitCode: number;
  /** Standard output captured from the process. */
  readonly stdout: string;
  /** Standard error captured from the process. */
  readonly stderr: string;
}

const CommandResultSchema = Schema.Struct({
  exitCode: Schema.Number.check(Schema.makeFilter((value) => Number.isSafeInteger(value))),
  stdout: Schema.String.check(Schema.isMaxLength(1024 * 1024)),
  stderr: Schema.String.check(Schema.isMaxLength(1024 * 1024)),
});

/** Provenance recorded for schema output. */
export interface SchemaOutputProvenance {
  /** Filesystem path associated with the value. */
  readonly path: string;
  /** Value size in bytes. */
  readonly size: number;
  /** SHA-256 digest of the value. */
  readonly sha256: Sha256Digest;
}

/** Type of command runner values. */
export type CommandRunner = (
  executablePath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

function runCommand(
  executablePath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Effect.Effect<CommandResult, unknown> {
  const child = Bun.spawn([executablePath, ...args], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    return Effect.fail(
      new CodexError("transport_failure", "The Codex command did not expose output pipes."),
    );
  }
  return Effect.gen(function* () {
    const [stdout, stderr, exitCode] = yield* waitForChild(
      Effect.all(
        [
          Effect.tryPromise({
            try: () => readBoundedStream(child.stdout, 1024 * 1024),
            catch: (error) => error,
          }),
          Effect.tryPromise({
            try: () => readBoundedStream(child.stderr, 1024 * 1024),
            catch: (error) => error,
          }),
          Effect.tryPromise({ try: () => child.exited, catch: (error) => error }),
        ],
        { concurrency: "unbounded" },
      ),
      () => child.kill(),
      "The Codex command timed out.",
    );
    return {
      exitCode,
      stdout: sanitizeText(decodeUtf8(stdout, "Codex command output"), 4096),
      stderr: sanitizeDiagnostic(decodeUtf8(stderr, "Codex command diagnostics")),
    };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CodexError
        ? error
        : new CodexError("transport_failure", "The Codex command failed.", {}, { cause: error }),
    ),
    Effect.ensuring(Effect.sync(() => child.kill())),
  );
}

function waitForChild<T, E>(
  operation: Effect.Effect<T, E>,
  kill: () => void,
  timeoutMessage: string,
): Effect.Effect<T, E | CodexError> {
  return operation.pipe(
    Effect.timeout(EXTERNAL_COMMAND_TIMEOUT_MS),
    Effect.mapError((error) =>
      error instanceof CodexError
        ? error
        : error !== null &&
            typeof error === "object" &&
            "_tag" in error &&
            error._tag === "TimeoutError"
          ? new CodexError("timeout", timeoutMessage)
          : (error as E),
    ),
    Effect.onError(() => Effect.sync(kill)),
  );
}

/** Options for configuring schema generation. */
export interface SchemaGenerationOptions {
  /** Executable in the schema generation options contract. */
  readonly executable: CodexExecutableIdentity;
  /** Output directory in the schema generation options contract. */
  readonly outputDirectory: string;
  /** Environment variables passed to the process. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Command runner in the schema generation options contract. */
  readonly commandRunner?: CommandRunner;
}

/** Provenance recorded for schema generation. */
export interface SchemaGenerationProvenance {
  /** Executable in the schema generation provenance contract. */
  readonly executable: CodexExecutableIdentity;
  /** Protocol epoch in the schema generation provenance contract. */
  readonly protocol_epoch: typeof CODEX_PROTOCOL_EPOCH;
  /** Output directory in the schema generation provenance contract. */
  readonly outputDirectory: string;
  /** Commands in the schema generation provenance contract. */
  readonly commands: readonly (readonly string[])[];
  /** Output digest in the schema generation provenance contract. */
  readonly output_digest: Sha256Digest;
  /** Outputs in the schema generation provenance contract. */
  readonly outputs: readonly SchemaOutputProvenance[];
}

/** Generate Codex TypeScript schemas into a verified empty output directory. */
export function generateCodexSchemas(
  options: SchemaGenerationOptions,
): Promise<SchemaGenerationProvenance> {
  return Effect.runPromise(generateCodexSchemasEffect(options));
}

function generateCodexSchemasEffect(
  options: SchemaGenerationOptions,
): Effect.Effect<SchemaGenerationProvenance, unknown> {
  return Effect.gen(function* () {
    if (options.outputDirectory.length === 0 || !isAbsolute(options.outputDirectory)) {
      return yield* Effect.fail(
        new CodexError(
          "empty_output_directory",
          "Schema generation requires an explicit absolute output directory.",
        ),
      );
    }
    yield* Effect.tryPromise({
      try: () => mkdir(options.outputDirectory, { recursive: true }),
      catch: (error) => error,
    });
    const outputStat = yield* Effect.tryPromise({
      try: () => lstat(options.outputDirectory),
      catch: (error) => error,
    });
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
      return yield* Effect.fail(
        new CodexError("empty_output_directory", "Schema output must be a real directory."),
      );
    }
    if (
      (yield* Effect.tryPromise({
        try: () => readdir(options.outputDirectory),
        catch: (error) => error,
      })).length !== 0
    ) {
      return yield* Effect.fail(
        new CodexError(
          "empty_output_directory",
          "Schema generation requires an empty output directory.",
        ),
      );
    }
    const outputDirectory = yield* Effect.tryPromise({
      try: () => realpath(options.outputDirectory),
      catch: (error) => error,
    });
    yield* assertExecutableStable(options.executable);
    const environment = allowlistedEnvironment(options.environment);
    const runner =
      options.commandRunner === undefined
        ? runCommand
        : (path: string, args: readonly string[], env: Readonly<Record<string, string>>) =>
            Effect.tryPromise({
              try: () => options.commandRunner!(path, args, env),
              catch: (error) => error,
            });
    const commands = [["app-server", "generate-ts", "--out", outputDirectory] as const] as const;
    for (const args of commands) {
      yield* assertExecutableStable(options.executable);
      const result = yield* runner(options.executable.path, args, environment);
      const parsedResult = checked(CommandResultSchema, result, "Codex schema generation result");
      if (parsedResult.exitCode !== 0) {
        return yield* Effect.fail(
          new CodexError("transport_failure", `Codex schema generation failed for ${args[1]}.`, {
            exitCode: parsedResult.exitCode,
            diagnostics: sanitizeDiagnostic(parsedResult.stderr),
          }),
        );
      }
    }
    yield* assertExecutableStable(options.executable);
    const outputs = yield* collectSchemaOutputs(outputDirectory);
    if (outputs.length === 0) {
      return yield* Effect.fail(
        new CodexError("empty_output_directory", "Schema generation produced no files."),
      );
    }
    const outputDigest = yield* Effect.tryPromise({
      try: () => domainSeparatedSha256("codex-schema-output", [canonicalJsonUtf8(outputs)]),
      catch: (error) => error,
    });
    return {
      executable: options.executable,
      protocol_epoch: CODEX_PROTOCOL_EPOCH,
      outputDirectory,
      commands,
      output_digest: outputDigest,
      outputs,
    };
  });
}

function assertExecutableStable(executable: CodexExecutableIdentity): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const observedDigest = yield* digestFile(executable.path);
    if (observedDigest !== executable.sha256) {
      return yield* Effect.fail(
        new CodexError(
          "discovery_failed",
          "The Codex executable changed during schema generation.",
        ),
      );
    }
  });
}

function collectSchemaOutputs(
  root: string,
): Effect.Effect<readonly SchemaOutputProvenance[], unknown> {
  return Effect.gen(function* () {
    const outputs: SchemaOutputProvenance[] = [];
    let total = 0;
    const visit = (directory: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(directory, { withFileTypes: true }),
          catch: (error) => error,
        });
        for (const entry of entries) {
          const absolute = join(directory, entry.name);
          const metadata = yield* Effect.tryPromise({
            try: () => lstat(absolute),
            catch: (error) => error,
          });
          if (metadata.isSymbolicLink()) {
            return yield* Effect.fail(
              new CodexError("transport_failure", "Schema generation produced a symlink."),
            );
          }
          if (metadata.isDirectory()) {
            yield* visit(absolute);
            continue;
          }
          if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 4 * 1024 * 1024) {
            return yield* Effect.fail(
              new CodexError("transport_failure", "Schema generation produced an invalid file."),
            );
          }
          total += metadata.size;
          if (total > 16 * 1024 * 1024) {
            return yield* Effect.fail(
              new CodexError(
                "transport_failure",
                "Schema generation output exceeds its size bound.",
              ),
            );
          }
          outputs.push({
            path: relative(root, absolute).split("\\").join("/"),
            size: metadata.size,
            sha256: yield* digestFile(absolute),
          });
        }
      });
    yield* visit(root);
    return outputs.sort((left, right) => left.path.localeCompare(right.path));
  });
}
