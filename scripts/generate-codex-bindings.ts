// SPDX-License-Identifier: Apache-2.0

import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { canonicalJsonUtf8, domainSeparatedSha256 } from "../packages/core/src/canonical.ts";
import {
  allowlistedEnvironment,
  DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  isSensitiveEnvironmentKey,
  redactDiagnostics,
  runCheckedEffect,
  assertTemporaryPath,
} from "./process.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const generatedRoot = join(workspaceRoot, "packages/codex/generated");
const generatedTypescriptRoot = join(generatedRoot, "typescript");
const provenancePath = join(generatedRoot, "provenance.json");
const require = createRequire(import.meta.url);
const CODEX_PACKAGE = "@openai/codex";
const StableVersionSchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
);
const TemporaryDirectoryPrefixSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,48}$/u),
);
const PlatformSchema = Schema.Literals(["win32", "darwin", "linux", "android"]);
const ArchitectureSchema = Schema.Literals(["arm64", "x64"]);
const CodexVersionOutputSchema = Schema.String.check(
  Schema.isPattern(/^codex-cli (\d+\.\d+\.\d+)$/u),
);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const CodexPackageManifestSchema = Schema.Struct({ version: Schema.String });
const GeneratedProvenanceSchema = Schema.Struct({
  schema_version: Schema.Literals(["holycodex-generated-v2"]),
  artifact_root: Schema.Literals(["packages/codex/generated"]),
  codex_cli_version: Schema.String.check(Schema.isPattern(/^codex-cli \d+\.\d+\.\d+$/u)),
  codex_cli_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  protocol_epoch: Schema.String.check(Schema.isPattern(/^codex-app-server-\d+\.\d+\.\d+$/u)),
  generator: Schema.Struct({
    command: Schema.Tuple([Schema.Literals(["app-server"]), Schema.Literals(["generate-ts"])]),
    supported_surface: Schema.Literals(["codex app-server generators"]),
  }),
  typescript_root: Schema.Literals(["typescript"]),
  files: Schema.Struct({
    count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
});

interface GeneratedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface GeneratedInventory {
  readonly count: number;
  readonly digest: string;
  readonly files: readonly GeneratedFile[];
}

interface GeneratedProvenance {
  readonly schema_version: "holycodex-generated-v2";
  readonly artifact_root: "packages/codex/generated";
  readonly codex_cli_version: `codex-cli ${string}`;
  readonly codex_cli_digest: string;
  readonly protocol_epoch: `codex-app-server-${string}`;
  readonly generator: {
    readonly command: readonly ["app-server", "generate-ts"];
    readonly supported_surface: "codex app-server generators";
  };
  readonly typescript_root: "typescript";
  readonly files: { readonly count: number; readonly digest: string };
}

/** Summarize whether Codex bindings were generated or reused and identify the verified artifact set. */
export interface EnsureCodexGeneratedResult {
  /** Whether generation ran or a matching generated tree was reused. */
  readonly status: "generated" | "reused";
  /** Stable Codex CLI version used to produce the bindings. */
  readonly codexCliVersion: string;
  /** SHA-256 identity of the Codex CLI executable used. */
  readonly codexCliDigest: string;
  /** Digest of the generated binding files. */
  readonly artifactDigest: string;
  /** Number of generated binding files represented by the digest. */
  readonly artifactFiles: number;
}

/** Identifies a Codex CLI installation for matching cached generated bindings. */
export interface GeneratedCacheIdentity {
  /** Stable Codex CLI version associated with the cache. */
  readonly codexCliVersion: string;
  /** SHA-256 identity of the Codex CLI executable associated with the cache. */
  readonly codexCliDigest: string;
}

/** Return the Bun invocation for the workspace-locked Codex package. */
export function codexExecutableCommand(): readonly string[] {
  return ["bun", require.resolve("@openai/codex/bin/codex.js")];
}

/** Return whether cached generated output matches the resolved Codex identity. */
export function canReuseGeneratedOutput(
  cached: GeneratedCacheIdentity,
  resolved: GeneratedCacheIdentity,
): boolean {
  return (
    cached.codexCliVersion === resolved.codexCliVersion &&
    cached.codexCliDigest === resolved.codexCliDigest
  );
}

/**
 * Ensure generated bindings match the Codex CLI locked in this workspace. A valid current tree is
 * reused without invoking the generator again.
 */
export function ensureCodexGenerated(): Effect.Effect<EnsureCodexGeneratedResult, unknown> {
  return Effect.gen(function* () {
    const resolved = yield* resolveCodexTool();
    const current = yield* verifyCurrentOutput(resolved);
    if (current !== undefined) return { status: "reused" as const, ...resolved, ...current };

    return yield* withTemporaryDirectoryEffect("holycodex-generation", (temporaryRoot) =>
      Effect.gen(function* () {
        const outputDirectory = join(temporaryRoot, "typescript");
        const isolatedCodexHome = join(temporaryRoot, "codex-home");
        yield* io(() => mkdir(outputDirectory, { recursive: true }));
        yield* io(() => mkdir(isolatedCodexHome, { recursive: true }));
        const environment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
          CODEX_HOME: isolatedCodexHome,
        });
        yield* runCheckedEffect(
          [...codexExecutableCommand(), "app-server", "generate-ts", "--out", outputDirectory],
          {
            cwd: workspaceRoot,
            env: environment,
            maxOutputBytes: 1024 * 1024,
          },
        );
        yield* io(() => rm(isolatedCodexHome, { recursive: true, force: true }));
        yield* normalizeGeneratedText(temporaryRoot);
        yield* writeProtocolConstants(outputDirectory, resolved.versionNumber);
        yield* assertSecretFree(temporaryRoot);
        const inventory = yield* collectInventory(temporaryRoot);
        yield* assertExpectedSurface(inventory);

        yield* io(() => rm(generatedRoot, { recursive: true, force: true }));
        yield* io(() => cp(temporaryRoot, generatedRoot, { recursive: true, dereference: true }));
        const provenance: GeneratedProvenance = {
          schema_version: "holycodex-generated-v2",
          artifact_root: "packages/codex/generated",
          codex_cli_version: resolved.codexCliVersion as `codex-cli ${string}`,
          codex_cli_digest: resolved.codexCliDigest,
          protocol_epoch: `codex-app-server-${resolved.versionNumber}`,
          generator: {
            command: ["app-server", "generate-ts"],
            supported_surface: "codex app-server generators",
          },
          typescript_root: "typescript",
          files: { count: inventory.count, digest: inventory.digest },
        };
        yield* io(() =>
          writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          }),
        );
        const verified = yield* verifyCurrentOutput(resolved);
        if (verified === undefined) {
          return yield* Effect.fail(
            new Error("Generated Codex bindings failed their post-generation verification."),
          );
        }
        return { status: "generated" as const, ...resolved, ...verified };
      }),
    );
  });
}

