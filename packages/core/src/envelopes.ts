// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { CLI_SCHEMA_VERSION, isObject, type JsonObject, type JsonValue } from "./common.ts";
import { type CoreResult, failure, inputError, success } from "./errors.ts";
import { identifierTextSchema } from "./identifiers.ts";
import { canonicalJson } from "./canonical.ts";
import { RoleSchema } from "./routes.ts";

export const SpecialistStatusSchema = type("'blocked' | 'completed' | 'failed' | 'partial'");
export type SpecialistStatus = typeof SpecialistStatusSchema.infer;

export const SuggestedLunaEffortSchema = type("'high' | 'max' | 'xhigh' | null");
export type SuggestedLunaEffort = typeof SuggestedLunaEffortSchema.infer;

function isSupportedJsonValue(value: unknown): value is JsonValue {
  try {
    return canonicalJson(value) !== undefined;
  } catch {
    return false;
  }
}

const JsonValueSchema = type("unknown").narrow((value): value is JsonValue =>
  isSupportedJsonValue(value),
);
const JsonObjectSchema = type("object").narrow(
  (value): value is JsonObject =>
    isObject(value) && !Array.isArray(value) && isSupportedJsonValue(value),
);

export const SpecialistOutcomeSchema = type({
  "+": "reject",
  blocked: "boolean",
  changed_files: "string[]",
  confidence: "number",
  context_owner: "string | null",
  material_findings: "string[]",
  needs_more_context: "boolean",
  needs_root_decision: "boolean",
  needs_verification: "boolean",
  relevant_files: "string[]",
  remaining_risk: "string[]",
  reuse_recommended: "boolean",
  status: SpecialistStatusSchema,
  suggested_followup: "string | null",
  suggested_luna_effort: SuggestedLunaEffortSchema,
  suggested_specialist: RoleSchema.or("null"),
  verification: "string[]",
  verification_passed: "boolean",
});
export type SpecialistOutcome = typeof SpecialistOutcomeSchema.infer;

const CliWarningSchema = type("string[]");
const CliCommandSchema = type(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u);
const CliSchemaVersionSchema = type(`'${CLI_SCHEMA_VERSION}'`);
const CliErrorSchema = type({
  "+": "reject",
  code: identifierTextSchema,
  message: "string",
  details: JsonObjectSchema,
});

export const CliSuccessEnvelopeSchema = type({
  "+": "reject",
  schema_version: CliSchemaVersionSchema,
  ok: "true",
  command: CliCommandSchema,
  data: JsonValueSchema,
  warnings: CliWarningSchema,
});
export type CliSuccessEnvelope = typeof CliSuccessEnvelopeSchema.infer;

export const CliFailureEnvelopeSchema = type({
  "+": "reject",
  schema_version: CliSchemaVersionSchema,
  ok: "false",
  command: CliCommandSchema,
  error: CliErrorSchema,
  warnings: CliWarningSchema,
});
export type CliFailureEnvelope = typeof CliFailureEnvelopeSchema.infer;

export const CliEnvelopeSchema = CliSuccessEnvelopeSchema.or(CliFailureEnvelopeSchema);
export type CliEnvelope = typeof CliEnvelopeSchema.infer;

export function parseSpecialistOutcome(input: unknown): CoreResult<SpecialistOutcome> {
  const parsed = SpecialistOutcomeSchema(input);
  if (parsed instanceof type.errors) {
    return failure(inputError("specialist outcome", parsed));
  }
  return success(parsed);
}

export function parseCliEnvelope(input: unknown): CoreResult<CliEnvelope> {
  const parsed = CliEnvelopeSchema(input);
  if (parsed instanceof type.errors) {
    return failure(inputError("CLI envelope", parsed));
  }
  return success(parsed);
}
