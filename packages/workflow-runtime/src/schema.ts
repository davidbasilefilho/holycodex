// SPDX-License-Identifier: Apache-2.0

/**
 * A small native codec boundary keeps Effect out of the public workflow DSL.
 * Host adapters can construct codecs from their Effect Schema decoders without
 * exposing Effect values in step composition.
 */
export interface ValueCodec<T> {
  readonly name: string;
  readonly decode: (value: unknown) => T;
}

export function createCodec<T>(name: string, decode: (value: unknown) => T): ValueCodec<T> {
  if (name.length === 0) {
    throw new Error("A workflow codec name is required.");
  }
  return Object.freeze({ name, decode });
}
