// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { readTomlPath, type TomlDocument } from "@holycodex/codex";
import {
  CAPABILITY_REGISTRY,
  NATIVE_AGENT_TYPES,
  GENERIC_BUILTIN_AGENT_TYPES,
  ROOT_ORCHESTRATION_POLICY,
  SPECIALIST_EFFICIENCY_POLICY,
  SPECIALIST_AUTHORITY_POLICY,
  SPECIALIST_TERMINAL_REPORT_POLICY,
  FRONTEND_WORKFLOW_POLICY,
  TESTING_POLICY,
  SURGICAL_MUTATION_RULE,
  lookupProfile,
  nativeAgentTypeFor,
  taskDescriptionFor,
  taskInstructionFor,
  taskPermissionsFor,
  type ServiceTier,
  type NativeAgentType,
  type ProfileName,
  type RoleTask,
  type GenericBuiltinAgentType,
  type RootOwnedAuthority,
} from "@holycodex/core";
import * as Effect from "effect/Effect";

import { assertNoSymlink, isFsCode, pathWithin } from "./paths.ts";
import { writeAtomicText } from "./storage.ts";
import type { ConflictResolver, ManagedArtifact, ManagedConflict } from "./types.ts";

/** Public CLI type describing native agent projection. */
export type NativeAgentProjection = Readonly<{
  name: NativeAgentType;
  taskInstruction: string;
  model: "gpt-6-luna";
  effort: string;
  description: string;
  serviceTier: "default" | "fast";
  permissions: ReturnType<typeof taskPermissionsFor>;
}>;

/** Public CLI type describing native agent sandbox mode. */
export type NativeAgentSandboxMode = "read-only" | "workspace-write";

/** Options controlling native agent instruction behavior. */
export type NativeAgentInstructionOptions = Readonly<{
  /** Whether the assignment may use an installed and available Browser Use capability. */
  browserUse?: boolean;
  /** Whether the assignment may use an installed and available Computer Use capability. */
  computerUse?: boolean;
  /** Whether the required frontend skill provider is projected. */
  frontend?: boolean;
  /** Whether Root may invoke the session-audit skill for matching work. */
  sessionAudit?: boolean;
  /** Whether Root may invoke the auto-reset skill for matching quota evidence. */
  autoReset?: boolean;
  /** Whether Root explicitly configures personality `none`, requiring a child transition. */
  parentPersonalityNone?: boolean;
}>;

/** Selected interactive capabilities that can be used within specialist Assignments. */
export type NativeAgentCapabilityOptions = Pick<
  NativeAgentInstructionOptions,
  "browserUse" | "computerUse" | "parentPersonalityNone"
>;

/**
 * Check whether Root explicitly selects personality `none`.
 *
 * An omitted TOML value is no personality override, not the `Personality::None` enum value used by
 * Codex's child model-instruction reset predicate.
 */
export function rootPersonalityIsNone(personality: unknown): boolean {
  return personality === "none";
}

/** Configure optional Root capabilities and the Windows shell. */
export type RootDeveloperInstructionOptions = NativeAgentInstructionOptions &
  Readonly<{
    computerUse?: boolean;
    frontend?: boolean;
    security?: boolean;
    sessionAudit?: boolean;
    autoReset?: boolean;
    /** Selected Root model; retained for installer call compatibility. */
    rootModel?: RootAgentProjection["model"];
  }>;

/** Public CLI type describing root agent projection. */
export type RootAgentProjection = Readonly<{
  name: "root";
  description: string;
  model: "gpt-6.1-sol" | "gpt-6-astra";
  effort: string;
  serviceTier: "default" | "fast";
}>;

const ROOT_AUTHORITY_LABELS = {
  user_interaction: "user interaction",
  intent: "Intent",
  material_decisions: "material decisions",
  orchestration_lifecycle: "orchestration and lifecycle",
  integration_acceptance: "integration acceptance",
  completion: "completion",
  git_vcs: "Git/VCS writes",
  external_effects: "external effects",
  visual_judgment: "visual judgment and its browser inspection",
  dev_server: "the shared background dev server",
} as const satisfies Readonly<Record<RootOwnedAuthority, string>>;

const DELEGABLE_ACTION_LABELS = {
  repository_discovery: "repository discovery",
  file_source_test_doc_inspection: "file, source, test, and documentation inspection",
  fact_finding: "fact finding",
  research: "research",
  implementation: "implementation",
  debugging: "debugging",
  testing: "testing",
  validation: "validation",
  frontend_work: "frontend work",
  security_work: "security work",
  browser_use: "authorized Browser Use",
  computer_use: "authorized Computer Use",
  review: "review",
  ci_release_observation: "CI or release observation",
} as const satisfies Readonly<
  Record<(typeof ROOT_ORCHESTRATION_POLICY.delegableActions)[number], string>
>;

const REVIEW_VALIDATION_PHASE_BARRIER =
  "Before acceptance or VCS writes, require a Reviewer.code fixed point and current relevant validation. Review and validation may overlap on non-conflicting scopes; serialize repairs against checks of the same source. Reuse worker proof and assign Worker.validation only for independent proof or an evidence gap. Repairs invalidate only affected evidence.";

/** Public data contract for native agent install result used by CLI operations. */
export interface NativeAgentInstallResult {
  /** The managed artifacts in native agent install result. */
  readonly managed_artifacts: readonly ManagedArtifact[];
  /** The preserved in native agent install result. */
  readonly preserved: readonly string[];
  /** The rollback in native agent install result. */
  readonly rollback: readonly NativeAgentRollbackEntry[];
}

/** Public data contract for native agent rollback entry used by CLI operations. */
export interface NativeAgentRollbackEntry {
  /** The path in native agent rollback entry. */
  readonly path: string;
  /** The previous in native agent rollback entry. */
  readonly previous: string | undefined;
  /** The installed digest in native agent rollback entry. */
  readonly installedDigest: string | undefined;
}

