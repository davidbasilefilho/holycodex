// SPDX-License-Identifier: Apache-2.0

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { CapabilityNameSchema } from "./capabilities.ts";
import { CLI_SCHEMA_VERSION, type JsonObject, type JsonValue } from "./common.ts";
import { type CoreResult, failure, inputError, success } from "./errors.ts";
import { identifierTextSchema } from "./identifiers.ts";
import {
  Context7EvidenceStateSchema,
  RoleSchema,
  RoleTaskSchema,
  type Role,
  type RoleTask,
} from "./routes.ts";
import { decodeUnknown } from "./schema.ts";

/** Runtime schema validating specialist status values at the receiving boundary. */
export const SpecialistStatusSchema = Schema.Literals([
  "blocked",
  "completed",
  "failed",
  "partial",
]);
/** Type representing specialist status in the core domain. */
export type SpecialistStatus = typeof SpecialistStatusSchema.Type;

/** Runtime schema validating suggested luna effort values at the receiving boundary. */
export const SuggestedLunaEffortSchema = Schema.Union([
  Schema.Literals(["high", "max", "xhigh"]),
  Schema.Null,
]);
/** Type representing suggested luna effort in the core domain. */
export type SuggestedLunaEffort = typeof SuggestedLunaEffortSchema.Type;

const JsonValueSchema = Schema.Json as Schema.Codec<JsonValue, unknown>;
const JsonObjectSchema = Schema.JsonObject as Schema.Codec<JsonObject, unknown>;

/** Runtime schema validating specialist outcome values at the receiving boundary. */
export const SpecialistOutcomeSchema = Schema.Struct({
  blocked: Schema.Boolean,
  changed_files: Schema.Array(Schema.String),
  confidence: Schema.Number,
  context_owner: Schema.Union([Schema.String, Schema.Null]),
  material_findings: Schema.Array(Schema.String),
  needs_more_context: Schema.Boolean,
  needs_root_decision: Schema.Boolean,
  needs_verification: Schema.Boolean,
  relevant_files: Schema.Array(Schema.String),
  remaining_risk: Schema.Array(Schema.String),
  reuse_recommended: Schema.Boolean,
  status: SpecialistStatusSchema,
  suggested_followup: Schema.Union([Schema.String, Schema.Null]),
  suggested_luna_effort: SuggestedLunaEffortSchema,
  suggested_specialist: Schema.Union([RoleSchema, Schema.Null]),
  verification: Schema.Array(Schema.String),
  verification_passed: Schema.Boolean,
});
/** Type representing specialist outcome in the core domain. */
export type SpecialistOutcome = typeof SpecialistOutcomeSchema.Type;

/** Canonical specialist outcome version used by core domain operations. */
export const SPECIALIST_OUTCOME_VERSION = "holycodex-specialist-outcome-2";
const OutcomeTextSchema = Schema.String.check(Schema.isMinLength(1));

/** Typed Context7 proof returned by a Librarian Assignment for current technical facts. */
export const Context7EvidenceSchema = Schema.Struct({
  state: Context7EvidenceStateSchema,
  evidence: Schema.Array(OutcomeTextSchema).check(Schema.isMinLength(1)),
  library: Schema.optional(OutcomeTextSchema),
  version: Schema.optional(OutcomeTextSchema),
});
/** Type representing context7 evidence in the core domain. */
export type Context7Evidence = typeof Context7EvidenceSchema.Type;

const SpecialistOutcomeV2BaseFields = {
  protocol_version: Schema.Literals([SPECIALIST_OUTCOME_VERSION]),
  route: RoleTaskSchema,
  evidence: Schema.Array(OutcomeTextSchema),
  context7: Schema.optional(Context7EvidenceSchema),
} as const;
/** Runtime schema validating specialist outcome v2 base values at the receiving boundary. */
export const SpecialistOutcomeV2BaseSchema = Schema.Struct(SpecialistOutcomeV2BaseFields);
/** Type representing specialist outcome v2 base in the core domain. */
export type SpecialistOutcomeV2Base = typeof SpecialistOutcomeV2BaseSchema.Type;

