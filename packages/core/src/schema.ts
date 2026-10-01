// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

const strictParseOptions = { onExcessProperty: "error" } as const;

/** Decode an unknown value with strict rejection of excess object properties. */
export function decodeUnknown<A>(schema: Schema.Codec<A, unknown>, input: unknown) {
  return Schema.decodeUnknownResult(schema, strictParseOptions)(input);
}
