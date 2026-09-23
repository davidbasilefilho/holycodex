// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import { readTomlPath, type TomlDocument } from "@holycodex/codex";
import {
  CAPABILITY_REGISTRY,
  ROLE_DEFINITIONS,
  NATIVE_AGENT_TYPES,
  GENERIC_BUILTIN_AGENT_TYPES,
  ROOT_ORCHESTRATION_POLICY,
  FRONTEND_WORKFLOW_POLICY,
  LIBRARIAN_CONTEXT7_POLICY,
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
  type RootOwnedAuthority,
} from "@holycodex/core";

import { assertNoSymlink, isFsCode, pathWithin } from "./paths.ts";
import { writeAtomicText } from "./storage.ts";
import type { ConflictResolver, ManagedArtifact, ManagedConflict } from "./types.ts";

export type NativeAgentProjection = Readonly<{
  name: NativeAgentType;
  taskInstruction: string;
  model: "gpt-6-luna";
  effort: string;
  description: string;
  serviceTier: "default" | "fast";
  permissions: ReturnType<typeof taskPermissionsFor>;
}>;

export type NativeAgentInstructionOptions = Readonly<{
  /** Verified Git-for-Windows Bash executable. Omit on non-Windows hosts. */
  windowsGitBashExecutable?: string;
}>;

/** Configure optional Root capabilities, the Windows shell, and model-specific guidance. */
export type RootDeveloperInstructionOptions = NativeAgentInstructionOptions &
  Readonly<{
    computerUse?: boolean;
    frontend?: boolean;
    security?: boolean;
    /** Selected Root model; Astra receives a shorter instruction projection. */
    rootModel?: RootAgentProjection["model"];
  }>;

export type RootAgentProjection = Readonly<{
  name: "root";
  description: string;
  model: "gpt-6-sol" | "gpt-6-astra";
  effort: string;
  serviceTier: "default" | "fast";
}>;

