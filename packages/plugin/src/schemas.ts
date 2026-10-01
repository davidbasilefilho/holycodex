// SPDX-License-Identifier: Apache-2.0

import { CanonicalVersionSchema, decodeUnknown } from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  DIGEST_PATTERN,
  EPOCH_PATTERN,
  PAYLOAD_MANIFEST_PATH,
  PLUGIN_NAME_PATTERN,
  SOURCE_MANIFEST_PATH,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import type { PluginError, PluginErrorCode } from "./errors.ts";
import {
  readPayloadFileEffect,
  readSourceFileEffect,
  assertSafePath,
  comparePathText,
  isNormalizableRelativePath,
} from "./source.ts";
import { normalizeRelativePath } from "./source.ts";

const PluginNameSchema = Schema.String.check(Schema.isPattern(PLUGIN_NAME_PATTERN));
const VersionSchema = CanonicalVersionSchema;
const SchemaEpochSchema = Schema.String.check(Schema.isPattern(EPOCH_PATTERN));
const DigestSchema = Schema.String.check(Schema.isPattern(DIGEST_PATTERN));
const PathSchema = Schema.String.check(Schema.makeFilter(isNormalizableRelativePath));
const DescriptionSchema = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && value.length <= 300),
);
const SkillRootSchema = Schema.Literals(["skills", "./skills", "skills/"]);
const AuthorSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  email: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});
const InterfaceSchema = Schema.Struct({
  displayName: Schema.String.check(Schema.isMinLength(1)),
  shortDescription: Schema.String.check(Schema.isMinLength(1)),
  longDescription: Schema.String.check(Schema.isMinLength(1)),
  developerName: Schema.String.check(Schema.isMinLength(1)),
  category: Schema.String.check(Schema.isMinLength(1)),
  capabilities: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  defaultPrompt: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
});
/** Schema for the checked-in plugin manifest accepted as packaging input. */
export const SourceManifestSchema = Schema.Struct({
  name: PluginNameSchema,
  version: VersionSchema,
  description: DescriptionSchema,
  author: AuthorSchema,
  homepage: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  skills: SkillRootSchema,
  interface: InterfaceSchema,
});
/** Validated fields of a checked-in plugin source manifest. */
export type SourceManifest = typeof SourceManifestSchema.Type;

/** Schema for the plugin manifest embedded in an assembled payload. */
export const GeneratedManifestSchema = Schema.Struct({
  name: PluginNameSchema,
  version: VersionSchema,
  description: DescriptionSchema,
  author: AuthorSchema,
  homepage: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  skills: SkillRootSchema,
  interface: InterfaceSchema,
});
/** Validated fields of a generated plugin manifest. */
export type GeneratedManifest = typeof GeneratedManifestSchema.Type;
/** Source manifest schema under its plugin-specific compatibility name. */
export const SourcePluginManifestSchema = SourceManifestSchema;
/** Generated manifest schema under its plugin-specific compatibility name. */
export const GeneratedPluginManifestSchema = GeneratedManifestSchema;
/** Generated plugin manifest type under its plugin-specific compatibility name. */
export type GeneratedPluginManifest = GeneratedManifest;

const PayloadFileSchema = Schema.Struct({
  path: PathSchema,
  size: Schema.Number.check(
    Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
  ),
  sha256: DigestSchema,
});
const PayloadFilesSchema = Schema.Array(PayloadFileSchema);
/** Relative path, byte length, and content digest for one payload file. */
export type PayloadFile = typeof PayloadFileSchema.Type;

/** Schema for the immutable version, digest, and epoch payload identity. */
export const PayloadIdentitySchema = Schema.Struct({
  version: VersionSchema,
  digest: DigestSchema,
  epoch: SchemaEpochSchema,
});
/** Validated identity that uniquely describes a plugin payload. */
export type PayloadIdentity = typeof PayloadIdentitySchema.Type;
/** Payload identity exposed under its artifact-specific compatibility name. */
export type ArtifactIdentity = PayloadIdentity;

