// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "@holycodex/core";
import * as Schema from "effect/Schema";

import { decodeSchema, isJsonObject } from "./schema.ts";
import { writeAtomicJson } from "./storage.ts";

const CanonicalVersionSchema = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?$/u),
);
const PublicVersionSchema = Schema.String.pipe(
  Schema.pattern(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*)|-dev\.[1-9]\d*\.[1-9]\d*)?$/u,
  ),
);
const PublicManifestSchema = Schema.declare(
  (
    value: unknown,
  ): value is JsonObject & { readonly name: "holycodex"; readonly version: string } =>
    isJsonObject(value) &&
    value["name"] === "holycodex" &&
    decodeSchema(PublicVersionSchema, value["version"]) !== undefined,
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

/** Read the canonical public package version from the validated manifest. */
export async function readCanonicalVersion(path = publicManifestPath): Promise<string> {
  return (await readPublicManifest(path))["version"];
}

/** Read the canonical version without an optional release suffix. */
export async function readCanonicalBaseVersion(path = publicManifestPath): Promise<string> {
  return (await readCanonicalVersion(path)).split("-", 1)[0] ?? "";
}

/** Resolve and optionally persist a canonical package version update. */
export async function updateCanonicalVersion(
  target: string,
  dryRun: boolean,
  path = publicManifestPath,
): Promise<Readonly<{ previous: string; next: string }>> {
  const manifest = await readPublicManifest(path);
  const previous = await readCanonicalBaseVersion(path);
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
  const parts = (current.split("-", 1)[0] ?? "").split(".");
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  return target === "minor" ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
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
