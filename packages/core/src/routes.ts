// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

import { freezeDeep } from "./common.ts";

/** Canonical user-facing routing profiles. */
export const ProfileNameSchema = Schema.Literal("low", "default", "high");
/** Type representing profile name in the core domain. */
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
/** Type representing legacy profile name in the core domain. */
export type LegacyProfileName = typeof LegacyProfileNameSchema.Type;
/** Runtime schema validating profile name migration values at the receiving boundary. */
export const ProfileNameMigrationSchema = Schema.Union(ProfileNameSchema, LegacyProfileNameSchema);
/** Type representing profile name migration input in the core domain. */
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

/** Runtime schema validating service tier values at the receiving boundary. */
export const ServiceTierSchema = Schema.Literal("standard", "fast", "fast-all");
/** Type representing service tier in the core domain. */
export type ServiceTier = typeof ServiceTierSchema.Type;

/** Runtime schema validating effort values at the receiving boundary. */
export const EffortSchema = Schema.Literal("low", "medium", "high", "xhigh", "max");
/** Type representing effort in the core domain. */
export type Effort = typeof EffortSchema.Type;

/** Canonical patch-quality rule for every source or artifact mutation. */
export const SURGICAL_MUTATION_RULE =
  "Satisfy the complete requested outcome correctly, elegantly, and mergeably; never weaken or reinterpret it to shrink the patch. Then make the smallest coherent patch within the authorized boundary. Prefer simple, cohesive, idiomatic solutions with appropriate abstraction and minimal accidental complexity. Avoid unrelated code, prose, configuration, documentation, instructions, tests, restructuring, formatting churn, files, and operations. Preserve unrelated work; return material scope expansion to Root.";

/** Canonical design judgment shared by Root and visual specialists. */
export const VISUAL_DESIGN_JUDGMENT =
  "Treat unnecessary text, headings, subheadings, typography hierarchy, cards, pills, badges, decorative containers, labels, microcopy, repeated information, and grouping without information or interaction value as design defects. Use these primitives when they materially improve hierarchy, comprehension, composition, interaction, or content. Every visible item must be necessary or usefully complementary to the content and design.";

/** Literal boundary for specialist tasks that may inspect or prove work but cannot mutate source. */
export const NO_SOURCE_MUTATION_RULE =
  "Do not modify repository source or the implementation under validation; observation, analysis, and proof artifacts only.";

const LIBRARIAN_CONTEXT7_INSTRUCTION =
  "For current library, framework, SDK, API, CLI, or cloud-service facts, resolve the library identity and query Context7 narrowly before model memory or web search. Return the typed context7 evidence state with version/source evidence. Use web search only when Context7 is unavailable, lacks relevant coverage or the required version, fails for authentication or quota, or a conflict remains after checking authoritative first-party documentation.";

/** Explicit fork policy for ordinary concrete specialist spawns. */
export const ForkTurnsSchema = Schema.Literal("none");
/** Type representing fork turns in the core domain. */
export type ForkTurns = typeof ForkTurnsSchema.Type;

/** Canonical work phases; actual dependencies determine ordering for each scope. */
export const ROOT_ORCHESTRATION_PHASE_ORDER = Object.freeze([
  "implementation",
  "review",
  "validation",
  "integration",
  "vcs",
] as const);
/** Type representing root orchestration phase in the core domain. */
export type RootOrchestrationPhase = (typeof ROOT_ORCHESTRATION_PHASE_ORDER)[number];

/** Canonical filesystem access schema used by core domain operations. */
export const FILESYSTEM_ACCESS_SCHEMA = Schema.Literal("read-only", "workspace-write");
/** Type representing filesystem access in the core domain. */
export type FilesystemAccess = typeof FILESYSTEM_ACCESS_SCHEMA.Type;

