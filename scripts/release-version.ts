// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");

export const BaseVersionSchema = Schema.String.pipe(
  Schema.pattern(/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
);
export const ReleaseVersionSchema = Schema.String.pipe(
  Schema.pattern(/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-dev\.[1-9]\d*\.[1-9]\d*)?$/u),
);
export const ReleaseChannelSchema = Schema.Literal("dev", "stable");
export const SourceShaSchema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/u));
export const Sha256Schema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));

const CanonicalManifestSchema = Schema.Struct({
  name: Schema.Literal("holycodex"),
  version: BaseVersionSchema,
});
const PositiveIntegerTextSchema = Schema.String.pipe(
  Schema.pattern(/^[1-9]\d*$/u),
  Schema.maxLength(15),
);
const StableTagSchema = Schema.String.pipe(Schema.pattern(/^v0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u));

export type ReleaseChannel = typeof ReleaseChannelSchema.Type;

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

export function developmentVersion(
  baseVersion: string,
  runNumber: string,
  runAttempt: string,
): string {
  const base = decode(BaseVersionSchema, baseVersion, "the canonical base version");
  const number = decode(PositiveIntegerTextSchema, runNumber, "the GitHub run number");
  const attempt = decode(PositiveIntegerTextSchema, runAttempt, "the GitHub run attempt");
  return `${base}-dev.${number}.${attempt}`;
}

export function stableVersionFromTag(baseVersion: string, tagName: string): string {
  const base = decode(BaseVersionSchema, baseVersion, "the canonical base version");
  const tag = decode(StableTagSchema, tagName, "the stable release tag");
  const version = tag.slice(1);
  if (version !== base) {
    throw new Error(`Stable tag ${tag} must match canonical version ${base}.`);
  }
  return version;
}

export function assertReleaseVersion(
  baseVersion: string,
  channel: ReleaseChannel,
  version: string,
): void {
  const base = decode(BaseVersionSchema, baseVersion, "the canonical base version");
  const selectedChannel = decode(ReleaseChannelSchema, channel, "the release channel");
  const candidate = decode(ReleaseVersionSchema, version, "the release version");
  if (selectedChannel === "stable" && candidate !== base) {
    throw new Error(`Stable version ${candidate} must equal canonical version ${base}.`);
  }
  if (selectedChannel === "dev" && !candidate.startsWith(`${base}-dev.`)) {
    throw new Error(`Development version ${candidate} must derive from canonical version ${base}.`);
  }
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
        "Usage: bun scripts/release-version.ts <dev run-number run-attempt|stable vX.Y.Z>",
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
