// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { canonicalJsonBytes, createIdentity, digestPayload, sha256 } from "./verification.ts";
import {
  DEFAULT_SCHEMA_EPOCH,
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  pluginSourceRoot,
  SOURCE_MANIFEST_PATH,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import {
  GeneratedManifestSchema,
  decodeSchema,
  parseAssemblyRequest,
  parseDirectoryText,
  readSourceManifest,
  declaredSourcePaths,
} from "./schemas.ts";
import { compareFiles, readSourceFile, resolveSourceRoot, walkSource } from "./source.ts";
import type { AssemblyPlan, SourceFile, SourceValidation } from "./types.ts";
import type { GeneratedManifest } from "./schemas.ts";

export async function validateSource(input: unknown = pluginSourceRoot): Promise<SourceValidation> {
  const sourceRoot = parseDirectoryText(input, "sourceRoot");
  const root = await resolveSourceRoot(sourceRoot);
  const walkedFiles: string[] = [];
  await walkSource(root, "", walkedFiles);

  const manifest = await readSourceManifest(root);
  const declaredPaths = declaredSourcePaths(manifest, walkedFiles);
  const walkedSet = new Set(walkedFiles);

  const skillDirectories = new Set(
    walkedFiles
      .map((path) => /^skills\/([^/]+)\//u.exec(path)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  for (const skill of skillDirectories) {
    if (!walkedSet.has(`skills/${skill}/SKILL.md`)) {
      throw pluginError("source_invalid", "A skill directory is missing SKILL.md.", { skill });
    }
  }

  for (const declaredPath of declaredPaths) {
    if (!walkedSet.has(declaredPath)) {
      throw pluginError("source_invalid", "A manifest-declared asset is missing.", {
        path: declaredPath,
      });
    }
  }

  for (const walkedPath of walkedFiles) {
    if (!declaredPaths.has(walkedPath)) {
      throw pluginError("source_invalid", "The plugin source contains an undeclared file.", {
        path: walkedPath,
      });
    }
  }

  const files: SourceFile[] = [];
  let totalSize = 0;
  for (const path of [...walkedSet].sort()) {
    const bytes = await readSourceFile(root, path);
    const size = bytes.byteLength;
    if (size > MAX_FILE_SIZE) {
      throw pluginError("source_invalid", "A plugin source file exceeds the size limit.", {
        path,
        size,
        limit: MAX_FILE_SIZE,
      });
    }
    totalSize += size;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw pluginError("source_invalid", "The plugin source exceeds the total size limit.", {
        limit: MAX_TOTAL_SIZE,
      });
    }
    files.push({ path, size, sha256: await sha256(bytes) });
  }

  return { sourceRoot: root, manifest, files };
}

export async function planAssembly(input: unknown): Promise<AssemblyPlan> {
  const request = parseAssemblyRequest(input);
  const source = await validateSource(request.sourceRoot);
  const schemaEpoch = request.schemaEpoch ?? DEFAULT_SCHEMA_EPOCH;
  const manifest = createGeneratedManifest(source.manifest, request.version);
  const manifestBytes = canonicalJsonBytes(manifest);
  const generatedManifestFile: SourceFile = {
    path: SOURCE_MANIFEST_PATH,
    size: manifestBytes.byteLength,
    sha256: await sha256(manifestBytes),
  };
  const sourceFiles = source.files.filter((file) => file.path !== SOURCE_MANIFEST_PATH);
  const files = [...sourceFiles, generatedManifestFile].sort(compareFiles);
  assertFileBounds(files);
  const payloadDigest = await digestPayload(request.version, schemaEpoch, files, async (path) => {
    if (path === SOURCE_MANIFEST_PATH) {
      return manifestBytes;
    }
    return readSourceFile(source.sourceRoot, path);
  });
  const identity = createIdentity(request.version, payloadDigest, schemaEpoch);

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
}

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
