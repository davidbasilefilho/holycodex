// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

const strictParseOptions = { onExcessProperty: "error" } as const;

/** Decode an unknown value with strict rejection of excess object properties. */
export function decodeUnknown<A, I>(schema: Schema.Schema<A, I>, input: unknown) {
  return Schema.decodeUnknownEither(schema, strictParseOptions)(input);
}