/** Public data contract for native agent removal result used by CLI operations. */
export interface NativeAgentRemovalResult {
  /** The removed in native agent removal result. */
  readonly removed: readonly string[];
  /** The preserved in native agent removal result. */
  readonly preserved: readonly string[];
}

/** Inspect every canonical native-agent path without changing the filesystem. */
export function inspectNativeAgentConflicts(
  codexHome: string,
  profile: ProfileName,
  previous: readonly ManagedArtifact[] = [],
  tier: ServiceTier = "standard",
  capabilities: NativeAgentCapabilityOptions = {},
  modelCatalogJson?: string,
): Promise<readonly ManagedConflict[]> {
  return Effect.runPromise(
    inspectNativeAgentConflictsEffect(
      codexHome,
      profile,
      previous,
      tier,
      capabilities,
      modelCatalogJson,
    ),
  );
}

function inspectNativeAgentConflictsEffect(
  codexHome: string,
  profile: ProfileName,
  previous: readonly ManagedArtifact[],
  tier: ServiceTier,
  capabilities: NativeAgentCapabilityOptions,
  modelCatalogJson?: string,
): Effect.Effect<readonly ManagedConflict[], unknown> {
  return Effect.gen(function* () {
    const generationId = nativeAgentGenerationId(profile, tier, capabilities);
    const projections = nativeAgentProjections(
      codexHome,
      profile,
      tier,
      capabilities,
      generationId,
    );
    if (modelCatalogJson !== undefined) {
      projections.push({
        path: join(codexHome, "holycodex", "model-catalog.json"),
        contents: modelCatalogJson,
      });
    }
    const previousByPath = new Map(
      previous.map((artifact) => [join(codexHome, artifact.path), artifact]),
    );
    const conflicts: ManagedConflict[] = [];
    for (const projection of projections) {
      const current = yield* Effect.tryPromise({
        try: () => readRegularFile(projection.path),
        catch: (error) => error,
      });
      const previousArtifact = previousByPath.get(projection.path);
      const conflict =
        current === undefined
          ? undefined
          : yield* nativeRoleConflict(projection, current, previousArtifact);
      if (conflict !== undefined) conflicts.push(conflict);
    }
    return conflicts;
  });
}

/** Inspect modified, recorded native-agent artifacts before removal mutates any path. */
export function inspectNativeAgentRemovalConflicts(
  codexHome: string,
  artifacts: readonly ManagedArtifact[],
): Promise<readonly (ManagedConflict & { readonly action: "remove" })[]> {
  return Effect.runPromise(inspectNativeAgentRemovalConflictsEffect(codexHome, artifacts));
}

function inspectNativeAgentRemovalConflictsEffect(
  codexHome: string,
  artifacts: readonly ManagedArtifact[],
): Effect.Effect<readonly (ManagedConflict & { readonly action: "remove" })[], unknown> {
  return Effect.gen(function* () {
    const root = join(codexHome, "agents");
    const managedRoot = join(codexHome, "holycodex", "agents");
    const managedCatalog = join(codexHome, "holycodex", "model-catalog.json");
    const conflicts: (ManagedConflict & { readonly action: "remove" })[] = [];
    for (const artifact of artifacts) {
      const target = join(codexHome, artifact.path);
      if (
        !pathWithin(codexHome, target) ||
        (!pathWithin(root, target) &&
          !pathWithin(managedRoot, target) &&
          target !== join(codexHome, "config.toml") &&
          target !== managedCatalog)
      ) {
        continue;
      }
      const current = yield* Effect.tryPromise({
        try: () => readRegularFile(target),
        catch: (error) => error,
      });
      if (
        current !== undefined &&
        (yield* Effect.tryPromise({ try: () => sha256(current), catch: (error) => error })) !==
          artifact.digest
      ) {
        const currentDigest = yield* Effect.tryPromise({
          try: () => sha256(current),
          catch: (error) => error,
        });
        conflicts.push({
          ...nativeConflict(
            target,
            "remove",
            { present: true, digest: currentDigest },
            { present: false },
            "The managed native artifact changed outside HolyCodex and would be removed.",
          ),
          action: "remove",
        });
      }
    }
    return conflicts;
  });
}

/** Return reviewed native files whose contents changed or can no longer be safely read. */
export function changedNativeAgentRemovalConflicts(
  codexHome: string,
  reviewedDigests: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  return Effect.runPromise(changedNativeAgentRemovalConflictsEffect(codexHome, reviewedDigests));
}

function changedNativeAgentRemovalConflictsEffect(
  codexHome: string,
  reviewedDigests: ReadonlyMap<string, string>,
): Effect.Effect<readonly string[], unknown> {
  return Effect.gen(function* () {
    const root = join(codexHome, "agents");
    const managedRoot = join(codexHome, "holycodex", "agents");
    const managedCatalog = join(codexHome, "holycodex", "model-catalog.json");
    const changed: string[] = [];
    for (const [target, reviewedDigest] of reviewedDigests) {
      if (
        !pathWithin(codexHome, target) ||
        (!pathWithin(root, target) && !pathWithin(managedRoot, target) && target !== managedCatalog)
      ) {
        changed.push(target);
        continue;
      }
      const current = yield* Effect.tryPromise({
        try: () => readRegularFile(target),
        catch: (error) => error,
      });
      if (
        current !== undefined &&
        (yield* Effect.tryPromise({ try: () => sha256(current), catch: (error) => error })) !==
          reviewedDigest
      )
        changed.push(target);
    }
    return changed;
  });
}

