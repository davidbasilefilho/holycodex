// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { canonicalJsonUtf8, domainSeparatedSha256, type Sha256Digest } from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { CodexError } from "./common";

const ARTIFACT_ROOT_RELATIVE = "packages/codex/generated" as const;
const STABLE_CODEX_VERSION = /^codex-cli \d+\.\d+\.\d+$/u;
const STABLE_PROTOCOL_EPOCH = /^codex-app-server-\d+\.\d+\.\d+$/u;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const Sha256DigestSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
  Schema.brand("Sha256Digest"),
);
const GeneratedArtifactFileSizeSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_FILE_BYTES),
);
const GeneratedProvenanceSchema = Schema.Struct({
  schema_version: Schema.Literals(["holycodex-generated-v2"]),
  artifact_root: Schema.Literals([ARTIFACT_ROOT_RELATIVE]),
  codex_cli_version: Schema.String.check(Schema.isPattern(STABLE_CODEX_VERSION)),
  codex_cli_digest: Sha256DigestSchema,
  protocol_epoch: Schema.String.check(Schema.isPattern(STABLE_PROTOCOL_EPOCH)),
  generator: Schema.Struct({
    command: Schema.Tuple([Schema.Literals(["app-server"]), Schema.Literals(["generate-ts"])]),
    supported_surface: Schema.Literals(["codex app-server generators"]),
  }),
  typescript_root: Schema.Literals(["typescript"]),
  files: Schema.Struct({
    count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    digest: Sha256DigestSchema,
  }),
});

const GeneratedArtifactFileSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  size: GeneratedArtifactFileSizeSchema,
  sha256: Sha256DigestSchema,
});
const JsonTextSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
);
/** Data contract for generated artifact file. */
export interface GeneratedArtifactFile {
  /** Filesystem path associated with the value. */
  readonly path: string;
  /** Value size in bytes. */
  readonly size: number;
  /** SHA-256 digest of the value. */
  readonly sha256: Sha256Digest;
}

/** Data contract for generated artifact inventory. */
export interface GeneratedArtifactInventory {
  /** Count in the generated artifact inventory contract. */
  readonly count: number;
  /** Files in the generated artifact inventory contract. */
  readonly files: readonly GeneratedArtifactFile[];
  /** Digest in the generated artifact inventory contract. */
  readonly digest: Sha256Digest;
}

/** Data contract for generated artifact verification. */
export interface GeneratedArtifactVerification {
  /** Artifact root in the generated artifact verification contract. */
  readonly artifact_root: typeof ARTIFACT_ROOT_RELATIVE;
  /** Protocol epoch in the generated artifact verification contract. */
  readonly protocol_epoch: string;
  /** Codex cli version in the generated artifact verification contract. */
  readonly codex_cli_version: string;
  /** Inventory in the generated artifact verification contract. */
  readonly inventory: GeneratedArtifactInventory;
  /** Multi agent v2 lifecycle in the generated artifact verification contract. */
  readonly multi_agent_v2_lifecycle: "verified" | "unverified";
}

/** Options for configuring generated artifact verification. */
export interface GeneratedArtifactVerificationOptions {
  /** Artifact root in the generated artifact verification options contract. */
  readonly artifactRoot?: string;
}

function comparePath(left: GeneratedArtifactFile, right: GeneratedArtifactFile): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

function sha256File(path: string): Effect.Effect<Sha256Digest, unknown> {
  return Effect.gen(function* () {
    const bytes = yield* promiseEffect(() => readFile(path));
    const digest = yield* promiseEffect(() => crypto.subtle.digest("SHA-256", bytes));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return yield* decodeSchema(Sha256DigestSchema, hex, "generated artifact digest");
  });
}

function checkedSha256(value: string, label: string): Effect.Effect<Sha256Digest, CodexError> {
  return decodeSchema(Sha256DigestSchema, value, label);
}

function readProvenance(
  root: string,
): Effect.Effect<typeof GeneratedProvenanceSchema.Type, unknown> {
  return Effect.gen(function* () {
    const text = yield* promiseEffect(() => readFile(join(root, "provenance.json"), "utf8"));
    const json = Schema.decodeUnknownResult(JsonTextSchema, { onExcessProperty: "error" })(text);
    if (Result.isFailure(json))
      return yield* Effect.fail(
        new CodexError(
          "protocol_mismatch",
          "The generated artifact provenance could not be read.",
          {},
          { cause: json.failure },
        ),
      );
    return yield* decodeSchema(
      GeneratedProvenanceSchema,
      json.success,
      "generated artifact provenance",
    );
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CodexError
        ? error
        : new CodexError(
            "protocol_mismatch",
            "The generated artifact provenance could not be read.",
            {},
            { cause: error },
          ),
    ),
  );
}

