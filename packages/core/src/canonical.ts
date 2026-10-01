// SPDX-License-Identifier: Apache-2.0

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { JsonObject, JsonValue } from "./common.ts";
import { CoreError } from "./errors.ts";
import { parseIdentityInput, type Sha256Digest } from "./identifiers.ts";

function canonicalError(path: string, reason: string): CoreError {
  return new CoreError("invalid_canonical_value", `Cannot canonicalize ${path}: ${reason}.`, {
    path,
    reason,
  });
}

function isCanonicalJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const nestedAncestors = new Set(ancestors);
  nestedAncestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isCanonicalJsonValue(descriptor.value, nestedAncestors)
      )
        return false;
    }
    return Object.getOwnPropertyNames(value).every((key) => {
      if (key === "length") return true;
      const index = Number(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        Number.isInteger(index) &&
        index >= 0 &&
        index < value.length &&
        String(index) === key &&
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor
      );
    });
  }

  if (
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    return false;
  return Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor &&
      isCanonicalJsonValue(descriptor.value, nestedAncestors)
    );
  });
}

const CanonicalJsonSchema = Schema.Json.check(
  Schema.makeFilter((value) => isCanonicalJsonValue(value)),
);
const DigestDomainSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/^[^\0]+$/u),
);

function canonicalize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return JSON.stringify(value);
    case "object":
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const objectValue = value as JsonObject;
  const fields = Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key]!)}`);
  return `{${fields.join(",")}}`;
}

/** Canonicalize a JSON-compatible value with sorted object keys and strict structure checks. */
export function canonicalJson(value: unknown): string {
  const parsed = Schema.decodeUnknownResult(CanonicalJsonSchema)(value);
  if (Result.isFailure(parsed))
    throw canonicalError("$", `invalid JSON value: ${String(parsed.failure)}`);
  return canonicalize(parsed.success as JsonValue);
}

/** Encode the canonical JSON representation of a value as UTF-8 bytes. */
export function canonicalJsonUtf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Validate an identity record and encode its canonical JSON representation as UTF-8. */
export function canonicalIdentityUtf8(input: unknown): Uint8Array {
  const parsed = parseIdentityInput(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return canonicalJsonUtf8(parsed.value);
}

/** Frame a domain and ordered byte parts into the deterministic SHA-256 input format. */
export function composeDigestInput(domain: string, parts: readonly Uint8Array[]): Uint8Array {
  const parsedDomain = Schema.decodeUnknownResult(DigestDomainSchema)(domain);
  if (Result.isFailure(parsedDomain)) {
    throw new CoreError("invalid_digest_domain", "Digest domains must be non-empty and NUL-free.", {
      field: "domain",
    });
  }
  const prefix = new TextEncoder().encode("holycodex-sha256\u0000");
  const domainBytes = new TextEncoder().encode(parsedDomain.success);
  let totalLength = prefix.byteLength + 8 + domainBytes.byteLength;
  for (const part of parts) {
    if (part.byteLength > 0xffffffff || totalLength > 0xffffffff - 4 - part.byteLength) {
      throw new CoreError("invalid_digest_domain", "Digest input is too large.");
    }
    totalLength += 4 + part.byteLength;
  }

  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  output.set(prefix, 0);
  let offset = prefix.byteLength;
  view.setUint32(offset, domainBytes.byteLength, false);
  offset += 4;
  output.set(domainBytes, offset);
  offset += domainBytes.byteLength;
  view.setUint32(offset, parts.length, false);
  offset += 4;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

/** Hash framed byte parts under a validated HolyCodex digest domain. */
export function domainSeparatedSha256(
  domain: string,
  parts: readonly Uint8Array[],
): Promise<Sha256Digest> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new CoreError("crypto_unavailable", "The standards-based crypto API is unavailable.");
  }
  return Effect.runPromise(
    Effect.map(
      Effect.tryPromise(() =>
        subtle.digest("SHA-256", toCryptoBuffer(composeDigestInput(domain, parts)).buffer),
      ),
      (digest) => {
        // SHA-256 always returns 32 bytes; the hex encoding is therefore a digest.
        return bytesToHex(new Uint8Array(digest)) as Sha256Digest;
      },
    ),
  );
}

function toCryptoBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** Hash framed byte parts under a validated HolyCodex digest domain. */
export const sha256DomainDigest = domainSeparatedSha256;
