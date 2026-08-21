// SPDX-License-Identifier: Apache-2.0

import { CoreError } from "./errors.ts";
import { parseIdentityInput, type Sha256Digest } from "./identifiers.ts";

function canonicalError(path: string, reason: string): CoreError {
  return new CoreError("invalid_canonical_value", `Cannot canonicalize ${path}: ${reason}.`, {
    path,
    reason,
  });
}

function canonicalize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string": {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw canonicalError(path, "invalid string");
      }
      return encoded;
    }
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw canonicalError(path, "non-finite number");
      }
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw canonicalError(path, "invalid number");
      }
      return encoded;
    }
    case "undefined":
      throw canonicalError(path, "undefined is not JSON");
    case "bigint":
      throw canonicalError(path, "bigint is not JSON");
    case "function":
      throw canonicalError(path, "function is not JSON");
    case "symbol":
      throw canonicalError(path, "symbol is not JSON");
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw canonicalError(path, "cyclic value");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const symbol of Object.getOwnPropertySymbols(value)) {
        throw canonicalError(path, `symbol property ${String(symbol)}`);
      }
      const arrayValue: readonly unknown[] = value;
      const items: string[] = [];
      for (let index = 0; index < arrayValue.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw canonicalError(`${path}[${index}]`, "sparse or accessor array item");
        }
        items.push(canonicalize(descriptor.value, `${path}[${index}]`, ancestors));
      }
      for (const key of Object.getOwnPropertyNames(arrayValue)) {
        if (key === "length") {
          continue;
        }
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= arrayValue.length ||
          String(index) !== key
        ) {
          throw canonicalError(path, `non-index array property ${key}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(arrayValue, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw canonicalError(`${path}[${index}]`, "non-enumerable or accessor array item");
        }
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw canonicalError(path, "only plain objects are supported");
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      throw canonicalError(path, `symbol property ${String(symbol)}`);
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw canonicalError(`${path}.${key}`, "non-enumerable or accessor property");
      }
    }

    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw canonicalError(`${path}.${key}`, "accessor property");
      }
      fields.push(
        `${JSON.stringify(key)}:${canonicalize(descriptor.value, `${path}.${key}`, ancestors)}`,
      );
    }
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$", new Set<object>());
}

export function canonicalJsonUtf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function canonicalIdentityUtf8(input: unknown): Uint8Array {
  const parsed = parseIdentityInput(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return canonicalJsonUtf8(parsed.value);
}

export function composeDigestInput(domain: string, parts: readonly Uint8Array[]): Uint8Array {
  if (domain.length === 0 || domain.includes("\u0000")) {
    throw new CoreError("invalid_digest_domain", "Digest domains must be non-empty and NUL-free.", {
      field: "domain",
    });
  }
  const prefix = new TextEncoder().encode("holycodex-sha256\u0000");
  const domainBytes = new TextEncoder().encode(domain);
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

export async function domainSeparatedSha256(
  domain: string,
  parts: readonly Uint8Array[],
): Promise<Sha256Digest> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new CoreError("crypto_unavailable", "The standards-based crypto API is unavailable.");
  }
  const digest = await subtle.digest("SHA-256", toCryptoBuffer(composeDigestInput(domain, parts)));
  // SHA-256 always returns 32 bytes; the hex encoding is therefore a digest.
  return bytesToHex(new Uint8Array(digest)) as Sha256Digest;
}

function toCryptoBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export const sha256DomainDigest = domainSeparatedSha256;
