// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { decodeUnknown } from "@holycodex/core";
import { readPayloadFile, readSourceFile, assertSafePath, comparePathText } from "./source.ts";
import {
  DIGEST_PATTERN,
  EPOCH_PATTERN,
  PAYLOAD_MANIFEST_PATH,
  PLUGIN_NAME_PATTERN,
  SKILL_NAME_PATTERN,
  SOURCE_MANIFEST_PATH,
  VERSION_PATTERN,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import { normalizeRelativePath } from "./source.ts";

const PluginNameSchema = Schema.String.pipe(Schema.pattern(PLUGIN_NAME_PATTERN));
const SkillNameSchema = Schema.String.pipe(Schema.pattern(SKILL_NAME_PATTERN));
const VersionSchema = Schema.String.pipe(Schema.pattern(VERSION_PATTERN));
const SchemaEpochSchema = Schema.String.pipe(Schema.pattern(EPOCH_PATTERN));
const DigestSchema = Schema.String.pipe(Schema.pattern(DIGEST_PATTERN));
const PathSchema = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      normalizeRelativePath(value);
      return true;
    } catch {
      return false;
    }
  }),
);
const DescriptionSchema = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 && value.length <= 300),
);
const SkillNamesSchema = Schema.Array(SkillNameSchema);
const AssetPathsSchema = Schema.Array(PathSchema);
const CapabilityAssetPathsSchema = Schema.Array(PathSchema);

export const SourceManifestSchema = Schema.Struct({
  name: PluginNameSchema,
  description: DescriptionSchema,
  license: Schema.optional(Schema.String),
  skills: Schema.optional(SkillNamesSchema),
  assets: Schema.optional(AssetPathsSchema),
  hooks: Schema.optional(CapabilityAssetPathsSchema),
  rules: Schema.optional(CapabilityAssetPathsSchema),
  compaction: Schema.optional(CapabilityAssetPathsSchema),
});
export type SourceManifest = typeof SourceManifestSchema.Type;

export const GeneratedManifestSchema = Schema.Struct({
  name: PluginNameSchema,
  version: VersionSchema,
  description: DescriptionSchema,
  license: Schema.optional(Schema.String),
  skills: Schema.optional(SkillNamesSchema),
  assets: Schema.optional(AssetPathsSchema),
  hooks: Schema.optional(CapabilityAssetPathsSchema),
  rules: Schema.optional(CapabilityAssetPathsSchema),
  compaction: Schema.optional(CapabilityAssetPathsSchema),
});
export type GeneratedManifest = typeof GeneratedManifestSchema.Type;
export const SourcePluginManifestSchema = SourceManifestSchema;
export const GeneratedPluginManifestSchema = GeneratedManifestSchema;
export type GeneratedPluginManifest = GeneratedManifest;

const PayloadFileSchema = Schema.Struct({
  path: PathSchema,
  size: Schema.Number.pipe(Schema.filter((value) => Number.isSafeInteger(value) && value >= 0)),
  sha256: DigestSchema,
});
const PayloadFilesSchema = Schema.Array(PayloadFileSchema);
export type PayloadFile = typeof PayloadFileSchema.Type;

export const PayloadIdentitySchema = Schema.Struct({
  version: VersionSchema,
  digest: DigestSchema,
  epoch: SchemaEpochSchema,
});
export type PayloadIdentity = typeof PayloadIdentitySchema.Type;
export type ArtifactIdentity = PayloadIdentity;

export const PayloadManifestSchema = Schema.Struct({
  schema_epoch: SchemaEpochSchema,
  version: VersionSchema,
  files: PayloadFilesSchema,
  payload_digest: DigestSchema,
  identity: PayloadIdentitySchema,
});
export type PayloadManifest = typeof PayloadManifestSchema.Type;

const AssemblyRequestSchema = Schema.Struct({
  sourceRoot: Schema.String.pipe(Schema.filter(isUsableDirectoryText)),
  stagingDirectory: Schema.String.pipe(Schema.filter(isUsableDirectoryText)),
  version: VersionSchema,
  schemaEpoch: Schema.optional(SchemaEpochSchema),
});
export type AssemblyRequest = typeof AssemblyRequestSchema.Type;

export function decodeSchema<T>(schema: Schema.Schema<T>, input: unknown): T | undefined {
  const parsed = decodeUnknown(schema, input);
  return Either.isRight(parsed) ? parsed.right : undefined;
}

export function parseAssemblyRequest(input: unknown): AssemblyRequest {
  const parsed = decodeSchema(AssemblyRequestSchema, input);
  if (parsed === undefined) {
    throw pluginError("source_invalid", "Assembly options are invalid.", {
      summary: "Effect Schema rejected the assembly options.",
    });
  }
  return parsed;
}

export function parseDirectoryText(input: unknown, field: string): string {
  const parsed = decodeSchema(Schema.String.pipe(Schema.filter(isUsableDirectoryText)), input);
  if (parsed === undefined) {
    throw pluginError("source_invalid", `The ${field} path is invalid.`, { field });
  }
  return parsed;
}

