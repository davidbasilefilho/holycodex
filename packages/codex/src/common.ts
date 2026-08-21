// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import {
  canonicalJson,
  CLI_SCHEMA_VERSION,
  decodeUnknown,
  type JsonObject,
  type JsonValue,
} from "@holycodex/core";

export const packageName = "@holycodex/codex" as const;
export const CODEX_PROTOCOL_VERSION = "codex-cli-0.148.0" as const;
export const CODEX_CLIENT_VERSION = CLI_SCHEMA_VERSION;
export const CODEX_PROTOCOL_EPOCH = "codex-app-server-0.148.0" as const;
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

export const JsonValueSchema = Schema.declare((value: unknown): value is JsonValue =>
  isJsonValue(value),
);
export const JsonObjectSchema = Schema.declare(
  (value: unknown): value is JsonObject => isPlainObject(value) && isJsonValue(value),
);
export const IdentifierSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
);
export const TextSchema = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 && value.length <= 4096),
);
export const NonNegativeNumberSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && value >= 0),
);

export type CodexErrorCode =
  | "approval_required"
  | "cancellation"
  | "capability_unavailable"
  | "closed"
  | "discovery_failed"
  | "empty_output_directory"
  | "execution_failed"
  | "invalid_external_data"
  | "invalid_project_root"
  | "invalid_transport_line"
  | "manifest_invalid"
  | "method_unsupported"
  | "model_unsupported"
  | "permission_denied"
  | "protocol_mismatch"
  | "route_incompatible"
  | "server_error"
  | "server_request_unsupported"
  | "subprocess_failed"
  | "timeout"
  | "transport_closed"
  | "transport_failure"
  | "turn_failed"
  | "unexpected_response";

export type CodexFailureKind =
  | "approval"
  | "capability"
  | "closed"
  | "identity"
  | "interruption"
  | "protocol"
  | "route"
  | "server"
  | "subprocess"
  | "timeout"
  | "transport"
  | "turn"
  | "uncertain_effect"
  | "validation";

export function failureKind(code: CodexErrorCode): CodexFailureKind {
  switch (code) {
    case "invalid_external_data":
    case "manifest_invalid":
    case "invalid_project_root":
    case "empty_output_directory":
      return "validation";
    case "discovery_failed":
      return "identity";
    case "protocol_mismatch":
    case "method_unsupported":
    case "server_request_unsupported":
    case "unexpected_response":
      return "protocol";
    case "invalid_transport_line":
    case "transport_closed":
    case "transport_failure":
      return "transport";
    case "capability_unavailable":
    case "model_unsupported":
      return "capability";
    case "route_incompatible":
      return "route";
    case "approval_required":
    case "permission_denied":
      return "approval";
    case "cancellation":
      return "interruption";
    case "timeout":
      return "timeout";
    case "turn_failed":
      return "turn";
    case "execution_failed":
      return "uncertain_effect";
    case "subprocess_failed":
      return "subprocess";
    case "closed":
      return "closed";
    case "server_error":
      return "server";
  }
}

export class CodexError extends Error {
  readonly code: CodexErrorCode;
  readonly kind: CodexFailureKind;
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
    this.kind = failureKind(code);
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

export function checked<T>(schema: Schema.Schema<T>, input: unknown, label: string): T {
  const parsed = decodeUnknown(schema, input);
  if (Either.isLeft(parsed)) {
    throw invalidData(label, input, String(parsed.left));
  }
  return parsed.right;
}

export function isValid<T>(schema: Schema.Schema<T>, input: unknown): input is T {
  try {
    checked(schema, input, "value");
    return true;
  } catch {
    return false;
  }
}
