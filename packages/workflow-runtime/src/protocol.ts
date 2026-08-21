// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, decodeUnknown, type JsonObject, type JsonValue } from "@holycodex/core";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

export const WORKFLOW_PROTOCOL_VERSION = 1 as const;

export type WorkflowLimits = Readonly<{
  readonly maxLineBytes: number;
  readonly maxJsonDepth: number;
  readonly maxObjectKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringBytes: number;
  readonly maxOperationCount: number;
  readonly maxConcurrentOperations: number;
  readonly maxResultBytes: number;
  readonly maxSourceBytes: number;
  readonly wallTimeMs: number;
  readonly memoryLimitBytes: number;
  readonly stackLimitBytes: number;
  readonly maxInterrupts: number;
}>;
export type WorkflowLimitsInput = Partial<WorkflowLimits>;

export const DEFAULT_WORKFLOW_LIMITS = Object.freeze({
  maxLineBytes: 512 * 1024,
  maxJsonDepth: 32,
  maxObjectKeys: 256,
  maxArrayItems: 256,
  maxStringBytes: 128 * 1024,
  maxOperationCount: 128,
  maxConcurrentOperations: 8,
  maxResultBytes: 256 * 1024,
  maxSourceBytes: 256 * 1024,
  wallTimeMs: 5_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  stackLimitBytes: 4 * 1024 * 1024,
  maxInterrupts: 100_000,
});

const WORKFLOW_LIMIT_CEILINGS = Object.freeze({
  maxLineBytes: 4 * 1024 * 1024,
  maxJsonDepth: 64,
  maxObjectKeys: 4_096,
  maxArrayItems: 4_096,
  maxStringBytes: 1024 * 1024,
  maxOperationCount: 1_024,
  maxConcurrentOperations: 32,
  maxResultBytes: 4 * 1024 * 1024,
  maxSourceBytes: 1024 * 1024,
  wallTimeMs: 60_000,
  memoryLimitBytes: 256 * 1024 * 1024,
  stackLimitBytes: 32 * 1024 * 1024,
  maxInterrupts: 1_000_000,
});

export const MAX_WORKFLOW_LIMITS: WorkflowLimits = Object.freeze({
  maxLineBytes: WORKFLOW_LIMIT_CEILINGS.maxLineBytes,
  maxJsonDepth: WORKFLOW_LIMIT_CEILINGS.maxJsonDepth,
  maxObjectKeys: WORKFLOW_LIMIT_CEILINGS.maxObjectKeys,
  maxArrayItems: WORKFLOW_LIMIT_CEILINGS.maxArrayItems,
  maxStringBytes: WORKFLOW_LIMIT_CEILINGS.maxStringBytes,
  maxOperationCount: WORKFLOW_LIMIT_CEILINGS.maxOperationCount,
  maxConcurrentOperations: WORKFLOW_LIMIT_CEILINGS.maxConcurrentOperations,
  maxResultBytes: WORKFLOW_LIMIT_CEILINGS.maxResultBytes,
  maxSourceBytes: WORKFLOW_LIMIT_CEILINGS.maxSourceBytes,
  wallTimeMs: WORKFLOW_LIMIT_CEILINGS.wallTimeMs,
  memoryLimitBytes: WORKFLOW_LIMIT_CEILINGS.memoryLimitBytes,
  stackLimitBytes: WORKFLOW_LIMIT_CEILINGS.stackLimitBytes,
  maxInterrupts: WORKFLOW_LIMIT_CEILINGS.maxInterrupts,
});

const WORKFLOW_LIMIT_KEYS = [
  "maxLineBytes",
  "maxJsonDepth",
  "maxObjectKeys",
  "maxArrayItems",
  "maxStringBytes",
  "maxOperationCount",
  "maxConcurrentOperations",
  "maxResultBytes",
  "maxSourceBytes",
  "wallTimeMs",
  "memoryLimitBytes",
  "stackLimitBytes",
  "maxInterrupts",
] as const satisfies readonly (keyof WorkflowLimits)[];

export type WorkflowOperation = Readonly<{
  readonly name: "agent";
  readonly prompt: string;
  readonly options: JsonValue;
}>;

export type WorkflowOperationHandler = (
  operation: WorkflowOperation,
) => JsonValue | Promise<JsonValue>;