/** Project every canonical specialist profile and service tier. */
export function projectNativeAgents(
  profileName: ProfileName,
  tier: ServiceTier = "standard",
): readonly NativeAgentProjection[] {
  const profile = lookupProfile(profileName);
  if (!profile.ok) return [];
  return profile.value.routes.map((route) => {
    const roleTask = { role: route.role, task: route.task } as RoleTask;
    return {
      name: nativeAgentTypeFor(roleTask),
      description: taskDescriptionFor(roleTask),
      taskInstruction: taskInstructionFor(roleTask),
      permissions: taskPermissionsFor(roleTask),
      model: route.model,
      effort: route.effort,
      serviceTier: tier === "standard" ? "default" : "fast",
    };
  });
}

function nativeAgentProjections(
  codexHome: string,
  profile: ProfileName,
  tier: ServiceTier,
  capabilities: NativeAgentCapabilityOptions,
  generationId: string,
): Array<{ path: string; contents: string }> {
  const root = join(codexHome, "holycodex", "agents", generationId);
  return [
    ...projectNativeAgents(profile, tier).map((agent) => ({
      path: join(root, `${agent.name}.toml`),
      contents: renderNativeAgent(agent, capabilities),
    })),
    ...GENERIC_BUILTIN_AGENT_TYPES.map((agentType) => ({
      path: join(root, `sentinel-${agentType}.toml`),
      contents: renderGenericBuiltinSentinel(
        agentType,
        capabilities.parentPersonalityNone === true,
      ),
    })),
  ];
}

/** Resolve the content-addressed generation that new Codex threads should load. */
export function nativeAgentGenerationId(
  profileName: ProfileName,
  tier: ServiceTier = "standard",
  instructionOptions: NativeAgentInstructionOptions = {},
): string {
  const snapshot = [
    ...projectNativeAgents(profileName, tier).map(
      (agent) => `${agent.name}\0${renderNativeAgent(agent, instructionOptions)}`,
    ),
    ...GENERIC_BUILTIN_AGENT_TYPES.map(
      (agentType) =>
        `${agentType}\0${renderGenericBuiltinSentinel(agentType, instructionOptions.parentPersonalityNone)}`,
    ),
  ].join("\0");
  return createHash("sha256").update(snapshot).digest("hex").slice(0, 20);
}

/** Resolve the managed TOML path registered for a canonical specialist route. */
export function nativeAgentConfigPath(agentType: NativeAgentType, generationId: string): string {
  if (!/^[a-f0-9]{20}$/u.test(generationId)) {
    throw new Error("Invalid native-agent generation identifier.");
  }
  return `holycodex/agents/${generationId}/${agentType}.toml`;
}

/** Resolve the managed TOML path for a generic-route fail-closed sentinel. */
export function genericAgentSentinelConfigPath(
  agentType: GenericBuiltinAgentType,
  generationId: string,
): string {
  if (!/^[a-f0-9]{20}$/u.test(generationId)) {
    throw new Error("Invalid native-agent generation identifier.");
  }
  return `holycodex/agents/${generationId}/sentinel-${agentType}.toml`;
}

