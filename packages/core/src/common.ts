// SPDX-License-Identifier: Apache-2.0

export const packageName = "@holycodex/core" as const;
export const CLI_SCHEMA_VERSION = "0.15" as const;
export const STATE_SCHEMA_EPOCH = "state-0.15" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type SafeDetails = JsonObject;

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

export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