function resolveCodexTool(): Effect.Effect<
  {
    readonly executable: string;
    readonly versionNumber: string;
    readonly codexCliVersion: string;
    readonly codexCliDigest: string;
  },
  unknown
> {
  const command = codexExecutableCommand();
  return Effect.gen(function* () {
    const packagePath = yield* Effect.try({
      try: () => require.resolve(`${CODEX_PACKAGE}/package.json`),
      catch: (error) => error,
    });
    const packageData = yield* readJson(CodexPackageManifestSchema, packagePath);
    const packageVersion = yield* Schema.decodeUnknownEffect(StableVersionSchema)(
      packageData.version,
    );
    const target = yield* codexPlatformTargetEffect(process.platform, process.arch);
    const platformPackageRoot = yield* Effect.try({
      try: () => {
        const packageRequire = createRequire(packagePath);
        return dirname(packageRequire.resolve(`${target.packageName}/package.json`));
      },
      catch: (error) => error,
    });
    const executable = yield* io(() =>
      realpath(
        join(
          platformPackageRoot,
          "vendor",
          target.targetTriple,
          "bin",
          process.platform === "win32" ? "codex.exe" : "codex",
        ),
      ),
    );
    const metadata = yield* io(() => lstat(executable));
    if (!metadata.isFile())
      return yield* Effect.fail(new Error("The locked Codex native binary is not a file."));

    const environment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
      CODEX_HOME: undefined,
    });
    const result = yield* runCheckedEffect([...command, "--version"], {
      cwd: workspaceRoot,
      env: environment,
      maxOutputBytes: 16 * 1024,
    });
    const versionOutput = result.stdout.trim();
    const output = yield* Schema.decodeUnknownEffect(CodexVersionOutputSchema)(versionOutput).pipe(
      Effect.mapError(
        () =>
          new Error(
            `The resolved Codex tool did not report an exact stable version (received ${redactDiagnostics(versionOutput || result.stderr, environment)}).`,
          ),
      ),
    );
    const versionNumber = yield* Schema.decodeUnknownEffect(StableVersionSchema)(
      output.slice("codex-cli ".length),
    );
    if (versionNumber !== packageVersion) {
      return yield* Effect.fail(
        new Error(
          `The workspace-locked Codex package reports ${packageVersion}, but its native executable reports ${versionNumber}.`,
        ),
      );
    }
    const codexCliDigest = yield* sha256File(executable);
    return {
      executable,
      versionNumber,
      codexCliVersion: `codex-cli ${versionNumber}`,
      codexCliDigest,
    };
  }).pipe(
    Effect.mapError(
      (error) =>
        new Error(`The workspace-locked Codex native binary is unavailable (${safeError(error)}).`),
    ),
  );
}

