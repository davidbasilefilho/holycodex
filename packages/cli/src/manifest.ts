// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { type JsonObject } from "@holycodex/core";
import { writeAtomicJson } from "./storage.ts";

const VersionSchema = type(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const PublicManifestSchema = type({
  "+": "ignore",
  name: "'holycodex'",
  version: VersionSchema,
});
type PublicManifest = typeof PublicManifestSchema.infer;

export const publicManifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

export async function readPublicManifest(
  path = publicManifestPath,
): Promise<PublicManifest & JsonObject> {
  const parsedJson: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = PublicManifestSchema(parsedJson);
  if (parsed instanceof type.errors) {
    throw new ManifestError("manifest_invalid", "The public package manifest is invalid.");
  }
  return parsed;
}

export async function readCanonicalVersion(path = publicManifestPath): Promise<string> {
  return (await readPublicManifest(path)).version;
}

export async function updateCanonicalVersion(
  target: string,
  dryRun: boolean,
  path = publicManifestPath,
): Promise<Readonly<{ previous: string; next: string }>> {
  const manifest = await readPublicManifest(path);
  const next = resolveVersion(target, manifest.version);
  if (!dryRun) {
    await writeAtomicJson(path, { ...manifest, version: next });
  }
  return { previous: manifest.version, next };
}

export function resolveVersion(target: string, current: string): string {
  if (target !== "patch" && target !== "minor") {
    if (VersionSchema(target) instanceof type.errors) {
      throw new ManifestError("version_invalid", "The version target is invalid.");
    }
    return target;
  }
  const parts = current.split(".");
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  return target === "minor" ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
}

export class ManifestError extends Error {
  readonly code: "manifest_invalid" | "version_invalid";

  constructor(code: "manifest_invalid" | "version_invalid", message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}