/** Schema for the complete staged payload manifest and its file inventory. */
export const PayloadManifestSchema = Schema.Struct({
  schema_epoch: SchemaEpochSchema,
  version: VersionSchema,
  files: PayloadFilesSchema,
  payload_digest: DigestSchema,
  identity: PayloadIdentitySchema,
});
/** Validated integrity manifest stored alongside an assembled payload. */
export type PayloadManifest = typeof PayloadManifestSchema.Type;

const AssemblyRequestSchema = Schema.Struct({
  sourceRoot: Schema.String.check(Schema.makeFilter(isUsableDirectoryText)),
  stagingDirectory: Schema.String.check(Schema.makeFilter(isUsableDirectoryText)),
  version: VersionSchema,
  schemaEpoch: Schema.optional(SchemaEpochSchema),
});
/** Validated source and staging paths and version options for assembly. */
export type AssemblyRequest = typeof AssemblyRequestSchema.Type;

/** Decode unknown input with an Effect Schema and return undefined on rejection. */
export function decodeSchema<T>(schema: Schema.Codec<T, unknown>, input: unknown): T | undefined {
  const parsed = decodeUnknown(schema, input);
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}

/** Parse and validate an assembly request at the plugin boundary. */
export function parseAssemblyRequest(input: unknown): AssemblyRequest {
  const parsed = decodeSchema(AssemblyRequestSchema, input);
  if (parsed === undefined) {
    throw pluginError("source_invalid", "Assembly options are invalid.", {
      summary: "Effect Schema rejected the assembly options.",
    });
  }
  return parsed;
}

/** Parse a non-empty directory path supplied through an unknown boundary value. */
export function parseDirectoryText(input: unknown, field: string): string {
  const parsed = decodeSchema(Schema.String.check(Schema.makeFilter(isUsableDirectoryText)), input);
  if (parsed === undefined) {
    throw pluginError("source_invalid", `The ${field} path is invalid.`, { field });
  }
  return parsed;
}

/** Parse a staged payload location from a string or request-shaped value. */
export function parsePayloadLocation(input: unknown): string {
  const direct = decodeSchema(Schema.String.check(Schema.makeFilter(isUsableDirectoryText)), input);
  if (direct !== undefined) {
    return direct;
  }
  const parsed = decodeSchema(
    Schema.Struct({
      stagingDirectory: Schema.String.check(Schema.makeFilter(isUsableDirectoryText)),
    }),
    input,
  );
  if (parsed === undefined) {
    throw pluginError("payload_invalid", "The payload location is invalid.", {
      summary: "Effect Schema rejected the payload location.",
    });
  }
  return parsed.stagingDirectory;
}

/** Read and validate the checked-in source plugin manifest. */
export function readSourceManifest(root: string): Promise<SourceManifest> {
  return Effect.runPromise(readSourceManifestEffect(root));
}

/** Read and decode the checked-in source manifest in the plugin effect domain. */
export function readSourceManifestEffect(root: string): Effect.Effect<SourceManifest, PluginError> {
  return Effect.gen(function* () {
    const bytes = yield* readSourceFileEffect(root, SOURCE_MANIFEST_PATH);
    const input = yield* decodeManifestJson(
      bytes,
      "manifest_invalid",
      "The source plugin manifest is not valid JSON.",
    );
    const parsed = decodeSchema(SourceManifestSchema, input);
    if (parsed === undefined) {
      return yield* Effect.fail(
        pluginError("manifest_invalid", "The source plugin manifest is invalid.", {
          summary: "Effect Schema rejected the source manifest.",
        }),
      );
    }
    if (containsMcpDeclaration(input)) {
      return yield* Effect.fail(
        pluginError("manifest_invalid", "Plugin source manifests cannot declare external servers."),
      );
    }
    if (
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Object.keys(input).some((key) => !OFFICIAL_MANIFEST_KEYS.has(key))
    ) {
      return yield* Effect.fail(
        pluginError("manifest_invalid", "The source plugin manifest contains unsupported fields."),
      );
    }
    yield* Effect.try({
      try: () => validateManifestDeclarations(parsed),
      catch: (error) => error as PluginError,
    });
    return parsed;
  });
}

