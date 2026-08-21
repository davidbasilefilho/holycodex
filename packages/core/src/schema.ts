// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

const strictParseOptions = { onExcessProperty: "error" } as const;

export function decodeUnknown<A, I>(schema: Schema.Schema<A, I>, input: unknown) {
  return Schema.decodeUnknownEither(schema, strictParseOptions)(input);
}
