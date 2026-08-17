// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, type JsonValue } from "@holycodex/core";

export function asJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error("The value is not JSON serializable.");
  }
  canonicalJson(value);
  return value;
}

export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, seen));
    }
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJsonValue(item, seen))
    );
  } finally {
    seen.delete(value);
  }
}