/** Render a prompt-only fail-closed guard for one built-in generic route. */
export function renderGenericBuiltinSentinel(
  agentType: GenericBuiltinAgentType,
  parentPersonalityNone = false,
): string {
  const instructions = `This is HolyCodex's fail-closed sentinel for the generic \`${agentType}\` route. Do not perform work, inspect files, use tools, or delegate. Immediately return to the parent that the generic route is disabled and that it must use an exact registered Role.task route or report the missing route to Root.`;
  return [
    // Codex resolves an `agents.<key>` registration by the `name` stored in
    // that file. Keep this equal to the registered built-in route so the
    // sentinel shadows Codex's generic default/worker/explorer implementation.
    `name = ${JSON.stringify(agentType)}`,
    `description = ${JSON.stringify(`Fail-closed sentinel for generic ${agentType} assignments.`)}`,
    'model = "gpt-6-luna"',
    'model_reasoning_effort = "low"',
    'service_tier = "default"',
    'model_reasoning_summary = "none"',
    'model_verbosity = "low"',
    `personality = ${JSON.stringify(parentPersonalityNone ? "friendly" : "none")}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    "",
  ].join("\n");
}

/** Return the absolute path of the HolyCodex-owned model catalog in CODEX_HOME. */
export function nativeModelCatalogPath(codexHome: string): string {
  return join(codexHome, "holycodex", "model-catalog.json");
}

/** Project the parent Root model configuration for a profile and service tier. */
export function projectRootAgent(
  profileName: ProfileName,
  tier: ServiceTier = "standard",
): RootAgentProjection {
  const profile = lookupProfile(profileName);
  if (!profile.ok) throw new Error("Unknown profile.");
  return {
    name: "root",
    description: "Root-directed HolyCodex control agent.",
    model: profile.value.root.model,
    effort: profile.value.root.effort,
    serviceTier: tier === "fast-all" ? "fast" : "default",
  };
}

/** The parent session is configured in config.toml, never as a spawnable role. */
export function rootDeveloperInstructions(
  input: boolean | RootDeveloperInstructionOptions = false,
): string {
  const options: RootDeveloperInstructionOptions =
    typeof input === "boolean" ? { computerUse: input, frontend: true, security: true } : input;
  if (
    !ROOT_ORCHESTRATION_POLICY.requiresDelegation ||
    ROOT_ORCHESTRATION_POLICY.normalSpawnForkContext !== false ||
    ROOT_ORCHESTRATION_POLICY.normalSpawnModelOverride !== false ||
    ROOT_ORCHESTRATION_POLICY.normalSpawnEffortOverride !== false ||
    ROOT_ORCHESTRATION_POLICY.orchestrationToolNamespace !== "multi_agent_v1" ||
    !ROOT_ORCHESTRATION_POLICY.orchestrationToolsDirectOnly ||
    !ROOT_ORCHESTRATION_POLICY.assignmentContextIsTaskSpecificOnly ||
    !ROOT_ORCHESTRATION_POLICY.configuredRouteModelAndEffortPreserved ||
    ROOT_ORCHESTRATION_POLICY.rootWaitTool !== "multi_agent_v1.wait_agent" ||
    ROOT_ORCHESTRATION_POLICY.rootWaitTimeoutMs !== 600_000 ||
    !ROOT_ORCHESTRATION_POLICY.waitIncludesEveryLiveBlockingSpecialist ||
    !ROOT_ORCHESTRATION_POLICY.v1UsageHintText.includes("fork_context=false") ||
    ROOT_ORCHESTRATION_POLICY.registeredSpecialistAgentTypes !== NATIVE_AGENT_TYPES ||
    ROOT_ORCHESTRATION_POLICY.forbiddenGenericAgentTypes !== GENERIC_BUILTIN_AGENT_TYPES
  ) {
    throw new Error("The Root orchestration policy is incomplete.");
  }
  const instructions = [
    `You are the HolyCodex Root/session orchestrator. Delegate all delegable work. Root owns ${ROOT_ORCHESTRATION_POLICY.rootOwnedAuthority.map((authority) => ROOT_AUTHORITY_LABELS[authority]).join("; ")}, within authorization and capability boundaries.`,
    `Delegate ${ROOT_ORCHESTRATION_POLICY.delegableActions
      .filter(
        (action) =>
          (action !== "browser_use" || options.browserUse) &&
          (action !== "computer_use" || options.computerUse),
      )
      .map((action) => DELEGABLE_ACTION_LABELS[action])
      .join(
        "; ",
      )} through bounded Assignments. Bundle related trivial and preparatory steps into a coherent Assignment rather than spawning per action.`,
    ROOT_ORCHESTRATION_POLICY.routeConfigurationBeforeDispatch,
    ROOT_ORCHESTRATION_POLICY.assignmentInvocationLifecycle,
    `For normal specialist spawns, set fork_context: ${ROOT_ORCHESTRATION_POLICY.normalSpawnForkContext}; do not override the selected route's model or effort. Give each specialist a self-contained Assignment with objective, bounded scope, constraints, dependencies, acceptance criteria, and evidence needed for acceptance.`,
    `Dispatch each Assignment to its exact concrete registered Role.task agent_type. Registered targets: ${ROOT_ORCHESTRATION_POLICY.registeredSpecialistAgentTypes.join(", ")}. Explorer, Librarian, Worker, and Reviewer are labels only; generic built-in agent_type values ${ROOT_ORCHESTRATION_POLICY.forbiddenGenericAgentTypes.join(", ")} are forbidden.`,
    ROOT_ORCHESTRATION_POLICY.semanticDefinitionsInstruction,
    ROOT_ORCHESTRATION_POLICY.semanticStateBoundary,
    ROOT_ORCHESTRATION_POLICY.dependencyAwareAmbiguityInstruction,
    `Root owns user interaction. Continue independent work while input is pending; prepare the concrete reviewable result before requesting approval for a consequential effect. Credential entry remains user-owned. ${ROOT_ORCHESTRATION_POLICY.dependencyAwareAmbiguityInstruction}`,
    "For visual tasks, Root uses visual-loop: Worker.visual implementation, Reviewer.visual independent review, then Root independent visual pass; use dev-server when a shared background server is needed. Honor active-surface tool precedence. Report a capability blocker without inventing a provider or widening authority.",
    renderVisualInspectionInstruction(options),
    FRONTEND_WORKFLOW_POLICY.designJudgment,
    "Use writing-instructions for model-facing contracts. Keep each meaning with one authoritative owner and add only the missing semantic delta for the receiver.",
    ROOT_ORCHESTRATION_POLICY.specialistCoordinationInstruction,
    `${TESTING_POLICY.rule} ${REVIEW_VALIDATION_PHASE_BARRIER}`,
    "After integration, Root owns approved VCS writes. For PR or release gates use babysit-ci and dispatch Worker.operations for exact-ref terminal evidence. Pending gates are not complete.",
  ];
  if (options.frontend ?? true) {
    instructions.push(renderFrontendCapabilityInstruction());
  }
  if (options.security ?? true) {
    instructions.push(
      "For security-sensitive changes, use the relevant security review skills before VCS. Validate supported findings; repair introduced or worsened vulnerabilities before VCS unless explicitly risk-accepted. Keep security review current after relevant repairs.",
    );
  }
  if (options.sessionAudit) {
    instructions.push(renderSemanticCapabilityInstruction("session-audit"));
  }
  if (options.autoReset) {
    instructions.push(renderSemanticCapabilityInstruction("auto-reset"));
  }
  return instructions.join("\n");
}

function renderSemanticCapabilityInstruction(name: "session-audit" | "auto-reset"): string {
  return CAPABILITY_REGISTRY[name].applicability
    .map(({ appliesWhen, skillId }) => `When ${appliesWhen}, use $${skillId}.`)
    .join(" ");
}

function renderVisualInspectionInstruction(
  options: NativeAgentInstructionOptions,
  receiver: "Root" | "specialist" = "Root",
): string {
  const inspection = options.browserUse
    ? `Inspect and interact with rendered visual work using Browser Use / the in-app browser (IAB). ${options.computerUse ? "Use Computer Use when Browser Use cannot perform the required interaction. " : ""}Use other available rendered evidence for remaining inspection gaps.`
    : options.computerUse
      ? "Inspect and interact with rendered visual work using Computer Use, then other available rendered evidence for remaining inspection gaps."
      : "Inspect rendered visual work using other available rendered evidence such as screenshots or image tools.";
  const visualization = options.browserUse
    ? `For web-visualize, open and inspect the standalone temporary HTML with Browser Use / IAB.${options.computerUse ? " Use Computer Use for HTML interactions Browser Use cannot perform." : ""}`
    : options.computerUse
      ? "For web-visualize, open and inspect the standalone temporary HTML with Computer Use."
      : "For web-visualize, give the standalone temporary HTML file to the user.";
  return `For ${receiver === "Root" ? "Root visual judgment" : "visual implementation and review"}, ${inspection} ${visualization} Honor higher-priority active-surface tool rules.`;
}

