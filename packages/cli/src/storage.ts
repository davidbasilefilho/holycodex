// SPDX-License-Identifier: Apache-2.0

import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TomlDocument, TomlValue } from "@holycodex/codex";
import { canonicalJson, type JsonObject, type JsonValue } from "@holycodex/core";
import * as Schema from "effect/Schema";

import { assertNoSymlink, ensureOwnedDirectory, isFsCode } from "./paths.ts";
import { decodeSchema, JsonObjectSchema } from "./schema.ts";
import { parseToml, stringifyToml } from "./toml.ts";

const IGNORED_SYNC_CODES = new Set(["EBADF", "EINVAL", "ENOSYS", "ENOTSUP", "EISDIR"]);
const JsonObjectBoundarySchema = JsonObjectSchema;

/** Flush a regular file when the host filesystem supports file synchronization. */
export async function syncFile(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!hasIgnoredSyncCode(error)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Flush a directory when the host filesystem supports directory synchronization. */
export async function syncDirectory(path: string): Promise<void> {
  await syncFile(path).catch((error: unknown) => {
    if (!hasIgnoredSyncCode(error)) {
      throw error;
    }
  });
}

/** Write a JSON value through a synced temporary file and atomic rename. */
export async function writeAtomicJson(path: string, value: JsonValue): Promise<void> {
  await writeAtomicText(path, `${canonicalJson(value)}\n`);
}

/** Persist installer configuration as TOML, preserving nullable snapshot values explicitly. */
export async function writeAtomicState(path: string, value: JsonValue): Promise<void> {
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
  await writeAtomicText(path, stringifyToml(document as TomlDocument));
}

/** Read canonical TOML or legacy JSON without changing persisted state. */
export async function optionalStateFile<T>(
  path: string,
  schema: Schema.Schema<T>,
): Promise<T | undefined> {
  const source = await optionalTextFile(path);
  if (source === undefined) {
    const legacyPath = path.replace(/\.toml$/u, ".json");
    return await optionalJsonFile(legacyPath, schema);
  }
  return decodeStateText(source, schema);
}

/** Migrate legacy bytes only after the installer validates the complete record and its integrity. */
export async function migrateValidatedState(path: string, value: JsonValue): Promise<void> {
  if ((await optionalTextFile(path)) !== undefined) return;
  const legacyPath = path.replace(/\.toml$/u, ".json");
  const legacySource = await optionalTextFile(legacyPath);
  if (legacySource === undefined) return;
  await writeAtomicState(path, value);
  if ((await optionalTextFile(legacyPath)) !== legacySource) {
    throw new StorageError("state_corrupt", "Legacy state changed during migration.");
  }
  await unlink(legacyPath);
}

/** Decode and validate installer TOML text without filesystem effects. */
export function decodeStateText<T>(source: string, schema: Schema.Schema<T>): T {
  let raw: unknown;
  try {
    // Accept prior JSON fixtures at the receiving edge, but never write JSON state.
    if (source.trimStart().startsWith("{")) raw = JSON.parse(source) as unknown;
    else {
      const document = parseToml(source);
      if (document["format_version"] !== 1 || !Array.isArray(document["null_paths"]))
        throw new Error("Invalid state format");
      raw = document["record"];
      for (const trail of document["null_paths"]) {
        if (
          !Array.isArray(trail) ||
          trail.length === 0 ||
          trail.some(
            (key) =>
              typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key),
          )
        )
          throw new Error("Invalid null path");
        let target = raw as Record<string, unknown>;
        for (const key of trail.slice(0, -1)) {
          if (
            typeof target !== "object" ||
            target === null ||
            !Object.hasOwn(target, key as string)
          )
            throw new Error("Invalid null path");
          target = target[key as string] as Record<string, unknown>;
        }
        const leaf = trail.at(-1) as string;
        if (
          typeof target !== "object" ||
          target === null ||
          !Object.hasOwn(target, leaf) ||
          target[leaf] !== ""
        )
          throw new Error("Invalid null placeholder");
        target[leaf] = null;
      }
    }
  } catch (error: unknown) {
    throw new StorageError("state_corrupt", "A persisted state file is not valid TOML.", error);
  }
  const parsed = decodeSchema(schema, raw);
  if (parsed === undefined)
    throw new StorageError("state_corrupt", "A persisted file failed schema validation.");
  return parsed;
}

/** Write text through a synced temporary file and atomic rename. */
export async function writeAtomicText(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await ensureOwnedDirectory(directory);
  await assertNoSymlink(path);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
    await syncFile(temporary);
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Read, parse, and validate a regular JSON file. */
export async function readJsonFile<T>(path: string, schema: Schema.Schema<T>): Promise<T> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new StorageError("state_corrupt", "A persisted file is not a regular file.");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new StorageError("state_corrupt", "A persisted file is not valid JSON.", error);
  }
  const parsed = decodeSchema(schema, parsedJson);
  if (parsed === undefined) {
    throw new StorageError("state_corrupt", "A persisted file failed schema validation.");
  }
  return parsed;
}

/** Read and validate a JSON object from a regular file. */
export async function readJsonObject(path: string): Promise<JsonObject> {
  const value = await readJsonFile(path, JsonObjectBoundarySchema);
  return value;
}

/** Read a regular text file, returning undefined when it does not exist. */
export async function optionalTextFile(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new StorageError("state_corrupt", "A persisted file is not a regular file.");
    }
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** Read and validate an optional JSON file, returning undefined when absent. */
export async function optionalJsonFile<T>(
  path: string,
  schema: Schema.Schema<T>,
): Promise<T | undefined> {
  try {
    return await readJsonFile(path, schema);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** Return whether a path exists as a regular file rather than a symlink. */
export async function existsRegular(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Require a path to be an existing regular directory without symlink components. */
export async function assertRegularDirectory(path: string): Promise<void> {
  await assertNoSymlink(path);
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new StorageError("state_corrupt", "A managed directory is not a real directory.");
  }
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