export type WorkflowErrorCode =
  | "invalid_input"
  | "source_rejected"
  | "protocol_breach"
  | "timed_out"
  | "cancelled"
  | "child_crashed"
  | "operation_failed"
  | "evaluation_failed"
  | "interrupted"
  | "resource_limit"
  | "invalid_result";

export type WorkflowErrorDetails = JsonObject;

export class WorkflowRuntimeError extends Error {
  readonly code: WorkflowErrorCode;
  readonly details: WorkflowErrorDetails;

  constructor(code: WorkflowErrorCode, message: string, details: WorkflowErrorDetails = {}) {
    super(message);
    this.name = "WorkflowRuntimeError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }
}

export type WorkflowResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: WorkflowRuntimeError };

const IdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u));
const JsonValueSchema = Schema.declare((value: unknown): value is JsonValue => isJsonValue(value));
const ErrorCodeSchema = Schema.Literal(
  "invalid_input",
  "source_rejected",
  "protocol_breach",
  "timed_out",
  "cancelled",
  "child_crashed",
  "operation_failed",
  "evaluation_failed",
  "interrupted",
  "resource_limit",
  "invalid_result",
);
const WireErrorSchema = Schema.Struct({
  code: ErrorCodeSchema,
  message: Schema.String,
});
type WireError = typeof WireErrorSchema.Type;

const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));

export const WorkflowLimitsSchema = Schema.Struct({
  max_line_bytes: PositiveIntegerSchema,
  max_json_depth: PositiveIntegerSchema,
  max_object_keys: PositiveIntegerSchema,
  max_array_items: PositiveIntegerSchema,
  max_string_bytes: PositiveIntegerSchema,
  max_operation_count: PositiveIntegerSchema,
  max_concurrent_operations: PositiveIntegerSchema,
  max_result_bytes: PositiveIntegerSchema,
  max_source_bytes: PositiveIntegerSchema,
  wall_time_ms: PositiveIntegerSchema,
  memory_limit_bytes: PositiveIntegerSchema,
  stack_limit_bytes: PositiveIntegerSchema,
  max_interrupts: PositiveIntegerSchema,
});

export type WireLimits = typeof WorkflowLimitsSchema.Type;

const StartMessageSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("start"),
  source: Schema.String,
  args: JsonValueSchema,
  runtime: JsonValueSchema,
  limits: WorkflowLimitsSchema,
});

const OperationInputSchema = Schema.Struct({
  prompt: Schema.String,
  options: JsonValueSchema,
});

const OperationRequestMessageSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("operation-request"),
  request_id: IdentifierSchema,
  operation: Schema.Literal("agent"),
  input: OperationInputSchema,
});

const OperationResultMessageSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("operation-result"),
  request_id: IdentifierSchema,
  ok: Schema.Boolean,
  result: Schema.optional(JsonValueSchema),
  error: Schema.optional(WireErrorSchema),
});

const CancelMessageSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cancel"),
  reason: Schema.Literal("cancelled", "timed_out"),
});

const TerminalSuccessMessageSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("terminal-success"),
  result: JsonValueSchema,
});

const TerminalFailureMessageSchema = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("terminal-failure"),
  error: WireErrorSchema,
});

export const WorkflowProtocolMessageSchema = Schema.Union(
  StartMessageSchema,
  OperationRequestMessageSchema,
  OperationResultMessageSchema,
  CancelMessageSchema,
  TerminalSuccessMessageSchema,
  TerminalFailureMessageSchema,
);

export type StartMessage = typeof StartMessageSchema.Type;
export type OperationRequestMessage = typeof OperationRequestMessageSchema.Type;
export type OperationResultMessage = typeof OperationResultMessageSchema.Type;
export type CancelMessage = typeof CancelMessageSchema.Type;
export type TerminalSuccessMessage = typeof TerminalSuccessMessageSchema.Type;
export type TerminalFailureMessage = typeof TerminalFailureMessageSchema.Type;
export type WorkflowProtocolMessage = typeof WorkflowProtocolMessageSchema.Type;