function renderFrontendCapabilityInstruction(): string {
  if (
    !FRONTEND_WORKFLOW_POLICY.repositoryAndUserRequirementsPrecedePluginDefaults ||
    !FRONTEND_WORKFLOW_POLICY.specialistsOwnImplementationAndInteractionProof ||
    FRONTEND_WORKFLOW_POLICY.specialistVisualImplementationInstruction.length === 0 ||
    !FRONTEND_WORKFLOW_POLICY.rootOwnsVisualJudgment ||
    !FRONTEND_WORKFLOW_POLICY.rootOwnsSharedDevServer ||
    !FRONTEND_WORKFLOW_POLICY.rootAcceptsTerminalVisualEvidence ||
    !FRONTEND_WORKFLOW_POLICY.sourceChangesInvalidateRenderEvidence ||
    !FRONTEND_WORKFLOW_POLICY.specialistReportsIncludeObservableRenderedEvidence ||
    FRONTEND_WORKFLOW_POLICY.logicOnlyChangesRequireVisualAcceptance
  ) {
    throw new Error("The Frontend workflow policy is incomplete.");
  }
  return `${renderFrontendSkillInstruction()} Follow the repository stack, design system, and user requirements. ${FRONTEND_WORKFLOW_POLICY.specialistVisualImplementationInstruction} Refresh affected visual evidence after relevant changes. Logic-only changes do not require a visual loop. Check responsive layout, accessibility, and interactions in proportion to the change.`;
}

function renderFrontendSkillInstruction(): string {
  const mappings = CAPABILITY_REGISTRY.frontend.applicability
    .map(({ skillId, appliesWhen }) => `${appliesWhen} uses ${skillId}`)
    .join("; ");
  return `Use Build Web Apps for applicable web-app construction and Frontend App Builder for applicable frontend work. For frontend work, ${mappings}.`;
}

