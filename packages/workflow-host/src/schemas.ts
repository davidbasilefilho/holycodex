// SPDX-License-Identifier: Apache-2.0

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
import { type } from "arktype";

export const WORKFLOW_HOST_SCHEMA_EPOCH = "host-state-1.0" as const;
export const WORKFLOW_HOST_SCHEMA_EPOCHS = Object.freeze({
  run: "host-run-1.0",
  journal: "host-journal-1.0",
  checkpoint: "host-checkpoint-1.0",
  continuation: "host-continuation-1.0",
  refinement: "host-refinement-1.0",
  telemetry: "host-telemetry-1.0",
});

const IdentifierSchema = type(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const DigestSchema = type(/^[0-9a-f]{64}$/u);
const DateTimeSchema = type(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s]{1,64}Z$/u);
const BoundedTextSchema = type("string").narrow(
  (value): value is string =>
    value.length <= 4096 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !(code <= 31 || code === 127);
    }),
);
const ShortTextSchema = type("string").narrow(
  (value): value is string => value.length > 0 && value.length <= 512,
);
const NonNegativeIntegerSchema = type("number.integer >= 0");
const PositiveIntegerSchema = type("number.integer > 0");

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
  } finally {
    if (Array.isArray(value)) {
      seen.delete(value);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }
  const valid = Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export const JsonValueSchema = type("unknown").narrow((value): value is JsonValue =>
  isJsonValue(value),
);
export const JsonObjectSchema = type("object").narrow(
  (value): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value),
);

export const ProjectTrustRefSchema = type({
  "+": "reject",
  project_id: IdentifierSchema,
  trust_id: IdentifierSchema,
  project_digest: DigestSchema,
  trust_digest: DigestSchema,
});
export type ProjectTrustRef = typeof ProjectTrustRefSchema.infer;

export const SchemaEpochsSchema = type({
  "+": "reject",
  core: IdentifierSchema,
  runtime: IdentifierSchema,
  host: IdentifierSchema,
});
export type SchemaEpochs = typeof SchemaEpochsSchema.infer;

export const IdentityComponentsSchema = type({
  "+": "reject",
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
export type IdentityComponents = typeof IdentityComponentsSchema.infer;

export const RunDefinitionSchema = type({
  "+": "reject",
  schema_epoch: "'host-run-1.0'",
  run_id: IdentifierSchema,
  objective_lineage: IdentifierSchema,
  parent_run_id: IdentifierSchema.or("null"),
  created_at: DateTimeSchema,
  identity: IdentityComponentsSchema,
});
export type RunDefinition = typeof RunDefinitionSchema.infer;

export const RunStatusSchema = type(
  "'created' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed' | 'blocked' | 'reopened'",
);
export type RunStatus = typeof RunStatusSchema.infer;

export const OperationStateSchema = type(
  "'reserved' | 'requested' | 'completed' | 'failed' | 'uncertain' | 'stopped'",
);
export type OperationState = typeof OperationStateSchema.infer;

export const OperationInputSchema = type({
  "+": "reject",
  operation_id: IdentifierSchema,
  input_digest: DigestSchema,
  route: RouteKeySchema,
  role: RoleSchema,
  task: ShortTextSchema,
  attempt: PositiveIntegerSchema,
  retry_limit: NonNegativeIntegerSchema,
  fan_out: PositiveIntegerSchema,
});
export type OperationInput = typeof OperationInputSchema.infer;

export const OperationLifecycleSchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
  operation: OperationInputSchema,
  state: OperationStateSchema,
  cost_units: NonNegativeIntegerSchema,
  at: DateTimeSchema,
  error_code: IdentifierSchema.or("null"),
});
export type OperationLifecycle = typeof OperationLifecycleSchema.infer;

const SafeStringArraySchema = type("string[]").narrow(
  (value): value is string[] => value.length <= 64 && value.every((item) => item.length <= 512),
);

export const CheckpointSchema = type({
  "+": "reject",
  schema_epoch: "'host-checkpoint-1.0'",
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
  usage_completeness: "'complete' | 'partial' | 'unknown'",
  recoverable_errors: SafeStringArraySchema,
  captured_at: DateTimeSchema,
});
export type Checkpoint = typeof CheckpointSchema.infer;

export const RetainedContextStatusSchema = type(
  "'available' | 'consumed' | 'invalidated' | 'blocked'",
);
export type RetainedContextStatus = typeof RetainedContextStatusSchema.infer;

