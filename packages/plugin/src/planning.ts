// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import * as Effect from "effect/Effect";

import {
  DEFAULT_SCHEMA_EPOCH,
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  pluginSourceRoot,
  SOURCE_MANIFEST_PATH,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import type { PluginError } from "./errors.ts";
import {
  GeneratedManifestSchema,
  decodeSchema,
  parseAssemblyRequest,
  parseDirectoryText,
  readSourceManifestEffect,
  declaredSourcePaths,
} from "./schemas.ts";
import type { GeneratedManifest } from "./schemas.ts";
import {
  compareFiles,
  readSourceFileEffect,
  resolveSourceRootEffect,
  walkSourceEffect,
} from "./source.ts";
import type { AssemblyPlan, SourceFile, SourceValidation } from "./types.ts";
import {
  canonicalJsonBytes,
  createIdentity,
  digestPayloadEffect,
  sha256Effect,
} from "./verification.ts";

/** Validate a plugin source tree against its manifest and file size bounds. */
export function validateSource(input: unknown = pluginSourceRoot): Promise<SourceValidation> {
  return Effect.runPromise(validateSourceEffect(input));
}

/** Validate the plugin source tree in the plugin effect domain. */
export function validateSourceEffect(
  input: unknown = pluginSourceRoot,
): Effect.Effect<SourceValidation, PluginError> {
  return Effect.gen(function* () {
    const sourceRoot = yield* Effect.try({
      try: () => parseDirectoryText(input, "sourceRoot"),
      catch: (error) => error as PluginError,
    });
    const root = yield* resolveSourceRootEffect(sourceRoot);
    const walkedFiles: string[] = [];
    yield* walkSourceEffect(root, "", walkedFiles);
    const manifest = yield* readSourceManifestEffect(root);
    const declaredPaths = declaredSourcePaths(manifest, walkedFiles);
    const walkedSet = new Set(walkedFiles);
    const skillDirectories = new Set(
      walkedFiles
        .map((path) => /^skills\/([^/]+)\//u.exec(path)?.[1])
        .filter((name): name is string => name !== undefined),
    );
    for (const skill of skillDirectories) {
      if (!walkedSet.has(`skills/${skill}/SKILL.md`)) {
        return yield* Effect.fail(
          pluginError("source_invalid", "A skill directory is missing SKILL.md.", { skill }),
        );
      }
    }
    for (const declaredPath of declaredPaths) {
      if (!walkedSet.has(declaredPath)) {
        return yield* Effect.fail(
          pluginError("source_invalid", "A manifest-declared asset is missing.", {
            path: declaredPath,
          }),
        );
      }
    }
    for (const walkedPath of walkedFiles) {
      if (!declaredPaths.has(walkedPath)) {
        return yield* Effect.fail(
          pluginError("source_invalid", "The plugin source contains an undeclared file.", {
            path: walkedPath,
          }),
        );
      }
    }
    const files: SourceFile[] = [];
    let totalSize = 0;
    for (const path of [...walkedSet].sort()) {
      const bytes = yield* readSourceFileEffect(root, path);
      const size = bytes.byteLength;
      if (size > MAX_FILE_SIZE) {
        return yield* Effect.fail(
          pluginError("source_invalid", "A plugin source file exceeds the size limit.", {
            path,
            size,
            limit: MAX_FILE_SIZE,
          }),
        );
      }
      totalSize += size;
      if (totalSize > MAX_TOTAL_SIZE) {
        return yield* Effect.fail(
          pluginError("source_invalid", "The plugin source exceeds the total size limit.", {
            limit: MAX_TOTAL_SIZE,
          }),
        );
      }
      files.push({ path, size, sha256: yield* sha256Effect(bytes) });
    }
    return { sourceRoot: root, manifest, files };
  });
}

/** Build the deterministic file, digest, identity, and staging plan for a plugin payload. */
export function planAssembly(input: unknown): Promise<AssemblyPlan> {
  return Effect.runPromise(planAssemblyEffect(input));
}

/** Build the payload staging plan in the plugin effect domain. */
export function planAssemblyEffect(input: unknown): Effect.Effect<AssemblyPlan, PluginError> {
  return Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => parseAssemblyRequest(input),
      catch: (error) => error as PluginError,
    });
    const source = yield* validateSourceEffect(request.sourceRoot);
    const schemaEpoch = request.schemaEpoch ?? DEFAULT_SCHEMA_EPOCH;
    const manifest = yield* Effect.try({
      try: () => createGeneratedManifest(source.manifest, request.version),
      catch: (error) => error as PluginError,
    });
    const manifestBytes = canonicalJsonBytes(manifest);
    const generatedManifestFile: SourceFile = {
      path: SOURCE_MANIFEST_PATH,
      size: manifestBytes.byteLength,
      sha256: yield* sha256Effect(manifestBytes),
    };
    const sourceFiles = source.files.filter((file) => file.path !== SOURCE_MANIFEST_PATH);
    const files = [...sourceFiles, generatedManifestFile].sort(compareFiles);
    yield* Effect.try({
      try: () => assertFileBounds(files),
      catch: (error) => error as PluginError,
    });
    const payloadDigest = yield* digestPayloadEffect(request.version, schemaEpoch, files, (path) =>
      path === SOURCE_MANIFEST_PATH
        ? Effect.succeed(manifestBytes)
        : readSourceFileEffect(source.sourceRoot, path),
    );
    const identity = yield* Effect.try({
      try: () => createIdentity(request.version, payloadDigest, schemaEpoch),
      catch: (error) => error as PluginError,
    });
    return {
      sourceRoot: source.sourceRoot,
      stagingDirectory: resolve(request.stagingDirectory),
      version: request.version,
      schemaEpoch,
      manifest,
      files,
      payloadDigest,
      identity,
    };
  });
}

/** Create the generated manifest for a validated source tree and target version. */
export function createGeneratedManifest(
  source: SourceValidation["manifest"],
  version: string,
): GeneratedManifest {
  const manifest: Record<string, unknown> = {
    name: source.name,
    version,
    description: source.description,
    author: source.author,
    skills: source.skills,
    interface: source.interface,
  };
  for (const key of ["license", "homepage", "repository", "keywords"] as const) {
    if (source[key] !== undefined) {
      manifest[key] = source[key];
    }
  }
  const parsed = decodeSchema(GeneratedManifestSchema, manifest);
  if (parsed === undefined) {
    throw pluginError("manifest_invalid", "Generated plugin metadata is invalid.", {
      summary: "Effect Schema rejected the generated plugin metadata.",
    });
  }
  return parsed;
}

/** Reject a payload file list that exceeds per-file or aggregate size limits. */
export function assertFileBounds(files: readonly SourceFile[]): void {
  let totalSize = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      throw pluginError("source_invalid", "A plugin payload file exceeds the size limit.", {
        path: file.path,
        size: file.size,
        limit: MAX_FILE_SIZE,
      });
    }
    totalSize += file.size;
  }
  if (totalSize > MAX_TOTAL_SIZE) {
    throw pluginError("source_invalid", "The plugin payload exceeds the total size limit.", {
      limit: MAX_TOTAL_SIZE,
    });
  }
}
