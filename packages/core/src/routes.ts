// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

import { freezeDeep } from "./common.ts";

/** Canonical user-facing routing profiles. */
export const ProfileNameSchema = Schema.Literal("low", "default", "high");
export type ProfileName = typeof ProfileNameSchema.Type;

/** Historical product plan/profile spellings accepted only during migration. */
export const LegacyProfileNameSchema = Schema.Literal(
  "go",
  "Go",
  "plus-low",
  "plus",
  "plus-high",
  "pro-5x",
  "pro-20x",
);
export type LegacyProfileName = typeof LegacyProfileNameSchema.Type;
export const ProfileNameMigrationSchema = Schema.Union(ProfileNameSchema, LegacyProfileNameSchema);
export type ProfileNameMigrationInput = typeof ProfileNameMigrationSchema.Type;

/** Migrate persisted product profile names without silently choosing for removed values. */
export function migrateProfileName(input: ProfileNameMigrationInput): ProfileName {
  switch (input) {
    case "go":
    case "Go":
      throw new Error(`Legacy profile ${input} was removed and requires an explicit replacement.`);
    case "plus-low":
      return "low";
    case "plus":
      return "default";
    case "plus-high":
      return "high";
    case "pro-5x":
    case "pro-20x":
      throw new Error(`Legacy profile ${input} was removed and requires an explicit replacement.`);
    default:
      return input;
  }
}

export const ServiceTierSchema = Schema.Literal("standard", "fast", "fast-all");
export type ServiceTier = typeof ServiceTierSchema.Type;

export const EffortSchema = Schema.Literal("low", "medium", "high", "xhigh", "max");
export type Effort = typeof EffortSchema.Type;

/** Canonical mutation-minimization rule projected into source-mutating task profiles. */
export const SURGICAL_MUTATION_RULE =
  "Make the smallest complete edit set within the authorized boundary, touch no unrelated paths, avoid speculative refactors or formatting churn, and perform no redundant writes or operations; preserve unrelated work and stop for Root input before expanding scope.";

/** Literal boundary for specialist tasks that may inspect or prove work but cannot mutate source. */
export const NO_SOURCE_MUTATION_RULE =
  "Do not modify repository source or the implementation under validation; observation, analysis, and proof artifacts only.";

/** Explicit fork policy for ordinary concrete specialist spawns. */
export const ForkTurnsSchema = Schema.Literal("none");
export type ForkTurns = typeof ForkTurnsSchema.Type;

export const FILESYSTEM_ACCESS_SCHEMA = Schema.Literal("read-only", "workspace-write");
export type FilesystemAccess = typeof FILESYSTEM_ACCESS_SCHEMA.Type;

