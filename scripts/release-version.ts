// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as Either from "effect/Either";
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

export const ReleaseChannelSchema = Schema.Literal("dev", "stable");
export const SourceShaSchema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/u));
export const Sha256Schema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));

const CanonicalManifestSchema = Schema.Struct({
  name: Schema.Literal("holycodex"),
  version: CanonicalVersionSchema,
});
const PositiveIntegerTextSchema = Schema.String.pipe(
  Schema.pattern(/^[1-9]\d*$/u),
  Schema.maxLength(15),
);
const StableTagSchema = Schema.String.pipe(
  Schema.filter((value) => value.startsWith("v") && isCanonicalVersion(value.slice(1))),
);

export type ReleaseChannel = typeof ReleaseChannelSchema.Type;

/** Read and validate the canonical public package version. */
export async function readCanonicalVersion(): Promise<string> {
  const raw: unknown = JSON.parse(
    await readFile(resolve(workspaceRoot, "packages/cli/package.json"), "utf8"),
  );
  const parsed = Schema.decodeUnknownEither(CanonicalManifestSchema, {
    onExcessProperty: "preserve",
  })(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`The canonical public package manifest is invalid: ${String(parsed.left)}`);
  }
  return parsed.right.version;
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

function decode<A>(schema: Schema.Schema<A>, value: unknown, label: string): A {
  const parsed = Schema.decodeUnknownEither(schema)(value);
  if (Either.isLeft(parsed)) {
    throw new Error(`${label} is invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
}

if (import.meta.main) {
  try {
    const rawArguments: unknown = Bun.argv.slice(2);
    const parsed = Schema.decodeUnknownEither(
      Schema.Union(
        Schema.Tuple(Schema.Literal("dev"), PositiveIntegerTextSchema, PositiveIntegerTextSchema),
        Schema.Tuple(Schema.Literal("stable"), StableTagSchema),
      ),
      { onExcessProperty: "error" },
    )(rawArguments);
    if (Either.isLeft(parsed)) {
      throw new Error(
        "Usage: bun scripts/release-version.ts <dev run-number run-attempt|stable vX.Y.Z[-n]>",
      );
    }
    const canonicalVersion = await readCanonicalVersion();
    const version =
      parsed.right[0] === "dev"
        ? developmentVersion(canonicalVersion, parsed.right[1], parsed.right[2])
        : stableVersionFromTag(canonicalVersion, parsed.right[1]);
    console.log(version);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "release version resolution failed");
    process.exitCode = 1;
  }
}
