// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import {
  DelegationModeSchema,
  NativeAgentTypeSchema,
  PlanNameSchema,
  RoleSchema,
  RoleSkillProfileSchema,
  RoleTaskSchema,
  RouteKeySchema,
  ServiceTierSchema,
  SpecialistOutcomeV2Schema,
  type JsonObject,
  type JsonValue,
  type PlanName,
  type Role,
  type RoleTask,
  type RouteKey,
  type ServiceTier,
  type SpecialistOutcomeV2,
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
      Array.from(value).every((character) => {
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
const SafeIntegerSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.filter((value) => Number.isSafeInteger(value)),
);
const SafeNonNegativeIntegerSchema = SafeIntegerSchema.pipe(Schema.greaterThanOrEqualTo(0));

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

export const NativeWorkflowIdentitySchema = Schema.Struct({
  source_sha256: DigestSchema,
  ir_sha256: DigestSchema,
  graph_sha256: DigestSchema,
  codec_profile_sha256: DigestSchema,
  abi_version: IdentifierSchema,
  execution_mode: Schema.Literal("native"),
});
export type NativeWorkflowIdentity = typeof NativeWorkflowIdentitySchema.Type;

export const CompatibilityCardinalitySchema = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("proven"),
    expected_calls: SafeNonNegativeIntegerSchema,
    proof_digest: DigestSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
  }),
);
export type CompatibilityCardinality = typeof CompatibilityCardinalitySchema.Type;

export const WorkflowExecutionIdentitySchema = Schema.Struct({
  execution_mode: Schema.Literal("native", "compatibility"),
  delegation_mode: DelegationModeSchema,
  compatibility_cardinality: Schema.Union(CompatibilityCardinalitySchema, Schema.Null),
});
export type WorkflowExecutionIdentity = typeof WorkflowExecutionIdentitySchema.Type;

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
  native_workflow: Schema.optional(NativeWorkflowIdentitySchema),
  workflow_execution: Schema.optional(WorkflowExecutionIdentitySchema),
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

const CostUsageSchema = Schema.Struct({
  input_tokens: Schema.optional(SafeNonNegativeIntegerSchema),
  cached_input_tokens: Schema.optional(SafeNonNegativeIntegerSchema),
  output_tokens: Schema.optional(SafeNonNegativeIntegerSchema),
  reasoning_output_tokens: Schema.optional(SafeNonNegativeIntegerSchema),
  total_tokens: Schema.optional(SafeNonNegativeIntegerSchema),
});

export const OperationCostAccountingSchema = Schema.Struct({
  estimated_units: SafeNonNegativeIntegerSchema,
  measured_units: Schema.optional(SafeNonNegativeIntegerSchema),
  pricing_key: ShortTextSchema,
  pricing_version: ShortTextSchema,
  usage: Schema.optional(CostUsageSchema),
  usage_completeness: Schema.Literal("complete", "partial", "unknown"),
  adjustment_units: SafeIntegerSchema,
  committed_units: SafeNonNegativeIntegerSchema,
  reserved_units: SafeNonNegativeIntegerSchema,
  overflow: Schema.Boolean,
});
export type OperationCostAccounting = typeof OperationCostAccountingSchema.Type;

export const OperationLifecycleSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  operation: OperationInputSchema,
  state: OperationStateSchema,
  cost_units: NonNegativeIntegerSchema,
  cost_accounting: Schema.optional(OperationCostAccountingSchema),
  at: DateTimeSchema,
  error_code: Schema.Union(IdentifierSchema, Schema.Null),
});
export type OperationLifecycle = typeof OperationLifecycleSchema.Type;

export const WorkflowRuntimeEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("workflow"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  node_id: IdentifierSchema,
  type: Schema.Literal("started", "completed", "failed", "skipped"),
  attempt: NonNegativeIntegerSchema,
  reason: Schema.optional(Schema.Literal("condition_false", "early_termination")),
  error_code: Schema.Union(IdentifierSchema, Schema.Null),
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});
export type WorkflowRuntimeEvent = typeof WorkflowRuntimeEventSchema.Type;

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

