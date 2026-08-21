// SPDX-License-Identifier: Apache-2.0

import { dirname } from "node:path";
import { canonicalJson, type JsonObject, type JsonValue } from "@holycodex/core";
import { assertNoSymlink, ensureOwnedDirectory, isFsCode } from "./paths.ts";
import { readJsonObject, writeAtomicJson } from "./storage.ts";
import { decodeSchema, JsonObjectSchema } from "./schema.ts";
import type { InstallRecord } from "./types.ts";

const MarketplaceSchema = JsonObjectSchema;
const MarketplaceEntrySchema = JsonObjectSchema;

export interface MarketplaceDocument extends JsonObject {
  readonly plugins: readonly JsonObject[];
}

export const MANAGED_MARKETPLACE_OWNER = "holycodex" as const;
export const MANAGED_MARKETPLACE_CATEGORY = "Development" as const;
export const MANAGED_INSTALL_POLICY = "AVAILABLE" as const;
export const MANAGED_AUTH_POLICY = "ON_INSTALL" as const;

export async function readMarketplace(path: string): Promise<MarketplaceDocument> {
  await assertNoSymlink(path).catch((error: unknown) => {
    if (!isFsCode(error, "ENOENT")) {
      throw error;
    }
  });
  let document: JsonObject;
  try {
    document = await readJsonObject(path);
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) {
      throw error;
    }
    return { plugins: [] };
  }
  const parsed = decodeSchema(MarketplaceSchema, document);
  if (parsed === undefined) {
    throw new MarketplaceError("marketplace_invalid", "The marketplace file is not a JSON object.");
  }
  const rawPlugins = parsed["plugins"];
  if (
    rawPlugins !== undefined &&
    (!Array.isArray(rawPlugins) ||
      rawPlugins.some((item) => decodeSchema(MarketplaceEntrySchema, item) === undefined))
  ) {
    throw new MarketplaceError("marketplace_invalid", "The marketplace plugins list is invalid.");
  }
  const plugins = Array.isArray(rawPlugins)
    ? rawPlugins.filter(
        (item): item is JsonObject => decodeSchema(MarketplaceEntrySchema, item) !== undefined,
      )
    : [];
  return { ...parsed, plugins };
}

export async function writeMarketplace(path: string, document: MarketplaceDocument): Promise<void> {
  await ensureOwnedDirectory(dirname(path));
  await writeAtomicJson(path, document);
}

export function managedMarketplaceEntry(record: InstallRecord): JsonObject {
  return {
    name: "holycodex",
    source: record.relative_path,
    version: record.version,
    category: MANAGED_MARKETPLACE_CATEGORY,
    install: MANAGED_INSTALL_POLICY,
    auth: MANAGED_AUTH_POLICY,
    owner: { name: MANAGED_MARKETPLACE_OWNER, schema: record.schema_epoch },
    cache: {
      identity: {
        version: record.version,
        digest: record.digest,
        epoch: record.epoch,
        artifact_id: record.artifact_id,
      },
    },
  };
}

export function marketplaceWithManagedEntry(
  document: MarketplaceDocument,
  record: InstallRecord,
): MarketplaceDocument {
  const managed = managedMarketplaceEntry(record);
  const entries = [...document.plugins];
  const indexes = entries.flatMap((entry, index) => (isManagedEntry(entry) ? [index] : []));
  if (indexes.length > 1) {
    throw new MarketplaceError(
      "marketplace_ambiguous",
      "The marketplace contains multiple HolyCodex entries.",
    );
  }
  if (indexes.length === 1) {
    const index = indexes[0];
    if (index === undefined) {
      throw new MarketplaceError(
        "marketplace_ambiguous",
        "The HolyCodex marketplace entry index is invalid.",
      );
    }
    entries[index] = { ...entries[index], ...managed };
  } else {
    entries.push(managed);
  }
  return { ...document, plugins: entries };
}

export function findManagedEntry(document: MarketplaceDocument): JsonObject | undefined {
  return document.plugins.find((entry) => isManagedEntry(entry));
}

export function isManagedEntry(entry: JsonObject): boolean {
  return (
    entry["name"] === "holycodex" ||
    (isJsonObject(entry["owner"]) && entry["owner"]["name"] === MANAGED_MARKETPLACE_OWNER)
  );
}

export function managedEntryMatches(entry: JsonObject | undefined, record: InstallRecord): boolean {
  if (!entry || !isManagedEntry(entry)) {
    return false;
  }
  const expected = managedMarketplaceEntry(record);
  return canonicalJson(pickManagedFields(entry)) === canonicalJson(pickManagedFields(expected));
}

export function pickManagedFields(entry: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const key of [
    "name",
    "source",
    "version",
    "category",
    "install",
    "auth",
    "owner",
    "cache",
  ]) {
    const value = entry[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class MarketplaceError extends Error {
  readonly code: "marketplace_invalid" | "marketplace_ambiguous";

  constructor(code: "marketplace_invalid" | "marketplace_ambiguous", message: string) {
    super(message);
    this.name = "MarketplaceError";
    this.code = code;
  }
}
