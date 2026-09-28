// SPDX-License-Identifier: Apache-2.0

/** Published package identifier for the shared core contracts. */
export const packageName = "@holycodex/core" as const;
/** Current version of the CLI JSON envelope schema. */
export const CLI_SCHEMA_VERSION = "0.15" as const;
/** Current persisted work-state schema epoch. */
export const STATE_SCHEMA_EPOCH = "state-0.16" as const;

/** JSON scalar values supported by the core serialization boundary. */
export type JsonPrimitive = string | number | boolean | null;
/** Readonly JSON object with recursively valid values. */
export type JsonObject = {
  /** Value associated with each JSON object key. */
  readonly [key: string]: JsonValue;
};
/** Recursive JSON value accepted by core envelopes and diagnostics. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
/** JSON-safe structured context attached to core errors. */
export type SafeDetails = JsonObject;

/** Deeply freeze an object graph while handling cycles safely. */
export function freezeDeep(value: object, seen = new WeakSet<object>()): void {
  if (seen.has(value)) {
    return;
  }

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor && isObject(descriptor.value)) {
      freezeDeep(descriptor.value, seen);
    }
  }
  Object.freeze(value);
}

/** Return whether a value is a non-null object. */
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