/** Publish canonical native profiles while preserving foreign or modified files. */
export function installNativeAgents(
  codexHome: string,
  profile: ProfileName,
  previous: readonly ManagedArtifact[] = [],
  tier: ServiceTier = "standard",
  resolveConflict?: ConflictResolver,
  preResolvedConflicts: readonly ManagedConflict[] = [],
  capabilities: NativeAgentCapabilityOptions = {},
  modelCatalogJson?: string,
): Promise<NativeAgentInstallResult> {
  const rollback: NativeAgentRollbackEntry[] = [];
  const operation = Effect.gen(function* () {
    const generationId = nativeAgentGenerationId(profile, tier, capabilities);
    const preserved: string[] = [];
    const projections = nativeAgentProjections(
      codexHome,
      profile,
      tier,
      capabilities,
      generationId,
    );
    if (modelCatalogJson !== undefined) {
      projections.push({
        path: join(codexHome, "holycodex", "model-catalog.json"),
        contents: modelCatalogJson,
      });
    }
    const previousByPath = new Map(
      previous.map((artifact) => [join(codexHome, artifact.path), artifact]),
    );
    const currentByPath = new Map<string, string | undefined>();
    const acceptedConflicts = new Set<string>();
    const preservedConflicts = new Set<string>();
    const conflictSnapshotDigests = new Map<string, string>();
    for (const projection of projections) {
      const current = yield* Effect.tryPromise({
        try: () => readRegularFile(projection.path),
        catch: (error) => error,
      });
      currentByPath.set(projection.path, current);
      const preResolved = preResolvedConflicts.find(
        (candidate) =>
          candidate.path === projection.path &&
          candidate.action === "replace" &&
          candidate.key === undefined,
      );
      if (preResolved !== undefined) {
        const reviewedDigest = conflictDigest(preResolved);
        if (
          reviewedDigest === undefined ||
          current === undefined ||
          (yield* Effect.tryPromise({ try: () => sha256(current), catch: (error) => error })) !==
            reviewedDigest
        ) {
          return yield* Effect.fail(
            new Error(
              `The native role conflict changed after review; review the latest file and retry: ${projection.path}`,
            ),
          );
        }
        conflictSnapshotDigests.set(projection.path, reviewedDigest);
        if (preResolved.decision === "keep") preservedConflicts.add(projection.path);
        else acceptedConflicts.add(projection.path);
      }
      const previousArtifact = previousByPath.get(projection.path);
      if (current !== undefined && preResolved === undefined) {
        const conflict = yield* nativeRoleConflict(projection, current, previousArtifact);
        if (conflict !== undefined) {
          const resolution =
            resolveConflict === undefined ? undefined : yield* resolveConflict(conflict);
          if (resolution === "cancel") {
            return yield* Effect.fail(
              new Error(`Native-agent conflict resolution was cancelled: ${projection.path}`),
            );
          }
          if (resolution === undefined) {
            preservedConflicts.add(projection.path);
          } else {
            const reviewedDigest = conflictDigest(conflict);
            const latest = yield* Effect.tryPromise({
              try: () => readRegularFile(projection.path),
              catch: (error) => error,
            });
            if (
              reviewedDigest === undefined ||
              latest === undefined ||
              (yield* Effect.tryPromise({ try: () => sha256(latest), catch: (error) => error })) !==
                reviewedDigest
            ) {
              return yield* Effect.fail(
                new Error(
                  `The native role conflict changed after review; review the latest file and retry: ${projection.path}`,
                ),
              );
            }
            conflictSnapshotDigests.set(projection.path, reviewedDigest);
            if (resolution === "accept") acceptedConflicts.add(projection.path);
            else preservedConflicts.add(projection.path);
          }
        }
      }
    }
    const managed_artifacts: ManagedArtifact[] = [];
    const transaction = yield* Effect.result(
      Effect.gen(function* () {
        for (const projection of projections) {
          const current = currentByPath.get(projection.path);
          const previousArtifact = previousByPath.get(projection.path);
          const reviewedDigest = conflictSnapshotDigests.get(projection.path);
          if (reviewedDigest !== undefined) {
            const latest = yield* Effect.tryPromise({
              try: () => readRegularFile(projection.path),
              catch: (error) => error,
            });
            if (
              latest === undefined ||
              (yield* Effect.tryPromise({ try: () => sha256(latest), catch: (error) => error })) !==
                reviewedDigest
            ) {
              return yield* Effect.fail(
                new Error(
                  `The native role conflict changed after review; review the latest file and retry: ${projection.path}`,
                ),
              );
            }
          }
          if (preservedConflicts.has(projection.path)) {
            preserved.push(projection.path);
            if (previousArtifact !== undefined) {
              managed_artifacts.push(previousArtifact);
            }
            continue;
          }
          if (current !== undefined && previousArtifact !== undefined) {
            const digest = yield* Effect.tryPromise({
              try: () => sha256(current),
              catch: (error) => error,
            });
            if (
              digest !== previousArtifact.digest &&
              current !== projection.contents &&
              !acceptedConflicts.has(projection.path)
            ) {
              preserved.push(projection.path);
              managed_artifacts.push({
                path: relative(codexHome, projection.path).replaceAll("\\", "/"),
                digest: previousArtifact.digest,
              });
              continue;
            }
          }
          if (current === undefined || current !== projection.contents) {
            yield* Effect.tryPromise({
              try: () => writeAtomicText(projection.path, projection.contents),
              catch: (error) => error,
            });
            rollback.push({
              path: projection.path,
              previous: current,
              installedDigest: yield* Effect.tryPromise({
                try: () => sha256(projection.contents),
                catch: (error) => error,
              }),
            });
          }
          managed_artifacts.push({
            path: relative(codexHome, projection.path).replaceAll("\\", "/"),
            digest: yield* Effect.tryPromise({
              try: () => sha256(projection.contents),
              catch: (error) => error,
            }),
          });
        }
        // A legacy root role was invalid by construction. Remove it only when its
        // content carries the old HolyCodex marker; an unrelated user root role is
        // preserved.
        const legacyRoot = join(codexHome, "agents", "root.toml");
        const legacyRootContents = yield* Effect.tryPromise({
          try: () => readRegularFile(legacyRoot),
          catch: (error) => error,
        });
        const legacyRootStatus = yield* Effect.tryPromise({
          try: () => removeLegacyRootIfOwned(legacyRoot),
          catch: (error) => error,
        });
        if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
        if (legacyRootStatus === "removed" && legacyRootContents !== undefined) {
          rollback.push({
            path: legacyRoot,
            previous: legacyRootContents,
            installedDigest: undefined,
          });
        }
        for (const artifact of previous) {
          const absolute = join(codexHome, artifact.path);
          if (!projections.some((candidate) => candidate.path === absolute)) {
            managed_artifacts.push(artifact);
          }
        }
        return { managed_artifacts, preserved, rollback };
      }),
    );
    if (transaction._tag === "Failure") {
      // The caller cannot receive a result when a write fails midway. Restore
      // everything already published while preserving concurrent user edits.
      yield* Effect.tryPromise({
        try: () => rollbackNativeAgentInstall(rollback),
        catch: () => undefined,
      });
      return yield* Effect.fail(transaction.failure);
    }
    return transaction.success;
  });
  return Effect.runPromise(operation);
}

/** Restore only files that still match the just-published native-agent state. */
export function rollbackNativeAgentInstall(
  entries: readonly NativeAgentRollbackEntry[],
): Promise<NativeAgentRemovalResult> {
  return Effect.runPromise(rollbackNativeAgentInstallEffect(entries));
}

function rollbackNativeAgentInstallEffect(
  entries: readonly NativeAgentRollbackEntry[],
): Effect.Effect<NativeAgentRemovalResult, unknown> {
  return Effect.gen(function* () {
    const removed: string[] = [];
    const preserved: string[] = [];
    for (const entry of [...entries].reverse()) {
      const current = yield* Effect.tryPromise({
        try: () => readRegularFile(entry.path),
        catch: (error) => error,
      });
      const unchanged =
        entry.installedDigest === undefined
          ? current === undefined
          : current !== undefined &&
            (yield* Effect.tryPromise({ try: () => sha256(current), catch: (error) => error })) ===
              entry.installedDigest;
      if (!unchanged) {
        preserved.push(entry.path);
        continue;
      }
      if (entry.previous === undefined) {
        yield* Effect.catchIf(
          Effect.tryPromise({
            try: () => rm(entry.path, { force: false }),
            catch: (error) => error,
          }),
          (error) => isFsCode(error, "ENOENT"),
          () => Effect.void,
        );
        removed.push(entry.path);
      } else {
        yield* Effect.tryPromise({
          try: () => writeAtomicText(entry.path, entry.previous!),
          catch: (error) => error,
        });
      }
    }
    return { removed, preserved };
  });
}

