// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, type JsonValue } from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const JsonValueSchema = Schema.Json;

/** Validate and return a value that can be emitted as canonical JSON. */
export function asJsonValue(value: unknown): JsonValue {
  return Effect.runSync(
    Effect.try({
      try: () => {
        Schema.decodeUnknownSync(JsonValueSchema)(value);
        canonicalJson(value);
        return value as JsonValue;
      },
      catch: () => new Error("The value is not JSON serializable."),
    }),
  ) as JsonValue;
}

/** Return whether a value is a finite, acyclic JSON value. */
export function isJsonValue(value: unknown): value is JsonValue {
  return Schema.is(JsonValueSchema)(value);
}