/** Canonical role definitions used by core domain operations. */
export const ROLE_DEFINITIONS = [
  {
    role: "Explorer",
    tasks: [
      {
        name: "map",
        description: "Bounded repository structure mapping specialist.",
        instruction: `Map the assigned repository area: locate its relevant packages, entry points, ownership boundaries, and nearby tests or docs. Return a compact path map and identify where a follow-up lookup or trace should start; do not trace runtime behavior or resolve an unrelated fact. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "lookup",
        description: "Repository fact lookup specialist.",
        instruction: `Find the specific requested repository fact and cite its exact path or symbol; keep the search narrower than a structure map or execution trace. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "trace",
        description: "Repository execution and reference tracing specialist.",
        instruction: `Follow the assigned execution or reference path across callers, boundaries, and tests; explain the evidence-backed flow and stop at the assigned boundary. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
    ],
    capability: "repository-read",
    authority:
      "Read only the delegated Assignment repository scope; Git/VCS writes, Intent lifecycle, and material decisions remain Root-only.",
    evidence: "Return exact paths, symbols, callers, tests, and constraints.",
    completion: "Account for every in-scope caller and constraint.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: true, filesystem: "read-only", sourceMutation: false },
  },
  {
    role: "Librarian",
    tasks: [
      {
        name: "lookup",
        description: "Authoritative external fact lookup specialist.",
        instruction: `Answer the specific external fact with its current authoritative source. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "research",
        description: "Current authoritative-source research specialist.",
        instruction: `Compare and synthesize the assigned current sources with citations, noting conflicts and uncertainty. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
    ],
    capability: "current-research",
    authority:
      "Research only the delegated Assignment current sources without repository mutation; Git/VCS writes, Intent lifecycle, and material decisions remain Root-only.",
    evidence: "Return sourced facts, dates, and explicit uncertainty.",
    completion: "Resolve the assigned external fact or report the exact evidence gap.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: true, filesystem: "read-only", sourceMutation: false },
  },
  {
    role: "Worker",
    tasks: [
      {
        name: "mechanical",
        description: "Deterministic bounded-edit specialist.",
        instruction: `Apply the exact already-decided transformation within the assigned files and verify it.`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "implementation",
        description: "Bounded behavior implementation specialist.",
        instruction: `Design and implement the assigned behavior within its bounded seam, then verify the changed behavior.`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "visual",
        description: "Rendered visual implementation and interaction specialist.",
        instruction: `Produce mergeable visual implementation within the Assignment, including frontend, 3D, browser-driven UI, and interactive visualization. Inspect the actual rendered and interacted-with result against acceptance criteria and references; iterate on material discrepancies in visual quality, UI, UX, accessibility, responsiveness, interaction, task adherence, and reference adherence. Use the projected skills appropriate to this visual work. Return changed paths and observable rendered/interaction evidence for independent Reviewer.visual review. ${VISUAL_DESIGN_JUDGMENT}`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "integration",
        description: "Decided seam integration specialist.",
        instruction: `Connect already-decided component seams, resolve interface mismatches within the assigned boundary, and verify their combined behavior.`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "operations",
        description: "Exact-ref or SHA terminal operations observer.",
        instruction: `Use babysit-ci to observe the assigned CI or release gate for the Root-supplied exact ref or SHA until terminal; report the matching result and failure evidence. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "read-only", sourceMutation: false },
      },
      {
        name: "validation",
        description: "Independent local behavioral validation specialist.",
        instruction: `Independently exercise the assigned local behavior with the smallest relevant checks, classify failures, and report reproducible evidence; generated proof state is allowed, but do not repair the implementation or substitute for code review. ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: false },
      },
      {
        name: "debugging",
        description: "Reproducible bounded defect-repair specialist.",
        instruction:
          "Use the debugging skill to repair the assigned defect within its bounded seam.",
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: true },
      },
    ],
    capability: "task-scoped-assignment",
    authority:
      "Concrete task permissions govern observation, proof writes, or source repair within the delegated Assignment; no role-level source-mutation authority is granted. Intent lifecycle, Git/VCS writes, and material choices remain Root-only.",
    evidence: "Return changed files, verification results, and remaining risk.",
    completion:
      "Finish the delegated Assignment with proportional proof or an exact blocker and return a compact structured outcome.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: true, filesystem: "read-only", sourceMutation: false },
  },
  {
    role: "Reviewer",
    tasks: [
      {
        name: "code",
        description: "Adversarial implemented-code review specialist.",
        instruction: `Review and repair the implemented code to a fixed point. Batch relevant evidence, then follow up on concrete uncertainty. Check correctness, safety, compatibility, test quality, generated-artifact hygiene, and the canonical patch-quality rule.`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: true },
      },
      {
        name: "visual",
        description: "Independent rendered visual, UI, UX, and interaction review specialist.",
        instruction: `Independently inspect the implementation and actual rendered/interacted-with result against acceptance criteria and references. Review visual quality, UI, UX, accessibility, responsiveness, interactions, task adherence, and reference adherence. Do not implement repairs. Return concrete reproducible discrepancies or sufficient acceptance evidence to Root for its final independent visual pass. ${VISUAL_DESIGN_JUDGMENT} ${NO_SOURCE_MUTATION_RULE}`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: false },
      },
      {
        name: "artifact",
        description: "Adversarial produced-artifact review specialist.",
        instruction: `Inspect the assigned produced artifact against its requested content, usability, and delivery constraints; repair concrete defects within the artifact boundary and repeat inspection until no actionable findings remain.`,
        permissions: { network: true, filesystem: "workspace-write", sourceMutation: true },
      },
    ],
    capability: "task-scoped-review",
    authority:
      "Concrete task permissions govern observational review or bounded repair within the delegated Assignment; no role-level source-mutation authority is granted. Intent lifecycle, Git/VCS writes, and material choices remain Root-only.",
    evidence: "Return findings, repaired paths, verification, and residual risk.",
    completion:
      "Reach a fixed point or report each reproducible blocker as a compact structured outcome.",
    // Role defaults are deliberately non-mutating; task permissions below are authoritative.
    permissions: { network: true, filesystem: "read-only", sourceMutation: false },
  },
] as const;
freezeDeep(ROLE_DEFINITIONS);

/** Type representing role definition in the core domain. */
export type RoleDefinition = (typeof ROLE_DEFINITIONS)[number];
/** Type representing role in the core domain. */
export type Role = RoleDefinition["role"];
/** Type representing task for role in the core domain. */
export type TaskForRole<R extends Role> = Extract<
  RoleDefinition,
  { readonly role: R }
>["tasks"][number]["name"];
/** Type representing explorer task in the core domain. */
export type ExplorerTask = TaskForRole<"Explorer">;
/** Type representing librarian task in the core domain. */
export type LibrarianTask = TaskForRole<"Librarian">;
/** Type representing worker task in the core domain. */
export type WorkerTask = TaskForRole<"Worker">;
/** Type representing reviewer task in the core domain. */
export type ReviewerTask = TaskForRole<"Reviewer">;
/** Type representing task slot in the core domain. */
export type TaskSlot = RoleDefinition["tasks"][number]["name"];
/** Type representing role task in the core domain. */
export type RoleTask = {
  readonly [R in Role]: { readonly role: R; readonly task: TaskForRole<R> };
}[Role];
/** Type representing route key in the core domain. */
export type RouteKey = RoleTask extends infer Pair
  ? Pair extends RoleTask
    ? `${Pair["role"]}:${Pair["task"]}`
    : never
  : never;
/** Type representing native agent type in the core domain. */
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

/** Runtime schema validating role values at the receiving boundary. */
export const RoleSchema = Schema.declare(isRole);
/** Runtime schema validating explorer task values at the receiving boundary. */
export const ExplorerTaskSchema = Schema.declare((value: unknown): value is ExplorerTask =>
  isTaskForRole("Explorer", value),
);
/** Runtime schema validating librarian task values at the receiving boundary. */
export const LibrarianTaskSchema = Schema.declare((value: unknown): value is LibrarianTask =>
  isTaskForRole("Librarian", value),
);
/** Runtime schema validating worker task values at the receiving boundary. */
export const WorkerTaskSchema = Schema.declare((value: unknown): value is WorkerTask =>
  isTaskForRole("Worker", value),
);
/** Runtime schema validating reviewer task values at the receiving boundary. */
export const ReviewerTaskSchema = Schema.declare((value: unknown): value is ReviewerTask =>
  isTaskForRole("Reviewer", value),
);
/** Runtime schema validating role task values at the receiving boundary. */
export const RoleTaskSchema = Schema.declare(isRoleTask);
/** Canonical route keys used by core domain operations. */
export const ROUTE_KEYS: readonly RouteKey[] = Object.freeze(
  routeKeys.filter((key): key is RouteKey => isRouteKey(key)),
);
/** Runtime schema validating route key values at the receiving boundary. */
export const RouteKeySchema = Schema.declare(isRouteKey);
/** Canonical native agent types used by core domain operations. */
export const NATIVE_AGENT_TYPES: readonly NativeAgentType[] = Object.freeze(
  nativeAgentTypes.filter((agentType): agentType is NativeAgentType =>
    nativeAgentTypeSet.has(agentType),
  ),
);
/** Runtime schema validating native agent type values at the receiving boundary. */
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
/** Type representing generic builtin agent type in the core domain. */
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
  return route.role === "Librarian"
    ? `${LIBRARIAN_CONTEXT7_INSTRUCTION} ${task.instruction}`
    : task.instruction;
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
  /** Whether the task can use network access. */
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
 * Every concrete route has web search and command network access. Worker.operations remains limited
 * to observing a Root-supplied exact ref/SHA for repository CI or release state.
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

/** Contract describing route definition. */
export interface RouteDefinition {
  /** Canonical route key. */
  readonly key: RouteKey;
  /** Specialist role that owns this route or task. */
  readonly role: Role;
  /** Concrete specialist task selected for this route. */
  readonly task: TaskSlot;
  /** Model assigned to this route. */
  readonly model: "gpt-6-luna";
  /** Reasoning effort assigned to this route. */
  readonly effort: Effort;
}

/** Contract describing profile definition. */
export interface ProfileDefinition {
  /** Canonical name for this definition. */
  readonly name: ProfileName;
  /** Root model and effort configuration. */
  readonly root: {
    readonly model: "gpt-6.1-sol" | "gpt-6-astra";
    readonly effort: Effort;
  };
  /** Specialist model recorded on this profile definition. */
  readonly specialistModel: "gpt-6-luna";
  /** Default service tier recorded on this profile definition. */
  readonly defaultServiceTier: ServiceTier;
  /** Specialist routes available in this profile. */
  readonly routes: readonly RouteDefinition[];
}

/** Runtime schema validating profile selection values at the receiving boundary. */
export const ProfileSelectionSchema = Schema.Struct({
  profile: ProfileNameSchema,
  service_tier: Schema.optional(ServiceTierSchema),
});
/** Type representing profile selection in the core domain. */
export type ProfileSelection = typeof ProfileSelectionSchema.Type;

/**
 * Root-owned actions that do not receive a specialist Assignment. `git_vcs` covers writes; relevant
 * read-only Git/VCS, CI, and PR-comment inspection may be delegated.
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
  "visual_judgment",
  "dev_server",
] as const);
/** Runtime schema validating root direct execution exception values at the receiving boundary. */
export const RootDirectExecutionExceptionSchema = Schema.Literal(
  ...ROOT_DIRECT_EXECUTION_EXCEPTIONS,
);
/** Type representing root direct execution exception in the core domain. */
export type RootDirectExecutionException = typeof RootDirectExecutionExceptionSchema.Type;

/** Effective authority for a Root work unit, including unavailable capabilities. */
export const RootExecutionStateSchema = Schema.Literal("delegated", "root_direct", "unavailable");
/** Type representing root execution state in the core domain. */
export type RootExecutionState = typeof RootExecutionStateSchema.Type;

/** Root-owned authority that cannot be transferred to a specialist Assignment. */
export const RootOwnedAuthoritySchema = Schema.Literal(...ROOT_DIRECT_EXECUTION_EXCEPTIONS);
/** Type representing root owned authority in the core domain. */
export type RootOwnedAuthority = typeof RootOwnedAuthoritySchema.Type;

/** Context7 evidence required from Librarian routes for current technical documentation. */
export const Context7EvidenceStateSchema = Schema.Literal(
  "used",
  "no_coverage",
  "unavailable",
  "auth_or_quota_failure",
  "source_conflict",
);
/** Type representing context7 evidence state in the core domain. */
export type Context7EvidenceState = typeof Context7EvidenceStateSchema.Type;

/** Canonical proportional proof rule for GPT-6-family instruction projections. */
export const TESTING_POLICY = Object.freeze({
  rule: "Prove success with the smallest meaningful validation proportionate to changed behavior, scope, risk, uncertainty, and acceptance criteria; preserve required repository gates. Reuse already-conclusive evidence. Do not manufacture proof work, add redundant tests, or test unrelated surfaces merely to increase confidence. Broaden or repeat validation only after relevant changes, failures, elevated risk, or unresolved material concerns. Avoid tests that mirror implementation for reversible low-impact changes.",
  avoidImplementationMirrorTestsForLowImpactReversibleChanges: true,
  broadenOrRepeatOnlyAfter: Object.freeze([
    "source_change",
    "proof_failure",
    "unresolved_material_concern",
    "change_breadth_or_risk",
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
  webFallbackEvidenceStates: Object.freeze([
    "no_coverage",
    "unavailable",
    "auth_or_quota_failure",
  ] as const satisfies readonly Context7EvidenceState[]),
  missingRequiredVersionAllowsFallback: true,
  successfulEvidenceAloneAllowsFallback: false,
  checkFirstPartyDocsBeforeFallbackForConflict: true,
  unresolvedConflictAfterFirstPartyAllowsFallback: true,
  materialDecisionsRemainRootOwned: true,
});

/** Assignment fields used to decide whether a Librarian result needs Context7 proof. */
export interface Context7AssignmentSemantics {
  /** Specialist role that owns this route or task. */
  readonly role: Role;
  /** Concrete specialist task selected for this route. */
  readonly task: string;
  /** Outcome this record is intended to achieve. */
  readonly objective: string;
  /** Repository or task boundary covered by this record. */
  readonly scope: readonly string[];
  /** Requirements that constrain this record. */
  readonly constraints: readonly string[];
  /** Work explicitly outside this record. */
  readonly exclusions: readonly string[];
  /** Records or work that must precede this one. */
  readonly dependencies: readonly string[];
  /** Observable conditions required for acceptance. */
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

/** Root visual judgment and specialist implementation for user-visible visual work. */
export const FRONTEND_WORKFLOW_POLICY = Object.freeze({
  repositoryAndUserRequirementsPrecedePluginDefaults: true,
  specialistsOwnImplementationAndInteractionProof: true,
  specialistVisualImplementationInstruction:
    "Assign material rendered implementation to Worker.visual, independent rendered review to Reviewer.visual, then perform Root's independent visual pass. Root remains final visual authority and actively looks for issues both specialists missed. Dispatch only bounded repairs for material discrepancies, repeat only affected review and judgment, and reuse unaffected evidence.",
  rootOwnsVisualJudgment: true,
  designJudgment: VISUAL_DESIGN_JUDGMENT,
  rootOwnsSharedDevServer: true,
  rootAcceptsTerminalVisualEvidence: true,
  sourceChangesInvalidateRenderEvidence: true,
  specialistReportsIncludeObservableRenderedEvidence: true,
  logicOnlyChangesRequireVisualAcceptance: false,
  fixedPoint: Object.freeze([
    "worker_visual_implements_and_inspects",
    "reviewer_visual_independently_reviews",
    "root_independently_judges",
    "root_assigns_bounded_visual_repair",
    "repeat_affected_review_and_judgment",
  ] as const),
});

/** Credential boundary for browser and GUI work performed under a specialist Assignment. */
export const CREDENTIAL_INTERACTION_POLICY = Object.freeze({
  interactiveCapabilitiesRemainSpecialistOwned: true,
  rootMayInspectForVisualJudgment: true,
  credentialEntryAndSubmissionRemainUserOwned: true,
  specialistsMustNeverHandleCredentials: true,
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

/** Root orchestration contract; only Root-owned authorities permit direct execution. */
export const ROOT_ORCHESTRATION_POLICY = Object.freeze({
  requiresDelegation: true,
  explicitUserDirectExecutionOverridesDelegation: true,
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
    "browser_use",
    "computer_use",
    "review",
    "ci_release_observation",
  ] as const),
  directExecutionExceptions: ROOT_DIRECT_EXECUTION_EXCEPTIONS,
  rootOwnedAuthority: ROOT_DIRECT_EXECUTION_EXCEPTIONS satisfies readonly RootOwnedAuthority[],
  requestUserInputGates: Object.freeze([
    "missing_authorization_for_consequential_effect",
    "ambiguity_or_missing_material_input",
  ] as const),
  surgicalMutationRule: SURGICAL_MUTATION_RULE,
  phaseOrder: ROOT_ORCHESTRATION_PHASE_ORDER,
  phaseGates: Object.freeze({
    implementedScopeStableBeforeReview: true,
    reviewerCodeAndWorkerValidationMayOverlapOnNonConflictingScopes: true,
    currentValidationBeforeRootIntegration: true,
    rootIntegrationBeforeVcs: true,
  }),
  initialDispatch: Object.freeze({
    independentAssignments: true,
    substantiveIndependentConcurrency: true,
    routinePostdispatchSteering: false,
    collectiveWaits: true,
    evidenceReusedAcrossPhases: true,
  }),
  atomicLifecycleTransitions: Object.freeze({
    relatedAssignmentAndIntentWrites: true,
    oneLockOneCommit: true,
    staleRevisionChecksRetained: true,
    repositoryDriftChecksRetained: true,
  }),
  supersession: Object.freeze({
    explicitOnly: true,
    unfinishedPredecessorOnly: true,
    validatedRelatedReplacement: true,
    reasonAndProvenanceRequired: true,
    supersededExcludedFromCompletionBlockers: true,
  }),
  specialistTerminalResultPersistence: Object.freeze({
    ownActiveInvocationCapabilityRequired: true,
    ownAssignmentOnly: true,
    terminalOutcomeOnly: true,
    rootOwnedIntentLifecycle: true,
    rootOwnedAcceptanceReviewAndCiGates: true,
    rootOwnedVcsAndExternalEffects: true,
    sharedRuntimeCallerIdentityUnavailable: true,
    legacyResultCompatibilityPreserved: true,
  }),
  /** Ordinary specialist spawns are explicit, concrete, and preserve route configuration. */
  normalSpawnForkTurns: "none" as ForkTurns,
  normalSpawnRequiresExplicitForkTurns: true,
  normalSpawnUsesConcreteRegisteredAgentType: true,
  /** Canonical Root boundary for semantic work-state operations and persisted TOON state. */
  semanticStateBoundary:
    "Use holycodex-agent semantic operations for Intent and Assignment state. Do not edit TOON state. Resume the current Intent or create one for new work; record verification, acceptance, and readiness, and complete only when holycodex-agent confirms every completion predicate. There is no HolyCodex planning workflow or automatic Plan approval gate; preserve existing Plan state when resuming work that uses it.",
  /** Verify registered route configuration once per generation before dispatch. */
  routeConfigurationBeforeDispatch:
    "Use the active profile's registered Role.task configuration, including model, effort, tier, permissions, shell, and capabilities. Verify the registration once per configuration generation; recheck after configuration changes or when resuming an unverified thread. Pass fields required by the dispatch tool; registered settings need not be copied into Assignment prose. Never inherit Root settings, substitute a generic route, or override the selected route. Report a missing or incompatible route before dispatch.",
  assignmentInvocationLifecycle:
    "Before each specialist spawn, persist the bounded Assignment and call holycodex-agent assignment start. Keep the returned active_invocation_id and capability in Root; give the specialist only the bounded Assignment, never the capability. After a terminal report, record the result with that invocation ID and capability. Recover an interrupted invocation only after confirming it stopped, using the matching Root-held capability; never share that capability.",
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
  /** Keep routine waits within the cache lifetime; specialist completion wakes early. */
  routineWaitMaximumTimeoutMs: 600_000,
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

/** Returns whether Root may execute a named Root-owned action directly. */
export function rootDirectExecutionAllowed(exception: RootDirectExecutionException): boolean {
  return rootExecutionState(exception) === "root_direct";
}

/** Resolve Root-owned direct actions and all other work that must be assigned to a specialist. */
export function rootExecutionState(exception?: RootDirectExecutionException): RootExecutionState {
  switch (exception) {
    case "user_interaction":
    case "intent":
    case "material_decisions":
    case "orchestration_lifecycle":
    case "integration_acceptance":
    case "completion":
    case "git_vcs":
    case "external_effects":
    case "visual_judgment":
    case "dev_server":
      return "root_direct";
    default:
      return "delegated";
  }
}
