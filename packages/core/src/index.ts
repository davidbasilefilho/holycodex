// SPDX-License-Identifier: Apache-2.0

export { CLI_SCHEMA_VERSION, STATE_SCHEMA_EPOCH, packageName } from "./common.ts";
export type { JsonObject, JsonPrimitive, JsonValue, SafeDetails } from "./common.ts";

export { CoreError } from "./errors.ts";
export type { CoreErrorCode, CoreResult } from "./errors.ts";
export { decodeUnknown } from "./schema.ts";

export {
  CAPABILITY_REGISTRY,
  CapabilityNameSchema,
  CapabilityHealthSchema,
  CapabilityProviderStatusSchema,
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
  OPTIONAL_CAPABILITY_NAMES,
  OptionalCapabilityNameSchema,
  capabilityHealth,
  migrateOptionalCapabilitySelections,
  pluginIdsForOptionalCapabilities,
  resolveOptionalCapabilitySelections,
} from "./capabilities.ts";
export type {
  CapabilityName,
  CapabilityDefinition,
  CapabilityHealth,
  CapabilityProviderStatus,
  ExplicitOptionalCapabilitySelections,
  OptionalCapabilityName,
  OptionalCapabilitySelections,
} from "./capabilities.ts";

export {
  APPROVAL_POLICY,
  APPROVAL_POLICY_GUIDANCE,
  ApprovalModeSchema,
  ApprovalPolicyActionSchema,
  ApprovalPolicyEntrySchema,
  ApprovalPolicySchema,
  approvalModeFor,
  lookupApprovalPolicy,
} from "./approval-policy.ts";
export type {
  ApprovalMode,
  ApprovalPolicy,
  ApprovalPolicyAction,
  ApprovalPolicyEntry,
} from "./approval-policy.ts";

export {
  createProjectId,
  createRunId,
  createSha256Digest,
  createTrustId,
  createWorkflowId,
  ProjectIdentityInputSchema,
  RunIdentityInputSchema,
  SchemaEpochIdSchema,
  TrustIdentityInputSchema,
  WorkflowIdentityInputSchema,
  parseIdentityInput,
  parseSchemaEpochId,
} from "./identifiers.ts";
export type {
  IdentityRecord,
  ProjectId,
  ProjectIdentityInput,
  RunId,
  RunIdentityInput,
  SchemaEpochId,
  Sha256Digest,
  TrustId,
  TrustIdentityInput,
  WorkflowId,
  WorkflowIdentityInput,
} from "./identifiers.ts";

export {
  DelegationModeSchema,
  EffortSchema,
  ExplorerTaskSchema,
  LibrarianTaskSchema,
  PlanNameSchema,
  PlanSelectionSchema,
  PONYTAIL_ROLE_SKILL,
  ReviewerTaskSchema,
  RoleSchema,
  RoleSkillProfileSchema,
  RoleTaskSchema,
  ROLE_DEFINITIONS,
  ROUTE_KEYS,
  RouteKeySchema,
  ServiceTierSchema,
  WorkerTaskSchema,
  lookupRoleDefinition,
} from "./routes.ts";
export type {
  DelegationMode,
  Effort,
  ExplorerTask,
  LibrarianTask,
  PlanName,
  PlanSelection,
  Role,
  RoleDefinition,
  RoleSkillProfile,
  RoleSkillProfileOrEmpty,
  RoleTask,
  ReviewerTask,
  RouteKey,
  ServiceTier,
  TaskForRole,
  TaskSlot,
  WorkerTask,
} from "./routes.ts";
export type { PlanBudget, PlanDefinition, RouteDefinition } from "./routes.ts";

export {
  CliEnvelopeSchema,
  CliFailureEnvelopeSchema,
  CliSuccessEnvelopeSchema,
  SPECIALIST_OUTCOME_VERSION,
  SpecialistOutcomeV2BaseSchema,
  CapabilityResultV2Schema,
  normalizeSpecialistOutcome,
  parseCapabilityResultV2,
  parseCliEnvelope,
  parseSpecialistOutcome,
  parseSpecialistOutcomeV2,
  specialistOutcomeFromCapabilityResult,
  SpecialistOutcomeSchema,
  SpecialistOutcomeV2Schema,
  SpecialistStatusSchema,
  SuggestedLunaEffortSchema,
} from "./envelopes.ts";
export type {
  CliEnvelope,
  CliFailureEnvelope,
  CliSuccessEnvelope,
  SpecialistOutcome,
  SpecialistOutcomeV2,
  CapabilityResultV2,
  SpecialistOutcomeV2Base,
  SpecialistOutcomeV2ForRole,
  ExplorerOutcome,
  LibrarianOutcome,
  WorkerOutcome,
  ReviewerOutcome,
  SpecialistStatus,
  SuggestedLunaEffort,
} from "./envelopes.ts";

export {
  lookupPlan,
  lookupRoute,
  parsePlanSelection,
  PLAN_CATALOG,
  ROUTE_EFFORT_OVERRIDES,
  resolvePlanSelection,
} from "./catalog.ts";

export {
  canonicalIdentityUtf8,
  canonicalJson,
  canonicalJsonUtf8,
  composeDigestInput,
  domainSeparatedSha256,
  sha256DomainDigest,
} from "./canonical.ts";
