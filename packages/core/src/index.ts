// SPDX-License-Identifier: Apache-2.0

export { CLI_SCHEMA_VERSION, STATE_SCHEMA_EPOCH, packageName } from "./common.ts";
export type { JsonObject, JsonPrimitive, JsonValue, SafeDetails } from "./common.ts";

export { CoreError } from "./errors.ts";
export type { CoreErrorCode, CoreResult } from "./errors.ts";

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
  EffortSchema,
  ExplorerTaskSchema,
  LibrarianTaskSchema,
  PlanNameSchema,
  PlanSelectionSchema,
  ReviewerTaskSchema,
  RoleSchema,
  RoleTaskSchema,
  ROUTE_KEYS,
  RouteKeySchema,
  ServiceTierSchema,
  WorkerTaskSchema,
} from "./routes.ts";
export type {
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
  parseCliEnvelope,
  parseSpecialistOutcome,
  SpecialistOutcomeSchema,
  SpecialistStatusSchema,
  SuggestedLunaEffortSchema,
} from "./envelopes.ts";
export type {
  CliEnvelope,
  CliFailureEnvelope,
  CliSuccessEnvelope,
  SpecialistOutcome,
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