const SPECIALIST_BASELINE_POLICY = [
  "Execute one bounded Assignment through its acceptance criteria and proportional proof. Preserve unrelated work and return out-of-boundary work or material decisions to Root. Do not delegate, change Intent lifecycle, or perform external effects. Read-only Git/VCS, CI, and PR-comment inspection is allowed when relevant and within the Assignment; Git/VCS writes remain Root-only. Source mutation requires permission from the concrete task; proof and cache writes do not grant it.",
  `Return one compact, evidence-first structured outcome (${ROOT_ORCHESTRATION_POLICY.specialistOutcomes.map((outcome) => `\`${outcome}\``).join(", ")}) with ${ROOT_ORCHESTRATION_POLICY.specialistReportFields.join(", ")}.`,
].join(" ");

const ROOT_AUTHORITY_LABELS = {
  user_interaction: "user interaction",
  intent: "Intent",
  material_decisions: "material decisions",
  orchestration_lifecycle: "orchestration and lifecycle",
  integration_acceptance: "integration acceptance",
  completion: "completion",
  git_vcs: "Git/VCS writes",
  external_effects: "external effects",
  gui_browser: "GUI and browser execution",
  computer_use: "Computer Use when selected",
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
  review: "review",
  ci_release_observation: "CI or release observation",
} as const satisfies Readonly<
  Record<(typeof ROOT_ORCHESTRATION_POLICY.delegableActions)[number], string>
>;

const REVIEW_VALIDATION_PHASE_BARRIER =
  "Require Reviewer.code before VCS. Follow the canonical phase gate: implementation completes, Reviewer.code reaches a fixed point, Worker.validation runs, then Root integrates and handles VCS. Any Reviewer.code repair invalidates earlier validation, so rerun Worker.validation.";

const ROOT_EVENT_WAIT_INSTRUCTION = `Use the longest practical event wait for every routine Root wait: call ${ROOT_ORCHESTRATION_POLICY.routineWaitTool} with timeout_ms=${ROOT_ORCHESTRATION_POLICY.routineWaitMaximumTimeoutMs} (20 minutes, within the cache lifetime). Early specialist completion wakes the wait; the collective mailbox already includes all relevant agents. If the maximum wait expires while idle, call the same maximum wait again. Never use short waits, list or status polling, or message loops on idle timeout; never busy-poll or run status-only coordination loops. Batch independent lifecycle actions and stop or release specialist leaves once their accepted terminal outcomes are recorded.`;

export interface NativeAgentInstallResult {
  readonly managed_artifacts: readonly ManagedArtifact[];
  readonly preserved: readonly string[];
  readonly rollback: readonly NativeAgentRollbackEntry[];
}

export interface NativeAgentRollbackEntry {
  readonly path: string;
  readonly previous: string | undefined;
  readonly installedDigest: string | undefined;
}

export interface NativeAgentRemovalResult {
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
}

/** Inspect every canonical native-agent path without changing the filesystem. */
export async function inspectNativeAgentConflicts(
  codexHome: string,
  profile: ProfileName,
  previous: readonly ManagedArtifact[] = [],
  tier: ServiceTier = "standard",
  windowsGitBashExecutable?: string,
): Promise<readonly ManagedConflict[]> {
  const root = join(codexHome, "holycodex", "agents");
  const projections = projectNativeAgents(profile, tier).map((agent) => ({
    path: join(root, `${agent.name}.toml`),
    contents: renderNativeAgent(
      agent,
      windowsGitBashExecutable === undefined ? {} : { windowsGitBashExecutable },
    ),
  }));
  const previousByPath = new Map(
    previous.map((artifact) => [join(codexHome, artifact.path), artifact]),
  );
  const conflicts: ManagedConflict[] = [];
  for (const projection of projections) {
    const current = await readRegularFile(projection.path);
    const previousArtifact = previousByPath.get(projection.path);
    if (
      current !== undefined &&
      previousArtifact === undefined &&
      current !== projection.contents
    ) {
      throw new Error(
        `A pre-existing HolyCodex role file is not owned by this installation: ${projection.path}`,
      );
    }
    if (
      current !== undefined &&
      previousArtifact !== undefined &&
      (await sha256(current)) !== previousArtifact.digest &&
      current !== projection.contents
    ) {
      conflicts.push(
        nativeConflict(
          projection.path,
          "replace",
          { present: true, digest: await sha256(current) },
          { present: true, digest: await sha256(projection.contents) },
          "The managed native role file changed outside the previous HolyCodex transaction.",
        ),
      );
    }
  }
  for (const artifact of previous) {
    const absolute = join(codexHome, artifact.path);
    if (
      projections.some((candidate) => candidate.path === absolute) ||
      !isKnownLegacyNativePath(codexHome, absolute, artifact.path)
    ) {
      continue;
    }
    const current = await readRegularFile(absolute);
    if (current !== undefined && (await sha256(current)) !== artifact.digest) {
      conflicts.push(
        nativeConflict(
          absolute,
          "remove",
          { present: true, digest: await sha256(current) },
          { present: false },
          "The managed legacy role file changed and would be removed during reconciliation.",
        ),
      );
    }
  }
  return conflicts;
}

/** Inspect modified, recorded native-agent artifacts before removal mutates any path. */
export async function inspectNativeAgentRemovalConflicts(
  codexHome: string,
  artifacts: readonly ManagedArtifact[],
): Promise<readonly (ManagedConflict & { readonly action: "remove" })[]> {
  const root = join(codexHome, "agents");
  const managedRoot = join(codexHome, "holycodex", "agents");
  const conflicts: (ManagedConflict & { readonly action: "remove" })[] = [];
  for (const artifact of artifacts) {
    const target = join(codexHome, artifact.path);
    if (
      !pathWithin(codexHome, target) ||
      (!pathWithin(root, target) &&
        !pathWithin(managedRoot, target) &&
        target !== join(codexHome, "config.toml"))
    ) {
      continue;
    }
    const current = await readRegularFile(target);
    if (current !== undefined && (await sha256(current)) !== artifact.digest) {
      conflicts.push({
        ...nativeConflict(
          target,
          "remove",
          { present: true, digest: await sha256(current) },
          { present: false },
          "The managed native artifact changed outside HolyCodex and would be removed.",
        ),
        action: "remove",
      });
    }
  }
  return conflicts;
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
  const computerUse = options.computerUse ?? false;
  if (
    !ROOT_ORCHESTRATION_POLICY.requiresDelegation ||
    !ROOT_ORCHESTRATION_POLICY.assignmentStartAndDispatchPrecedeDelegableExecution ||
    !ROOT_ORCHESTRATION_POLICY.trivialWorkRequiresDelegation ||
    !ROOT_ORCHESTRATION_POLICY.preparatoryAndExploratoryWorkRequiresDelegation ||
    ROOT_ORCHESTRATION_POLICY.genericDirectWorkFallback ||
    ROOT_ORCHESTRATION_POLICY.directExecutionExceptions !==
      ROOT_ORCHESTRATION_POLICY.rootOwnedAuthority ||
    !ROOT_ORCHESTRATION_POLICY.codeReviewRequiredForImplementation ||
    !ROOT_ORCHESTRATION_POLICY.codeReviewRequiredBeforeVcs ||
    !ROOT_ORCHESTRATION_POLICY.externalVerificationMustBeTerminal ||
    !ROOT_ORCHESTRATION_POLICY.concreteSpecialistDispatchRequired ||
    !ROOT_ORCHESTRATION_POLICY.roleFamiliesAreLabelsOnly ||
    !ROOT_ORCHESTRATION_POLICY.missingConcreteRouteIsBlocker ||
    !ROOT_ORCHESTRATION_POLICY.normalSpawnRequiresExplicitForkTurns ||
    ROOT_ORCHESTRATION_POLICY.normalSpawnForkTurns !== "none" ||
    !ROOT_ORCHESTRATION_POLICY.normalSpawnUsesConcreteRegisteredAgentType ||
    !ROOT_ORCHESTRATION_POLICY.assignmentContextIsTaskSpecificOnly ||
    !ROOT_ORCHESTRATION_POLICY.configuredRouteModelAndEffortPreserved ||
    ROOT_ORCHESTRATION_POLICY.normalProgressMessages ||
    ROOT_ORCHESTRATION_POLICY.normalHeartbeatMessages ||
    ROOT_ORCHESTRATION_POLICY.normalIntermediateEvidence ||
    !ROOT_ORCHESTRATION_POLICY.userUpdatesUsefulOrImportantOnly ||
    !ROOT_ORCHESTRATION_POLICY.routinePerToolOrSubagentNarrationForbidden ||
    !ROOT_ORCHESTRATION_POLICY.routineStatusOnlyChatterForbidden ||
    !ROOT_ORCHESTRATION_POLICY.fixedCadenceUserUpdatesForbidden ||
    !ROOT_ORCHESTRATION_POLICY.materialUserUpdateKinds.includes(
      "significant_findings_or_decisions",
    ) ||
    !ROOT_ORCHESTRATION_POLICY.materialUserUpdateKinds.includes(
      "consequential_blockers_or_input_needs",
    ) ||
    !ROOT_ORCHESTRATION_POLICY.materialUserUpdateKinds.includes("release_milestones") ||
    !ROOT_ORCHESTRATION_POLICY.outOfBoundaryRequiresNewAssignment ||
    !ROOT_ORCHESTRATION_POLICY.longestPracticalEventWait ||
    !ROOT_ORCHESTRATION_POLICY.busyPollingForbidden ||
    !ROOT_ORCHESTRATION_POLICY.statusOnlyCoordinationLoopsForbidden ||
    !ROOT_ORCHESTRATION_POLICY.batchIndependentLifecycleActions ||
    !ROOT_ORCHESTRATION_POLICY.releaseLeavesAfterAcceptedOutcome ||
    ROOT_ORCHESTRATION_POLICY.routineWaitTool !== "collaboration.wait_agent" ||
    !Number.isSafeInteger(ROOT_ORCHESTRATION_POLICY.routineWaitMaximumTimeoutMs) ||
    ROOT_ORCHESTRATION_POLICY.routineWaitMaximumTimeoutMs <= 0 ||
    !ROOT_ORCHESTRATION_POLICY.routineWaitUsesMaximumRuntimeTimeout ||
    !ROOT_ORCHESTRATION_POLICY.earlySpecialistCompletionWakesWait ||
    !ROOT_ORCHESTRATION_POLICY.collectiveMailboxIncludesRelevantAgents ||
    !ROOT_ORCHESTRATION_POLICY.idleTimeoutRepeatsMaximumWait ||
    !ROOT_ORCHESTRATION_POLICY.shortRoutineWaitsForbidden ||
    !ROOT_ORCHESTRATION_POLICY.evidenceFirstConciseStructuredReports ||
    (ROOT_ORCHESTRATION_POLICY.specialistReportFields as readonly string[]).length === 0 ||
    (ROOT_ORCHESTRATION_POLICY.rootLargeReadsOnlyFor as readonly string[]).length === 0 ||
    !ROOT_ORCHESTRATION_POLICY.stableFactsReused ||
    !ROOT_ORCHESTRATION_POLICY.duplicatePolicyForbidden ||
    !ROOT_ORCHESTRATION_POLICY.stableBoundedComponentScopesAreCanonical ||
    !ROOT_ORCHESTRATION_POLICY.lifecycleWorkerOwnsDeterministicApi ||
    ROOT_ORCHESTRATION_POLICY.registeredSpecialistAgentTypes !== NATIVE_AGENT_TYPES ||
    ROOT_ORCHESTRATION_POLICY.forbiddenGenericAgentTypes !== GENERIC_BUILTIN_AGENT_TYPES
  ) {
    throw new Error("The Root orchestration policy is incomplete.");
  }
  if (options.rootModel === "gpt-6-astra") {
    return astraRootDeveloperInstructions(options, computerUse);
  }
  const instructions = [
    `You are the HolyCodex Root/session orchestrator. Your model and reasoning effort come from the selected Root profile. Root directly owns only ${ROOT_ORCHESTRATION_POLICY.rootOwnedAuthority.map((authority) => ROOT_AUTHORITY_LABELS[authority]).join("; ")}. These actions remain subject to their approval and capability boundaries.`,
    `Delegate every delegable action with a bounded Assignment and dispatch spawn_agent using the exact concrete registered Role.task agent_type selected from this canonical HolyCodex inventory: ${ROOT_ORCHESTRATION_POLICY.registeredSpecialistAgentTypes.join(", ")}. The role families Explorer, Librarian, Worker, and Reviewer are labels only and are never dispatch targets. Generic built-in agent_type values ${ROOT_ORCHESTRATION_POLICY.forbiddenGenericAgentTypes.join(", ")} are forbidden for HolyCodex specialist Assignments. If no matching concrete registered route is available, stop with needs_root_input; never substitute a generic agent. This includes ${ROOT_ORCHESTRATION_POLICY.delegableActions.map((action) => DELEGABLE_ACTION_LABELS[action]).join("; ")}. Starting the Assignment and dispatching its specialist must precede every such inspection or execution, including trivial, preparatory, and exploratory work. There is no generic Root direct-work fallback. Root may inspect returned evidence for integration acceptance.`,
    `For every normal specialist spawn, pass the exact concrete Role.task agent_type and explicitly set fork_turns: "${ROOT_ORCHESTRATION_POLICY.normalSpawnForkTurns}"; never omit fork_turns or use "all" or its default. Preserve the selected route's configured model and reasoning effort. Each Assignment must be self-contained with the objective, bounded scope, constraints, exclusions, dependencies, acceptance criteria, and required evidence; include only task-specific context.`,
    "Use holycodex-agent semantic operations for Intent, optional Plan, and Assignment state. Never edit TOON state or create standalone handoff, Decision, or blocker files.",
    "Explicit user instructions override skill guidelines on conflict except genuine HolyCodex hard safety, authority, capability, and lifecycle invariants. Infer routine safe, reversible, in-scope choices and carry authorized read-only, reversible, preparatory, and independent work through implementation, inspection, repair, meaningful proof, required CI, and every requested terminal state. Ask only for a material unresolved choice, a genuine approval boundary such as installation profile approval or remote/public external mutation, user-owned credential entry, or a blocker that can change the outcome; persist needs_root_input when applicable. Out-of-boundary work returns to Root for a new bounded Assignment.",
    "Dispatch independent non-overlapping Assignments concurrently, keep dependent phases ordered, and serialize writes to one mutable seam. Do not send messages to active specialists or request progress; receive their terminal results. Use writing-instructions for GPT-6 model-facing contracts, add only the missing semantic delta for the receiver's effective context, and keep each meaning with one authoritative owner.",
    "Make each phase a coherent dependency, decision, or integration boundary. Resolve choices needed by the current phase, persist Plan and Assignment evidence, and advance after acceptance; do not ask later-phase questions prematurely.",
    "Give the user only useful or important information. Do not output after every tool use or subagent update, emit routine status-only chatter or heartbeat messages, or follow a fixed update cadence. Material updates include significant findings or decisions, consequential blockers or input needs, and release milestones. Preserve native Astra Default questions, including asking while independent work proceeds; this rule adds no question protocol.",
    ROOT_EVENT_WAIT_INSTRUCTION,
    `Keep specialist and Reviewer reports concise, structured, and evidence-first: lead with ${ROOT_ORCHESTRATION_POLICY.specialistReportFields.join(", ")}. Root reads large transcripts or artifacts only for ${ROOT_ORCHESTRATION_POLICY.rootLargeReadsOnlyFor.join(", ")}; reuse stable facts, keep each meaning with one authoritative owner, and do not duplicate policy. Stable bounded component scopes are canonical guidance; the lifecycle worker owns deterministic Intent, Plan, and Assignment API decisions, while Root owns material decisions, integration, and completion.`,
    `${TESTING_POLICY.rule} Do not add tests for low-impact reversible changes when they merely mirror implementation details. Once relevant proof passes, broaden or repeat it only after another source change, a failure, or an unresolved material concern. Mandatory repository gates and Reviewer.code remain required. Inspect specialist evidence before integration; Worker.validation supplies independent local proof without replacing implementation proof or Reviewer.code. ${REVIEW_VALIDATION_PHASE_BARRIER}`,
    `For current technical documentation, Librarian.lookup and Librarian.research resolve the library identity and query Context7 narrowly before model memory or generic web, then return one typed evidence state (${LIBRARIAN_CONTEXT7_POLICY.evidenceStates.join(" | ")}) in the context7 field with version/source evidence. Web search is allowed only for these Context7 states (${LIBRARIAN_CONTEXT7_POLICY.webFallbackEvidenceStates.join(" | ")}), a missing required version, or a conflict still unresolved after checking authoritative first-party documentation; successful Context7 evidence alone never justifies fallback. Context7 supplies facts while Root owns material product, architecture, dependency, compatibility, and implementation decisions.`,
    "After integration, Root performs approved VCS writes and dispatches Worker.operations with the exact ref or SHA for terminal CI or release evidence. Specialists may inspect Git/VCS state, CI, and PR comments read-only within their Assignments. Pending is never success. Discover the actual topology; repair failures through bounded Assignments and repeat integration, fixed-point review, VCS, and terminal observation until the applicable gate is green.",
  ];
  if (options.frontend ?? true) {
    instructions.push(renderFrontendCapabilityInstruction());
  }
  if (options.security ?? true) {
    instructions.push(
      "Security is selected. Use threat-model for material trust-boundary changes, security-diff-scan before VCS for security-sensitive diffs, and full security-scan for explicit audits, substantial new exposed surfaces, or broader systemic concern. Validate supported findings before blocking. A validated vulnerability introduced or worsened by the change blocks VCS until repaired or explicitly risk-accepted; report unrelated pre-existing findings without expanding scope. Security-driven edits invalidate Reviewer.code, and security-sensitive Reviewer.code edits invalidate the applicable security review; repeat both gates until green together.",
    );
  }
  if (computerUse) {
    instructions.push(
      "Computer Use is selected and is directly executable by Root/session only; it must not be delegated.",
      "For interactive authentication, use Computer Use with the user's default browser unless the builtin browser is that default. Navigate to authentication, hand control to the user, wait while the user personally enters and submits every credential, then resume from the authenticated session. Never ask for credentials in chat or type, paste, retrieve, infer, expose, store, or submit them. If no authorized Computer Use/default-browser path exists, report the capability blocker.",
    );
  } else {
    instructions.push(
      "Computer Use is unavailable for this installation and cannot be delegated. GUI and browser execution remain Root/session-only.",
    );
  }
  if (options.windowsGitBashExecutable !== undefined) {
    instructions.push(windowsGitBashShellDirective(options.windowsGitBashExecutable));
  }
  return instructions.join("\n");
}

