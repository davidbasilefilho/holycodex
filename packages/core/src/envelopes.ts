// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { CLI_SCHEMA_VERSION, isObject, type JsonObject, type JsonValue } from "./common.ts";
import { type CoreResult, failure, inputError, success } from "./errors.ts";
import { identifierTextSchema } from "./identifiers.ts";
import { canonicalJson } from "./canonical.ts";
import { RoleSchema, RoleTaskSchema, type Role, type RoleTask } from "./routes.ts";
import { decodeUnknown } from "./schema.ts";
import { CapabilityNameSchema } from "./capabilities.ts";

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

export const SPECIALIST_OUTCOME_VERSION = "holycodex-specialist-outcome-2";
const OutcomeTextSchema = Schema.String.pipe(Schema.minLength(1));

const SpecialistOutcomeV2BaseFields = {
  protocol_version: Schema.Literal(SPECIALIST_OUTCOME_VERSION),
  route: RoleTaskSchema,
  evidence: Schema.Array(OutcomeTextSchema),
} as const;
export const SpecialistOutcomeV2BaseSchema = Schema.Struct(SpecialistOutcomeV2BaseFields);
export type SpecialistOutcomeV2Base = typeof SpecialistOutcomeV2BaseSchema.Type;

const SpecialistOutcomeV2CompletedSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literal("completed"),
  summary: OutcomeTextSchema,
});
const SpecialistOutcomeV2BlockedSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literal("blocked"),
  reason: OutcomeTextSchema,
  needs_root_decision: Schema.Boolean,
});
const SpecialistOutcomeV2PartialSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literal("partial"),
  summary: OutcomeTextSchema,
  completed: Schema.Array(OutcomeTextSchema),
  remaining: Schema.Array(OutcomeTextSchema),
  needs_root_decision: Schema.Boolean,
});
const SpecialistOutcomeV2FailedSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literal("failed"),
  error: OutcomeTextSchema,
});

export const SpecialistOutcomeV2Schema = Schema.Union(
  SpecialistOutcomeV2CompletedSchema,
  SpecialistOutcomeV2BlockedSchema,
  SpecialistOutcomeV2PartialSchema,
  SpecialistOutcomeV2FailedSchema,
);
export type SpecialistOutcomeV2 = typeof SpecialistOutcomeV2Schema.Type;
export type SpecialistOutcomeV2ForRole<R extends Role> = SpecialistOutcomeV2 & {
  readonly route: Extract<RoleTask, { readonly role: R }>;
};
type PublicOutcomeAliases = {
  [R in Role as `${R}Outcome`]: SpecialistOutcomeV2ForRole<R>;
};
export type ExplorerOutcome = PublicOutcomeAliases["ExplorerOutcome"];
export type LibrarianOutcome = PublicOutcomeAliases["LibrarianOutcome"];
export type WorkerOutcome = PublicOutcomeAliases["WorkerOutcome"];
export type ReviewerOutcome = PublicOutcomeAliases["ReviewerOutcome"];

const CapabilityResultV2BaseFields = {
  protocol_version: Schema.Literal(SPECIALIST_OUTCOME_VERSION),
  capability: CapabilityNameSchema,
  route: Schema.Union(RoleTaskSchema, Schema.Null),
  evidence: Schema.Array(OutcomeTextSchema),
  data: JsonValueSchema,
} as const;
const CapabilityResultV2CompletedSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literal("completed"),
  summary: OutcomeTextSchema,
});
const CapabilityResultV2BlockedSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literal("blocked"),
  reason: OutcomeTextSchema,
  needs_root_decision: Schema.Boolean,
});
const CapabilityResultV2PartialSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literal("partial"),
  summary: OutcomeTextSchema,
  completed: Schema.Array(OutcomeTextSchema),
  remaining: Schema.Array(OutcomeTextSchema),
  needs_root_decision: Schema.Boolean,
});
const CapabilityResultV2FailedSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literal("failed"),
  error: OutcomeTextSchema,
});

/** Common V2 envelope for typed host capabilities and specialist-compatible results. */
export const CapabilityResultV2Schema = Schema.Union(
  CapabilityResultV2CompletedSchema,
  CapabilityResultV2BlockedSchema,
  CapabilityResultV2PartialSchema,
  CapabilityResultV2FailedSchema,
);
export type CapabilityResultV2 = typeof CapabilityResultV2Schema.Type;

export function parseCapabilityResultV2(input: unknown): CoreResult<CapabilityResultV2> {
  const parsed = decodeUnknown(CapabilityResultV2Schema, input);
  if (Either.isLeft(parsed)) {
    return failure(inputError("capability result v2", parsed.left));
  }
  return success(parsed.right);
}

