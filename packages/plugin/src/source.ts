// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";

import * as Effect from "effect/Effect";

import {
  GENERATED_DIRECTORY_NAMES,
  SECRET_EXTENSION_PATTERN,
  SECRET_PATH_PATTERN,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import type { PluginError } from "./errors.ts";

/** Normalize a relative asset path and reject absolute paths or traversal. */
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

/** Check path normalizability without throwing inside an Effect Schema refinement. */
export function isNormalizableRelativePath(input: string): boolean {
  if (input.length === 0 || input.includes("\u0000") || isAbsolute(input)) return false;
  const slashPath = input.replaceAll("\\", "/");
  if (slashPath.split("/").some((segment) => segment === "..")) return false;
  const normalized = posix.normalize(slashPath);
  return !(
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized)
  );
}

/** Reject generated, cache, and secret-like paths from plugin assets. */
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

/** Resolve and validate the real directory containing plugin source assets. */
export function resolveSourceRoot(sourceRoot: string): Promise<string> {
  return Effect.runPromise(resolveSourceRootEffect(sourceRoot));
}

/** Resolve the source root in the plugin effect domain. */
export function resolveSourceRootEffect(sourceRoot: string): Effect.Effect<string, PluginError> {
  const requested = resolve(sourceRoot);
  return Effect.gen(function* () {
    const stats = yield* Effect.tryPromise({
      try: () => lstat(requested),
      catch: (error) =>
        pluginError("source_invalid", "The plugin source root cannot be read.", {}, error),
    });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return yield* Effect.fail(
        pluginError("source_invalid", "The plugin source root must be a real directory."),
      );
    }
    yield* assertNoSymlinkAncestorsEffect(requested, "path_invalid");
    return yield* Effect.tryPromise({
      try: () => realpath(requested),
      catch: (error) =>
        pluginError("source_invalid", "The plugin source root cannot be be resolved.", {}, error),
    });
  });
}

/** Resolve and validate the real directory used to stage a plugin payload. */
export function resolveStagingRoot(stagingDirectory: string): Promise<string> {
  return Effect.runPromise(resolveStagingRootEffect(stagingDirectory));
}

/** Resolve the staging root in the plugin effect domain. */
export function resolveStagingRootEffect(
  stagingDirectory: string,
): Effect.Effect<string, PluginError> {
  const requested = resolve(stagingDirectory);
  return Effect.gen(function* () {
    const stats = yield* Effect.tryPromise({
      try: () => lstat(requested),
      catch: (error) =>
        pluginError("staging_invalid", "The payload staging directory cannot be read.", {}, error),
    });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return yield* Effect.fail(
        pluginError("staging_invalid", "The payload staging path must be a real directory."),
      );
    }
    yield* assertNoSymlinkAncestorsEffect(requested, "staging_invalid");
    return yield* Effect.tryPromise({
      try: () => realpath(requested),
      catch: (error) =>
        pluginError(
          "staging_invalid",
          "The payload staging directory cannot be resolved.",
          {},
          error,
        ),
    });
  });
}

function assertNoSymlinkAncestorsEffect(
  requested: string,
  code: "path_invalid" | "staging_invalid",
): Effect.Effect<void, PluginError> {
  return Effect.gen(function* () {
    let current = requested;
    while (true) {
      const entry = yield* Effect.tryPromise({
        try: () => lstat(current),
        catch: (error) =>
          pluginError(code, "A managed plugin path ancestor cannot be read.", {}, error),
      });
      if (entry.isSymbolicLink()) {
        return yield* Effect.fail(
          pluginError(code, "The managed plugin path must not contain a symbolic link."),
        );
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  });
}

/** Enumerate regular files in a plugin source tree into a relative path list. */
export function walkSource(root: string, prefix: string, output: string[]): Promise<void> {
  return Effect.runPromise(walkSourceEffect(root, prefix, output));
}

/** Enumerate source files in the plugin effect domain. */
export function walkSourceEffect(
  root: string,
  prefix: string,
  output: string[],
): Effect.Effect<void, PluginError> {
  const directory = prefix ? join(root, prefix) : root;
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (error) =>
        pluginError(
          "source_invalid",
          "The plugin source cannot be enumerated.",
          { path: prefix },
          error,
        ),
    });
    for (const entry of entries) {
      const relativePath = yield* Effect.try({
        try: () => {
          const path = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
          assertSafePath(path);
          return path;
        },
        catch: (error) => error as PluginError,
      });
      if (entry.isSymbolicLink()) {
        return yield* Effect.fail(
          pluginError("path_invalid", "Symbolic links are not plugin source assets.", {
            path: relativePath,
          }),
        );
      }
      if (entry.isDirectory()) {
        yield* walkSourceEffect(root, relativePath, output);
      } else if (entry.isFile()) {
        output.push(relativePath);
      } else {
        return yield* Effect.fail(
          pluginError("source_invalid", "Only regular files and directories are allowed.", {
            path: relativePath,
          }),
        );
      }
    }
  });
}

