// SPDX-License-Identifier: Apache-2.0

import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TomlDocument, TomlValue } from "@holycodex/codex";
import { canonicalJson, type JsonObject, type JsonValue } from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { assertNoSymlinkEffect, ensureOwnedDirectoryEffect, isFsCode } from "./paths.ts";
import { decodeSchema, JsonObjectSchema } from "./schema.ts";
import { parseToml, stringifyToml } from "./toml.ts";

const IGNORED_SYNC_CODES = new Set(["EBADF", "EINVAL", "ENOSYS", "ENOTSUP", "EISDIR"]);
const JsonObjectBoundarySchema = JsonObjectSchema;
const StateNullPathSchema = Schema.Array(
  Schema.String.check(
    Schema.makeFilter((key) => !["__proto__", "constructor", "prototype"].includes(key)),
  ),
).check(Schema.isMinLength(1));
const PersistedStateDocumentSchema = Schema.Struct({
  format_version: Schema.Literals([1]),
  null_paths: Schema.Array(StateNullPathSchema),
  record: Schema.Unknown,
});

/** Flush a regular file when the host filesystem supports file synchronization. */
export function syncFileEffect(path: string): Effect.Effect<void, unknown> {
  const effect = Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(path, "r"), catch: (error) => error }),
    (handle) => Effect.tryPromise({ try: () => handle.sync(), catch: (error) => error }),
    (handle) =>
      Effect.tryPromise({ try: () => handle.close(), catch: (error) => error }).pipe(
        Effect.catchIf(
          () => true,
          () => Effect.void,
        ),
      ),
  );
  return Effect.catchIf(effect, hasIgnoredSyncCode, () => Effect.void);
}

/** Flush a file through the Promise-facing filesystem adapter. */
export function syncFile(path: string): Promise<void> {
  return Effect.runPromise(syncFileEffect(path));
}

/** Flush a directory when the host filesystem supports directory synchronization. */
export function syncDirectoryEffect(path: string): Effect.Effect<void, unknown> {
  return Effect.catchIf(syncFileEffect(path), hasIgnoredSyncCode, () => Effect.void);
}

/** Flush a directory through the Promise-facing filesystem adapter. */
export function syncDirectory(path: string): Promise<void> {
  return Effect.runPromise(syncDirectoryEffect(path));
}

/** Write a JSON value through a synced temporary file and atomic rename. */
export function writeAtomicJson(path: string, value: JsonValue): Promise<void> {
  return writeAtomicText(path, `${canonicalJson(value)}\n`);
}

/** Persist installer configuration as TOML, preserving nullable snapshot values explicitly. */
export function writeAtomicStateEffect(
  path: string,
  value: JsonValue,
): Effect.Effect<void, unknown> {
  const nullPaths: string[][] = [];
  function encode(input: JsonValue, trail: string[]): TomlValue {
    if (input === null) {
      nullPaths.push(trail);
      return "";
    }
    if (Array.isArray(input))
      return input.map((item, index) => encode(item, [...trail, String(index)]));
    if (typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [key, encode(item, [...trail, key])]),
      );
    return input;
  }
  const document = {
    format_version: 1,
    null_paths: nullPaths,
    record: encode(value, []),
  };
  return writeAtomicTextEffect(path, stringifyToml(document as TomlDocument));
}

/** Persist installer configuration through the Promise-facing filesystem adapter. */
export function writeAtomicState(path: string, value: JsonValue): Promise<void> {
  return Effect.runPromise(writeAtomicStateEffect(path, value));
}

/** Read canonical TOML or legacy JSON without changing persisted state. */
export function optionalStateFileEffect<T>(
  path: string,
  schema: Schema.Codec<T, unknown>,
): Effect.Effect<T | undefined, unknown> {
  return Effect.gen(function* () {
    const source = yield* optionalTextFileEffect(path);
    if (source === undefined) {
      const legacyPath = path.replace(/\.toml$/u, ".json");
      return yield* optionalJsonFileEffect(legacyPath, schema);
    }
    return decodeStateText(source, schema);
  });
}

