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
import * as Schema from "effect/Schema";

import { decodeSchema, isJsonObject } from "./schema.ts";
import { writeAtomicJson } from "./storage.ts";

const PublicManifestSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & {
    readonly name: "holycodex";
    readonly version: ReleaseVersion;
  } =>
    isJsonObject(value) &&
    value["name"] === "holycodex" &&
    decodeSchema(ReleaseVersionSchema, value["version"]) !== undefined,
);
type PublicManifest = typeof PublicManifestSchema.Type;

export const publicManifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

/** Read and validate the public package manifest at the supplied path. */
export async function readPublicManifest(
  path = publicManifestPath,
): Promise<PublicManifest & JsonObject> {
  const parsedJson: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = decodeSchema(PublicManifestSchema, parsedJson);
  if (parsed === undefined) {
    throw new ManifestError("manifest_invalid", "The public package manifest is invalid.");
  }
  return parsed;
}

/** Read the exact public release version, including a development release suffix. */
export async function readPublicVersion(path = publicManifestPath): Promise<ReleaseVersion> {
  const version = (await readPublicManifest(path))["version"];
  const release = decodeSchema(ReleaseVersionSchema, version);
  if (release === undefined) {
    throw new ManifestError("manifest_invalid", "The public package manifest version is invalid.");
  }
  return release;
}

/** Read the canonical public package version from the validated manifest. */
export async function readCanonicalVersion(path = publicManifestPath): Promise<CanonicalVersion> {
  const version = await readPublicVersion(path);
  const canonical = decodeSchema(CanonicalVersionSchema, version);
  if (canonical === undefined) {
    throw new ManifestError(
      "manifest_invalid",
      "The public package manifest must use a canonical stable release version.",
    );
  }
  return canonical;
}

/** Read the canonical version without an optional release suffix. */
export async function readCanonicalBaseVersion(path = publicManifestPath): Promise<BaseVersion> {
  const version = await readPublicVersion(path);
  const base = version.split("-", 1)[0];
  const canonical = decodeSchema(BaseVersionSchema, base);
  if (canonical === undefined) {
    throw new ManifestError(
      "manifest_invalid",
      "The public package manifest must use a canonical release base version.",
    );
  }
  return canonical;
}

/** Read the exact release version recorded for an installation. */
export async function readInstallationVersion(path = publicManifestPath): Promise<ReleaseVersion> {
  return await readPublicVersion(path);
}

/** Resolve and optionally persist a canonical package version update. */
export async function updateCanonicalVersion(
  target: string,
  dryRun: boolean,
  path = publicManifestPath,
): Promise<Readonly<{ previous: string; next: string }>> {
  const manifest = await readPublicManifest(path);
  const previous = await readCanonicalVersion(path);
  const next = resolveVersion(target, previous);
  if (!dryRun) {
    await writeAtomicJson(path, { ...manifest, version: next });
  }
  return { previous, next };
}

/** Resolve an explicit version or the next patch or minor version. */
export function resolveVersion(target: string, current: string): string {
  if (target !== "patch" && target !== "minor") {
    if (decodeSchema(CanonicalVersionSchema, target) === undefined) {
      throw new ManifestError("version_invalid", "The version target is invalid.");
    }
    return target;
  }
  try {
    return resolveCanonicalVersion(target, current);
  } catch (error: unknown) {
    throw new ManifestError(
      "version_invalid",
      error instanceof Error ? error.message : "The current version is invalid.",
    );
  }
}

/** Structured failure raised while reading or validating an install manifest. */
export class ManifestError extends Error {
  readonly code: "manifest_invalid" | "version_invalid";

  constructor(code: "manifest_invalid" | "version_invalid", message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}
