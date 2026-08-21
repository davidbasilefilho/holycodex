// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import {
  PlanNameSchema,
  RoleSchema,
  RouteKeySchema,
  ServiceTierSchema,
  SpecialistOutcomeSchema,
  type JsonObject,
  type JsonValue,
  type PlanName,
  type Role,
  type RoleTask,
  type RouteKey,
  type ServiceTier,
  type SpecialistOutcome,
} from "@holycodex/core";

export const WORKFLOW_HOST_SCHEMA_EPOCH = "host-state-1.0" as const;
export const WORKFLOW_HOST_SCHEMA_EPOCHS = Object.freeze({
  run: "host-run-1.0",
  journal: "host-journal-1.0",
  checkpoint: "host-checkpoint-1.0",
  continuation: "host-continuation-1.0",
  refinement: "host-refinement-1.0",
  telemetry: "host-telemetry-1.0",
});

const IdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u));
const DigestSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const DateTimeSchema = Schema.String.pipe(
  Schema.pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s]{1,64}Z$/u),
);
const BoundedTextSchema = Schema.String.pipe(
  Schema.filter(
    (value) =>
      value.length <= 4096 &&
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return !(code <= 31 || code === 127);
      }),
  ),
);
const ShortTextSchema = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 && value.length <= 512),
);
const NonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));
const PositiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Object.values(value).every((item) => isJsonValue(item, seen));
  } finally {
    seen.delete(value);
  }
}

export const JsonValueSchema = Schema.declare((value: unknown): value is JsonValue =>
  isJsonValue(value),
);
export const JsonObjectSchema = Schema.declare(
  (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value),
);

/** The one strict decoding helper for all host boundary schemas. */
export function decodeHostSchema<T>(schema: Schema.Schema<T>, input: unknown): T | undefined {
  const parsed = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(input);
  return Either.isRight(parsed) ? parsed.right : undefined;
}

export const ProjectTrustRefSchema = Schema.Struct({
  project_id: IdentifierSchema,
  trust_id: IdentifierSchema,
  project_digest: DigestSchema,
  trust_digest: DigestSchema,
});
export type ProjectTrustRef = typeof ProjectTrustRefSchema.Type;

export const SchemaEpochsSchema = Schema.Struct({
  core: IdentifierSchema,
  runtime: IdentifierSchema,
  host: IdentifierSchema,
});
export type SchemaEpochs = typeof SchemaEpochsSchema.Type;

export const IdentityComponentsSchema = Schema.Struct({
  project: ProjectTrustRefSchema,
  workflow_source_digest: DigestSchema,
  resupplied_args_digest: DigestSchema,
  plan_catalog_digest: DigestSchema,
  plan: PlanNameSchema,
  route: RouteKeySchema,
  service_tier: ServiceTierSchema,
  policy_digest: DigestSchema,
  prompt_profile: IdentifierSchema,
  role: RoleSchema,
  tool_profile: IdentifierSchema,
  security_profile: IdentifierSchema,
  approval_policy: IdentifierSchema,
  sandbox_policy: IdentifierSchema,
  codex_capability_digest: DigestSchema,
  schema_epochs: SchemaEpochsSchema,
});
export type IdentityComponents = typeof IdentityComponentsSchema.Type;

export const RunDefinitionSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-run-1.0"),
  run_id: IdentifierSchema,
  objective_lineage: IdentifierSchema,
  parent_run_id: Schema.Union(IdentifierSchema, Schema.Null),
  created_at: DateTimeSchema,
  identity: IdentityComponentsSchema,
});
export type RunDefinition = typeof RunDefinitionSchema.Type;

export const RunStatusSchema = Schema.Literal(
  "created",
  "running",
  "waiting_for_approval",
  "approved",
  "denied",
  "paused",
  "stopped",
  "completed",
  "failed",
  "blocked",
  "reopened",
);
export type RunStatus = typeof RunStatusSchema.Type;

export const OperationStateSchema = Schema.Literal(
  "reserved",
  "requested",
  "waiting_for_approval",
  "approved",
  "denied",
  "completed",
  "failed",
  "uncertain",
  "stopped",
);
export type OperationState = typeof OperationStateSchema.Type;