/** Read state through the Promise-facing filesystem adapter. */
export function optionalStateFile<T>(
  path: string,
  schema: Schema.Codec<T, unknown>,
): Promise<T | undefined> {
  return Effect.runPromise(optionalStateFileEffect(path, schema));
}

/** Migrate legacy bytes only after the installer validates the complete record and its integrity. */
export function migrateValidatedStateEffect(
  path: string,
  value: JsonValue,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if ((yield* optionalTextFileEffect(path)) !== undefined) return;
    const legacyPath = path.replace(/\.toml$/u, ".json");
    const legacySource = yield* optionalTextFileEffect(legacyPath);
    if (legacySource === undefined) return;
    yield* writeAtomicStateEffect(path, value);
    const currentSource = yield* optionalTextFileEffect(legacyPath);
    if (currentSource !== legacySource) {
      return yield* Effect.fail(
        new StorageError("state_corrupt", "Legacy state changed during migration."),
      );
    }
    yield* Effect.tryPromise({ try: () => unlink(legacyPath), catch: (error) => error });
  });
}

/** Migrate state through the Promise-facing filesystem adapter. */
export function migrateValidatedState(path: string, value: JsonValue): Promise<void> {
  return Effect.runPromise(migrateValidatedStateEffect(path, value));
}

/** Decode and validate installer TOML text without filesystem effects. */
export function decodeStateText<T>(source: string, schema: Schema.Codec<T, unknown>): T {
  const raw = Effect.runSync(
    Effect.try({
      try: () => {
        // Accept prior JSON fixtures at the receiving edge, but never write JSON state.
        if (source.trimStart().startsWith("{")) return JSON.parse(source) as unknown;
        const parsed = decodeSchema(PersistedStateDocumentSchema, parseToml(source));
        if (parsed === undefined) throw new Error("Invalid state document");
        const raw = parsed.record;
        for (const trail of parsed.null_paths) {
          let target = raw as Record<string, unknown>;
          for (const key of trail.slice(0, -1)) {
            if (typeof target !== "object" || target === null || !Object.hasOwn(target, key))
              throw new Error("Invalid null path");
            target = target[key] as Record<string, unknown>;
          }
          const leaf = trail.at(-1);
          if (
            leaf === undefined ||
            typeof target !== "object" ||
            target === null ||
            !Object.hasOwn(target, leaf) ||
            target[leaf] !== ""
          )
            throw new Error("Invalid null placeholder");
          target[leaf] = null;
        }
        return raw;
      },
      catch: (error) =>
        new StorageError("state_corrupt", "A persisted state file is not valid TOML.", error),
    }),
  );
  const parsed = decodeSchema(schema, raw);
  if (parsed === undefined)
    throw new StorageError("state_corrupt", "A persisted file failed schema validation.");
  return parsed;
}

/** Write text through a synced temporary file and atomic rename. */
export function writeAtomicTextEffect(path: string, value: string): Effect.Effect<void, unknown> {
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const operation = Effect.gen(function* () {
    yield* ensureOwnedDirectoryEffect(directory);
    yield* assertNoSymlinkEffect(path);
    yield* Effect.tryPromise({
      try: () => writeFile(temporary, value, { encoding: "utf8", mode: 0o600 }),
      catch: (error) => error,
    });
    yield* syncFileEffect(temporary);
    yield* Effect.tryPromise({ try: () => rename(temporary, path), catch: (error) => error });
    yield* syncDirectoryEffect(directory);
  });
  return operation.pipe(
    Effect.catchIf(
      () => true,
      (error) =>
        Effect.flatMap(
          Effect.tryPromise({ try: () => unlink(temporary), catch: () => undefined }),
          () => Effect.fail(error),
        ),
    ),
  );
}

/** Write text through the Promise-facing filesystem adapter. */
export function writeAtomicText(path: string, value: string): Promise<void> {
  return Effect.runPromise(writeAtomicTextEffect(path, value));
}

