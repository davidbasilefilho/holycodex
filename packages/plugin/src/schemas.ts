// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
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

const PluginNameSchema = type(PLUGIN_NAME_PATTERN);
const SkillNameSchema = type(SKILL_NAME_PATTERN);
const VersionSchema = type(VERSION_PATTERN);
const SchemaEpochSchema = type(EPOCH_PATTERN);
const DigestSchema = type(DIGEST_PATTERN);
const PathSchema = type("string").narrow((value): value is string => {
  try {
    normalizeRelativePath(value);
    return true;
  } catch {
    return false;
  }
});
const DescriptionSchema = type("string").narrow(
  (value): value is string => value.length > 0 && value.length <= 300,
);
const SkillNamesSchema = type("string[]").narrow((value): value is string[] =>
  value.every((skill) => !(SkillNameSchema(skill) instanceof type.errors)),
);
const AssetPathsSchema = type("string[]").narrow((value): value is string[] =>
  value.every((asset) => !(PathSchema(asset) instanceof type.errors)),
);

export const SourceManifestSchema = type({
  "+": "reject",
  name: PluginNameSchema,
  description: DescriptionSchema,
  "license?": "string",
  "skills?": SkillNamesSchema,
  "assets?": AssetPathsSchema,
});
export type SourceManifest = typeof SourceManifestSchema.infer;

export const GeneratedManifestSchema = type({
  "+": "reject",
  name: PluginNameSchema,
  version: VersionSchema,
  description: DescriptionSchema,
  "license?": "string",
  "skills?": SkillNamesSchema,
  "assets?": AssetPathsSchema,
});
export type GeneratedManifest = typeof GeneratedManifestSchema.infer;
export const SourcePluginManifestSchema = SourceManifestSchema;
export const GeneratedPluginManifestSchema = GeneratedManifestSchema;
export type GeneratedPluginManifest = GeneratedManifest;

const PayloadFileSchema = type({
  "+": "reject",
  path: PathSchema,
  size: "number.integer >= 0",
  sha256: DigestSchema,
});
const PayloadFilesSchema = PayloadFileSchema.array();
export type PayloadFile = typeof PayloadFileSchema.infer;

export const PayloadIdentitySchema = type({
  "+": "reject",
  version: VersionSchema,
  digest: DigestSchema,
  epoch: SchemaEpochSchema,
});
export type PayloadIdentity = typeof PayloadIdentitySchema.infer;
export type ArtifactIdentity = PayloadIdentity;

export const PayloadManifestSchema = type({
  "+": "reject",
  schema_epoch: SchemaEpochSchema,
  version: VersionSchema,
  files: PayloadFilesSchema,
  payload_digest: DigestSchema,
  identity: PayloadIdentitySchema,
});
export type PayloadManifest = typeof PayloadManifestSchema.infer;

const AssemblyRequestSchema = type({
  "+": "reject",
  sourceRoot: type("string").narrow(isUsableDirectoryText),
  stagingDirectory: type("string").narrow(isUsableDirectoryText),
  version: VersionSchema,
  "schemaEpoch?": SchemaEpochSchema,
});
export type AssemblyRequest = typeof AssemblyRequestSchema.infer;

export function parseAssemblyRequest(input: unknown): AssemblyRequest {
  const parsed = AssemblyRequestSchema(input);
  if (parsed instanceof type.errors) {
    throw pluginError("source_invalid", "Assembly options are invalid.", {
      summary: parsed.summary,
    });
  }
  return parsed;
}

export function parseDirectoryText(input: unknown, field: string): string {
  const parsed = type("string").narrow(isUsableDirectoryText)(input);
  if (parsed instanceof type.errors) {
    throw pluginError("source_invalid", `The ${field} path is invalid.`, { field });
  }
  return parsed;
}

export function parsePayloadLocation(input: unknown): string {
  const direct = type("string").narrow(isUsableDirectoryText)(input);
  if (!(direct instanceof type.errors)) {
    return direct;
  }
  const parsed = type({
    "+": "reject",
    stagingDirectory: type("string").narrow(isUsableDirectoryText),
  })(input);
  if (parsed instanceof type.errors) {
    throw pluginError("payload_invalid", "The payload location is invalid.", {
      summary: parsed.summary,
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
  const parsed = SourceManifestSchema(input);
  if (parsed instanceof type.errors) {
    throw pluginError("manifest_invalid", "The source plugin manifest is invalid.", {
      summary: parsed.summary,
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
  const parsed = GeneratedManifestSchema(input);
  if (parsed instanceof type.errors) {
    throw pluginError("payload_invalid", "The generated plugin manifest is invalid.", {
      summary: parsed.summary,
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
  const parsed = PayloadManifestSchema(input);
  if (parsed instanceof type.errors) {
    throw pluginError("payload_invalid", "The payload manifest is invalid.", {
      summary: parsed.summary,
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
  if (new Set(skills).size !== skills.length || new Set(assets).size !== assets.length) {
    throw pluginError("manifest_invalid", "Manifest asset declarations must be unique.");
  }
  const seen = new Set<string>();
  for (const asset of assets) {
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
