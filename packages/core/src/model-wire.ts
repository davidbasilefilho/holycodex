// SPDX-License-Identifier: Apache-2.0

import { decode, encode } from "@toon-format/toon";
import type { JsonValue } from "./common.ts";

/** The sole structured model-boundary codec. Internal protocols may keep JSON. */
export function encodeModelWire(value: unknown): string {
  return encode(value);
}

export function decodeModelWire(value: string): JsonValue {
  return decode(value, { strict: true });
}