/** Read and validate the generated plugin manifest from a staged payload. */
export function readGeneratedManifest(root: string): Promise<GeneratedManifest> {
  return Effect.runPromise(readGeneratedManifestEffect(root));
}

/** Read and decode generated metadata in the plugin effect domain. */
export function readGeneratedManifestEffect(
  root: string,
): Effect.Effect<GeneratedManifest, PluginError> {
  return Effect.gen(function* () {
    const bytes = yield* readPayloadFileEffect(root, SOURCE_MANIFEST_PATH);
    const input = yield* decodeManifestJson(
      bytes,
      "payload_invalid",
      "The generated plugin manifest is not valid JSON.",
    );
    const parsed = decodeSchema(GeneratedManifestSchema, input);
    if (parsed === undefined) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The generated plugin manifest is invalid.", {
          summary: "Effect Schema rejected the generated manifest.",
        }),
      );
    }
    if (containsMcpDeclaration(input)) {
      return yield* Effect.fail(
        pluginError(
          "payload_invalid",
          "Generated plugin manifests cannot declare external servers.",
        ),
      );
    }
    yield* Effect.try({
      try: () => validateManifestDeclarations(parsed),
      catch: (error) => error as PluginError,
    });
    return parsed;
  });
}

/** Read and validate the payload file manifest from a staging directory. */
export function readPayloadManifest(root: string): Promise<PayloadManifest> {
  return Effect.runPromise(readPayloadManifestEffect(root));
}

/** Read and verify the staged file inventory in the plugin effect domain. */
export function readPayloadManifestEffect(
  root: string,
): Effect.Effect<PayloadManifest, PluginError> {
  return Effect.gen(function* () {
    const bytes = yield* readPayloadFileEffect(root, PAYLOAD_MANIFEST_PATH);
    const input = yield* decodeManifestJson(
      bytes,
      "payload_invalid",
      "The payload manifest is not valid JSON.",
    );
    const parsed = decodeSchema(PayloadManifestSchema, input);
    if (parsed === undefined) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The payload manifest is invalid.", {
          summary: "Effect Schema rejected the payload manifest.",
        }),
      );
    }
    const paths = parsed.files.map((file) => file.path);
    yield* Effect.try({
      try: () => {
        for (const path of paths) assertSafePath(path);
      },
      catch: (error) => error as PluginError,
    });
    if (paths.some((path, index) => path !== [...paths].sort(comparePathText)[index])) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The payload file manifest is not sorted."),
      );
    }
    if (new Set(paths).size !== paths.length || paths.includes(PAYLOAD_MANIFEST_PATH)) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The payload file manifest contains invalid paths."),
      );
    }
    return parsed;
  });
}

function decodeManifestJson(
  bytes: Uint8Array,
  code: PluginErrorCode,
  message: string,
): Effect.Effect<unknown, PluginError> {
  return Effect.try({
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    catch: (error) => pluginError(code, message, {}, error),
  });
}

/** Validate manifest declarations that control the plugin asset tree. */
export function validateManifestDeclarations(manifest: SourceManifest | GeneratedManifest): void {
  if (
    manifest.skills !== "skills" &&
    manifest.skills !== "./skills" &&
    manifest.skills !== "skills/"
  ) {
    throw pluginError("manifest_invalid", "The plugin skills path must resolve to `skills`.");
  }
}

/** Return the manifest and declared skill paths accepted for a source tree. */
export function declaredSourcePaths(
  _manifest: SourceManifest | GeneratedManifest,
  candidates: readonly string[] = [],
): Set<string> {
  const paths = new Set<string>([SOURCE_MANIFEST_PATH]);
  for (const candidate of candidates) {
    const normalized = normalizeRelativePath(candidate);
    if (isPayloadAssetPath(normalized)) {
      paths.add(normalized);
    }
  }
  return paths;
}

const OFFICIAL_MANIFEST_KEYS = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "interface",
]);

function isPayloadAssetPath(path: string): boolean {
  return path.startsWith("skills/");
}

/** Return whether a directory input is non-empty and free of NUL characters. */
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