export function mergeWorkflowLimits(input: WorkflowLimitsInput = {}): WorkflowLimits {
  const merged = {
    maxLineBytes: input.maxLineBytes ?? DEFAULT_WORKFLOW_LIMITS.maxLineBytes,
    maxJsonDepth: input.maxJsonDepth ?? DEFAULT_WORKFLOW_LIMITS.maxJsonDepth,
    maxObjectKeys: input.maxObjectKeys ?? DEFAULT_WORKFLOW_LIMITS.maxObjectKeys,
    maxArrayItems: input.maxArrayItems ?? DEFAULT_WORKFLOW_LIMITS.maxArrayItems,
    maxStringBytes: input.maxStringBytes ?? DEFAULT_WORKFLOW_LIMITS.maxStringBytes,
    maxOperationCount: input.maxOperationCount ?? DEFAULT_WORKFLOW_LIMITS.maxOperationCount,
    maxConcurrentOperations:
      input.maxConcurrentOperations ?? DEFAULT_WORKFLOW_LIMITS.maxConcurrentOperations,
    maxResultBytes: input.maxResultBytes ?? DEFAULT_WORKFLOW_LIMITS.maxResultBytes,
    maxSourceBytes: input.maxSourceBytes ?? DEFAULT_WORKFLOW_LIMITS.maxSourceBytes,
    wallTimeMs: input.wallTimeMs ?? DEFAULT_WORKFLOW_LIMITS.wallTimeMs,
    memoryLimitBytes: input.memoryLimitBytes ?? DEFAULT_WORKFLOW_LIMITS.memoryLimitBytes,
    stackLimitBytes: input.stackLimitBytes ?? DEFAULT_WORKFLOW_LIMITS.stackLimitBytes,
    maxInterrupts: input.maxInterrupts ?? DEFAULT_WORKFLOW_LIMITS.maxInterrupts,
  };
  const parsed = decodeWireLimits({
    max_line_bytes: merged.maxLineBytes,
    max_json_depth: merged.maxJsonDepth,
    max_object_keys: merged.maxObjectKeys,
    max_array_items: merged.maxArrayItems,
    max_string_bytes: merged.maxStringBytes,
    max_operation_count: merged.maxOperationCount,
    max_concurrent_operations: merged.maxConcurrentOperations,
    max_result_bytes: merged.maxResultBytes,
    max_source_bytes: merged.maxSourceBytes,
    wall_time_ms: merged.wallTimeMs,
    memory_limit_bytes: merged.memoryLimitBytes,
    stack_limit_bytes: merged.stackLimitBytes,
    max_interrupts: merged.maxInterrupts,
  });
  if (parsed.max_line_bytes < parsed.max_source_bytes) {
    throw new WorkflowRuntimeError("invalid_input", "The line limit must fit the source limit.", {
      field: "limits.maxLineBytes",
    });
  }
  assertLimitCeilings(merged, "invalid_input");
  return merged;
}

export function toWireLimits(limits: WorkflowLimits): WireLimits {
  return decodeWireLimits({
    max_line_bytes: limits.maxLineBytes,
    max_json_depth: limits.maxJsonDepth,
    max_object_keys: limits.maxObjectKeys,
    max_array_items: limits.maxArrayItems,
    max_string_bytes: limits.maxStringBytes,
    max_operation_count: limits.maxOperationCount,
    max_concurrent_operations: limits.maxConcurrentOperations,
    max_result_bytes: limits.maxResultBytes,
    max_source_bytes: limits.maxSourceBytes,
    wall_time_ms: limits.wallTimeMs,
    memory_limit_bytes: limits.memoryLimitBytes,
    stack_limit_bytes: limits.stackLimitBytes,
    max_interrupts: limits.maxInterrupts,
  });
}

export function fromWireLimits(input: unknown): WorkflowLimits {
  const parsed = decodeWireLimits(input, "protocol_breach");
  if (parsed.max_line_bytes < parsed.max_source_bytes) {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow line limit is invalid.");
  }
  const limits: WorkflowLimits = {
    maxLineBytes: parsed.max_line_bytes,
    maxJsonDepth: parsed.max_json_depth,
    maxObjectKeys: parsed.max_object_keys,
    maxArrayItems: parsed.max_array_items,
    maxStringBytes: parsed.max_string_bytes,
    maxOperationCount: parsed.max_operation_count,
    maxConcurrentOperations: parsed.max_concurrent_operations,
    maxResultBytes: parsed.max_result_bytes,
    maxSourceBytes: parsed.max_source_bytes,
    wallTimeMs: parsed.wall_time_ms,
    memoryLimitBytes: parsed.memory_limit_bytes,
    stackLimitBytes: parsed.stack_limit_bytes,
    maxInterrupts: parsed.max_interrupts,
  };
  assertLimitCeilings(limits, "protocol_breach");
  return limits;
}