/** Remove only unchanged native profiles recorded as HolyCodex-owned artifacts. */
export function removeManagedNativeAgents(
  codexHome: string,
  artifacts: readonly ManagedArtifact[],
  acceptedConflictDigests: ReadonlyMap<string, string> = new Map(),
): Promise<NativeAgentRemovalResult> {
  return Effect.runPromise(
    removeManagedNativeAgentsEffect(codexHome, artifacts, acceptedConflictDigests),
  );
}

function removeManagedNativeAgentsEffect(
  codexHome: string,
  artifacts: readonly ManagedArtifact[],
  acceptedConflictDigests: ReadonlyMap<string, string>,
): Effect.Effect<NativeAgentRemovalResult, unknown> {
  return Effect.gen(function* () {
    const removed: string[] = [];
    const preserved: string[] = [];
    const root = join(codexHome, "agents");
    const managedRoot = join(codexHome, "holycodex", "agents");
    const managedCatalog = join(codexHome, "holycodex", "model-catalog.json");
    for (const artifact of artifacts) {
      const target = join(codexHome, artifact.path);
      if (
        !pathWithin(codexHome, target) ||
        (!pathWithin(root, target) &&
          !pathWithin(managedRoot, target) &&
          target !== managedCatalog &&
          target !== join(codexHome, "config.toml"))
      ) {
        preserved.push(target);
        continue;
      }
      const result = yield* Effect.result(
        Effect.gen(function* () {
          yield* Effect.tryPromise({ try: () => assertNoSymlink(target), catch: (error) => error });
          const entry = yield* Effect.tryPromise({
            try: () => lstat(target),
            catch: (error) => error,
          });
          if (entry.isSymbolicLink() || !entry.isFile()) return "preserved" as const;
          const current = yield* Effect.tryPromise({
            try: () => readFile(target),
            catch: (error) => error,
          });
          const currentDigest = yield* Effect.tryPromise({
            try: () => sha256(current),
            catch: (error) => error,
          });
          const reviewedDigest = acceptedConflictDigests.get(target);
          if (currentDigest !== artifact.digest && currentDigest !== reviewedDigest)
            return "preserved" as const;
          yield* Effect.tryPromise({
            try: () => rm(target, { force: false }),
            catch: (error) => error,
          });
          return "removed" as const;
        }),
      );
      if (result._tag === "Success") {
        if (result.success === "removed") removed.push(target);
        else preserved.push(target);
      } else if (!isFsCode(result.failure, "ENOENT")) {
        preserved.push(target);
      }
    }
    const legacyRoot = join(codexHome, "agents", "root.toml");
    const legacyRootStatus = yield* Effect.tryPromise({
      try: () => removeLegacyRootIfOwned(legacyRoot),
      catch: (error) => error,
    });
    if (legacyRootStatus === "removed") removed.push(legacyRoot);
    if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
    // Snapshot file paths because pruning appends removed directories to the same result.
    const removedFiles = removed.slice();
    for (const target of removedFiles) {
      let parent = dirname(target);
      while (parent !== managedRoot && pathWithin(managedRoot, parent)) {
        const removedDirectory = yield* Effect.result(
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => assertNoSymlink(parent),
              catch: (error) => error,
            });
            yield* Effect.tryPromise({ try: () => rmdir(parent), catch: (error) => error });
          }),
        );
        if (removedDirectory._tag === "Failure") {
          if (!isFsCode(removedDirectory.failure, "ENOENT")) break;
        } else removed.push(parent);
        parent = dirname(parent);
      }
    }
    return { removed, preserved };
  });
}