/** Resolve Codex's locked optional native package and binary target for a supported host. */
export function codexPlatformTarget(
  platform: string,
  architecture: string,
): Readonly<{ packageName: string; targetTriple: string }> {
  const parsedArchitecture = Schema.decodeUnknownResult(ArchitectureSchema)(architecture);
  if (Result.isFailure(parsedArchitecture)) {
    throw new Error(`Codex has no native package for ${platform}/${architecture}.`);
  }
  const architectureName = parsedArchitecture.success;
  const parsedPlatform = Schema.decodeUnknownResult(PlatformSchema)(platform);
  if (Result.isFailure(parsedPlatform)) {
    throw new Error(`Codex has no native package for ${platform}/${architecture}.`);
  }
  const platformName = parsedPlatform.success;
  switch (platformName) {
    case "win32":
      return {
        packageName: `@openai/codex-win32-${architectureName}`,
        targetTriple: `${architectureName === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`,
      };
    case "darwin":
      return {
        packageName: `@openai/codex-darwin-${architectureName}`,
        targetTriple: `${architectureName === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
      };
    case "linux":
    case "android":
      return {
        packageName: `@openai/codex-linux-${architectureName}`,
        targetTriple: `${architectureName === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`,
      };
  }
}

function codexPlatformTargetEffect(
  platform: string,
  architecture: string,
): Effect.Effect<Readonly<{ packageName: string; targetTriple: string }>, unknown> {
  return Effect.gen(function* () {
    const platformName = yield* Schema.decodeUnknownEffect(PlatformSchema)(platform);
    const architectureName = yield* Schema.decodeUnknownEffect(ArchitectureSchema)(architecture);
    return codexPlatformTarget(platformName, architectureName);
  });
}

function verifyCurrentOutput(resolved: {
  readonly codexCliVersion: string;
  readonly codexCliDigest: string;
}): Effect.Effect<
  Readonly<{ artifactDigest: string; artifactFiles: number }> | undefined,
  unknown
> {
  return Effect.gen(function* () {
    const provenance = yield* readJson(GeneratedProvenanceSchema, provenancePath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (provenance === undefined) return undefined;
    if (
      !canReuseGeneratedOutput(
        {
          codexCliVersion: provenance.codex_cli_version,
          codexCliDigest: provenance.codex_cli_digest,
        },
        resolved,
      ) ||
      provenance.protocol_epoch !==
        `codex-app-server-${resolved.codexCliVersion.slice("codex-cli ".length)}`
    )
      return undefined;
    const protocolSource = yield* readTextIfPresent(join(generatedTypescriptRoot, "protocol.ts"));
    if (
      protocolSource !==
      protocolSourceForVersion(resolved.codexCliVersion.slice("codex-cli ".length))
    )
      return undefined;
    const result = yield* collectInventory(generatedRoot).pipe(
      Effect.flatMap((inventory) =>
        assertExpectedSurface(inventory).pipe(
          Effect.andThen(assertSecretFree(generatedRoot)),
          Effect.andThen(() =>
            inventory.count === provenance.files.count &&
            inventory.digest === provenance.files.digest
              ? Effect.succeed({ artifactDigest: inventory.digest, artifactFiles: inventory.count })
              : Effect.succeed(undefined),
          ),
        ),
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return result;
  });
}

function writeProtocolConstants(root: string, version: string): Effect.Effect<void, unknown> {
  return io(() =>
    writeFile(join(root, "protocol.ts"), protocolSourceForVersion(version), {
      encoding: "utf8",
      mode: 0o600,
    }),
  );
}

function protocolSourceForVersion(version: string): string {
  return `// GENERATED CODE! DO NOT MODIFY BY HAND!\n\nexport const CODEX_PROTOCOL_VERSION = "codex-cli-${version}" as const;\nexport const CODEX_PROTOCOL_EPOCH = "codex-app-server-${version}" as const;\n`;
}

function collectInventory(root: string): Effect.Effect<GeneratedInventory, unknown> {
  return Effect.gen(function* () {
    yield* assertNoSymlinkBoundary(root);
    const files: GeneratedFile[] = [];
    let totalBytes = 0;
    const visit = (directory: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const entries = yield* io(() => readdir(directory, { withFileTypes: true }));
        for (const entry of entries) {
          const absolute = join(directory, entry.name);
          const metadata = yield* io(() => lstat(absolute));
          if (metadata.isSymbolicLink())
            return yield* Effect.fail(
              new Error("Generated Codex bindings may not contain symlinks."),
            );
          if (metadata.isDirectory()) {
            yield* visit(absolute);
            continue;
          }
          if (!metadata.isFile())
            return yield* Effect.fail(
              new Error("Generated Codex bindings contain a non-file entry."),
            );
          const relativePath = relative(root, absolute).split("\\").join("/");
          if (relativePath === "provenance.json") continue;
          if (!relativePath.startsWith("typescript/"))
            return yield* Effect.fail(
              new Error(`Generated Codex binding is outside typescript/: ${relativePath}`),
            );
          if (metadata.size <= 0 || metadata.size > MAX_FILE_BYTES)
            return yield* Effect.fail(
              new Error(`Generated Codex binding has an invalid size: ${relativePath}`),
            );
          totalBytes += metadata.size;
          if (totalBytes > MAX_TOTAL_BYTES)
            return yield* Effect.fail(new Error("Generated Codex bindings exceed the size bound."));
          files.push({
            path: relativePath,
            size: metadata.size,
            sha256: yield* sha256File(absolute),
          });
        }
      });
    yield* visit(root);
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const digest = yield* Effect.tryPromise({
      try: () => domainSeparatedSha256("codex-schema-output", [canonicalJsonUtf8(files)]),
      catch: (error) => error,
    });
    return { count: files.length, digest, files };
  });
}

function assertExpectedSurface(inventory: GeneratedInventory): Effect.Effect<void, Error> {
  const paths = new Set(inventory.files.map((file) => file.path));
  for (const required of [
    "typescript/index.ts",
    "typescript/ClientRequest.ts",
    "typescript/ClientNotification.ts",
    "typescript/ServerRequest.ts",
    "typescript/ServerNotification.ts",
    "typescript/protocol.ts",
  ]) {
    if (!paths.has(required)) {
      return Effect.fail(
        new Error(`Generated Codex bindings are missing required surface ${required}.`),
      );
    }
  }
  return Effect.void;
}

function assertSecretFree(root: string): Effect.Effect<void, unknown> {
  const sensitiveValues = Object.entries(process.env)
    .filter(
      (entry): entry is [string, string] =>
        isSensitiveEnvironmentKey(entry[0]) && entry[1] !== undefined && entry[1].length > 0,
    )
    .map(([, value]) => value);
  if (sensitiveValues.length === 0) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const inventory = yield* collectInventory(root);
    for (const file of inventory.files) {
      const content = yield* io(() => readFile(join(root, file.path), "utf8"));
      if (sensitiveValues.some((secret) => content.includes(secret)))
        return yield* Effect.fail(
          new Error("Generated Codex bindings contain an environment secret value."),
        );
    }
  });
}