export function validateJsonValue(
  value: unknown,
  limits: WorkflowLimits,
  field: string,
): JsonValue {
  if (!isJsonValue(value)) {
    throw new WorkflowRuntimeError(
      field.includes("result") ? "invalid_result" : "invalid_input",
      `Invalid ${field}.`,
      { field },
    );
  }
  const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
  if (bytes > limits.maxResultBytes && field.includes("result")) {
    throw new WorkflowRuntimeError("resource_limit", "The workflow result is too large.", {
      field,
    });
  }
  validateJsonShape(value, limits, "$", new Set<object>());
  return value;
}

export function parseProtocolLine(line: string, limits: WorkflowLimits): WorkflowProtocolMessage {
  if (new TextEncoder().encode(line).byteLength > limits.maxLineBytes) {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow protocol line is too large.");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(line) as unknown;
  } catch {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow protocol JSON is malformed.");
  }
  validateJsonShape(parsedJson, limits, "$", new Set<object>());
  const parsed = decodeUnknown(WorkflowProtocolMessageSchema, parsedJson);
  if (Either.isLeft(parsed)) {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow protocol message is invalid.");
  }
  return parsed.right;
}

export function serializeProtocolMessage(
  message: WorkflowProtocolMessage,
  limits: WorkflowLimits,
): string {
  const parsed = decodeUnknown(WorkflowProtocolMessageSchema, message);
  if (Either.isLeft(parsed)) {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow protocol message is invalid.");
  }
  validateJsonShape(parsed.right, limits, "$", new Set<object>());
  const line = JSON.stringify(parsed.right);
  if (line === undefined || new TextEncoder().encode(line).byteLength + 1 > limits.maxLineBytes) {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow protocol line is too large.");
  }
  return `${line}\n`;
}

function decodeWireLimits(
  input: unknown,
  code: "invalid_input" | "protocol_breach" = "invalid_input",
): WireLimits {
  const parsed = decodeUnknown(WorkflowLimitsSchema, input);
  if (Either.isLeft(parsed)) {
    throw new WorkflowRuntimeError(code, "The workflow limits message is invalid.");
  }
  return parsed.right;
}

function assertLimitCeilings(
  limits: WorkflowLimits,
  code: "invalid_input" | "protocol_breach",
): void {
  for (const key of WORKFLOW_LIMIT_KEYS) {
    const value = limits[key];
    const ceiling = WORKFLOW_LIMIT_CEILINGS[key];
    if (value > ceiling) {
      throw new WorkflowRuntimeError(code, "The workflow limit exceeds its safe ceiling.", {
        field: key,
      });
    }
  }
}

export function wireError(error: WorkflowRuntimeError): WireError {
  return {
    code: error.code,
    message: error.message,
  };
}

export function createProtocolFailure(error: WorkflowRuntimeError): TerminalFailureMessage {
  return {
    version: 1,
    type: "terminal-failure",
    error: wireError(error),
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function validateJsonShape(
  value: unknown,
  limits: WorkflowLimits,
  path: string,
  ancestors: Set<object>,
  depth = 0,
): void {
  if (depth > limits.maxJsonDepth) {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow JSON depth is too large.");
  }
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > limits.maxStringBytes) {
      throw new WorkflowRuntimeError("protocol_breach", "The workflow JSON string is too large.", {
        field: path,
      });
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (ancestors.has(value)) {
    throw new WorkflowRuntimeError("protocol_breach", "The workflow JSON is cyclic.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        throw new WorkflowRuntimeError("protocol_breach", "The workflow JSON array is too large.");
      }
      for (const [index, item] of value.entries()) {
        validateJsonShape(item, limits, `${path}[${index}]`, ancestors, depth + 1);
      }
      return;
    }
    const keys = Object.keys(value);
    if (keys.length > limits.maxObjectKeys) {
      throw new WorkflowRuntimeError("protocol_breach", "The workflow JSON object is too large.");
    }
    for (const [key, item] of Object.entries(value)) {
      validateJsonShape(item, limits, `${path}.${key}`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}
