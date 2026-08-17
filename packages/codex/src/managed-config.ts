// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { canonicalJson, type JsonObject, type JsonValue } from "@holycodex/core";
import {
  checked,
  IdentifierSchema,
  invalidData,
  JsonObjectSchema,
  JsonValueSchema,
  TextSchema,
} from "./common";

export const ManagedConfigMetadataSchema = type({
  "+": "reject",
  owner: "'holycodex'",
  schema: TextSchema,
  installId: IdentifierSchema,
});
export type ManagedConfigMetadata = typeof ManagedConfigMetadataSchema.infer;

export const ManagedConfigEntrySchema = type({
  "+": "reject",
  owner: "'holycodex'",
  schema: TextSchema,
  installId: IdentifierSchema,
  originalValue: JsonValueSchema,
  lastManagedValue: JsonValueSchema,
  hadOriginalValue: "boolean",
});
export type ManagedConfigEntry = typeof ManagedConfigEntrySchema.infer;

export interface ManagedConfigState {
  readonly values: JsonObject;
  readonly managed: Readonly<Record<string, ManagedConfigEntry>>;
}

export interface ManagedConfigCleanup {
  readonly state: ManagedConfigState;
  readonly restoredKeys: readonly string[];
  readonly preservedKeys: readonly string[];
}

function copyJsonObject(value: JsonObject): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value));
}

function validateManagedEntries(managed: Readonly<Record<string, ManagedConfigEntry>>): void {
  for (const [key, entry] of Object.entries(managed)) {
    if (IdentifierSchema(key) instanceof type.errors) {
      throw invalidData("managed config key", key);
    }
    if (ManagedConfigEntrySchema(entry) instanceof type.errors) {
      throw invalidData("managed config entry", entry);
    }
  }
}

function equalJson(left: JsonValue | undefined, right: JsonValue): boolean {
  if (left === undefined) {
    return false;
  }
  return canonicalJson(left) === canonicalJson(right);
}

export function createManagedConfigState(values: JsonObject = {}): ManagedConfigState {
  if (JsonObjectSchema(values) instanceof type.errors) {
    throw invalidData("managed config values", values);
  }
  return { values: copyJsonObject(values), managed: {} };
}

export function mergeManagedConfig(
  current: ManagedConfigState,
  desired: JsonObject,
  metadata: ManagedConfigMetadata,
): ManagedConfigState {
  const validatedMetadata = checked(
    ManagedConfigMetadataSchema,
    metadata,
    "managed config metadata",
  );
  if (
    JsonObjectSchema(current.values) instanceof type.errors ||
    JsonObjectSchema(desired) instanceof type.errors
  ) {
    throw invalidData("managed config", { values: current.values, desired });
  }
  validateManagedEntries(current.managed);
  const values = copyJsonObject(current.values);
  const managed: Record<string, ManagedConfigEntry> = { ...current.managed };
  for (const [key, nextValue] of Object.entries(desired)) {
    const existing = managed[key];
    const hadOriginalValue =
      existing?.hadOriginalValue ?? Object.prototype.hasOwnProperty.call(values, key);
    const originalValue = existing?.originalValue ?? values[key] ?? null;
    values[key] = nextValue;
    managed[key] = {
      owner: validatedMetadata.owner,
      schema: validatedMetadata.schema,
      installId: validatedMetadata.installId,
      originalValue,
      lastManagedValue: nextValue,
      hadOriginalValue,
    };
  }
  return { values, managed };
}

export function cleanupManagedConfig(
  current: ManagedConfigState,
  metadata: ManagedConfigMetadata,
): ManagedConfigCleanup {
  const validatedMetadata = checked(
    ManagedConfigMetadataSchema,
    metadata,
    "managed config metadata",
  );
  if (JsonObjectSchema(current.values) instanceof type.errors) {
    throw invalidData("managed config values", current.values);
  }
  validateManagedEntries(current.managed);
  const values = copyJsonObject(current.values);
  const managed: Record<string, ManagedConfigEntry> = { ...current.managed };
  const restoredKeys: string[] = [];
  const preservedKeys: string[] = [];
  for (const [key, entry] of Object.entries(current.managed)) {
    if (
      entry.owner !== validatedMetadata.owner ||
      entry.schema !== validatedMetadata.schema ||
      entry.installId !== validatedMetadata.installId
    ) {
      continue;
    }
    const currentValue = values[key];
    if (equalJson(currentValue, entry.lastManagedValue)) {
      if (entry.hadOriginalValue) {
        values[key] = entry.originalValue;
      } else {
        delete values[key];
      }
      restoredKeys.push(key);
    } else {
      preservedKeys.push(key);
    }
    delete managed[key];
  }
  return { state: { values, managed }, restoredKeys, preservedKeys };
}

export interface ManagedWriteDecision {
  readonly shouldWrite: boolean;
  readonly current: JsonValue | null;
  readonly next: JsonValue;
}

export function compareBeforeManagedWrite(
  current: JsonValue | undefined,
  expected: JsonValue,
  next: JsonValue,
): ManagedWriteDecision {
  return {
    shouldWrite: !equalJson(current, expected),
    current: current ?? null,
    next,
  };
}