/** Read, parse, and validate a regular JSON file. */
export function readJsonFile<T>(path: string, schema: Schema.Codec<T, unknown>): Promise<T> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const entry = yield* Effect.tryPromise({ try: () => lstat(path), catch: (error) => error });
      if (!entry.isFile() || entry.isSymbolicLink()) {
        return yield* Effect.fail(
          new StorageError("state_corrupt", "A persisted file is not a regular file."),
        );
      }
      const source = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (error) => error,
      });
      const parsedJson = yield* Effect.try({
        try: () => JSON.parse(source) as unknown,
        catch: (error) =>
          new StorageError("state_corrupt", "A persisted file is not valid JSON.", error),
      });
      const parsed = decodeSchema(schema, parsedJson);
      if (parsed === undefined) {
        return yield* Effect.fail(
          new StorageError("state_corrupt", "A persisted file failed schema validation."),
        );
      }
      return parsed;
    }),
  );
}

/** Read and validate a JSON object from a regular file. */
export function readJsonObject(path: string): Promise<JsonObject> {
  return readJsonFile(path, JsonObjectBoundarySchema);
}

/** Read a regular text file, returning undefined when it does not exist. */
export function optionalTextFileEffect(path: string): Effect.Effect<string | undefined, unknown> {
  return Effect.gen(function* () {
    const entry = yield* Effect.catchIf(
      Effect.tryPromise({ try: () => lstat(path), catch: (error) => error }),
      (error) => isFsCode(error, "ENOENT"),
      () => Effect.succeed(undefined),
    );
    if (entry === undefined) return undefined;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return yield* Effect.fail(
        new StorageError("state_corrupt", "A persisted file is not a regular file."),
      );
    }
    return yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) => error,
    });
  });
}

/** Read optional text through the Promise-facing filesystem adapter. */
export function optionalTextFile(path: string): Promise<string | undefined> {
  return Effect.runPromise(optionalTextFileEffect(path));
}

/** Read and validate an optional JSON file, returning undefined when absent. */
export function optionalJsonFileEffect<T>(
  path: string,
  schema: Schema.Codec<T, unknown>,
): Effect.Effect<T | undefined, unknown> {
  return Effect.catchIf(
    Effect.tryPromise({ try: () => readJsonFile(path, schema), catch: (error) => error }),
    (error) => isFsCode(error, "ENOENT"),
    () => Effect.succeed(undefined),
  );
}

/** Read an optional JSON file through the Promise-facing filesystem adapter. */
export function optionalJsonFile<T>(
  path: string,
  schema: Schema.Codec<T, unknown>,
): Promise<T | undefined> {
  return Effect.runPromise(optionalJsonFileEffect(path, schema));
}

/** Return whether a path exists as a regular file rather than a symlink. */
export function existsRegular(path: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.catchIf(
      Effect.map(
        Effect.tryPromise({ try: () => lstat(path), catch: (error) => error }),
        (entry) => entry.isFile() && !entry.isSymbolicLink(),
      ),
      (error) => isFsCode(error, "ENOENT"),
      () => Effect.succeed(false),
    ),
  );
}

/** Require a path to be an existing regular directory without symlink components. */
export function assertRegularDirectoryEffect(path: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* assertNoSymlinkEffect(path);
    const entry = yield* Effect.tryPromise({ try: () => lstat(path), catch: (error) => error });
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return yield* Effect.fail(
        new StorageError("state_corrupt", "A managed directory is not a real directory."),
      );
    }
  });
}

/** Require a managed directory through the Promise-facing filesystem adapter. */
export function assertRegularDirectory(path: string): Promise<void> {
  return Effect.runPromise(assertRegularDirectoryEffect(path));
}

/** Structured failure raised while reading or writing managed state. */
export class StorageError extends Error {
  /** The code in public cli contract. */
  readonly code: "state_corrupt" | "storage_failure";
  /** The cause value in public cli contract. */
  readonly causeValue: unknown;

  constructor(code: "state_corrupt" | "storage_failure", message: string, causeValue?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.causeValue = causeValue;
  }
}

function hasIgnoredSyncCode(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return (
      IGNORED_SYNC_CODES.has(error.code) || (process.platform === "win32" && error.code === "EPERM")
    );
  }
  return false;
}