export const RetainedSessionRefSchema = Schema.Struct({
  thread_id: IdentifierSchema,
  turn_id: IdentifierSchema,
  session_mode: Schema.Literal("fresh", "resumed"),
  project: ProjectTrustRefSchema,
  objective_lineage: IdentifierSchema,
  role_task: RoleTaskSchema,
  agent_type: NativeAgentTypeSchema,
  route: RouteKeySchema,
  authority_scope_digest: DigestSchema,
  policy_digest: DigestSchema,
  tool_profile: IdentifierSchema,
  security_profile: IdentifierSchema,
  prompt_profile: IdentifierSchema,
  approval_policy: IdentifierSchema,
  sandbox_policy: IdentifierSchema,
  codex_capability_digest: DigestSchema,
  skill_profile: Schema.Union(RoleSkillProfileSchema, Schema.Null),
  skill_profile_digest: Schema.Union(DigestSchema, Schema.Literal("none")),
  fingerprint: DigestSchema,
  last_assignment: Schema.optional(JsonObjectSchema),
});
export type RetainedSessionRef = typeof RetainedSessionRefSchema.Type;

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
  skill_profile_digest: Schema.Union(DigestSchema, Schema.Literal("none")),
  status: RetainedContextStatusSchema,
  summary: SafeStringArraySchema,
  created_at: DateTimeSchema,
  session: Schema.optional(RetainedSessionRefSchema),
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
  delegation_mode: Schema.optional(DelegationModeSchema),
  session_mode: Schema.optional(Schema.Literal("fresh", "resumed")),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: NonNegativeIntegerSchema,
      cached_input_tokens: NonNegativeIntegerSchema,
      output_tokens: NonNegativeIntegerSchema,
      reasoning_output_tokens: NonNegativeIntegerSchema,
      total_tokens: Schema.optional(NonNegativeIntegerSchema),
    }),
  ),
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
  delegation_mode: Schema.optional(DelegationModeSchema),
  compatibility_cardinality: Schema.optional(CompatibilityCardinalitySchema),
  execution_identity: Schema.optional(WorkflowExecutionIdentitySchema),
  /** Read-only migration inputs from pre-0.15 compatibility descriptors. */
  expected_calls: Schema.optional(SafeNonNegativeIntegerSchema),
  expected_calls_proof_digest: Schema.optional(DigestSchema),
  proof_digest: Schema.optional(DigestSchema),
  source: WorkflowSourceSchema,
  args: JsonValueSchema,
  source_path: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096))),
  objective: BoundedTextSchema,
  constraints: SafeStringArraySchema,
  compile_options: Schema.optional(JsonObjectSchema),
});
export type WorkflowDescriptor = typeof WorkflowDescriptorSchema.Type;

export const WorkflowProjectionSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-workflow-1.0"),
  execution_mode: WorkflowExecutionModeSchema,
  delegation_mode: Schema.optional(DelegationModeSchema),
  compatibility_cardinality: Schema.optional(CompatibilityCardinalitySchema),
  execution_identity: Schema.optional(WorkflowExecutionIdentitySchema),
  source_digest: DigestSchema,
  args_digest: DigestSchema,
  objective: BoundedTextSchema,
  constraints: SafeStringArraySchema,
  native_identity: Schema.optional(NativeWorkflowIdentitySchema),
});
export type WorkflowProjection = typeof WorkflowProjectionSchema.Type;

const RunCreatedEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("run-created"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  definition: RunDefinitionSchema,
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
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
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});
const OperationEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("operation"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  lifecycle: OperationLifecycleSchema,
  outcome: Schema.optional(SpecialistOutcomeV2Schema),
  session: Schema.optional(RetainedSessionRefSchema),
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});
const CheckpointEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("checkpoint"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  checkpoint: CheckpointSchema,
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});
const ContinuationEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("continuation-claimed"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  claim: ContinuationClaimSchema,
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});
const RefinementEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("refinement"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  refinement: RefinementSchema,
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});

const CommitIntentEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("commit-intent"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  transaction_version: Schema.Literal("host-commit-1.0"),
  transaction_id: IdentifierSchema,
  previous_revision: NonNegativeIntegerSchema,
  new_revision: NonNegativeIntegerSchema,
  snapshot_digest: DigestSchema,
  journal_sequence: PositiveIntegerSchema,
  journal_digest: DigestSchema,
  checkpoint_revision: Schema.Union(PositiveIntegerSchema, Schema.Null),
  checkpoint_digest: Schema.Union(DigestSchema, Schema.Null),
  operation_state: Schema.Union(JsonObjectSchema, Schema.Null),
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});

const CommitRecordEventSchema = Schema.Struct({
  schema_epoch: Schema.Literal("host-journal-1.0"),
  event: Schema.Literal("commit-record"),
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  transaction_version: Schema.Literal("host-commit-1.0"),
  transaction_id: IdentifierSchema,
  intent_digest: DigestSchema,
  previous_revision: NonNegativeIntegerSchema,
  new_revision: NonNegativeIntegerSchema,
  snapshot_digest: DigestSchema,
  journal_sequence: PositiveIntegerSchema,
  journal_digest: DigestSchema,
  checkpoint_revision: Schema.Union(PositiveIntegerSchema, Schema.Null),
  checkpoint_digest: Schema.Union(DigestSchema, Schema.Null),
  operation_state: Schema.Union(JsonObjectSchema, Schema.Null),
  previous_digest: Schema.optional(DigestSchema),
  record_digest: Schema.optional(DigestSchema),
});

export const JournalEventSchema = Schema.Union(
  RunCreatedEventSchema,
  StateEventSchema,
  OperationEventSchema,
  WorkflowRuntimeEventSchema,
  CheckpointEventSchema,
  ContinuationEventSchema,
  RefinementEventSchema,
  CommitIntentEventSchema,
  CommitRecordEventSchema,
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
  workflow: Schema.optional(WorkflowProjectionSchema),
  operations: Schema.Array(OperationLifecycleSchema),
  workflow_events: Schema.Array(WorkflowRuntimeEventSchema),
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
export type HostSpecialistOutcome = SpecialistOutcomeV2;
export type RunId = string;