export const ROLE_DEFINITIONS = [
  {
    role: "Explorer",
    tasks: [
      {
        name: "lookup",
        description: "Repository fact lookup specialist.",
        instruction: `Locate the exact requested repository fact. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: false, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "trace",
        description: "Repository execution and reference tracing specialist.",
        instruction: `Trace the complete in-scope execution or reference path. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: false, filesystem: "read-only", sourceMutation: false },
      },
    ],
    capability: "repository-read",
    authority:
      "Read only the delegated Assignment repository scope; Git/VCS, lifecycle, and decisions remain Root-only.",
    evidence: "Return exact paths, symbols, callers, tests, and constraints.",
    completion: "Account for every in-scope caller and constraint.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: false, filesystem: "read-only", sourceMutation: false },
  },
  {
    role: "Librarian",
    tasks: [
      {
        name: "lookup",
        description: "Authoritative external fact lookup specialist.",
        instruction: `Locate the exact requested authoritative external fact. For current library, framework, SDK, API, CLI, or cloud-service facts, resolve the library identity and query Context7 narrowly before model memory or generic web sources. Return a typed Context7 evidence state in the context7 field with supporting version/source evidence; fall back only for an allowed evidence state or when the required version is absent, and prefer authoritative first-party documentation when sources conflict. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "research",
        description: "Current authoritative-source research specialist.",
        instruction: `Synthesize the assigned current sources with citations. For current library, framework, SDK, API, CLI, or cloud-service facts, resolve the library identity and query Context7 narrowly before model memory or generic web sources. Return a typed Context7 evidence state in the context7 field with supporting version/source evidence; fall back only for an allowed evidence state or when the required version is absent, and prefer authoritative first-party documentation when sources conflict. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
    ],
    capability: "current-research",
    authority:
      "Research only the delegated Assignment current sources without repository mutation; Git/VCS, lifecycle, and decisions remain Root-only.",
    evidence: "Return sourced facts, dates, and explicit uncertainty.",
    completion: "Resolve the assigned external fact or report the exact evidence gap.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: false, filesystem: "read-only", sourceMutation: false },
  },
  {
    role: "Worker",
    tasks: [
      {
        name: "mechanical",
        description: "Deterministic bounded-edit specialist.",
        instruction: "Apply only deterministic, already-decided edits.",
        permissions: { network: false, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "implementation",
        description: "Bounded behavior implementation specialist.",
        instruction: "Implement and verify the bounded behavior seam.",
        permissions: { network: false, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "integration",
        description: "Decided seam integration specialist.",
        instruction: "Integrate the decided seams and verify them together.",
        permissions: { network: false, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "operations",
        description: "Exact-ref or SHA terminal operations observer.",
        instruction: `Observe the assigned post-VCS external gate at the supplied exact ref or SHA. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "validation",
        description: "Independent local behavioral validation specialist.",
        instruction: `When independent proof is useful, run the smallest relevant local checks for the delegated seam, classify failures, and report evidence without redesigning the solution or replacing code review. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: false, filesystem: "workspace-write", sourceMutation: false },
      },
      {
        name: "debugging",
        description: "Reproducible bounded defect-repair specialist.",
        instruction:
          "Establish the failure reproducibly, identify the evidence-backed root cause, make the narrow bounded repair, and prove the regression is gone; return material redesigns to Root.",
        permissions: { network: false, filesystem: "workspace-write", sourceMutation: true },
      },
    ],
    capability: "task-scoped-assignment",
    authority:
      "Concrete task permissions govern observation, proof writes, or source repair within the delegated Assignment; no role-level source-mutation authority is granted. Intent lifecycle, Git/VCS, and material choices remain Root-only.",
    evidence: "Return changed files, verification results, and remaining risk.",
    completion:
      "Finish the delegated Assignment with proportional proof or an exact blocker and return a compact structured outcome.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: false, filesystem: "read-only", sourceMutation: false },
  },
  {
    role: "Reviewer",
    tasks: [
      {
        name: "plan",
        description: "Adversarial implementation-plan review specialist.",
        instruction: `Review the complete plan to a fixed point. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: false, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "code",
        description: "Adversarial implemented-code review specialist.",
        instruction:
          "Review and repair the implemented code to a fixed point. The acceptance contract covers correctness, safety, compatibility, mergeability, clarity, simplicity, cohesion, idiomaticity, appropriate abstraction, accidental complexity, duplication, unnecessary files or file splitting, speculative abstraction, test quality, and generated-artifact hygiene. Prefer simple cohesive code over clever or over-engineered code.",
        permissions: { network: false, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "artifact",
        description: "Adversarial produced-artifact review specialist.",
        instruction: "Review and repair the produced artifact to a fixed point.",
        permissions: { network: false, filesystem: "workspace-write", sourceMutation: true },
      },
    ],
    capability: "task-scoped-review",
    authority:
      "Concrete task permissions govern observational review or bounded repair within the delegated Assignment; no role-level source-mutation authority is granted. Intent lifecycle, Git/VCS, and material choices remain Root-only.",
    evidence: "Return findings, repaired paths, verification, and residual risk.",
    completion:
      "Reach a fixed point or report each reproducible blocker as a compact structured outcome.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: false, filesystem: "read-only", sourceMutation: false },
  },
] as const;
freezeDeep(ROLE_DEFINITIONS);

export type RoleDefinition = (typeof ROLE_DEFINITIONS)[number];
export type Role = RoleDefinition["role"];
export type TaskForRole<R extends Role> = Extract<
  RoleDefinition,
  { readonly role: R }
>["tasks"][number]["name"];
export type ExplorerTask = TaskForRole<"Explorer">;
export type LibrarianTask = TaskForRole<"Librarian">;
export type WorkerTask = TaskForRole<"Worker">;
export type ReviewerTask = TaskForRole<"Reviewer">;
export type TaskSlot = RoleDefinition["tasks"][number]["name"];
export type RoleTask = {
  readonly [R in Role]: { readonly role: R; readonly task: TaskForRole<R> };
}[Role];
export type RouteKey = RoleTask extends infer Pair
  ? Pair extends RoleTask
    ? `${Pair["role"]}:${Pair["task"]}`
    : never
  : never;
export type NativeAgentType = RoleTask extends infer Pair
  ? Pair extends RoleTask
    ? `${Pair["role"]}.${Pair["task"]}`
    : never
  : never;

const roleDefinitionsByName = new Map<Role, RoleDefinition>(
  ROLE_DEFINITIONS.map((definition) => [definition.role, definition]),
);
const roleNameSet = new Set<string>(ROLE_DEFINITIONS.map((definition) => definition.role));
const routeKeys = ROLE_DEFINITIONS.flatMap((definition) =>
  definition.tasks.map((task) => `${definition.role}:${task.name}`),
);
const routeKeySet = new Set<string>(routeKeys);
const nativeAgentTypes = routeKeys.map((key) => key.replace(":", "."));
const nativeAgentTypeSet = new Set(nativeAgentTypes);

function isRole(value: unknown): value is Role {
  return typeof value === "string" && roleNameSet.has(value);
}

function isRoleTask(value: unknown): value is RoleTask {
  if (typeof value !== "object" || value === null || !("role" in value) || !("task" in value)) {
    return false;
  }
  const role = value.role;
  const task = value.task;
  if (!isRole(role) || typeof task !== "string") {
    return false;
  }
  return (
    roleDefinitionsByName.get(role)?.tasks.some((candidate) => candidate.name === task) === true
  );
}

function isTaskForRole(role: Role, value: unknown): boolean {
  return (
    typeof value === "string" &&
    roleDefinitionsByName.get(role)?.tasks.some((candidate) => candidate.name === value) === true
  );
}

function isRouteKey(value: unknown): value is RouteKey {
  return typeof value === "string" && routeKeySet.has(value);
}

export const RoleSchema = Schema.declare(isRole);
export const ExplorerTaskSchema = Schema.declare((value: unknown): value is ExplorerTask =>
  isTaskForRole("Explorer", value),
);
export const LibrarianTaskSchema = Schema.declare((value: unknown): value is LibrarianTask =>
  isTaskForRole("Librarian", value),
);
export const WorkerTaskSchema = Schema.declare((value: unknown): value is WorkerTask =>
  isTaskForRole("Worker", value),
);
export const ReviewerTaskSchema = Schema.declare((value: unknown): value is ReviewerTask =>
  isTaskForRole("Reviewer", value),
);
export const RoleTaskSchema = Schema.declare(isRoleTask);
export const ROUTE_KEYS: readonly RouteKey[] = Object.freeze(
  routeKeys.filter((key): key is RouteKey => isRouteKey(key)),
);
export const RouteKeySchema = Schema.declare(isRouteKey);
export const NATIVE_AGENT_TYPES: readonly NativeAgentType[] = Object.freeze(
  nativeAgentTypes.filter((agentType): agentType is NativeAgentType =>
    nativeAgentTypeSet.has(agentType),
  ),
);
export const NativeAgentTypeSchema = Schema.declare(
  (value: unknown): value is NativeAgentType =>
    typeof value === "string" && nativeAgentTypeSet.has(value),
);

/** Generic built-in agent names that must never receive HolyCodex specialist Assignments. */
export const GENERIC_BUILTIN_AGENT_TYPES = Object.freeze([
  "worker",
  "explorer",
  "reviewer",
  "librarian",
] as const);
export type GenericBuiltinAgentType = (typeof GENERIC_BUILTIN_AGENT_TYPES)[number];

/** Resolve a concrete route to its native Codex agent type. */
export function nativeAgentTypeFor(route: RoleTask): NativeAgentType {
  const value = `${route.role}.${route.task}`;
  if (!nativeAgentTypeSet.has(value)) throw new Error("Unknown native specialist agent type.");
  return value as NativeAgentType;
}

/** Return the model-facing instruction assigned to a concrete specialist route. */
export function taskInstructionFor(route: RoleTask): string {
  const task = roleDefinitionsByName
    .get(route.role)
    ?.tasks.find((candidate) => candidate.name === route.task);
  if (task === undefined) throw new Error("Unknown specialist task policy.");
  return task.instruction;
}

/** Return the human-facing description assigned to a concrete specialist route. */
export function taskDescriptionFor(route: RoleTask): string {
  const task = roleDefinitionsByName
    .get(route.role)
    ?.tasks.find((candidate) => candidate.name === route.task);
  if (task === undefined) throw new Error("Unknown specialist task policy.");
  return task.description;
}

/** Look up the complete task policy for a specialist role. */
export function lookupRoleDefinition(role: Role): RoleDefinition {
  const definition = roleDefinitionsByName.get(role);
  if (definition === undefined) {
    throw new Error("Unknown specialist role.");
  }
  return definition;
}

/** Effective least-privilege permissions for one concrete specialist task. */
export interface SpecialistTaskPermissions {
  readonly network: boolean;
  /** Native sandbox/filesystem access; this does not imply source-mutation authority. */
  readonly filesystem: FilesystemAccess;
  /** Whether this concrete task may change repository source or implementation files. */
  readonly sourceMutation: boolean;
  /** Restricts enabled network access to the declared source boundary. */
  readonly networkScope: "disabled" | "current_sources" | "exact_ref_or_sha";
}

/**
 * Resolve permissions for one concrete specialist task.
 *
 * Role defaults intentionally do not grant Worker network access. The sole exception is
 * Worker.operations, whose network is limited to observing a Root-supplied exact ref/SHA for
 * repository CI or release state.
 */
export function taskPermissionsFor(route: RoleTask): SpecialistTaskPermissions {
  const role = lookupRoleDefinition(route.role);
  const task = role.tasks.find((candidate) => candidate.name === route.task);
  if (task === undefined) throw new Error("Unknown specialist task policy.");
  const networkScope =
    route.role === "Worker" && route.task === "operations"
      ? "exact_ref_or_sha"
      : task.permissions.network
        ? "current_sources"
        : "disabled";
  return Object.freeze({
    network: task.permissions.network,
    filesystem: task.permissions.filesystem,
    sourceMutation: task.permissions.sourceMutation,
    networkScope,
  });
}

export interface RouteDefinition {
  readonly key: RouteKey;
  readonly role: Role;
  readonly task: TaskSlot;
  readonly model: "gpt-5.6-luna";
  readonly effort: Effort;
}

export interface ProfileDefinition {
  readonly name: ProfileName;
  readonly root: {
    readonly model: "gpt-6-astra";
    readonly effort: Effort;
  };
  readonly specialistModel: "gpt-5.6-luna";
  readonly defaultServiceTier: ServiceTier;
  readonly routes: readonly RouteDefinition[];
}

export const ProfileSelectionSchema = Schema.Struct({
  profile: ProfileNameSchema,
  service_tier: Schema.optional(ServiceTierSchema),
});
export type ProfileSelection = typeof ProfileSelectionSchema.Type;

/**
 * Root-only actions that do not receive a specialist Assignment.
 *
 * Direct execution remains subject to the applicable approval and capability boundary.
 */
export const ROOT_DIRECT_EXECUTION_EXCEPTIONS = Object.freeze([
  "user_interaction",
  "intent",
  "material_decisions",
  "orchestration_lifecycle",
  "integration_acceptance",
  "completion",
  "git_vcs",
  "external_effects",
  "gui_browser",
  "computer_use",
] as const);
export const RootDirectExecutionExceptionSchema = Schema.Literal(
  ...ROOT_DIRECT_EXECUTION_EXCEPTIONS,
);
export type RootDirectExecutionException = typeof RootDirectExecutionExceptionSchema.Type;

/** Effective authority for a Root work unit, including unavailable capabilities. */
export const RootExecutionStateSchema = Schema.Literal("delegated", "root_direct", "unavailable");
export type RootExecutionState = typeof RootExecutionStateSchema.Type;

/** Root-owned authority that cannot be transferred to a specialist Assignment. */
export const RootOwnedAuthoritySchema = Schema.Literal(...ROOT_DIRECT_EXECUTION_EXCEPTIONS);
export type RootOwnedAuthority = typeof RootOwnedAuthoritySchema.Type;

/** Context7 evidence required from Librarian routes for current technical documentation. */
export const Context7EvidenceStateSchema = Schema.Literal(
  "used",
  "no_coverage",
  "unavailable",
  "auth_or_quota_failure",
  "source_conflict",
);
export type Context7EvidenceState = typeof Context7EvidenceStateSchema.Type;

/** Canonical proportional proof rule for GPT-6-family instruction projections. */
export const TESTING_POLICY = Object.freeze({
  rule: "Run meaningful proof appropriate to changed behavior plus repository-required checks.",
  avoidImplementationMirrorTestsForLowImpactReversibleChanges: true,
  broadenOrRepeatOnlyAfter: Object.freeze([
    "source_change",
    "proof_failure",
    "unresolved_material_concern",
  ] as const),
  mandatoryRepositoryGatesRemainRequired: true,
  reviewerCodeRemainsRequired: true,
});

/** Context7-first current-documentation policy owned by Librarian routes. */
export const LIBRARIAN_CONTEXT7_POLICY = Object.freeze({
  requiredFor: Object.freeze([
    "library",
    "framework",
    "sdk",
    "api",
    "cli",
    "cloud_service",
  ] as const),
  resolveIdentityBeforeQuery: true,
  queryNarrowly: true,
  evidenceStates: Object.freeze([
    "used",
    "no_coverage",
    "unavailable",
    "auth_or_quota_failure",
    "source_conflict",
  ] as const satisfies readonly Context7EvidenceState[]),
  fallbackRequiresEvidenceStateOrMissingVersion: true,
  authoritativeFirstPartyResolvesConflicts: true,
  materialDecisionsRemainRootOwned: true,
});

/** Assignment fields used to decide whether a Librarian result needs Context7 proof. */
export interface Context7AssignmentSemantics {
  readonly role: Role;
  readonly task: string;
  readonly objective: string;
  readonly scope: readonly string[];
  readonly constraints: readonly string[];
  readonly exclusions: readonly string[];
  readonly dependencies: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

const CONTEXT7_TECHNICAL_SUBJECT_PATTERN =
  /\b(?:libraries?|frameworks?|sdks?|apis?|clis?|cloud[ _-]?services?|packages?|dependencies?|technical|documentation|docs?|context7)\b/iu;
const CONTEXT7_NONCURRENT_SUBJECT_PATTERN = /\b(?:historical|history|legacy|archived?|past)\b/iu;

/**
 * Returns whether a concrete Assignment's own contract requires typed Context7 evidence.
 *
 * Librarian routes remain valid for other external facts; only technical subjects in a
 * non-historical contract require the Context7 proof at the receiving boundary.
 */
export function context7RequiredForAssignment(input: Context7AssignmentSemantics): boolean {
  if (input.role !== "Librarian" || (input.task !== "lookup" && input.task !== "research")) {
    return false;
  }
  const contract = [
    input.objective,
    ...input.scope,
    ...input.constraints,
    ...input.exclusions,
    ...input.dependencies,
    ...input.acceptanceCriteria,
  ].join(" ");
  return (
    CONTEXT7_TECHNICAL_SUBJECT_PATTERN.test(contract) &&
    !CONTEXT7_NONCURRENT_SUBJECT_PATTERN.test(contract)
  );
}

/** Root's required acceptance loop for selected, user-visible frontend work. */
export const FRONTEND_WORKFLOW_POLICY = Object.freeze({
  repositoryAndUserRequirementsPrecedePluginDefaults: true,
  specialistsOwnInspectionImplementationAndRepair: true,
  rootOwnsLiveVisualAndInteractionAcceptance: true,
  sourceChangesInvalidateRenderEvidence: true,
  specialistReportsCannotSubstituteForRootAcceptance: true,
  logicOnlyChangesRequireVisualAcceptance: false,
  fixedPoint: Object.freeze([
    "specialist_implements",
    "root_renders_opens_and_interacts",
    "root_judges_current_result",
    "root_delegates_discrepancies",
    "specialist_repairs",
    "root_rerenders_and_retests",
  ] as const),
});

/** Credential boundary for Root-only browser, GUI, and Computer Use activity. */
export const CREDENTIAL_INTERACTION_POLICY = Object.freeze({
  interactiveCapabilitiesRemainRootOwned: true,
  credentialEntryAndSubmissionRemainUserOwned: true,
  useDefaultBrowserWithComputerUse: true,
  agentsMustNeverHandleCredentials: true,
  authenticationSequence: Object.freeze([
    "root_navigates_to_authentication",
    "root_hands_control_to_user",
    "user_enters_and_submits_credentials",
    "root_waits_for_completion",
    "root_resumes_authenticated_session",
  ] as const),
  missingAuthorizedPathIsCapabilityBlocker: true,
});

/** Proportional security gates and their fixed-point relationship with code review. */
export const SECURITY_WORKFLOW_POLICY = Object.freeze({
  threatModelForMaterialTrustBoundaryChanges: true,
  securityDiffScanRequiredForSecuritySensitiveDiffs: true,
  fullScanOnlyForAuditNewExposedSurfaceOrSystemicConcern: true,
  validateSupportedFindingsBeforeBlocking: true,
  introducedOrWorsenedValidatedVulnerabilityBlocksVcs: true,
  preExistingUnrelatedFindingsDoNotExpandScope: true,
  securityEditsInvalidateCodeReview: true,
  securitySensitiveCodeReviewEditsInvalidateSecurityReview: true,
  materialDecisionsRemainRootOwned: true,
});

/**
 * Durable Root orchestration contract shared by runtime projections and proofs. Every task is
 * delegated, including trivial work, except for Git/VCS and Computer Use when that capability was
 * selected during installation.
 */
export const ROOT_ORCHESTRATION_POLICY = Object.freeze({
  requiresDelegation: true,
  assignmentStartAndDispatchPrecedeDelegableExecution: true,
  trivialWorkRequiresDelegation: true,
  preparatoryAndExploratoryWorkRequiresDelegation: true,
  genericDirectWorkFallback: false,
  concreteSpecialistDispatchRequired: true,
  registeredSpecialistAgentTypes: NATIVE_AGENT_TYPES,
  roleFamiliesAreLabelsOnly: true,
  forbiddenGenericAgentTypes: GENERIC_BUILTIN_AGENT_TYPES,
  missingConcreteRouteIsBlocker: true,
  delegableActions: Object.freeze([
    "repository_discovery",
    "file_source_test_doc_inspection",
    "fact_finding",
    "research",
    "implementation",
    "debugging",
    "testing",
    "validation",
    "frontend_work",
    "security_work",
    "review",
    "ci_release_observation",
  ] as const),
  directExecutionExceptions: ROOT_DIRECT_EXECUTION_EXCEPTIONS,
  rootOwnedAuthority: ROOT_DIRECT_EXECUTION_EXCEPTIONS satisfies readonly RootOwnedAuthority[],
  requestUserInputGates: Object.freeze([
    "plan_approval",
    "installation_profile_approval",
    "remote_origin_server_vcs_mutation",
    "public_publication_or_release",
    "ambiguity_or_missing_material_input",
  ] as const),
  surgicalMutationRule: SURGICAL_MUTATION_RULE,
  /** Ordinary specialist spawns are explicit, concrete, and preserve route configuration. */
  normalSpawnForkTurns: "none" as ForkTurns,
  normalSpawnRequiresExplicitForkTurns: true,
  normalSpawnUsesConcreteRegisteredAgentType: true,
  assignmentContextIsTaskSpecificOnly: true,
  configuredRouteModelAndEffortPreserved: true,
  /** Root user updates contain useful or important information only. */
  normalProgressMessages: false,
  normalHeartbeatMessages: false,
  normalIntermediateEvidence: false,
  userUpdatesUsefulOrImportantOnly: true,
  routinePerToolOrSubagentNarrationForbidden: true,
  routineStatusOnlyChatterForbidden: true,
  fixedCadenceUserUpdatesForbidden: true,
  materialUserUpdateKinds: Object.freeze([
    "significant_findings_or_decisions",
    "consequential_blockers_or_input_needs",
    "release_milestones",
  ] as const),
  outOfBoundaryRequiresNewAssignment: true,
  /** Root waits and batches lifecycle work instead of polling or coordinating status-only loops. */
  routineWaitTool: "collaboration.wait_agent" as const,
  /** Verified V1 runtime maximum; completion of a specialist wakes the wait early. */
  routineWaitMaximumTimeoutMs: 3_600_000,
  routineWaitUsesMaximumRuntimeTimeout: true,
  earlySpecialistCompletionWakesWait: true,
  collectiveMailboxIncludesRelevantAgents: true,
  idleTimeoutRepeatsMaximumWait: true,
  shortRoutineWaitsForbidden: true,
  longestPracticalEventWait: true,
  busyPollingForbidden: true,
  statusOnlyCoordinationLoopsForbidden: true,
  batchIndependentLifecycleActions: true,
  releaseLeavesAfterAcceptedOutcome: true,
  specialistOutcomes: Object.freeze([
    "completed",
    "blocked",
    "needs_root_input",
    "failed",
  ] as const),
  evidenceFirstConciseStructuredReports: true,
  specialistReportFields: Object.freeze([
    "changed paths",
    "checks",
    "observable evidence",
    "blockers",
    "Root decisions needed",
    "remaining risk",
  ] as const),
  rootLargeReadsOnlyFor: Object.freeze([
    "material decisions",
    "conflicts",
    "failures",
    "findings",
  ] as const),
  stableFactsReused: true,
  duplicatePolicyForbidden: true,
  stableBoundedComponentScopesAreCanonical: true,
  lifecycleWorkerOwnsDeterministicApi: true,
  materialDecisionsRemainRootOwned: true,
  lifecycleRemainsRootOwned: true,
  integrationAndCompletionRemainRootOwned: true,
  routineSafeReversibleInScopeDecisionsProceedAutonomously: true,
  userInstructionsOverrideSkillGuidelinesExceptHardInvariants: true,
  authorizedWorkContinuesThroughRequestedTerminalState: true,
  testingPolicy: TESTING_POLICY,
  codeReviewRequiredForImplementation: true,
  codeReviewRequiredBeforeVcs: true,
  externalVerificationMustBeTerminal: true,
  postVcsFlow: "discover_topology_observe_repair_repeat" as const,
});

/** Returns whether Root may execute a named exception directly. */
export function rootDirectExecutionAllowed(
  exception: RootDirectExecutionException,
  computerUseEnabled = false,
): boolean {
  // This predicate only answers the direct case; `false` also covers unavailable.
  return rootExecutionState(exception, computerUseEnabled) === "root_direct";
}

/**
 * Resolve direct, delegated, and unavailable states without conflating disabled capability with
 * delegation.
 */
export function rootExecutionState(
  exception?: RootDirectExecutionException,
  computerUseEnabled = false,
): RootExecutionState {
  switch (exception) {
    case "computer_use":
      return computerUseEnabled ? "root_direct" : "unavailable";
    case "user_interaction":
    case "intent":
    case "material_decisions":
    case "orchestration_lifecycle":
    case "integration_acceptance":
    case "completion":
    case "git_vcs":
    case "external_effects":
    case "gui_browser":
      return "root_direct";
    default:
      return "delegated";
  }
}
