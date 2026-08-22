// SPDX-License-Identifier: Apache-2.0

export const packageName = "@holycodex/workflow-host" as const;

export { WorkflowHostError } from "./errors.ts";
export type { WorkflowHostErrorCode } from "./errors.ts";
export { decodeStoredJournalEvent, FileRunStore } from "./store.ts";
export type { StoredRun } from "./store.ts";
export { WorkflowHost } from "./host.ts";
export { operationFingerprint } from "./identity.ts";
export type { NormalizedOperationInput } from "./identity.ts";
export type {
  ContinuationDecision,
  CreateRunInput,
  HostCapacity,
  ProjectTrustInput,
  ReplayAdmission,
  ReplayDecision,
  RefinementOperation,
  RetainedReuseDecision,
  RetainedReuseInput,
  RunExecution,
  RunInput,
  RuntimeEvaluator,
  WorkflowDefinition,
  WorkflowExecutionMode,
  WorkflowHostServices,
  HostApprovalDecision,
  HostApprovalHandler,
  HostVerificationHandler,
  HostCheckpointHandler,
  SpecialistAssignment,
  SpecialistExecutor,
  TelemetrySink,
  WorkflowHostOptions,
} from "./types.ts";
export {
  CheckpointSchema,
  ContinuationClaimSchema,
  ContinuationPacketSchema,
  IdentityComponentsSchema,
  InspectionProjectionSchema,
  JsonObjectSchema,
  JsonValueSchema,
  JournalEventSchema,
  OperationInputSchema,
  OperationLifecycleSchema,
  ProjectTrustRefSchema,
  RefinementProposalSchema,
  RefinementSchema,
  RetainedContextIdentitySchema,
  RetainedContextStatusSchema,
  RetainedSessionRefSchema,
  RunDefinitionSchema,
  RunSnapshotSchema,
  RunStatusSchema,
  SchemaEpochsSchema,
  TelemetrySchema,
  WorkflowDescriptorSchema,
  WorkflowExecutionModeSchema,
  WORKFLOW_HOST_SCHEMA_EPOCH,
  WORKFLOW_HOST_SCHEMA_EPOCHS,
  decodeHostSchema,
} from "./schemas.ts";
export type {
  Checkpoint,
  ContinuationClaim,
  ContinuationPacket,
  IdentityComponents,
  InspectionProjection,
  JournalEvent,
  OperationInput,
  OperationLifecycle,
  OperationState,
  ProjectTrustRef,
  Refinement,
  RefinementProposal,
  RetainedContextIdentity,
  RetainedContextStatus,
  RetainedSessionRef,
  RunDefinition,
  RunId,
  RunSnapshot,
  RunStatus,
  SchemaEpochs,
  Telemetry,
  WorkflowDescriptor,
} from "./schemas.ts";
