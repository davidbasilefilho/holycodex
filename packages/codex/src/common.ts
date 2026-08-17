// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { canonicalJson, type JsonObject, type JsonValue } from "@holycodex/core";

export const packageName = "@holycodex/codex" as const;
export const CODEX_PROTOCOL_VERSION = "0.15" as const;
export const CODEX_CLIENT_VERSION = [CODEX_PROTOCOL_VERSION, "0"].join(".");
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

type SafeObject = Record<string, JsonValue>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

export const JsonValueSchema = type("unknown").narrow((value): value is JsonValue =>
  isJsonValue(value),
);
export const JsonObjectSchema = type("object").narrow(
  (value): value is JsonObject => isPlainObject(value) && isJsonValue(value),
);
export const IdentifierSchema = type(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const TextSchema = type("string").narrow(
  (value): value is string => value.length > 0 && value.length <= 4096,
);
export const NonNegativeNumberSchema = type("number").narrow(
  (value): value is number => Number.isFinite(value) && value >= 0,
);

export type CodexErrorCode =
  | "closed"
  | "discovery_failed"
  | "empty_output_directory"
  | "invalid_external_data"
  | "invalid_project_root"
  | "invalid_transport_line"
  | "manifest_invalid"
  | "method_unsupported"
  | "server_error"
  | "server_request_unsupported"
  | "transport_closed"
  | "transport_failure"
  | "unexpected_response";

export class CodexError extends Error {
  readonly code: CodexErrorCode;
  readonly details: JsonObject;
  readonly retryable: boolean;

  constructor(
    code: CodexErrorCode,
    message: string,
    details: JsonObject = {},
    options?: { readonly cause?: unknown; readonly retryable?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexError";
    this.code = code;
    this.details = details;
    this.retryable = options?.retryable ?? false;
    Object.freeze(this.details);
    Object.freeze(this);
  }
}

export type CodexResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CodexError };

export function failure<T>(error: CodexError): CodexResult<T> {
  return { ok: false, error };
}

export function success<T>(value: T): CodexResult<T> {
  return { ok: true, value };
}

export function sanitizeText(value: string, maxLength = 512): string {
  let withoutControls = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    withoutControls +=
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
        ? " "
        : character;
  }
  return withoutControls.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function sanitizeMetadata(value: unknown, depth = 0): JsonValue {
  if (depth > 3) {
    return "[truncated]";
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeText(value, 256);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const output: SafeObject = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      const safeKey = sanitizeText(key, 96);
      if (safeKey.length > 0) {
        output[safeKey] = sanitizeMetadata(item, depth + 1);
      }
    }
    return output;
  }
  return "[redacted]";
}

export function safeDetails(value: unknown): JsonObject {
  const sanitized = sanitizeMetadata(value);
  return isPlainObject(sanitized) ? sanitized : { value: sanitized };
}

export function invalidData(label: string, input: unknown, cause?: unknown): CodexError {
  return new CodexError(
    "invalid_external_data",
    `Invalid ${label}.`,
    { field: label, received: sanitizeMetadata(input) },
    cause === undefined ? undefined : { cause },
  );
}

export function checked<T>(
  schema: (input: unknown) => T | InstanceType<typeof type.errors>,
  input: unknown,
  label: string,
): T {
  const parsed = schema(input);
  if (parsed instanceof type.errors) {
    throw invalidData(label, input, parsed.summary);
  }
  return parsed;
}
