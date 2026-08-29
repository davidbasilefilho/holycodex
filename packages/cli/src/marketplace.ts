// SPDX-License-Identifier: Apache-2.0

import { dirname } from "node:path";
import * as Schema from "effect/Schema";
import { canonicalJson, type JsonObject, type JsonValue } from "@holycodex/core";
import { assertNoSymlink, ensureOwnedDirectory, isFsCode } from "./paths.ts";
import { readJsonObject, writeAtomicJson } from "./storage.ts";
import { decodeSchema, JsonObjectSchema } from "./schema.ts";
import type { InstallRecord } from "./types.ts";

const MarketplaceSchema = JsonObjectSchema;
const MarketplaceEntrySchema = Schema.declare((value: unknown): value is JsonObject => {
  const parsed = decodeSchema(JsonObjectSchema, value);
  return parsed !== undefined && typeof parsed["name"] === "string";
});
const MarketplaceNameSchema = Schema.Literal("holycodex");

export interface MarketplaceDocument extends JsonObject {
  readonly name: typeof MANAGED_MARKETPLACE_OWNER;
  readonly plugins: readonly JsonObject[];
}

export interface MarketplaceReadResult {
  readonly document: MarketplaceDocument;
  readonly repaired: boolean;
}

export const MANAGED_MARKETPLACE_OWNER = "holycodex" as const;
export const MANAGED_MARKETPLACE_CATEGORY = "Development" as const;
export const MANAGED_INSTALL_POLICY = "AVAILABLE" as const;
export const MANAGED_AUTH_POLICY = "ON_INSTALL" as const;

export async function readMarketplace(path: string): Promise<MarketplaceDocument> {
  return (await readMarketplaceInternal(path, false)).document;
}

/** Reads the official document and repairs only the previous HolyCodex shape in memory. */
export async function readMarketplaceForInstall(path: string): Promise<MarketplaceReadResult> {
  return await readMarketplaceInternal(path, true);
}

async function readMarketplaceInternal(
  path: string,
  allowLegacyRepair: boolean,
): Promise<MarketplaceReadResult> {
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
    return { document: emptyMarketplace(), repaired: false };
  }
  const parsed = decodeSchema(MarketplaceSchema, document);
  if (parsed !== undefined) {
    const official = parseOfficialMarketplace(parsed);
    if (official !== undefined) return { document: official, repaired: false };
  }
  if (allowLegacyRepair) {
    const repaired = repairLegacyMarketplace(document);
    if (repaired !== undefined) return { document: repaired, repaired: true };
  }
  throw new MarketplaceError(
    "marketplace_invalid",
    "The marketplace file is not a valid Codex marketplace.",
  );
}

function parseOfficialMarketplace(document: JsonObject): MarketplaceDocument | undefined {
  if (decodeSchema(MarketplaceNameSchema, document["name"]) === undefined) return undefined;
  const rawPlugins = document["plugins"];
  if (!Array.isArray(rawPlugins)) return undefined;
  const plugins: JsonObject[] = [];
  for (const item of rawPlugins) {
    const plugin = decodeSchema(MarketplaceEntrySchema, item);
    if (plugin === undefined) return undefined;
    plugins.push(plugin);
  }
  return {
    ...document,
    name: MANAGED_MARKETPLACE_OWNER,
    plugins,
  };
}

function repairLegacyMarketplace(document: JsonObject): MarketplaceDocument | undefined {
  const rawPlugins = document["plugins"];
  if (!Array.isArray(rawPlugins)) return undefined;
  const plugins: JsonObject[] = [];
  for (const item of rawPlugins) {
    if (!isJsonObject(item)) return undefined;
    if (isLegacyManagedEntry(item)) {
      const source = item["source"];
      if (typeof source !== "string" || source.length === 0) return undefined;
      plugins.push(repairLegacyEntry(item));
    } else {
      plugins.push(item);
    }
  }
  return {
    ...document,
    name: MANAGED_MARKETPLACE_OWNER,
    interface: isJsonObject(document["interface"])
      ? document["interface"]
      : { displayName: "HolyCodex" },
    plugins,
  };
}

function repairLegacyEntry(entry: JsonObject): JsonObject {
  const source = entry["source"];
  return {
    name: MANAGED_MARKETPLACE_OWNER,
    source: { source: "local", path: typeof source === "string" ? source : "" },
    policy: { installation: MANAGED_INSTALL_POLICY, authentication: MANAGED_AUTH_POLICY },
    category: MANAGED_MARKETPLACE_CATEGORY,
  };
}

function isLegacyManagedEntry(value: JsonValue | undefined): value is JsonObject {
  return (
    isJsonObject(value) &&
    (value["name"] === MANAGED_MARKETPLACE_OWNER ||
      (isJsonObject(value["owner"]) && value["owner"]["name"] === MANAGED_MARKETPLACE_OWNER))
  );
}

function emptyMarketplace(): MarketplaceDocument {
  return {
    name: MANAGED_MARKETPLACE_OWNER,
    interface: { displayName: "HolyCodex" },
    plugins: [],
  };
}

export async function writeMarketplace(path: string, document: MarketplaceDocument): Promise<void> {
  await ensureOwnedDirectory(dirname(path));
  await writeAtomicJson(path, document);
}

export function managedMarketplaceEntry(record: InstallRecord): JsonObject {
  return {
    name: "holycodex",
    source: { source: "local", path: record.relative_path },
    policy: { installation: MANAGED_INSTALL_POLICY, authentication: MANAGED_AUTH_POLICY },
    category: MANAGED_MARKETPLACE_CATEGORY,
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
  for (const key of ["name", "source", "policy", "category"]) {
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