export const RetainedContextIdentitySchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
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
export type RetainedContextIdentity = typeof RetainedContextIdentitySchema.infer;

export const ContinuationPacketSchema = type({
  "+": "reject",
  schema_epoch: "'host-continuation-1.0'",
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
export type ContinuationPacket = typeof ContinuationPacketSchema.infer;

export const ContinuationClaimSchema = type({
  "+": "reject",
  schema_epoch: "'host-continuation-1.0'",
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
export type ContinuationClaim = typeof ContinuationClaimSchema.infer;

export const RefinementProposalSchema = type({
  "+": "reject",
  kind: "'clarification' | 'constraint' | 'evidence' | 'workflow-note'",
  summary: ShortTextSchema,
  rationale: ShortTextSchema,
});
export type RefinementProposal = typeof RefinementProposalSchema.infer;

export const RefinementSchema = type({
  "+": "reject",
  schema_epoch: "'host-refinement-1.0'",
  refinement_id: IdentifierSchema,
  project: ProjectTrustRefSchema,
  run_id: IdentifierSchema,
  proposal: RefinementProposalSchema,
  status: "'enabled' | 'disabled'",
  reversible: "true",
  attributable_to: IdentifierSchema,
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
});
export type Refinement = typeof RefinementSchema.infer;

export const TelemetrySchema = type({
  "+": "reject",
  schema_epoch: "'host-telemetry-1.0'",
  event: "'run' | 'operation' | 'checkpoint' | 'replay' | 'continuation' | 'refinement'",
  run_id: IdentifierSchema.or("null"),
  route: RouteKeySchema.or("null"),
  status: IdentifierSchema,
  duration_ms: NonNegativeIntegerSchema,
  count: NonNegativeIntegerSchema,
  error_code: IdentifierSchema.or("null"),
  schema_epochs: SchemaEpochsSchema,
  replayed: "boolean",
});
export type Telemetry = typeof TelemetrySchema.infer;

const RunCreatedEventSchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
  event: "'run-created'",
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  definition: RunDefinitionSchema,
});
const StateEventSchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
  event: "'state-changed'",
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  from: RunStatusSchema,
  to: RunStatusSchema,
  reason: ShortTextSchema,
});
const OperationEventSchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
  event: "'operation'",
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  lifecycle: OperationLifecycleSchema,
  "outcome?": SpecialistOutcomeSchema,
});
const CheckpointEventSchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
  event: "'checkpoint'",
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  checkpoint: CheckpointSchema,
});
const ContinuationEventSchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
  event: "'continuation-claimed'",
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  claim: ContinuationClaimSchema,
});
const RefinementEventSchema = type({
  "+": "reject",
  schema_epoch: "'host-journal-1.0'",
  event: "'refinement'",
  run_id: IdentifierSchema,
  sequence: PositiveIntegerSchema,
  at: DateTimeSchema,
  refinement: RefinementSchema,
});

export const JournalEventSchema = RunCreatedEventSchema.or(StateEventSchema)
  .or(OperationEventSchema)
  .or(CheckpointEventSchema)
  .or(ContinuationEventSchema)
  .or(RefinementEventSchema);
export type JournalEvent = typeof JournalEventSchema.infer;

export const RunSnapshotSchema = type({
  "+": "reject",
  schema_epoch: "'host-run-1.0'",
  definition: RunDefinitionSchema,
  status: RunStatusSchema,
  revision: NonNegativeIntegerSchema,
  checkpoint: CheckpointSchema.or("null"),
  integrity: "'valid' | 'uncertain'",
  updated_at: DateTimeSchema,
});
export type RunSnapshot = typeof RunSnapshotSchema.infer;

export const InspectionProjectionSchema = type({
  "+": "reject",
  schema_epoch: "'host-run-1.0'",
  definition: RunDefinitionSchema,
  status: RunStatusSchema,
  revision: NonNegativeIntegerSchema,
  checkpoint: CheckpointSchema.or("null"),
  operations: OperationLifecycleSchema.array(),
  retained_contexts: RetainedContextIdentitySchema.array(),
  integrity: "'valid' | 'uncertain'",
  replayed: "boolean",
});
export type InspectionProjection = typeof InspectionProjectionSchema.infer;

export type HostRoleTask = RoleTask;
export type HostPlanName = PlanName;
export type HostRole = Role;
export type HostRouteKey = RouteKey;
export type HostServiceTier = ServiceTier;
export type HostSpecialistOutcome = SpecialistOutcome;
export type RunId = string;
