// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "@holycodex/core";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

/** Portable schemas are the only schema values that may cross the QuickJS boundary. */
export type PortableSchemaIR = Readonly<
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unknown" }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "array"; readonly element: PortableSchemaIR }
  | { readonly kind: "struct"; readonly fields: Readonly<Record<string, PortableSchemaIR>> }
>;

export type PortableSchema<T extends JsonValue = JsonValue> = Readonly<{
  readonly __holycodexSchema: PortableSchemaIR;
  readonly _type?: T;
}>;

export interface ValueCodec<T extends JsonValue = JsonValue> {
  readonly name: string;
  readonly decode: (value: unknown) => T;
}

export function createCodec<T extends JsonValue>(
  name: string,
  decode: ((value: unknown) => T) | PortableSchema<T>,
): ValueCodec<T> {
  if (name.length === 0) {
    throw new Error("A workflow codec name is required.");
  }
  if (typeof decode === "function") return Object.freeze({ name, decode });
  return Object.freeze({
    name,
    decode: (value: unknown) => decodePortableSchema(decode, value) as T,
  });
}

/** Decode portable schema IR with the real host-side Effect Schema runtime. */
export function decodePortableSchema<T extends JsonValue = JsonValue>(
  schema: PortableSchema<T> | PortableSchemaIR,
  value: unknown,
): T {
  const ir = "__holycodexSchema" in schema ? schema.__holycodexSchema : schema;
  const parsed = Schema.decodeUnknownEither(toEffectSchema(ir))(value);
  if (Either.isLeft(parsed)) throw new Error("The workflow value does not match its schema.");
  return parsed.right as T;
}

function toEffectSchema(ir: PortableSchemaIR): Schema.Schema.AnyNoContext {
  switch (ir.kind) {
    case "string":
      return Schema.String;
    case "number":
      return Schema.Number;
    case "boolean":
      return Schema.Boolean;
    case "unknown":
      return Schema.Unknown;
    case "literal":
      return Schema.Literal(ir.value);
    case "array":
      return Schema.Array(toEffectSchema(ir.element));
    case "struct":
      return Schema.Struct(
        Object.fromEntries(
          Object.entries(ir.fields).map(([key, value]) => [key, toEffectSchema(value)]),
        ),
      );
  }
}
