import type { JsonSchema } from "./types.js";

/** Provides object schema. */
export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
  };
}
