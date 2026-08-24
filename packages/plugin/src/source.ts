// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import {
  GENERATED_DIRECTORY_NAMES,
  SECRET_EXTENSION_PATTERN,
  SECRET_PATH_PATTERN,
} from "./constants.ts";
import { pluginError } from "./errors.ts";

export function normalizeRelativePath(input: string): string {
  if (input.length === 0 || input.includes("\u0000") || isAbsolute(input)) {
    throw pluginError("path_invalid", "Asset paths must be non-empty relative paths.");
  }
  const slashPath = input.replaceAll("\\", "/");
  const segments = slashPath.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw pluginError("path_invalid", "Asset paths cannot traverse their source root.", {
      path: input,
    });
  }
  const normalized = posix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    throw pluginError("path_invalid", "Asset paths must stay inside their source root.", {
      path: input,
    });
  }
  return normalized;
}

export function assertSafePath(path: string): void {
  const normalized = normalizeRelativePath(path);
  const parts = normalized.split("/");
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (GENERATED_DIRECTORY_NAMES.has(lower) || lower === ".ds_store") {
      throw pluginError("path_invalid", "Generated and cache paths are not plugin source assets.", {
        path: normalized,
      });
    }
    if (SECRET_PATH_PATTERN.test(part) || SECRET_EXTENSION_PATTERN.test(part)) {
      throw pluginError("path_invalid", "Secret-like paths are not plugin source assets.", {
        path: normalized,
      });
    }
  }
}

export async function resolveSourceRoot(sourceRoot: string): Promise<string> {
  const requested = resolve(sourceRoot);
  let stats;
  try {
    stats = await lstat(requested);
  } catch (error: unknown) {
    throw pluginError("source_invalid", "The plugin source root cannot be read.", {}, error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw pluginError("source_invalid", "The plugin source root must be a real directory.");
  }
  await assertNoSymlinkAncestors(requested, "path_invalid");
  return await realpath(requested);
}

export async function resolveStagingRoot(stagingDirectory: string): Promise<string> {
  const requested = resolve(stagingDirectory);
  let stats;
  try {
    stats = await lstat(requested);
  } catch (error: unknown) {
    throw pluginError(
      "staging_invalid",
      "The payload staging directory cannot be read.",
      {},
      error,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw pluginError("staging_invalid", "The payload staging path must be a real directory.");
  }
  await assertNoSymlinkAncestors(requested, "staging_invalid");
  return await realpath(requested);
}

async function assertNoSymlinkAncestors(
  requested: string,
  code: "path_invalid" | "staging_invalid",
): Promise<void> {
  let current = requested;
  while (true) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw pluginError(code, "The managed plugin path must not contain a symbolic link.");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function walkSource(root: string, prefix: string, output: string[]): Promise<void> {
  const directory = prefix ? join(root, prefix) : root;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    throw pluginError(
      "source_invalid",
      "The plugin source cannot be enumerated.",
      { path: prefix },
      error,
    );
  }
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    assertSafePath(relativePath);
    if (entry.isSymbolicLink()) {
      throw pluginError("path_invalid", "Symbolic links are not plugin source assets.", {
        path: relativePath,
      });
    }
    if (entry.isDirectory()) {
      await walkSource(root, relativePath, output);
    } else if (entry.isFile()) {
      output.push(relativePath);
    } else {
      throw pluginError("source_invalid", "Only regular files and directories are allowed.", {
        path: relativePath,
      });
    }
  }
}

export async function walkPayload(root: string, prefix: string, output: string[]): Promise<void> {
  const directory = prefix ? join(root, prefix) : root;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    throw pluginError(
      "payload_invalid",
      "The payload cannot be enumerated.",
      { path: prefix },
      error,
    );
  }
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isSymbolicLink()) {
      throw pluginError("payload_invalid", "Symbolic links are not valid payload files.", {
        path: relativePath,
      });
    }
    if (entry.isDirectory()) {
      await walkPayload(root, relativePath, output);
    } else if (entry.isFile()) {
      output.push(relativePath);
    } else {
      throw pluginError("payload_invalid", "Only regular payload files are allowed.", {
        path: relativePath,
      });
    }
  }
}

export async function readSourceFile(root: string, path: string): Promise<Uint8Array> {
  const normalized = normalizeRelativePath(path);
  const filePath = join(root, normalized);
  const stats = await lstat(filePath).catch((error: unknown) => {
    throw pluginError(
      "source_invalid",
      "A plugin source file cannot be read.",
      { path: normalized },
      error,
    );
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw pluginError("path_invalid", "Plugin source files must be regular files.", {
      path: normalized,
    });
  }
  return new Uint8Array(await readFile(filePath));
}

export async function readPayloadFile(root: string, path: string): Promise<Uint8Array> {
  const normalized = normalizeRelativePath(path);
  const filePath = join(root, normalized);
  const stats = await lstat(filePath).catch((error: unknown) => {
    throw pluginError(
      "payload_invalid",
      "A payload file cannot be read.",
      { path: normalized },
      error,
    );
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw pluginError("payload_invalid", "Payload files must be regular files.", {
      path: normalized,
    });
  }
  return new Uint8Array(await readFile(filePath));
}

export function compareFiles(
  left: Pick<SourceFileLike, "path">,
  right: Pick<SourceFileLike, "path">,
): number {
  return comparePathText(left.path, right.path);
}

export function comparePathText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

interface SourceFileLike {
  readonly path: string;
}