function astraRootDeveloperInstructions(
  options: RootDeveloperInstructionOptions,
  computerUse: boolean,
): string {
  const instructions = [
    `You are the HolyCodex Root/session orchestrator. Root owns only ${ROOT_ORCHESTRATION_POLICY.rootOwnedAuthority.map((authority) => ROOT_AUTHORITY_LABELS[authority]).join("; ")}. All actions remain subject to approval and capability boundaries.`,
    `Dispatch every delegable action as a bounded Assignment to the exact concrete registered Role.task agent_type listed here: ${ROOT_ORCHESTRATION_POLICY.registeredSpecialistAgentTypes.join(", ")}. Explorer, Librarian, Worker, and Reviewer are labels, never targets; generic built-in agent_type values ${ROOT_ORCHESTRATION_POLICY.forbiddenGenericAgentTypes.join(", ")} are forbidden. Start and dispatch before delegated inspection or execution, including preparatory, exploratory, and trivial work. If no matching route exists, stop with needs_root_input.`,
    `Every normal specialist spawn must set fork_turns: "${ROOT_ORCHESTRATION_POLICY.normalSpawnForkTurns}"; never omit it or use "all" or the default.`,
    "Use holycodex-agent semantic operations for Intent, optional Plan, and Assignment state. Do not edit TOON state or create standalone handoff, Decision, or blocker files.",
    "Follow explicit user instructions over skills except hard safety, authority, capability, and lifecycle invariants. Make routine safe, reversible, in-scope choices; carry authorized work through implementation, repair, proportional proof, and the requested terminal state. Ask only for material unresolved choices, genuine approval boundaries, user credential entry, or outcome-changing blockers. Give each specialist a self-contained Assignment with objective, bounded scope, constraints, exclusions, dependencies, acceptance criteria, and required evidence; return out-of-boundary work to Root for a new Assignment.",
    `Use the selected capabilities and relevant skills. For current technical documentation, delegate to Librarian specialists and query Context7 narrowly before model memory or generic web. Web search is allowed only for these Context7 states (${LIBRARIAN_CONTEXT7_POLICY.webFallbackEvidenceStates.join(" | ")}), a missing required version, or a conflict still unresolved after checking authoritative first-party documentation; successful Context7 evidence alone never justifies fallback. ${TESTING_POLICY.rule} ${REVIEW_VALIDATION_PHASE_BARRIER} Security-sensitive edits and reviews must remain valid together.`,
    `Report material findings, decisions, blockers, and release milestones only. Do not message active specialists or request progress; receive their terminal results. ${ROOT_EVENT_WAIT_INSTRUCTION} After integration and approved VCS writes, dispatch Worker.operations with the exact ref or SHA for terminal CI or release evidence; pending is not success.`,
  ];
  if (options.frontend ?? true) instructions.push(renderFrontendCapabilityInstruction());
  if (options.security ?? true) {
    instructions.push(
      "Security is selected. Use threat-model for material trust-boundary changes, security-diff-scan before VCS for security-sensitive diffs, and full security-scan for explicit audits, substantial new exposed surfaces, or broader systemic concern. Validate supported findings before blocking. A validated vulnerability introduced or worsened by the change blocks VCS until repaired or explicitly risk-accepted; report unrelated pre-existing findings without expanding scope.",
    );
  }
  if (computerUse) {
    instructions.push(
      "Computer Use is selected and is directly executable by Root/session only; it must not be delegated.",
      "For interactive authentication, use Computer Use with the user's default browser unless the builtin browser is that default. Navigate to authentication, hand control to the user, wait while the user personally enters and submits every credential, then resume from the authenticated session. Never ask for credentials in chat or type, paste, retrieve, infer, expose, store, or submit them. If no authorized Computer Use/default-browser path exists, report the capability blocker.",
    );
  } else {
    instructions.push(
      "Computer Use is unavailable for this installation and cannot be delegated. GUI and browser execution remain Root/session-only.",
    );
  }
  if (options.windowsGitBashExecutable !== undefined) {
    instructions.push(windowsGitBashShellDirective(options.windowsGitBashExecutable));
  }
  return instructions.join("\n");
}

