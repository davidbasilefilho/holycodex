// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BaseVersionSchema,
  CanonicalVersionSchema,
  ReleaseVersionSchema,
  resolveCanonicalVersion,
  type BaseVersion,
  type CanonicalVersion,
  type JsonObject,
  type ReleaseVersion,
} from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { writeAtomicJson } from "./storage.ts";

const PublicManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.Literals(["holycodex"]),
    version: ReleaseVersionSchema,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
type PublicManifest = typeof PublicManifestSchema.Type;

/** Public CLI value for public manifest path. */
export const publicManifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

/** Read and validate the public package manifest at the supplied path. */
export function readPublicManifest(
  path = publicManifestPath,
): Promise<PublicManifest & JsonObject> {
  return Effect.runPromise(readPublicManifestEffect(path));
}

/** Read and validate the public package manifest in Effect. */
export function readPublicManifestEffect(
  path = publicManifestPath,
): Effect.Effect<PublicManifest & JsonObject, unknown> {
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) => error,
    });
    return (yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.fromJsonString(PublicManifestSchema))(text),
      catch: () => new ManifestError("manifest_invalid", "The public package manifest is invalid."),
    })) as PublicManifest & JsonObject;
  });
}

/** Read the exact public release version, including a development release suffix. */
export function readPublicVersion(path = publicManifestPath): Promise<ReleaseVersion> {
  return Effect.runPromise(readPublicVersionEffect(path));
}

/** Read the exact public release version in Effect. */
export function readPublicVersionEffect(
  path = publicManifestPath,
): Effect.Effect<ReleaseVersion, unknown> {
  return Effect.map(readPublicManifestEffect(path), (manifest) => manifest["version"]);
}

/** Read the canonical public package version from the validated manifest. */
export function readCanonicalVersion(path = publicManifestPath): Promise<CanonicalVersion> {
  return Effect.runPromise(readCanonicalVersionEffect(path));
}

/** Read the canonical stable package version in Effect. */
export function readCanonicalVersionEffect(
  path = publicManifestPath,
): Effect.Effect<CanonicalVersion, unknown> {
  return Effect.flatMap(readPublicVersionEffect(path), (version) =>
    Schema.is(CanonicalVersionSchema)(version)
      ? Effect.succeed(version)
      : Effect.fail(
          new ManifestError(
            "manifest_invalid",
            "The public package manifest must use a canonical stable release version.",
          ),
        ),
  );
}

/** Read the canonical version without an optional release suffix. */
export function readCanonicalBaseVersion(path = publicManifestPath): Promise<BaseVersion> {
  return Effect.runPromise(readCanonicalBaseVersionEffect(path));
}

/** Read the canonical package version without a release suffix in Effect. */
export function readCanonicalBaseVersionEffect(
  path = publicManifestPath,
): Effect.Effect<BaseVersion, unknown> {
  return Effect.flatMap(readPublicVersionEffect(path), (version) => {
    const base = version.split("-", 1)[0];
    return Schema.is(BaseVersionSchema)(base)
      ? Effect.succeed(base)
      : Effect.fail(
          new ManifestError(
            "manifest_invalid",
            "The public package manifest must use a canonical release base version.",
          ),
        );
  });
}

/** Read the exact release version recorded for an installation. */
export function readInstallationVersion(path = publicManifestPath): Promise<ReleaseVersion> {
  return Effect.runPromise(readInstallationVersionEffect(path));
}

/** Read the installed release version in Effect. */
export function readInstallationVersionEffect(
  path = publicManifestPath,
): Effect.Effect<ReleaseVersion, unknown> {
  return readPublicVersionEffect(path);
}

/** Resolve and optionally persist a canonical package version update. */
export function updateCanonicalVersion(
  target: string,
  dryRun: boolean,
  path = publicManifestPath,
): Promise<Readonly<{ previous: string; next: string }>> {
  return Effect.runPromise(updateCanonicalVersionEffect(target, dryRun, path));
}

/** Resolve and optionally persist a canonical package version update in Effect. */
export function updateCanonicalVersionEffect(
  target: string,
  dryRun: boolean,
  path = publicManifestPath,
): Effect.Effect<Readonly<{ previous: string; next: string }>, unknown> {
  return Effect.gen(function* () {
    const manifest = yield* readPublicManifestEffect(path);
    const previous = yield* readCanonicalVersionEffect(path);
    const next = yield* resolveVersionEffect(target, previous);
    if (!dryRun)
      yield* Effect.tryPromise({
        try: () => writeAtomicJson(path, { ...manifest, version: next }),
        catch: (error) => error,
      });
    return { previous, next };
  });
}

/** Resolve a version target and return failures in Effect. */
export function resolveVersionEffect(
  target: string,
  current: string,
): Effect.Effect<string, ManifestError> {
  if (target !== "patch" && target !== "minor") {
    return Schema.is(CanonicalVersionSchema)(target)
      ? Effect.succeed(target)
      : Effect.fail(new ManifestError("version_invalid", "The version target is invalid."));
  }
  return Effect.try({
    try: () => resolveCanonicalVersion(target, current),
    catch: (error: unknown) =>
      new ManifestError(
        "version_invalid",
        error instanceof Error ? error.message : "The current version is invalid.",
      ),
  });
}

/** Resolve an explicit version or the next patch or minor version. */
export function resolveVersion(target: string, current: string): string {
  return Effect.runSync(resolveVersionEffect(target, current));
}

/** Structured failure raised while reading or validating an install manifest. */
export class ManifestError extends Error {
  /** The code in public manifest. */
  readonly code: "manifest_invalid" | "version_invalid";

  constructor(code: "manifest_invalid" | "version_invalid", message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}