/** Enumerate regular files in a staged payload tree into a relative path list. */
export function walkPayload(root: string, prefix: string, output: string[]): Promise<void> {
  return Effect.runPromise(walkPayloadEffect(root, prefix, output));
}

/** Enumerate staged payload files in the plugin effect domain. */
export function walkPayloadEffect(
  root: string,
  prefix: string,
  output: string[],
): Effect.Effect<void, PluginError> {
  const directory = prefix ? join(root, prefix) : root;
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (error) =>
        pluginError(
          "payload_invalid",
          "The payload cannot be enumerated.",
          { path: prefix },
          error,
        ),
    });
    for (const entry of entries) {
      const relativePath = yield* Effect.try({
        try: () => normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name),
        catch: (error) => error as PluginError,
      });
      if (entry.isSymbolicLink()) {
        return yield* Effect.fail(
          pluginError("payload_invalid", "Symbolic links are not valid payload files.", {
            path: relativePath,
          }),
        );
      }
      if (entry.isDirectory()) {
        yield* walkPayloadEffect(root, relativePath, output);
      } else if (entry.isFile()) {
        output.push(relativePath);
      } else {
        return yield* Effect.fail(
          pluginError("payload_invalid", "Only regular payload files are allowed.", {
            path: relativePath,
          }),
        );
      }
    }
  });
}

/** Read a regular plugin source file as bytes after validating its relative path. */
export function readSourceFile(root: string, path: string): Promise<Uint8Array> {
  return Effect.runPromise(readSourceFileEffect(root, path));
}

/** Read source bytes in the plugin effect domain. */
export function readSourceFileEffect(
  root: string,
  path: string,
): Effect.Effect<Uint8Array, PluginError> {
  return Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => normalizeRelativePath(path),
      catch: (error) => error as PluginError,
    });
    const filePath = join(root, normalized);
    const stats = yield* Effect.tryPromise({
      try: () => lstat(filePath),
      catch: (error) =>
        pluginError(
          "source_invalid",
          "A plugin source file cannot be read.",
          { path: normalized },
          error,
        ),
    });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return yield* Effect.fail(
        pluginError("path_invalid", "Plugin source files must be regular files.", {
          path: normalized,
        }),
      );
    }
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(filePath),
      catch: (error) =>
        pluginError(
          "source_invalid",
          "A plugin source file cannot be read.",
          { path: normalized },
          error,
        ),
    });
    return new Uint8Array(bytes);
  });
}

/** Read a regular staged payload file as bytes after validating its relative path. */
export function readPayloadFile(root: string, path: string): Promise<Uint8Array> {
  return Effect.runPromise(readPayloadFileEffect(root, path));
}

/** Read staged payload bytes in the plugin effect domain. */
export function readPayloadFileEffect(
  root: string,
  path: string,
): Effect.Effect<Uint8Array, PluginError> {
  return Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => normalizeRelativePath(path),
      catch: (error) => error as PluginError,
    });
    const filePath = join(root, normalized);
    const stats = yield* Effect.tryPromise({
      try: () => lstat(filePath),
      catch: (error) =>
        pluginError(
          "payload_invalid",
          "A payload file cannot be read.",
          { path: normalized },
          error,
        ),
    });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "Payload files must be regular files.", {
          path: normalized,
        }),
      );
    }
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(filePath),
      catch: (error) =>
        pluginError(
          "payload_invalid",
          "A payload file cannot be read.",
          { path: normalized },
          error,
        ),
    });
    return new Uint8Array(bytes);
  });
}

/** Compare source-like file records by their relative paths. */
export function compareFiles(
  left: Pick<SourceFileLike, "path">,
  right: Pick<SourceFileLike, "path">,
): number {
  return comparePathText(left.path, right.path);
}

/** Compare two relative paths using deterministic lexical ordering. */
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