const SpecialistOutcomeV2CompletedSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literals(["completed"]),
  summary: OutcomeTextSchema,
});
const SpecialistOutcomeV2BlockedSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literals(["blocked"]),
  reason: OutcomeTextSchema,
  needs_root_decision: Schema.Boolean,
});
const SpecialistOutcomeV2PartialSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literals(["partial"]),
  summary: OutcomeTextSchema,
  completed: Schema.Array(OutcomeTextSchema),
  remaining: Schema.Array(OutcomeTextSchema),
  needs_root_decision: Schema.Boolean,
});
const SpecialistOutcomeV2FailedSchema = Schema.Struct({
  ...SpecialistOutcomeV2BaseFields,
  status: Schema.Literals(["failed"]),
  error: OutcomeTextSchema,
});

/** Runtime schema validating specialist outcome v2 values at the receiving boundary. */
export const SpecialistOutcomeV2Schema = Schema.Union([
  SpecialistOutcomeV2CompletedSchema,
  SpecialistOutcomeV2BlockedSchema,
  SpecialistOutcomeV2PartialSchema,
  SpecialistOutcomeV2FailedSchema,
]);
/** Type representing specialist outcome v2 in the core domain. */
export type SpecialistOutcomeV2 = typeof SpecialistOutcomeV2Schema.Type;
/** Type representing specialist outcome v2 for role in the core domain. */
export type SpecialistOutcomeV2ForRole<R extends Role> = SpecialistOutcomeV2 & {
  readonly route: Extract<RoleTask, { readonly role: R }>;
};
type PublicOutcomeAliases = {
  [R in Role as `${R}Outcome`]: SpecialistOutcomeV2ForRole<R>;
};
/** Type representing explorer outcome in the core domain. */
export type ExplorerOutcome = PublicOutcomeAliases["ExplorerOutcome"];
/** Type representing librarian outcome in the core domain. */
export type LibrarianOutcome = PublicOutcomeAliases["LibrarianOutcome"];
/** Type representing worker outcome in the core domain. */
export type WorkerOutcome = PublicOutcomeAliases["WorkerOutcome"];
/** Type representing reviewer outcome in the core domain. */
export type ReviewerOutcome = PublicOutcomeAliases["ReviewerOutcome"];

const CapabilityResultV2BaseFields = {
  protocol_version: Schema.Literals([SPECIALIST_OUTCOME_VERSION]),
  capability: CapabilityNameSchema,
  route: Schema.Union([RoleTaskSchema, Schema.Null]),
  evidence: Schema.Array(OutcomeTextSchema),
  context7: Schema.optional(Context7EvidenceSchema),
  data: JsonValueSchema,
} as const;
const CapabilityResultV2CompletedSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literals(["completed"]),
  summary: OutcomeTextSchema,
});
const CapabilityResultV2BlockedSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literals(["blocked"]),
  reason: OutcomeTextSchema,
  needs_root_decision: Schema.Boolean,
});
const CapabilityResultV2PartialSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literals(["partial"]),
  summary: OutcomeTextSchema,
  completed: Schema.Array(OutcomeTextSchema),
  remaining: Schema.Array(OutcomeTextSchema),
  needs_root_decision: Schema.Boolean,
});
const CapabilityResultV2FailedSchema = Schema.Struct({
  ...CapabilityResultV2BaseFields,
  status: Schema.Literals(["failed"]),
  error: OutcomeTextSchema,
});

/** Common V2 envelope for typed host capabilities and specialist-compatible results. */
export const CapabilityResultV2Schema = Schema.Union([
  CapabilityResultV2CompletedSchema,
  CapabilityResultV2BlockedSchema,
  CapabilityResultV2PartialSchema,
  CapabilityResultV2FailedSchema,
]);
/** Type representing capability result v2 in the core domain. */
export type CapabilityResultV2 = typeof CapabilityResultV2Schema.Type;

/** Decode an unknown value as a typed V2 capability result envelope. */
export function parseCapabilityResultV2(input: unknown): CoreResult<CapabilityResultV2> {
  const parsed = decodeUnknown(CapabilityResultV2Schema, input);
  if (Result.isFailure(parsed)) {
    return failure(inputError("capability result v2", parsed.failure));
  }
  return success(parsed.success);
}

