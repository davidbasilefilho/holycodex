// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  BaseVersionSchema,
  CanonicalVersionSchema,
  ReleaseVersionSchema,
  canonicalBaseVersion,
  isCanonicalVersion,
} from "../packages/core/src/version.ts";

export {
  BaseVersionSchema,
  CanonicalVersionSchema,
  ReleaseVersionSchema,
} from "../packages/core/src/version.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");

/** Accepted release publication channels. */
export const ReleaseChannelSchema = Schema.Literals(["dev", "stable"]);
/** Schema for a full Git commit SHA used as release source identity. */
export const SourceShaSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
/** Schema for a lowercase SHA-256 digest. */
export const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const CanonicalManifestSchema = Schema.Struct({
  name: Schema.Literals(["holycodex"]),
  version: CanonicalVersionSchema,
});
const ManifestRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const PositiveIntegerTextSchema = Schema.String.check(
  Schema.isPattern(/^[1-9]\d*$/u),
  Schema.isMaxLength(15),
);
const StableTagSchema = Schema.String.check(
  Schema.makeFilter((value) => value.startsWith("v") && isCanonicalVersion(value.slice(1))),
);

/** Release publication channel accepted by the release workflows. */
export type ReleaseChannel = typeof ReleaseChannelSchema.Type;

/** Read and validate the canonical public package version. */
export function readCanonicalVersion(): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const manifestText = yield* Effect.tryPromise(() =>
      readFile(resolve(workspaceRoot, "packages/cli/package.json"), "utf8"),
    );
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(CanonicalManifestSchema),
      {
        onExcessProperty: "ignore",
      },
    )(manifestText);
    return manifest.version;
  });
}

/** Build and validate a development version from a base and run number. */
export function developmentVersion(
  baseVersion: string,
  runNumber: string,
  runAttempt: string,
): string {
  const canonical = decode(CanonicalVersionSchema, baseVersion, "the canonical version");
  const base = canonicalBaseVersion(canonical);
  const number = decode(PositiveIntegerTextSchema, runNumber, "the GitHub run number");
  const attempt = decode(PositiveIntegerTextSchema, runAttempt, "the GitHub run attempt");
  return `${base}-dev.${number}.${attempt}`;
}

/** Build and validate a stable release version from a tag. */
export function stableVersionFromTag(baseVersion: string, tagName: string): string {
  const canonical = decode(CanonicalVersionSchema, baseVersion, "the canonical version");
  const tag = decode(StableTagSchema, tagName, "the stable release tag");
  const version = tag.slice(1);
  if (version !== canonical) {
    throw new Error(`Stable tag ${tag} must match canonical version ${canonical}.`);
  }
  return version;
}

/** Assert that a release version matches its channel and canonical base. */
export function assertReleaseVersion(
  baseVersion: string,
  channel: ReleaseChannel,
  version: string,
): void {
  const canonical = decode(CanonicalVersionSchema, baseVersion, "the canonical version");
  const base = canonicalBaseVersion(canonical);
  const selectedChannel = decode(ReleaseChannelSchema, channel, "the release channel");
  const candidate = decode(ReleaseVersionSchema, version, "the release version");
  if (selectedChannel === "stable" && candidate !== canonical) {
    throw new Error(`Stable version ${candidate} must equal canonical version ${canonical}.`);
  }
  if (selectedChannel === "dev" && !candidate.startsWith(`${base}-dev.`)) {
    throw new Error(`Development version ${candidate} must derive from canonical version ${base}.`);
  }
}

/** Extracts and validates the stable three-part base from a release version. */
export function baseVersionFromRelease(version: string): string {
  const release = decode(ReleaseVersionSchema, version, "the release version");
  const base = release.split("-", 1)[0] ?? "";
  return decode(BaseVersionSchema, base, "the release base version");
}

function decode<A>(schema: Schema.Decoder<A>, value: unknown, label: string): A {
  const parsed = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(parsed)) {
    throw new Error(`${label} is invalid: ${String(parsed.failure)}`);
  }
  return parsed.success;
}

/** Decode the version fields while preserving manifest extension fields for updates. */
export function decodeVersionedManifest(
  input: unknown,
  schema: Schema.Decoder<Readonly<{ name: string; version: string }>> = CanonicalManifestSchema,
): Result.Result<
  Readonly<Record<string, unknown>> & Readonly<{ name: string; version: string }>,
  Schema.SchemaError
> {
  const record = Schema.decodeUnknownResult(ManifestRecordSchema, { onExcessProperty: "error" })(
    input,
  );
  if (Result.isFailure(record)) return Result.fail(record.failure);
  const manifest = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "ignore",
  })(record.success);
  if (Result.isFailure(manifest)) return Result.fail(manifest.failure);
  return Result.succeed({ ...record.success, ...manifest.success });
}

if (import.meta.main) {
  const argumentsSchema = Schema.Union([
    Schema.Tuple([Schema.Literals(["dev"]), PositiveIntegerTextSchema, PositiveIntegerTextSchema]),
    Schema.Tuple([Schema.Literals(["stable"]), StableTagSchema]),
  ]);
  const program = Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(argumentsSchema)(Bun.argv.slice(2));
    const canonicalVersion = yield* readCanonicalVersion();
    const version =
      parsed[0] === "dev"
        ? developmentVersion(canonicalVersion, parsed[1], parsed[2])
        : stableVersionFromTag(canonicalVersion, parsed[1]);
    console.log(version);
  });
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error(
            `Usage: bun scripts/release-version.ts <dev run-number run-attempt|stable vX.Y.Z[-n]>\n${Cause.pretty(cause)}`,
          );
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
