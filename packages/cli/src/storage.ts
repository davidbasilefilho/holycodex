// SPDX-License-Identifier: Apache-2.0

import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, type JsonObject, type JsonValue } from "@holycodex/core";
import * as Schema from "effect/Schema";

import { assertNoSymlink, ensureOwnedDirectory, isFsCode } from "./paths.ts";
import { decodeSchema, JsonObjectSchema } from "./schema.ts";

const IGNORED_SYNC_CODES = new Set(["EBADF", "EINVAL", "ENOSYS", "ENOTSUP", "EISDIR"]);
const JsonObjectBoundarySchema = JsonObjectSchema;

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

export async function syncDirectory(path: string): Promise<void> {
  await syncFile(path).catch((error: unknown) => {
    if (!hasIgnoredSyncCode(error)) {
      throw error;
    }
  });
}

export async function writeAtomicJson(path: string, value: JsonValue): Promise<void> {
  await writeAtomicText(path, `${canonicalJson(value)}\n`);
}

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

export async function readJsonObject(path: string): Promise<JsonObject> {
  const value = await readJsonFile(path, JsonObjectBoundarySchema);
  return value;
}

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

export async function assertRegularDirectory(path: string): Promise<void> {
  await assertNoSymlink(path);
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new StorageError("state_corrupt", "A managed directory is not a real directory.");
  }
}

export class StorageError extends Error {
  readonly code: "state_corrupt" | "storage_failure";
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