function renderFrontendCapabilityInstruction(): string {
  if (
    !FRONTEND_WORKFLOW_POLICY.repositoryAndUserRequirementsPrecedePluginDefaults ||
    !FRONTEND_WORKFLOW_POLICY.specialistsOwnInspectionImplementationAndRepair ||
    !FRONTEND_WORKFLOW_POLICY.rootOwnsLiveVisualAndInteractionAcceptance ||
    !FRONTEND_WORKFLOW_POLICY.sourceChangesInvalidateRenderEvidence ||
    !FRONTEND_WORKFLOW_POLICY.specialistReportsCannotSubstituteForRootAcceptance ||
    FRONTEND_WORKFLOW_POLICY.logicOnlyChangesRequireVisualAcceptance
  ) {
    throw new Error("The Frontend workflow policy is incomplete.");
  }
  const capability = CAPABILITY_REGISTRY.frontend;
  const mappings = capability.applicability
    .map(({ skillId, appliesWhen }) => `${appliesWhen} uses ${skillId}`)
    .join("; ");
  return `Frontend is selected. For a user-visible frontend task, ${mappings}. Repository stack, existing design system, and explicit user requirements govern over generic plugin defaults. Specialists inspect, implement, and repair; Root renders, opens, and interacts with the current result, judges it against the accepted outcome, delegates concrete discrepancies, and repeats repair and live acceptance to a fixed point. Every source change invalidates earlier render evidence. Build results, specialist reports, and Reviewer.artifact cannot replace Root's acceptance of the current UI. Apply proportional responsive, accessibility, and core-interaction checks; logic-only nonvisual changes do not require visual ceremony.`;
}