/** Adapt a capability result into a specialist outcome for the expected route. */
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
    ...(result.context7 === undefined ? {} : { context7: result.context7 }),
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
const CliCommandSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u),
);
const CliSchemaVersionSchema = Schema.Literals([CLI_SCHEMA_VERSION]);
const CliErrorSchema = Schema.Struct({
  code: identifierTextSchema,
  message: Schema.String,
  details: JsonObjectSchema,
});

/** Runtime schema validating cli success envelope values at the receiving boundary. */
export const CliSuccessEnvelopeSchema = Schema.Struct({
  schema_version: CliSchemaVersionSchema,
  ok: Schema.Literals([true]),
  command: CliCommandSchema,
  data: JsonValueSchema,
  warnings: CliWarningSchema,
});
/** Type representing cli success envelope in the core domain. */
export type CliSuccessEnvelope = typeof CliSuccessEnvelopeSchema.Type;

/** Runtime schema validating cli failure envelope values at the receiving boundary. */
export const CliFailureEnvelopeSchema = Schema.Struct({
  schema_version: CliSchemaVersionSchema,
  ok: Schema.Literals([false]),
  command: CliCommandSchema,
  error: CliErrorSchema,
  warnings: CliWarningSchema,
});
/** Type representing cli failure envelope in the core domain. */
export type CliFailureEnvelope = typeof CliFailureEnvelopeSchema.Type;

/** Runtime schema validating cli envelope values at the receiving boundary. */
export const CliEnvelopeSchema = Schema.Union([CliSuccessEnvelopeSchema, CliFailureEnvelopeSchema]);
/** Type representing cli envelope in the core domain. */
export type CliEnvelope = typeof CliEnvelopeSchema.Type;

/**
 * Parse a legacy specialist outcome.
 *
 * @deprecated Use {@link normalizeSpecialistOutcome} at compatibility boundaries.
 */
export function parseSpecialistOutcome(input: unknown): CoreResult<SpecialistOutcome> {
  const parsed = decodeUnknown(SpecialistOutcomeSchema, input);
  if (Result.isFailure(parsed)) {
    return failure(inputError("specialist outcome", parsed.failure));
  }
  return success(parsed.success);
}

/** Decode an unknown value as a typed V2 specialist outcome envelope. */
export function parseSpecialistOutcomeV2(input: unknown): CoreResult<SpecialistOutcomeV2> {
  const parsed = decodeUnknown(SpecialistOutcomeV2Schema, input);
  if (Result.isFailure(parsed)) {
    return failure(inputError("specialist outcome v2", parsed.failure));
  }
  return success(parsed.success);
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

/** Decode a V2 outcome or normalize a compatible legacy outcome for the expected route. */
export function normalizeSpecialistOutcome(
  input: unknown,
  expectedRoute: RoleTask,
): CoreResult<SpecialistOutcomeV2> {
  const route = decodeUnknown(RoleTaskSchema, expectedRoute);
  if (Result.isFailure(route)) {
    return failure(inputError("specialist outcome route", route.failure));
  }
  const v2 = decodeUnknown(SpecialistOutcomeV2Schema, input);
  if (Result.isSuccess(v2) && sameRoute(v2.success.route, route.success)) {
    return success(v2.success);
  }
  const legacy = decodeUnknown(SpecialistOutcomeSchema, input);
  if (Result.isSuccess(legacy)) {
    if (legacy.success.blocked !== (legacy.success.status === "blocked")) {
      return failure(inputError("specialist outcome status", "Legacy blocked/status mismatch."));
    }
    return success(normalizeLegacyOutcome(legacy.success, route.success));
  }
  return failure(inputError("specialist outcome", legacy.failure));
}

/** Decode an unknown value as the validated CLI success or failure envelope. */
export function parseCliEnvelope(input: unknown): CoreResult<CliEnvelope> {
  const parsed = decodeUnknown(CliEnvelopeSchema, input);
  if (Result.isFailure(parsed)) {
    return failure(inputError("CLI envelope", parsed.failure));
  }
  return success(parsed.success);
}