function collectInventory(root: string): Effect.Effect<GeneratedArtifactInventory, unknown> {
  const files: GeneratedArtifactFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const entries = yield* promiseEffect(() => readdir(directory, { withFileTypes: true }));
      for (const entry of entries) {
        const absolute = join(directory, entry.name);
        const metadata = yield* promiseEffect(() => lstat(absolute));
        if (metadata.isSymbolicLink())
          return yield* Effect.fail(
            new CodexError("protocol_mismatch", "Generated artifacts may not contain symlinks."),
          );
        if (metadata.isDirectory()) {
          yield* visit(absolute);
          continue;
        }
        if (!metadata.isFile())
          return yield* Effect.fail(
            new CodexError("protocol_mismatch", "Generated artifacts contain a non-file entry."),
          );
        const path = relative(root, absolute).split("\\").join("/");
        if (path === "provenance.json") continue;
        if (!path.startsWith("typescript/"))
          return yield* Effect.fail(
            new CodexError(
              "protocol_mismatch",
              "Generated artifacts contain a file outside the declared roots.",
              { path },
            ),
          );
        const size = Schema.decodeUnknownResult(GeneratedArtifactFileSizeSchema)(metadata.size);
        if (Result.isFailure(size))
          return yield* Effect.fail(
            new CodexError("protocol_mismatch", "A generated artifact file has an invalid size.", {
              path,
            }),
          );
        totalBytes += size.success;
        if (totalBytes > MAX_TOTAL_BYTES)
          return yield* Effect.fail(
            new CodexError("protocol_mismatch", "Generated artifacts exceed the size bound."),
          );
        files.push({ path, size: size.success, sha256: yield* sha256File(absolute) });
      }
    });

  return Effect.gen(function* () {
    yield* assertNoSymlinkBoundary(root);
    yield* visit(root);
    files.sort(comparePath);
    const validatedFiles = yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const validated = yield* decodeSchema(
          GeneratedArtifactFileSchema,
          file,
          "generated artifact file",
        );
        return {
          path: validated.path,
          size: validated.size,
          sha256: yield* checkedSha256(validated.sha256, "generated artifact file"),
        };
      }),
    );
    const digest = yield* promiseEffect(() =>
      domainSeparatedSha256("codex-schema-output", [canonicalJsonUtf8(validatedFiles)]),
    );
    return { count: validatedFiles.length, files: validatedFiles, digest };
  });
}

function assertNoSymlinkBoundary(path: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    let current = resolve(path);
    while (true) {
      const metadata = yield* promiseEffect(() => lstat(current));
      if (metadata.isSymbolicLink())
        return yield* Effect.fail(
          new CodexError(
            "protocol_mismatch",
            "Generated artifacts may not contain symlinked roots.",
          ),
        );
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  });
}

function generatedV2LifecycleStatus(
  root: string,
): Effect.Effect<"verified" | "unverified", unknown> {
  // The generated union is authoritative for RPCs. A V2 collaboration data type alone
  // is insufficient; this checks for a generated client control method before enabling V2.
  return promiseEffect(() => readFile(join(root, "typescript", "ClientRequest.ts"), "utf8")).pipe(
    Effect.map((requestSource) =>
      /"method":\s*"[^"]*(?:agent|collab)[^"]*"/u.test(requestSource)
        ? ("verified" as const)
        : ("unverified" as const),
    ),
    Effect.catchIf(
      () => true,
      () => Effect.succeed("unverified" as const),
    ),
  );
}

function verifyGeneratedArtifactInternal(
  options: GeneratedArtifactVerificationOptions,
): Effect.Effect<GeneratedArtifactVerification, unknown> {
  return Effect.gen(function* () {
    const root = resolve(options.artifactRoot ?? join(import.meta.dirname, "../generated"));
    const provenance = yield* readProvenance(root);
    const inventory = yield* collectInventory(root);
    if (inventory.count !== provenance.files.count || inventory.digest !== provenance.files.digest)
      return yield* Effect.fail(
        new CodexError(
          "protocol_mismatch",
          "Generated artifact provenance does not match its portable inventory digest.",
        ),
      );
    const version = provenance.codex_cli_version.slice("codex-cli ".length);
    if (provenance.protocol_epoch !== `codex-app-server-${version}`)
      return yield* Effect.fail(
        new CodexError(
          "protocol_mismatch",
          "Generated artifact provenance has mismatched Codex and protocol versions.",
        ),
      );
    const protocolSource = yield* promiseEffect(() =>
      readFile(join(root, "typescript", "protocol.ts"), "utf8"),
    );
    if (
      protocolSource !==
      `// GENERATED CODE! DO NOT MODIFY BY HAND!\n\nexport const CODEX_PROTOCOL_VERSION = "codex-cli-${version}" as const;\nexport const CODEX_PROTOCOL_EPOCH = "codex-app-server-${version}" as const;\n`
    )
      return yield* Effect.fail(
        new CodexError(
          "protocol_mismatch",
          "Generated protocol imports do not match the resolved Codex version.",
        ),
      );
    return {
      artifact_root: provenance.artifact_root,
      protocol_epoch: provenance.protocol_epoch,
      codex_cli_version: provenance.codex_cli_version,
      inventory,
      multi_agent_v2_lifecycle: yield* generatedV2LifecycleStatus(root),
    };
  });
}

/** Verify generated Codex artifact inventory, provenance, protocol, and lifecycle status. */
export async function verifyGeneratedArtifact(
  options: GeneratedArtifactVerificationOptions = {},
): Promise<GeneratedArtifactVerification> {
  return Effect.runPromise(
    verifyGeneratedArtifactInternal(options).pipe(
      Effect.mapError((error) =>
        error instanceof CodexError
          ? error
          : new CodexError(
              "protocol_mismatch",
              "The generated artifact could not be verified.",
              {},
              { cause: error },
            ),
      ),
    ),
  );
}

function promiseEffect<A>(operation: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

function decodeSchema<A, I>(
  schema: Schema.Codec<A, I>,
  input: unknown,
  label: string,
): Effect.Effect<A, CodexError> {
  const decoded = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);
  if (Result.isFailure(decoded))
    return Effect.fail(
      new CodexError("protocol_mismatch", `Invalid ${label}.`, {
        issue: String(decoded.failure),
      }),
    );
  return Effect.succeed(decoded.success);
}