/** Publish canonical native profiles while preserving foreign or modified files. */
export async function installNativeAgents(
  codexHome: string,
  profile: ProfileName,
  previous: readonly ManagedArtifact[] = [],
  tier: ServiceTier = "standard",
  windowsGitBashExecutable?: string,
  resolveConflict?: ConflictResolver,
  preResolvedConflicts: readonly ManagedConflict[] = [],
): Promise<NativeAgentInstallResult> {
  const root = join(codexHome, "holycodex", "agents");
  const preserved: string[] = [];
  const rollback: NativeAgentRollbackEntry[] = [];
  const projections = projectNativeAgents(profile, tier).map((agent) => ({
    path: join(root, `${agent.name}.toml`),
    contents: renderNativeAgent(
      agent,
      windowsGitBashExecutable === undefined ? {} : { windowsGitBashExecutable },
    ),
  }));
  const previousByPath = new Map(
    previous.map((artifact) => [join(codexHome, artifact.path), artifact]),
  );
  const currentByPath = new Map<string, string | undefined>();
  const acceptedConflicts = new Set<string>();
  const preservedConflicts = new Set<string>();
  const conflictSnapshotDigests = new Map<string, string>();
  for (const projection of projections) {
    const current = await readRegularFile(projection.path);
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
        (await sha256(current)) !== reviewedDigest
      ) {
        throw new Error(
          `The native role conflict changed after review; review the latest file and retry: ${projection.path}`,
        );
      }
      conflictSnapshotDigests.set(projection.path, reviewedDigest);
      if (preResolved.decision === "keep") preservedConflicts.add(projection.path);
      else acceptedConflicts.add(projection.path);
    }
    const previousArtifact = previousByPath.get(projection.path);
    if (
      current !== undefined &&
      previousArtifact === undefined &&
      current !== projection.contents
    ) {
      throw new Error(
        `A pre-existing HolyCodex role file is not owned by this installation: ${projection.path}`,
      );
    }
    if (current !== undefined && previousArtifact !== undefined) {
      const digest = await sha256(current);
      if (digest !== previousArtifact.digest && current !== projection.contents) {
        const conflict = nativeConflict(
          projection.path,
          "replace",
          { present: true, digest },
          { present: true, digest: await sha256(projection.contents) },
          "The managed native role file changed outside the previous HolyCodex transaction.",
        );
        const resolution =
          preResolved === undefined
            ? await resolveConflict?.(conflict)
            : preResolved.decision === "keep"
              ? "decline"
              : "accept";
        if (resolution === "cancel") {
          throw new Error(`Native-agent conflict resolution was cancelled: ${projection.path}`);
        }
        if (resolution === "accept" || resolution === "decline") {
          const reviewedDigest = await sha256(current);
          const latest = await readRegularFile(projection.path);
          if (latest === undefined || (await sha256(latest)) !== reviewedDigest) {
            throw new Error(
              `The native role conflict changed after review; review the latest file and retry: ${projection.path}`,
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
  try {
    for (const projection of projections) {
      const current = currentByPath.get(projection.path);
      const previousArtifact = previousByPath.get(projection.path);
      const reviewedDigest = conflictSnapshotDigests.get(projection.path);
      if (reviewedDigest !== undefined) {
        const latest = await readRegularFile(projection.path);
        if (latest === undefined || (await sha256(latest)) !== reviewedDigest) {
          throw new Error(
            `The native role conflict changed after review; review the latest file and retry: ${projection.path}`,
          );
        }
      }
      if (preservedConflicts.has(projection.path)) {
        if (previousArtifact !== undefined) {
          preserved.push(projection.path);
          managed_artifacts.push(previousArtifact);
        }
        continue;
      }
      if (current !== undefined && previousArtifact !== undefined) {
        const digest = await sha256(current);
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
        await writeAtomicText(projection.path, projection.contents);
        rollback.push({
          path: projection.path,
          previous: current,
          installedDigest: await sha256(projection.contents),
        });
      }
      managed_artifacts.push({
        path: relative(codexHome, projection.path).replaceAll("\\", "/"),
        digest: await sha256(projection.contents),
      });
    }
    // A legacy root role was invalid by construction. Remove it only when its
    // content carries the old HolyCodex marker; an unrelated user root role is
    // preserved.
    const legacyRoot = join(codexHome, "agents", "root.toml");
    const legacyRootContents = await readRegularFile(legacyRoot);
    const legacyRootStatus = await removeLegacyRootIfOwned(legacyRoot);
    if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
    if (legacyRootStatus === "removed" && legacyRootContents !== undefined) {
      rollback.push({ path: legacyRoot, previous: legacyRootContents, installedDigest: undefined });
    }
    for (const artifact of previous) {
      const absolute = join(codexHome, artifact.path);
      if (!projections.some((candidate) => candidate.path === absolute)) {
        if (!isKnownLegacyNativePath(codexHome, absolute, artifact.path)) {
          preserved.push(absolute);
          continue;
        }
        const preResolvedRemoval = preResolvedConflicts.find(
          (conflict) => conflict.path === absolute && conflict.action === "remove",
        );
        if (preResolvedRemoval !== undefined) {
          const current = await readRegularFile(absolute);
          const reviewedDigest = conflictDigest(preResolvedRemoval);
          if (
            current === undefined ||
            reviewedDigest === undefined ||
            (await sha256(current)) !== reviewedDigest
          ) {
            throw new Error(
              `The native role conflict changed after review; review the latest file and retry: ${absolute}`,
            );
          }
          if (preResolvedRemoval.decision === "keep") {
            preserved.push(absolute);
          } else {
            await rm(absolute, { force: false });
            rollback.push({ path: absolute, previous: current, installedDigest: undefined });
          }
          continue;
        }
        const status = await removeIfUnchanged(absolute, artifact.digest);
        if (status.status === "preserved") preserved.push(absolute);
        else if (status.previous !== undefined) {
          rollback.push({ path: absolute, previous: status.previous, installedDigest: undefined });
        }
      }
    }
    for (const artifact of previous) {
      const absolute = join(codexHome, artifact.path);
      if (
        preserved.includes(absolute) &&
        !managed_artifacts.some((candidate) => join(codexHome, candidate.path) === absolute)
      ) {
        managed_artifacts.push(artifact);
      }
    }
    return { managed_artifacts, preserved, rollback };
  } catch (error: unknown) {
    // The caller cannot receive a result when a write fails midway. Restore
    // everything already published while preserving concurrent user edits.
    await rollbackNativeAgentInstall(rollback).catch(() => undefined);
    throw error;
  }
}

/** Restore only files that still match the just-published native-agent state. */
export async function rollbackNativeAgentInstall(
  entries: readonly NativeAgentRollbackEntry[],
): Promise<NativeAgentRemovalResult> {
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const entry of [...entries].reverse()) {
    const current = await readRegularFile(entry.path);
    const unchanged =
      entry.installedDigest === undefined
        ? current === undefined
        : current !== undefined && (await sha256(current)) === entry.installedDigest;
    if (!unchanged) {
      preserved.push(entry.path);
      continue;
    }
    if (entry.previous === undefined) {
      await rm(entry.path, { force: false }).catch((error: unknown) => {
        if (!isFsCode(error, "ENOENT")) throw error;
      });
      removed.push(entry.path);
    } else {
      await writeAtomicText(entry.path, entry.previous);
    }
  }
  return { removed, preserved };
}

/** Remove only unchanged native profiles recorded as HolyCodex-owned artifacts. */
export async function removeManagedNativeAgents(
  codexHome: string,
  artifacts: readonly ManagedArtifact[],
  acceptedConflictPaths: ReadonlySet<string> = new Set(),
): Promise<NativeAgentRemovalResult> {
  const removed: string[] = [];
  const preserved: string[] = [];
  const root = join(codexHome, "agents");
  const managedRoot = join(codexHome, "holycodex", "agents");
  for (const artifact of artifacts) {
    const target = join(codexHome, artifact.path);
    if (
      !pathWithin(codexHome, target) ||
      (!pathWithin(root, target) &&
        !pathWithin(managedRoot, target) &&
        target !== join(codexHome, "config.toml"))
    ) {
      preserved.push(target);
      continue;
    }
    try {
      await assertNoSymlink(target);
      const entry = await lstat(target);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        preserved.push(target);
        continue;
      }
      const current = await readFile(target);
      if ((await sha256(current)) !== artifact.digest) {
        if (acceptedConflictPaths.has(target)) {
          await rm(target, { force: false });
          removed.push(target);
          continue;
        }
        preserved.push(target);
        continue;
      }
      await rm(target, { force: false });
      removed.push(target);
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) preserved.push(target);
    }
  }
  const legacyRoot = join(codexHome, "agents", "root.toml");
  const legacyRootStatus = await removeLegacyRootIfOwned(legacyRoot);
  if (legacyRootStatus === "removed") removed.push(legacyRoot);
  if (legacyRootStatus === "preserved") preserved.push(legacyRoot);
  return { removed, preserved };
}

/** Render one canonical native specialist profile as Codex TOML. */
export function renderNativeAgent(
  agent: NativeAgentProjection,
  instructionOptions: NativeAgentInstructionOptions = {},
): string {
  const instructions = [
    SPECIALIST_BASELINE_POLICY,
    agent.taskInstruction,
    ...(agent.permissions.sourceMutation
      ? [`Surgical mutation rule: ${SURGICAL_MUTATION_RULE}`]
      : []),
    ...(instructionOptions.windowsGitBashExecutable === undefined
      ? []
      : [windowsGitBashShellDirective(instructionOptions.windowsGitBashExecutable)]),
  ].join("\n");
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model = ${JSON.stringify(agent.model)}`,
    `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
    `service_tier = ${JSON.stringify(agent.serviceTier)}`,
    'model_reasoning_summary = "none"',
    'model_verbosity = "low"',
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    'web_search = "live"',
    `developer_instructions = ${JSON.stringify(instructions)}`,
    "",
    "[agents]",
    "enabled = false",
    "interrupt_message = false",
    "",
    "[features]",
    "context_management = true",
    "agent_message_board = false",
    "multi_agent_v2 = false",
    "multi_agent = false",
    "computer_use = false",
    "browser_use = false",
    "in_app_browser = false",
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
  ].join("\n");
}