export const OperationInputSchema = Schema.Struct({
  operation_id: IdentifierSchema,
  input_digest: DigestSchema,
  route: RouteKeySchema,
  role: RoleSchema,
  task: ShortTextSchema,
  attempt: PositiveIntegerSchema,
  retry_limit: NonNegativeIntegerSchema,
  fan_out: PositiveIntegerSchema,
});
export type OperationInput = typeof OperationInputSchema.Type;

export const OperationLifecycleSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  operation: OperationInputSchema,
  state: OperationStateSchema,
  cost_units: NonNegativeIntegerSchema,
  at: DateTimeSchema,
  error_code: Schema.Union(IdentifierSchema, Schema.Null),
});
export type OperationLifecycle = typeof OperationLifecycleSchema.Type;

const SafeStringArraySchema = Schema.Array(Schema.String).pipe(
  Schema.filter((value) => value.length <= 64 && value.every((item) => item.length <= 512)),
);

export const CheckpointSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-checkpoint-1.0"),
  run_id: IdentifierSchema,
  revision: PositiveIntegerSchema,
  journal_sequence: NonNegativeIntegerSchema,
  objective: BoundedTextSchema,
  constraints: SafeStringArraySchema,
  decisions: SafeStringArraySchema,
  verified_evidence: SafeStringArraySchema,
  phases: SafeStringArraySchema,
  active_work: SafeStringArraySchema,
  unresolved_work: SafeStringArraySchema,
  blockers: SafeStringArraySchema,
  verification: SafeStringArraySchema,
  resources: JsonObjectSchema,
  retained_summaries: SafeStringArraySchema,
  next_actions: SafeStringArraySchema,
  usage_completeness: Schema.Literal("complete", "partial", "unknown"),
  recoverable_errors: SafeStringArraySchema,
  captured_at: DateTimeSchema,
});
export type Checkpoint = typeof CheckpointSchema.Type;

export const RetainedContextStatusSchema = Schema.Literal(
  "available",
  "consumed",
  "invalidated",
  "blocked",
);
export type RetainedContextStatus = typeof RetainedContextStatusSchema.Type;

export const RetainedContextIdentitySchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  context_id: IdentifierSchema,
  run_id: IdentifierSchema,
  project: ProjectTrustRefSchema,
  route: RouteKeySchema,
  role: RoleSchema,
  policy_digest: DigestSchema,
  tool_profile: IdentifierSchema,
  security_profile: IdentifierSchema,
  prompt_profile: IdentifierSchema,
  approval_policy: IdentifierSchema,
  sandbox_policy: IdentifierSchema,
  status: RetainedContextStatusSchema,
  summary: SafeStringArraySchema,
  created_at: DateTimeSchema,
});
export type RetainedContextIdentity = typeof RetainedContextIdentitySchema.Type;

export const ContinuationPacketSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-continuation-1.0"),
  packet_id: IdentifierSchema,
  session_id: IdentifierSchema,
  parent_run_id: IdentifierSchema,
  objective_lineage: IdentifierSchema,
  project: ProjectTrustRefSchema,
  source_digest: DigestSchema,
  checkpoint_revision: PositiveIntegerSchema,
  checkpoint_digest: DigestSchema,
  verified_evidence: SafeStringArraySchema,
  decisions: SafeStringArraySchema,
  next_actions: SafeStringArraySchema,
  packet_digest: DigestSchema,
  created_at: DateTimeSchema,
});
export type ContinuationPacket = typeof ContinuationPacketSchema.Type;

export const ContinuationClaimSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-continuation-1.0"),
  claim_id: IdentifierSchema,
  packet_id: IdentifierSchema,
  session_id: IdentifierSchema,
  parent_run_id: IdentifierSchema,
  project: ProjectTrustRefSchema,
  source_digest: DigestSchema,
  checkpoint_digest: DigestSchema,
  checkpoint_revision: PositiveIntegerSchema,
  packet_digest: DigestSchema,
  claimed_at: DateTimeSchema,
});
export type ContinuationClaim = typeof ContinuationClaimSchema.Type;

