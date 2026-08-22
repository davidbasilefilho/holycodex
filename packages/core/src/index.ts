// SPDX-License-Identifier: Apache-2.0

export { CLI_SCHEMA_VERSION, STATE_SCHEMA_EPOCH, packageName } from "./common.ts";
export type { JsonObject, JsonPrimitive, JsonValue, SafeDetails } from "./common.ts";

export { CoreError } from "./errors.ts";
export type { CoreErrorCode, CoreResult } from "./errors.ts";
export { decodeUnknown } from "./schema.ts";

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
  ReviewerTaskSchema,
  RoleSchema,
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
  normalizeSpecialistOutcome,
  parseCliEnvelope,
  parseSpecialistOutcome,
  parseSpecialistOutcomeV2,
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
  SpecialistStatus,
  SuggestedLunaEffort,
} from "./envelopes.ts";

export {
  lookupPlan,
  lookupRoute,
  parsePlanSelection,
  PLAN_CATALOG,
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