/** Return the canonical Windows-only shell invariant after Git Bash verification. */
export function windowsGitBashShellDirective(executable?: string): string {
  if (executable === undefined || executable.trim().length === 0) {
    throw new Error("Git Bash executable is required.");
  }
  return `On Windows, use Git for Windows Bash for all shell actions. The verified executable is ${JSON.stringify(executable)}. Do not launch another Bash process when already running in that environment. Do not use PowerShell, pwsh, cmd.exe, WSL Bash, Cygwin, or unrelated MSYS shells. If the active shell is not Git for Windows Bash, report the environment mismatch instead of continuing.`;
}

/** Return the Codex sandbox mode for a concrete task, including proof-only writable tasks. */
export function nativeAgentSandboxMode(_agent: NativeAgentProjection): "workspace-write" {
  return "workspace-write";
}

/** Check the generated sandbox and command-network controls for one specialist. */
export function nativeAgentSandboxConfigurationMatches(
  agent: NativeAgentProjection,
  document: TomlDocument,
): boolean {
  return (
    document["sandbox_mode"] === "workspace-write" &&
    document["default_permissions"] === undefined &&
    readTomlPath(document, "sandbox_workspace_write.network_access") === true
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

function isKnownLegacyNativePath(
  codexHome: string,
  absolute: string,
  relativePath: string,
): boolean {
  if (relativePath === "agents/root.toml") return true;
  if (
    ROLE_DEFINITIONS.some(
      (definition) => relativePath === `holycodex/agents/${definition.role.toLowerCase()}.toml`,
    )
  ) {
    return true;
  }
  if (!pathWithin(join(codexHome, "agents"), absolute)) return false;
  return NATIVE_AGENT_TYPES.some((agentType) => {
    const [role, task] = agentType.split(".");
    const legacyName = `${role![0]!.toUpperCase()}${role!.slice(1)}.${task}.toml`;
    return relativePath === `agents/${legacyName}`;
  });
}

async function removeLegacyRootIfOwned(path: string): Promise<"removed" | "preserved" | "absent"> {
  try {
    await assertNoSymlink(path);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return "preserved";
    const content = await readFile(path, "utf8");
    if (!isKnownLegacyRootRoleContent(content)) {
      return "preserved";
    }
    await rm(path, { force: false });
    return "removed";
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return "absent";
    throw error;
  }
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    await assertNoSymlink(path);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Invalid managed path: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function removeIfUnchanged(
  path: string,
  digest: string,
): Promise<Readonly<{ status: "removed" | "preserved"; previous?: string }>> {
  try {
    await assertNoSymlink(path);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return { status: "preserved" };
    const previous = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    if ((await sha256(previous)) === digest) {
      await rm(path, { force: false });
      return { status: "removed", previous };
    }
    return { status: "preserved" };
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return { status: "removed" };
    throw error;
  }
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function conflictDigest(conflict: ManagedConflict): string | undefined {
  if (typeof conflict.existing !== "object" || conflict.existing === null) return undefined;
  const digest = (conflict.existing as { readonly digest?: unknown }).digest;
  return typeof digest === "string" ? digest : undefined;
}
