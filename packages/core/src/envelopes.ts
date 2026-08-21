// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { CLI_SCHEMA_VERSION, isObject, type JsonObject, type JsonValue } from "./common.ts";
import { type CoreResult, failure, inputError, success } from "./errors.ts";
import { identifierTextSchema } from "./identifiers.ts";
import { canonicalJson } from "./canonical.ts";
import { RoleSchema } from "./routes.ts";
import { decodeUnknown } from "./schema.ts";

export const SpecialistStatusSchema = Schema.Literal("blocked", "completed", "failed", "partial");
export type SpecialistStatus = typeof SpecialistStatusSchema.Type;

export const SuggestedLunaEffortSchema = Schema.Union(
  Schema.Literal("high", "max", "xhigh"),
  Schema.Null,
);
export type SuggestedLunaEffort = typeof SuggestedLunaEffortSchema.Type;

function isSupportedJsonValue(value: unknown): value is JsonValue {
  try {
    return canonicalJson(value) !== undefined;
  } catch {
    return false;
  }
}

const JsonValueSchema = Schema.declare((value: unknown): value is JsonValue =>
  isSupportedJsonValue(value),
);
const JsonObjectSchema = Schema.declare(
  (value: unknown): value is JsonObject =>
    isObject(value) && !Array.isArray(value) && isSupportedJsonValue(value),
);

export const SpecialistOutcomeSchema = Schema.Struct({
  blocked: Schema.Boolean,
  changed_files: Schema.Array(Schema.String),
  confidence: Schema.Number,
  context_owner: Schema.Union(Schema.String, Schema.Null),
  material_findings: Schema.Array(Schema.String),
  needs_more_context: Schema.Boolean,
  needs_root_decision: Schema.Boolean,
  needs_verification: Schema.Boolean,
  relevant_files: Schema.Array(Schema.String),
  remaining_risk: Schema.Array(Schema.String),
  reuse_recommended: Schema.Boolean,
  status: SpecialistStatusSchema,
  suggested_followup: Schema.Union(Schema.String, Schema.Null),
  suggested_luna_effort: SuggestedLunaEffortSchema,
  suggested_specialist: Schema.Union(RoleSchema, Schema.Null),
  verification: Schema.Array(Schema.String),
  verification_passed: Schema.Boolean,
});
export type SpecialistOutcome = typeof SpecialistOutcomeSchema.Type;

const CliWarningSchema = Schema.Array(Schema.String);
const CliCommandSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u),
);
const CliSchemaVersionSchema = Schema.Literal(CLI_SCHEMA_VERSION);
const CliErrorSchema = Schema.Struct({
  code: identifierTextSchema,
  message: Schema.String,
  details: JsonObjectSchema,
});

export const CliSuccessEnvelopeSchema = Schema.Struct({
  schema_version: CliSchemaVersionSchema,
  ok: Schema.Literal(true),
  command: CliCommandSchema,
  data: JsonValueSchema,
  warnings: CliWarningSchema,
});
export type CliSuccessEnvelope = typeof CliSuccessEnvelopeSchema.Type;

export const CliFailureEnvelopeSchema = Schema.Struct({
  schema_version: CliSchemaVersionSchema,
  ok: Schema.Literal(false),
  command: CliCommandSchema,
  error: CliErrorSchema,
  warnings: CliWarningSchema,
});
export type CliFailureEnvelope = typeof CliFailureEnvelopeSchema.Type;

export const CliEnvelopeSchema = Schema.Union(CliSuccessEnvelopeSchema, CliFailureEnvelopeSchema);
export type CliEnvelope = typeof CliEnvelopeSchema.Type;

export function parseSpecialistOutcome(input: unknown): CoreResult<SpecialistOutcome> {
  const parsed = decodeUnknown(SpecialistOutcomeSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(inputError("specialist outcome", parsed.left));
  }
  return success(parsed.right);
}

export function parseCliEnvelope(input: unknown): CoreResult<CliEnvelope> {
  const parsed = decodeUnknown(CliEnvelopeSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(inputError("CLI envelope", parsed.left));
  }
  return success(parsed.right);
}