export const RefinementProposalSchema = Schema.Struct({
  kind: Schema.Literal("clarification", "constraint", "evidence", "workflow-note"),
  summary: ShortTextSchema,
  rationale: ShortTextSchema,
});
export type RefinementProposal = typeof RefinementProposalSchema.Type;

export const RefinementSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-refinement-1.0"),
  refinement_id: IdentifierSchema,
  project: ProjectTrustRefSchema,
  run_id: IdentifierSchema,
  proposal: RefinementProposalSchema,
  status: Schema.Literal("enabled", "disabled"),
  reversible: Schema.Literal(true),
  attributable_to: IdentifierSchema,
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
});
export type Refinement = typeof RefinementSchema.Type;

export const TelemetrySchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-telemetry-1.0"),
  event: Schema.Literal("run", "operation", "checkpoint", "replay", "continuation", "refinement"),
  run_id: Schema.Union(IdentifierSchema, Schema.Null),
  route: Schema.Union(RouteKeySchema, Schema.Null),
  status: IdentifierSchema,
  duration_ms: NonNegativeIntegerSchema,
  count: NonNegativeIntegerSchema,
  error_code: Schema.Union(IdentifierSchema, Schema.Null),
  schema_epochs: SchemaEpochsSchema,
  replayed: Schema.Boolean,
});
export type Telemetry = typeof TelemetrySchema.Type;

const WorkflowSourceSchema = Schema.String.pipe(
  Schema.filter((value) => new TextEncoder().encode(value).byteLength <= 1024 * 1024),
);
export const WorkflowExecutionModeSchema = Schema.Literal("native", "compatibility");
export const WorkflowDescriptorSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-workflow-1.0"),
  execution_mode: WorkflowExecutionModeSchema,
  source: WorkflowSourceSchema,
  args: JsonValueSchema,
  objective: BoundedTextSchema,
  constraints: SafeStringArraySchema,
  compile_options: Schema.optional(JsonObjectSchema),
});
export type WorkflowDescriptor = typeof WorkflowDescriptorSchema.Type;

const RunCreatedEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("run-created"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  definition: RunDefinitionSchema,
});
const StateEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("state-changed"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  from: RunStatusSchema,
  to: RunStatusSchema,
  reason: ShortTextSchema,
});
const OperationEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("operation"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  lifecycle: OperationLifecycleSchema,
  outcome: Schema.optional(SpecialistOutcomeSchema),
});
const CheckpointEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("checkpoint"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  checkpoint: CheckpointSchema,
});
const ContinuationEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("continuation-claimed"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  claim: ContinuationClaimSchema,
});
const RefinementEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("refinement"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  refinement: RefinementSchema,
});

export const JournalEventSchema = Schema.Union(
  RunCreatedEventSchema,
  StateEventSchema,
  OperationEventSchema,
  CheckpointEventSchema,
  ContinuationEventSchema,
  RefinementEventSchema,
);
export type JournalEvent = typeof JournalEventSchema.Type;

export const RunSnapshotSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-run-1.0"),
  definition: RunDefinitionSchema,
  status: RunStatusSchema,
  revision: NonNegativeIntegerSchema,
  checkpoint: Schema.Union(CheckpointSchema, Schema.Null),
  integrity: Schema.Literal("valid", "uncertain"),
  updated_at: DateTimeSchema,
  workflow: Schema.optional(WorkflowDescriptorSchema),
});
export type RunSnapshot = typeof RunSnapshotSchema.Type;

export const InspectionProjectionSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-run-1.0"),
  definition: RunDefinitionSchema,
  status: RunStatusSchema,
  revision: NonNegativeIntegerSchema,
  checkpoint: Schema.Union(CheckpointSchema, Schema.Null),
  operations: Schema.Array(OperationLifecycleSchema),
  retained_contexts: Schema.Array(RetainedContextIdentitySchema),
  integrity: Schema.Literal("valid", "uncertain"),
  replayed: Schema.Boolean,
});
export type InspectionProjection = typeof InspectionProjectionSchema.Type;

export type HostRoleTask = RoleTask;
export type HostPlanName = PlanName;
export type HostRole = Role;
export type HostRouteKey = RouteKey;
export type HostServiceTier = ServiceTier;
export type HostSpecialistOutcome = SpecialistOutcome;
export type RunId = string;