export function parsePayloadLocation(input: unknown): string {
  const direct = decodeSchema(Schema.String.pipe(Schema.filter(isUsableDirectoryText)), input);
  if (direct !== undefined) {
    return direct;
  }
  const parsed = decodeSchema(
    Schema.Struct({ stagingDirectory: Schema.String.pipe(Schema.filter(isUsableDirectoryText)) }),
    input,
  );
  if (parsed === undefined) {
    throw pluginError("payload_invalid", "The payload location is invalid.", {
      summary: "Effect Schema rejected the payload location.",
    });
  }
  return parsed.stagingDirectory;
}

export async function readSourceManifest(root: string): Promise<SourceManifest> {
  const bytes = await readSourceFile(root, SOURCE_MANIFEST_PATH);
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    throw pluginError(
      "manifest_invalid",
      "The source plugin manifest is not valid JSON.",
      {},
      error,
    );
  }
  const parsed = decodeSchema(SourceManifestSchema, input);
  if (parsed === undefined) {
    throw pluginError("manifest_invalid", "The source plugin manifest is invalid.", {
      summary: "Effect Schema rejected the source manifest.",
    });
  }
  if (containsMcpDeclaration(input)) {
    throw pluginError(
      "manifest_invalid",
      "Plugin source manifests cannot declare external servers.",
    );
  }
  validateManifestDeclarations(parsed);
  return parsed;
}

export async function readGeneratedManifest(root: string): Promise<GeneratedManifest> {
  const bytes = await readPayloadFile(root, SOURCE_MANIFEST_PATH);
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    throw pluginError(
      "payload_invalid",
      "The generated plugin manifest is not valid JSON.",
      {},
      error,
    );
  }
  const parsed = decodeSchema(GeneratedManifestSchema, input);
  if (parsed === undefined) {
    throw pluginError("payload_invalid", "The generated plugin manifest is invalid.", {
      summary: "Effect Schema rejected the generated manifest.",
    });
  }
  if (containsMcpDeclaration(input)) {
    throw pluginError(
      "payload_invalid",
      "Generated plugin manifests cannot declare external servers.",
    );
  }
  validateManifestDeclarations(parsed);
  return parsed;
}

export async function readPayloadManifest(root: string): Promise<PayloadManifest> {
  const bytes = await readPayloadFile(root, PAYLOAD_MANIFEST_PATH);
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error: unknown) {
    throw pluginError("payload_invalid", "The payload manifest is not valid JSON.", {}, error);
  }
  const parsed = decodeSchema(PayloadManifestSchema, input);
  if (parsed === undefined) {
    throw pluginError("payload_invalid", "The payload manifest is invalid.", {
      summary: "Effect Schema rejected the payload manifest.",
    });
  }
  const paths = parsed.files.map((file) => file.path);
  for (const path of paths) {
    assertSafePath(path);
  }
  if (paths.some((path, index) => path !== [...paths].sort(comparePathText)[index])) {
    throw pluginError("payload_invalid", "The payload file manifest is not sorted.");
  }
  if (new Set(paths).size !== paths.length || paths.includes(PAYLOAD_MANIFEST_PATH)) {
    throw pluginError("payload_invalid", "The payload file manifest contains invalid paths.");
  }
  return parsed;
}

export function validateManifestDeclarations(manifest: SourceManifest | GeneratedManifest): void {
  const skills = manifest.skills ?? [];
  const assets = manifest.assets ?? [];
  const hooks = manifest.hooks ?? [];
  const rules = manifest.rules ?? [];
  const compaction = manifest.compaction ?? [];
  const declared = [...assets, ...hooks, ...rules, ...compaction];
  if (new Set(skills).size !== skills.length || new Set(declared).size !== declared.length) {
    throw pluginError("manifest_invalid", "Manifest asset declarations must be unique.");
  }
  const seen = new Set<string>();
  for (const asset of declared) {
    const normalized = normalizeRelativePath(asset);
    if (normalized === SOURCE_MANIFEST_PATH || normalized === PAYLOAD_MANIFEST_PATH) {
      throw pluginError("manifest_invalid", "Generated metadata paths are reserved.", {
        path: normalized,
      });
    }
    if (seen.has(normalized)) {
      throw pluginError("manifest_invalid", "Manifest asset declarations must be canonical.", {
        path: normalized,
      });
    }
    seen.add(normalized);
  }
}

export function declaredSourcePaths(manifest: SourceManifest): Set<string> {
  const paths = new Set<string>([SOURCE_MANIFEST_PATH]);
  for (const asset of manifest.assets ?? []) {
    paths.add(normalizeRelativePath(asset));
  }
  for (const skill of manifest.skills ?? []) {
    paths.add(`skills/${skill}/SKILL.md`);
    paths.add(`skills/${skill}/agents/openai.yaml`);
  }
  for (const path of [
    ...(manifest.assets ?? []),
    ...(manifest.hooks ?? []),
    ...(manifest.rules ?? []),
    ...(manifest.compaction ?? []),
  ]) {
    paths.add(normalizeRelativePath(path));
  }
  return paths;
}

export function isUsableDirectoryText(value: string): boolean {
  return value.length > 0 && !value.includes("\u0000");
}

function containsMcpDeclaration(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsMcpDeclaration(item));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/mcp|model[_\s.-]?context[_\s.-]?protocol/iu.test(key)) {
      return true;
    }
    if (containsMcpDeclaration(child)) {
      return true;
    }
  }
  return false;
}