/** Render one canonical native specialist profile as Codex TOML. */
export function renderNativeAgent(
  agent: NativeAgentProjection,
  instructionOptions: NativeAgentInstructionOptions = {},
): string {
  const sharedStart = agent.taskInstruction.indexOf(SPECIALIST_AUTHORITY_POLICY);
  const efficiencyStart = agent.taskInstruction.indexOf(SPECIALIST_EFFICIENCY_POLICY, sharedStart);
  const terminalStart = agent.taskInstruction.indexOf(
    SPECIALIST_TERMINAL_REPORT_POLICY,
    efficiencyStart,
  );
  if (sharedStart < 0 || efficiencyStart < sharedStart || terminalStart < efficiencyStart) {
    throw new Error(`The ${agent.name} task instruction has no canonical specialist policy order.`);
  }
  const taskAndFamilyInstructions = agent.taskInstruction.slice(0, sharedStart).trim();
  const capabilityInstructions = [
    ...(agent.name === "Worker.visual" || agent.name === "Reviewer.visual"
      ? [
          renderVisualInspectionInstruction(instructionOptions, "specialist"),
          ...((instructionOptions.frontend ?? true) ? [renderFrontendSkillInstruction()] : []),
        ]
      : []),
    ...(agent.permissions.sourceMutation ? [`Patch quality: ${SURGICAL_MUTATION_RULE}`] : []),
    ...(instructionOptions.browserUse
      ? [
          "Use Browser Use only for this Assignment, following active-surface tool rules. Return tool failures that prevent required evidence as a blocker. Tool availability does not grant authority, and consequential external effects remain Root-owned.",
        ]
      : []),
    ...(instructionOptions.computerUse
      ? [
          "Use Computer Use only for this Assignment, following active-surface tool rules and platform restrictions. External actions require explicit task authority. Return tool failures that prevent required evidence as a blocker. Tool availability does not grant authority. Credential entry and submission remain user-owned; never request, enter, retrieve, expose, or store credentials.",
        ]
      : []),
  ];
  const instructions = [
    taskAndFamilyInstructions,
    agent.taskInstruction.slice(sharedStart, efficiencyStart).trim(),
    agent.taskInstruction.slice(efficiencyStart, terminalStart).trim(),
    ...capabilityInstructions,
    agent.taskInstruction.slice(terminalStart).trim(),
  ].join("\n");
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model = ${JSON.stringify(agent.model)}`,
    `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
    `service_tier = ${JSON.stringify(agent.serviceTier)}`,
    'model_reasoning_summary = "none"',
    'model_verbosity = "low"',
    `personality = ${JSON.stringify(
      instructionOptions.parentPersonalityNone === true ? "friendly" : "none",
    )}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    "",
  ].join("\n");
}

/** Return the Codex sandbox mode for a concrete task, including proof-only writable tasks. */
export function nativeAgentSandboxMode(agent: NativeAgentProjection): NativeAgentSandboxMode {
  return agent.permissions.filesystem;
}

/** Check that a generated specialist inherits its parent permission profile. */
export function nativeAgentSandboxConfigurationMatches(
  _agent: NativeAgentProjection,
  document: TomlDocument,
): boolean {
  return (
    document["sandbox_mode"] === undefined &&
    document["approval_policy"] === undefined &&
    document["approvals_reviewer"] === undefined &&
    document["web_search"] === undefined &&
    document["default_permissions"] === undefined &&
    readTomlPath(document, "sandbox_workspace_write.network_access") === undefined
  );
}

function renderHistoricalRootAgent(
  model: "gpt-5.6-terra" | "gpt-5.6-sol",
  effort: string,
  serviceTier: "default" | "fast",
): string {
  return [
    'name = "root"',
    'description = "Root-directed HolyCodex control agent."',
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `service_tier = ${JSON.stringify(serviceTier)}`,
    'model_verbosity = "low"',
    "",
  ].join("\n");
}

// Previous releases wrote only these exact root-role layouts. Keep the
// allowlist closed over their historical Terra/Sol profile and tier output;
// a user-owned root role with even a small shape/content difference is not
// ours to remove.
const LEGACY_ROOT_ROLE_CONTENTS = new Set(
  (
    [
      { model: "gpt-5.6-terra", effort: "high" },
      { model: "gpt-5.6-sol", effort: "low" },
      { model: "gpt-5.6-sol", effort: "medium" },
      { model: "gpt-5.6-sol", effort: "high" },
    ] as const
  ).flatMap(({ model, effort }) =>
    (["default", "fast"] as const).map((serviceTier) =>
      renderHistoricalRootAgent(model, effort, serviceTier),
    ),
  ),
);

/** Identify the closed set of legacy HolyCodex Root files safe to remove. */
export function isKnownLegacyRootRoleContent(content: string): boolean {
  return LEGACY_ROOT_ROLE_CONTENTS.has(content);
}

function removeLegacyRootIfOwned(path: string): Promise<"removed" | "preserved" | "absent"> {
  return Effect.runPromise(
    Effect.catchIf(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => assertNoSymlink(path), catch: (error) => error });
        const entry = yield* Effect.tryPromise({ try: () => lstat(path), catch: (error) => error });
        if (!entry.isFile() || entry.isSymbolicLink()) return "preserved" as const;
        const content = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: (error) => error,
        });
        if (!isKnownLegacyRootRoleContent(content)) return "preserved" as const;
        yield* Effect.tryPromise({
          try: () => rm(path, { force: false }),
          catch: (error) => error,
        });
        return "removed" as const;
      }),
      (error) => isFsCode(error, "ENOENT"),
      () => Effect.succeed("absent" as const),
    ),
  );
}

function readRegularFile(path: string): Promise<string | undefined> {
  return Effect.runPromise(
    Effect.catchIf(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => assertNoSymlink(path), catch: (error) => error });
        const entry = yield* Effect.tryPromise({ try: () => lstat(path), catch: (error) => error });
        if (entry.isSymbolicLink() || !entry.isFile()) {
          return yield* Effect.fail(new Error(`Invalid managed path: ${path}`));
        }
        const contents = yield* Effect.tryPromise({
          try: () => readFile(path),
          catch: (error) => error,
        });
        return yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(contents),
          catch: (error) => error,
        });
      }),
      (error) => isFsCode(error, "ENOENT"),
      () => Effect.succeed(undefined),
    ),
  );
}

function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Effect.runPromise(
    Effect.map(
      Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
        catch: (error) => error,
      }),
      (digest) =>
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
}

function nativeConflict(
  path: string,
  action: "replace" | "remove",
  existing: unknown,
  desired: unknown,
  explanation: string,
): ManagedConflict {
  return {
    identity: `role-asset:${path}:${action}`,
    category: "role-asset",
    target: path,
    existing,
    desired,
    defaultDecision: "replace",
    validDecisions: ["keep", "replace", "cancel"],
    explanation,
    path,
    action,
  };
}

function nativeRoleConflict(
  projection: Readonly<{ path: string; contents: string }>,
  current: string,
  previousArtifact: ManagedArtifact | undefined,
): Effect.Effect<ManagedConflict | undefined, unknown> {
  if (current === projection.contents) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    const digest = yield* Effect.tryPromise({
      try: () => sha256(current),
      catch: (error) => error,
    });
    if (previousArtifact !== undefined && digest === previousArtifact.digest) return undefined;
    const projectedDigest = yield* Effect.tryPromise({
      try: () => sha256(projection.contents),
      catch: (error) => error,
    });
    const conflict = nativeConflict(
      projection.path,
      "replace",
      { present: true, digest },
      { present: true, digest: projectedDigest },
      previousArtifact === undefined
        ? "A pre-existing generated native role file is not recorded as managed by this installation."
        : "The managed native role file changed outside the previous HolyCodex transaction.",
    );
    return { ...conflict, validDecisions: ["replace", "cancel"] };
  });
}

function conflictDigest(conflict: ManagedConflict): string | undefined {
  if (typeof conflict.existing !== "object" || conflict.existing === null) return undefined;
  const digest = (conflict.existing as { readonly digest?: unknown }).digest;
  return typeof digest === "string" ? digest : undefined;
}