function assertNoSymlinkBoundary(path: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    let current = resolve(path);
    while (true) {
      const metadata = yield* io(() => lstat(current));
      if (metadata.isSymbolicLink())
        return yield* Effect.fail(
          new Error("Generated Codex bindings may not contain symlinked roots."),
        );
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  });
}

function normalizeGeneratedText(root: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const inventory = yield* collectInventory(root);
    for (const file of inventory.files) {
      const path = join(root, file.path);
      const content = yield* io(() => readFile(path, "utf8"));
      const normalized = content.replaceAll("\\r\\n", "\\n");
      if (normalized !== content)
        yield* io(() => writeFile(path, normalized, { encoding: "utf8", mode: 0o600 }));
    }
  });
}

function sha256File(path: string): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const contents = yield* io(() => readFile(path));
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", contents),
      catch: (error) => error,
    });
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

function readTextIfPresent(path: string): Effect.Effect<string | undefined, unknown> {
  return io(() => readFile(path, "utf8")).pipe(
    Effect.catch((error) =>
      isFsCode(error, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
}

function readJson<A>(schema: Schema.Decoder<A>, path: string): Effect.Effect<A, unknown> {
  return io(() => readFile(path, "utf8")).pipe(
    Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)),
  );
}

function io<A>(operation: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

function withTemporaryDirectoryEffect<A, E>(
  prefix: string,
  operation: (directory: string) => Effect.Effect<A, E>,
): Effect.Effect<A, unknown> {
  return Effect.gen(function* () {
    const validatedPrefix = yield* Schema.decodeUnknownEffect(TemporaryDirectoryPrefixSchema)(
      prefix,
    );
    return yield* Effect.acquireUseRelease(
      io(() => mkdtemp(join(tmpdir(), `${validatedPrefix}-`))).pipe(
        Effect.map((path) => assertTemporaryPath(path, "generated bindings temporary directory")),
      ),
      operation,
      (directory) =>
        io(() =>
          rm(assertTemporaryPath(directory, "generated bindings temporary directory"), {
            recursive: true,
            force: true,
          }),
        ).pipe(Effect.orDie),
    );
  });
}

function isFsCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function safeError(error: unknown): string {
  return redactDiagnostics(error instanceof Error ? error.message : "unknown error");
}

if (import.meta.main) {
  await Effect.runPromise(
    ensureCodexGenerated().pipe(
      Effect.tap((result) => Effect.sync(() => console.log(JSON.stringify(result)))),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(JSON.stringify({ status: "failed", message: safeError(error) }));
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