export function specialistOutcomeFromCapabilityResult(
  result: CapabilityResultV2,
  expectedCapability: typeof CapabilityNameSchema.Type,
  expectedRoute: RoleTask,
): CoreResult<SpecialistOutcomeV2> {
  if (result.capability !== expectedCapability || result.route === null) {
    return failure(inputError("capability result route"));
  }
  if (!sameRoute(result.route, expectedRoute)) {
    return failure(inputError("capability result route"));
  }
  const base = {
    protocol_version: SPECIALIST_OUTCOME_VERSION,
    route: expectedRoute,
    evidence: result.evidence,
  } as const;
  switch (result.status) {
    case "completed":
      return success({ ...base, status: "completed", summary: result.summary });
    case "blocked":
      return success({
        ...base,
        status: "blocked",
        reason: result.reason,
        needs_root_decision: result.needs_root_decision,
      });
    case "partial":
      return success({
        ...base,
        status: "partial",
        summary: result.summary,
        completed: result.completed,
        remaining: result.remaining,
        needs_root_decision: result.needs_root_decision,
      });
    case "failed":
      return success({ ...base, status: "failed", error: result.error });
  }
}

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

/** @deprecated Use normalizeSpecialistOutcome at compatibility boundaries. */
export function parseSpecialistOutcome(input: unknown): CoreResult<SpecialistOutcome> {
  const parsed = decodeUnknown(SpecialistOutcomeSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(inputError("specialist outcome", parsed.left));
  }
  return success(parsed.right);
}

export function parseSpecialistOutcomeV2(input: unknown): CoreResult<SpecialistOutcomeV2> {
  const parsed = decodeUnknown(SpecialistOutcomeV2Schema, input);
  if (Either.isLeft(parsed)) {
    return failure(inputError("specialist outcome v2", parsed.left));
  }
  return success(parsed.right);
}

function sameRoute(left: RoleTask, right: RoleTask): boolean {
  return left.role === right.role && left.task === right.task;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function firstOr(values: readonly string[], fallback: string): string {
  return values.find((value) => value.length > 0) ?? fallback;
}

function legacyEvidence(outcome: SpecialistOutcome): string[] {
  return stableUnique([
    ...outcome.relevant_files,
    ...outcome.verification,
    ...outcome.material_findings,
  ]);
}

function normalizeLegacyOutcome(
  outcome: SpecialistOutcome,
  expectedRoute: RoleTask,
): SpecialistOutcomeV2 {
  const base = {
    protocol_version: SPECIALIST_OUTCOME_VERSION,
    route: expectedRoute,
    evidence: legacyEvidence(outcome),
  } as const;
  switch (outcome.status) {
    case "blocked":
      return {
        ...base,
        status: "blocked",
        reason:
          outcome.suggested_followup ??
          outcome.remaining_risk[0] ??
          "Specialist reported a blocked outcome.",
        needs_root_decision: outcome.needs_root_decision,
      };
    case "completed":
      return {
        ...base,
        status: "completed",
        summary: firstOr(outcome.material_findings, "Completed assigned work."),
      };
    case "failed":
      return {
        ...base,
        status: "failed",
        error:
          outcome.suggested_followup ?? outcome.remaining_risk[0] ?? "Specialist execution failed.",
      };
    case "partial":
      return {
        ...base,
        status: "partial",
        summary: firstOr(outcome.material_findings, "Partially completed assigned work."),
        completed: stableUnique(outcome.changed_files),
        remaining: stableUnique(outcome.remaining_risk),
        needs_root_decision: outcome.needs_root_decision,
      };
  }
}

export function normalizeSpecialistOutcome(
  input: unknown,
  expectedRoute: RoleTask,
): CoreResult<SpecialistOutcomeV2> {
  const route = decodeUnknown(RoleTaskSchema, expectedRoute);
  if (Either.isLeft(route)) {
    return failure(inputError("specialist outcome route", route.left));
  }
  const v2 = decodeUnknown(SpecialistOutcomeV2Schema, input);
  if (Either.isRight(v2) && sameRoute(v2.right.route, route.right)) {
    return success(v2.right);
  }
  const legacy = decodeUnknown(SpecialistOutcomeSchema, input);
  if (Either.isRight(legacy)) {
    if (legacy.right.blocked !== (legacy.right.status === "blocked")) {
      return failure(inputError("specialist outcome status", "Legacy blocked/status mismatch."));
    }
    return success(normalizeLegacyOutcome(legacy.right, route.right));
  }
  return failure(inputError("specialist outcome", legacy.left));
}

export function parseCliEnvelope(input: unknown): CoreResult<CliEnvelope> {
  const parsed = decodeUnknown(CliEnvelopeSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(inputError("CLI envelope", parsed.left));
  }
  return success(parsed.right);
}
