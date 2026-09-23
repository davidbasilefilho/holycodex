// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import * as Either from "effect/Either";

import {
  CliFailureEnvelopeSchema,
  CliSuccessEnvelopeSchema,
  CapabilityResultV2Schema,
  CAPABILITY_REGISTRY,
  CORE_SEMANTIC_SKILL_IDS,
  CREDENTIAL_INTERACTION_POLICY,
  Context7EvidenceSchema,
  Context7EvidenceStateSchema,
  CoreError,
  DEFAULT_CAPABILITY_SELECTIONS,
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
  EffortSchema,
  ForkTurnsSchema,
  GENERIC_BUILTIN_AGENT_TYPES,
  LegacyProfileNameSchema,
  PROFILE_CATALOG,
  NATIVE_AGENT_TYPES,
  migrateProfileName,
  ProfileNameMigrationSchema,
  ProfileNameSchema,
  ProfileSelectionSchema,
  RoleTaskSchema,
  ROLE_DEFINITIONS,
  ROUTE_KEYS,
  ROUTE_EFFORT_OVERRIDES,
  ROOT_ORCHESTRATION_PHASE_ORDER,
  ROOT_ORCHESTRATION_POLICY,
  FRONTEND_WORKFLOW_POLICY,
  LIBRARIAN_CONTEXT7_POLICY,
  NO_SOURCE_MUTATION_RULE,
  SURGICAL_MUTATION_RULE,
  SECURITY_WORKFLOW_POLICY,
  TESTING_POLICY,
  rootDirectExecutionAllowed,
  rootExecutionState,
  RootDirectExecutionExceptionSchema,
  RouteKeySchema,
  RunIdentityInputSchema,
  SPECIALIST_OUTCOME_VERSION,
  SpecialistOutcomeSchema,
  parseSpecialistOutcomeV2,
  STATE_SCHEMA_EPOCH,
  TrustIdentityInputSchema,
  canonicalIdentityUtf8,
  canonicalJson,
  canonicalJsonUtf8,
  context7RequiredForAssignment,
  composeDigestInput,
  domainSeparatedSha256,
  lookupProfile,
  lookupRoute,
  parseCliEnvelope,
  parseCapabilityResultV2,
  parseIdentityInput,
  normalizeSpecialistOutcome,
  nativeAgentTypeFor,
  parseSchemaEpochId,
  parseSpecialistOutcome,
  specialistOutcomeFromCapabilityResult,
  taskPermissionsFor,
  taskInstructionFor,
} from "./index";
import { decodeUnknown } from "./schema";

const profileNames = ["low", "default", "high"] as const;
describe("core profile catalog", () => {
  test("contains every profile with the exact Root model and effort policy", () => {
    expect(PROFILE_CATALOG.map((profile) => profile.name)).toEqual([...profileNames]);
    expect(PROFILE_CATALOG.map((profile) => profile.root)).toEqual([
      { model: "gpt-6-sol", effort: "medium" },
      { model: "gpt-6-sol", effort: "high" },
      { model: "gpt-6-astra", effort: "high" },
    ]);
    for (const profile of PROFILE_CATALOG) {
      expect(profile).not.toHaveProperty("budget");
    }
  });

  test("contains all current route slots and exact parity-floor efforts", () => {
    expect(ROUTE_EFFORT_OVERRIDES.map(({ profile, efforts }) => ({ profile, efforts }))).toEqual([
      {
        profile: "low",
        efforts: {
          "Explorer:map": "medium",
          "Explorer:lookup": "medium",
          "Explorer:trace": "high",
          "Librarian:lookup": "medium",
          "Librarian:research": "high",
          "Worker:mechanical": "high",
          "Worker:implementation": "high",
          "Worker:integration": "max",
          "Worker:operations": "high",
          "Worker:validation": "medium",
          "Worker:debugging": "high",
          "Reviewer:plan": "high",
          "Reviewer:code": "max",
          "Reviewer:artifact": "high",
        },
      },
      {
        profile: "default",
        efforts: {
          "Explorer:map": "high",
          "Explorer:lookup": "medium",
          "Explorer:trace": "xhigh",
          "Librarian:lookup": "medium",
          "Librarian:research": "xhigh",
          "Worker:mechanical": "high",
          "Worker:implementation": "xhigh",
          "Worker:integration": "max",
          "Worker:operations": "high",
          "Worker:validation": "high",
          "Worker:debugging": "xhigh",
          "Reviewer:plan": "xhigh",
          "Reviewer:code": "max",
          "Reviewer:artifact": "xhigh",
        },
      },
      {
        profile: "high",
        efforts: {
          "Explorer:map": "high",
          "Explorer:lookup": "medium",
          "Explorer:trace": "max",
          "Librarian:lookup": "medium",
          "Librarian:research": "max",
          "Worker:mechanical": "xhigh",
          "Worker:implementation": "max",
          "Worker:integration": "max",
          "Worker:operations": "xhigh",
          "Worker:validation": "xhigh",
          "Worker:debugging": "max",
          "Reviewer:plan": "max",
          "Reviewer:code": "max",
          "Reviewer:artifact": "max",
        },
      },
    ]);
    expect(ROUTE_KEYS.length).toBeGreaterThan(0);
    expect(new Set(ROUTE_KEYS).size).toBe(ROUTE_KEYS.length);
    for (const profile of PROFILE_CATALOG) {
      expect(profile.routes.map((route) => route.key)).toEqual([...ROUTE_KEYS]);
      expect(profile.routes.every((route) => route.model === "gpt-6-luna")).toBe(true);
    }

    for (const expected of ROUTE_EFFORT_OVERRIDES) {
      const profile = lookupProfile(expected.profile);
      expect(profile.ok).toBe(true);
      if (!profile.ok) {
        continue;
      }
      expect(profile.value.routes.map((route) => route.effort)).toEqual(
        ROUTE_KEYS.map((key) => expected.efforts[key]),
      );
    }
  });

  test("derives every role/task route from one capability registry", () => {
    expect(
      ROLE_DEFINITIONS.flatMap((definition) =>
        definition.tasks.map((task) => `${definition.role}:${task.name}`),
      ),
    ).toEqual([...ROUTE_KEYS]);
    expect(
      ROLE_DEFINITIONS.every(
        (definition) =>
          definition.permissions.sourceMutation === false &&
          definition.permissions.filesystem === "read-only",
      ),
    ).toBe(true);
    for (const definition of ROLE_DEFINITIONS) {
      expect(definition).not.toHaveProperty("skills");
      expect(definition).not.toHaveProperty("skill_profile");
    }
    for (const definition of ROLE_DEFINITIONS) {
      expect(definition.authority).toContain("delegated Assignment");
      expect(definition.authority).toContain("Git/VCS");
    }
    expect(ROLE_DEFINITIONS.find((definition) => definition.role === "Worker")).toMatchObject({
      capability: "task-scoped-assignment",
    });
    expect(ROLE_DEFINITIONS.find((definition) => definition.role === "Reviewer")).toMatchObject({
      capability: "task-scoped-review",
    });
    for (const definition of ROLE_DEFINITIONS) {
      for (const task of definition.tasks) {
        expect(task.permissions.network).toBe(true);
      }
    }
  });

  test("derives canonical native agent types from valid semantic routes", () => {
    expect(nativeAgentTypeFor({ role: "Explorer", task: "map" })).toBe("Explorer.map");
    expect(nativeAgentTypeFor({ role: "Worker", task: "implementation" })).toBe(
      "Worker.implementation",
    );
    expect(NATIVE_AGENT_TYPES).toContain("Worker.mechanical");
    expect(NATIVE_AGENT_TYPES).toContain("Worker.validation");
    expect(NATIVE_AGENT_TYPES).toContain("Worker.debugging");
    expect(NATIVE_AGENT_TYPES).not.toContain("Worker.research" as never);
  });

  test("keeps debugging effort and reviewer quality contracts canonical", () => {
    expect(ROUTE_EFFORT_OVERRIDES.map((override) => override.efforts["Worker:debugging"])).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
    const debuggingInstruction = taskInstructionFor({ role: "Worker", task: "debugging" });
    expect(debuggingInstruction).toContain("debugging skill");
    expect(debuggingInstruction).toContain("bounded seam");

    const reviewerInstruction = taskInstructionFor({ role: "Reviewer", task: "code" });
    expect(reviewerInstruction).toContain("canonical patch-quality rule");
    expect(reviewerInstruction).toContain("correctness, safety, compatibility, test quality");
  });

  test("grants assigned network access while bounding operations to the supplied ref", () => {
    expect(taskPermissionsFor({ role: "Worker", task: "operations" })).toEqual({
      network: true,
      filesystem: "read-only",
      sourceMutation: false,
      networkScope: "exact_ref_or_sha",
    });
    expect(taskPermissionsFor({ role: "Worker", task: "validation" })).toEqual({
      network: true,
      filesystem: "workspace-write",
      sourceMutation: false,
      networkScope: "current_sources",
    });
    expect(taskPermissionsFor({ role: "Worker", task: "debugging" })).toEqual({
      network: true,
      filesystem: "workspace-write",
      sourceMutation: true,
      networkScope: "current_sources",
    });
    for (const task of ["mechanical", "implementation", "integration"] as const) {
      expect(taskPermissionsFor({ role: "Worker", task })).toMatchObject({
        network: true,
        filesystem: "workspace-write",
        sourceMutation: true,
        networkScope: "current_sources",
      });
    }
    expect(taskPermissionsFor({ role: "Reviewer", task: "plan" })).toEqual({
      network: true,
      filesystem: "read-only",
      sourceMutation: false,
      networkScope: "current_sources",
    });
    expect(taskPermissionsFor({ role: "Librarian", task: "lookup" })).toEqual({
      network: true,
      filesystem: "read-only",
      sourceMutation: false,
      networkScope: "current_sources",
    });
    expect(NO_SOURCE_MUTATION_RULE).toContain("Do not modify repository source");
  });

  test("keeps profile route parity in the single effort policy source", () => {
    for (const profile of PROFILE_CATALOG) {
      const override = ROUTE_EFFORT_OVERRIDES.find(
        (candidate) => candidate.profile === profile.name,
      );
      expect(override).toBeDefined();
      if (!override) continue;
      expect(profile.routes.map((route) => route.model)).toEqual(
        Array(ROUTE_KEYS.length).fill("gpt-6-luna"),
      );
      expect(profile.routes.map((route) => route.effort)).toEqual(
        ROUTE_KEYS.map((key) => override.efforts[key]),
      );
      expect(profile.defaultServiceTier).toBe("standard");
    }
  });

  test("keeps capability defaults in one typed source", () => {
    expect(DEFAULT_CAPABILITY_SELECTIONS).toMatchObject({
      coding: true,
      computer_use: false,
      frontend: true,
      security: true,
    });
    expect(DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS).toEqual({
      computer_use: DEFAULT_CAPABILITY_SELECTIONS.computer_use,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
      security: DEFAULT_CAPABILITY_SELECTIONS.security,
    });
    for (const name of ["computer_use", "frontend", "security"] as const) {
      expect(CAPABILITY_REGISTRY[name].defaultSelected).toBe(DEFAULT_CAPABILITY_SELECTIONS[name]);
    }
    expect(DEFAULT_CAPABILITY_SELECTIONS).not.toHaveProperty("work");
    expect(CAPABILITY_REGISTRY).not.toHaveProperty("work");
    expect(CORE_SEMANTIC_SKILL_IDS).toEqual(["writing-instructions", "babysit-ci"]);
  });

  test("keeps public profile lookup canonical while classifying legacy state", () => {
    expect(Either.isRight(decodeUnknown(ProfileNameSchema, "default"))).toBe(true);
    expect(Either.isLeft(decodeUnknown(ProfileNameSchema, "go"))).toBe(true);
    expect(lookupProfile("default").ok).toBe(true);
    expect(lookupProfile("go").ok).toBe(false);
    expect(Either.isRight(decodeUnknown(LegacyProfileNameSchema, "Go"))).toBe(true);
    expect(Either.isRight(decodeUnknown(ProfileNameMigrationSchema, "Go"))).toBe(true);
    expect(() => migrateProfileName("Go")).toThrow(/requires an explicit replacement/u);
    expect(migrateProfileName("plus-low")).toBe("low");
    expect(migrateProfileName("plus")).toBe("default");
    expect(migrateProfileName("plus-high")).toBe("high");
    expect(() => migrateProfileName("pro-5x")).toThrow(/requires an explicit replacement/u);
  });

  test("enforces Root delegation with only the approved direct exceptions", () => {
    expect(ROOT_ORCHESTRATION_POLICY).toMatchObject({
      requiresDelegation: true,
      assignmentStartAndDispatchPrecedeDelegableExecution: true,
      trivialWorkRequiresDelegation: true,
      preparatoryAndExploratoryWorkRequiresDelegation: true,
      genericDirectWorkFallback: false,
      materialDecisionsRemainRootOwned: true,
      lifecycleRemainsRootOwned: true,
      integrationAndCompletionRemainRootOwned: true,
      codeReviewRequiredForImplementation: true,
      codeReviewRequiredBeforeVcs: true,
      externalVerificationMustBeTerminal: true,
      postVcsFlow: "discover_topology_observe_repair_repeat",
      routineSafeReversibleInScopeDecisionsProceedAutonomously: true,
      userInstructionsOverrideSkillGuidelinesExceptHardInvariants: true,
      authorizedWorkContinuesThroughRequestedTerminalState: true,
      phaseOrder: ROOT_ORCHESTRATION_PHASE_ORDER,
      phaseGates: {
        implementationLeavesTerminalBeforeReviewerCode: true,
        reviewerCodeFixedPointBeforeWorkerValidation: true,
        workerValidationBeforeRootIntegration: true,
        rootIntegrationBeforeVcs: true,
      },
      initialDispatch: {
        independentAssignments: true,
        substantiveIndependentConcurrency: true,
        routinePostdispatchSteering: false,
        collectiveWaits: true,
        evidenceReusedAcrossPhases: true,
      },
      atomicLifecycleTransitions: {
        relatedAssignmentAndIntentWrites: true,
        oneLockOneCommit: true,
        staleRevisionChecksRetained: true,
        repositoryDriftChecksRetained: true,
      },
      supersession: {
        explicitOnly: true,
        unfinishedPredecessorOnly: true,
        validatedRelatedReplacement: true,
        reasonAndProvenanceRequired: true,
        supersededExcludedFromCompletionBlockers: true,
      },
      specialistTerminalResultPersistence: {
        ownActiveInvocationCapabilityRequired: true,
        ownAssignmentOnly: true,
        terminalOutcomeOnly: true,
        rootOwnedIntentLifecycle: true,
        rootOwnedAcceptanceReviewAndCiGates: true,
        rootOwnedVcsAndExternalEffects: true,
        sharedRuntimeCallerIdentityUnavailable: true,
        legacyResultCompatibilityPreserved: true,
      },
    });
    expect(ROOT_ORCHESTRATION_PHASE_ORDER).toEqual([
      "implementation",
      "review",
      "validation",
      "integration",
      "vcs",
    ]);
    const rootOnlyActions = [
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
    ] as const;
    expect(ROOT_ORCHESTRATION_POLICY.directExecutionExceptions).toEqual(rootOnlyActions);
    expect(ROOT_ORCHESTRATION_POLICY.delegableActions).toEqual([
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
    ]);
    expect(ROOT_ORCHESTRATION_POLICY.rootOwnedAuthority).toBe(
      ROOT_ORCHESTRATION_POLICY.directExecutionExceptions,
    );
    expect(ROOT_ORCHESTRATION_POLICY.rootOwnedAuthority).toEqual(rootOnlyActions);
    expect(Either.isRight(decodeUnknown(RootDirectExecutionExceptionSchema, "git_vcs"))).toBe(true);
    expect(Either.isLeft(decodeUnknown(RootDirectExecutionExceptionSchema, "shell"))).toBe(true);
    expect(rootDirectExecutionAllowed("git_vcs")).toBe(true);
    expect(rootDirectExecutionAllowed("user_interaction")).toBe(true);
    expect(rootDirectExecutionAllowed("intent")).toBe(true);
    expect(rootDirectExecutionAllowed("material_decisions")).toBe(true);
    expect(rootDirectExecutionAllowed("orchestration_lifecycle")).toBe(true);
    expect(rootDirectExecutionAllowed("integration_acceptance")).toBe(true);
    expect(rootDirectExecutionAllowed("completion")).toBe(true);
    expect(rootDirectExecutionAllowed("external_effects")).toBe(true);
    expect(rootDirectExecutionAllowed("gui_browser")).toBe(true);
    expect(rootDirectExecutionAllowed("computer_use")).toBe(false);
    expect(rootDirectExecutionAllowed("computer_use", true)).toBe(true);
    expect(rootExecutionState()).toBe("delegated");
    expect(rootExecutionState("git_vcs")).toBe("root_direct");
    expect(rootExecutionState("computer_use")).toBe("unavailable");
    expect(rootExecutionState("computer_use", true)).toBe("root_direct");
    expect(ROOT_ORCHESTRATION_POLICY.requestUserInputGates).toEqual([
      "plan_approval",
      "installation_profile_approval",
      "remote_origin_server_vcs_mutation",
      "public_publication_or_release",
      "ambiguity_or_missing_material_input",
    ]);
    expect(ROOT_ORCHESTRATION_POLICY.surgicalMutationRule).toBe(SURGICAL_MUTATION_RULE);
    expect(SURGICAL_MUTATION_RULE).toContain("complete requested outcome correctly");
    expect(SURGICAL_MUTATION_RULE).toContain("never weaken or reinterpret it");
    expect(SURGICAL_MUTATION_RULE).toContain("smallest coherent patch");
    expect(SURGICAL_MUTATION_RULE).toContain("simple, cohesive, idiomatic solutions");
    expect(ROOT_ORCHESTRATION_POLICY.specialistOutcomes).toEqual([
      "completed",
      "blocked",
      "needs_root_input",
      "failed",
    ]);
    expect(ROOT_ORCHESTRATION_POLICY.testingPolicy).toBe(TESTING_POLICY);
    expect(TESTING_POLICY.rule).toContain(
      "smallest meaningful proof proportionate to changed behavior, scope, and risk",
    );
    expect(TESTING_POLICY.rule).toContain("repository-required gates");
    expect(TESTING_POLICY.broadenOrRepeatOnlyAfter).toEqual([
      "source_change",
      "proof_failure",
      "unresolved_material_concern",
      "change_breadth_or_risk",
    ]);
  });

  test("requires concrete registered specialist dispatch targets", () => {
    expect(ROOT_ORCHESTRATION_POLICY.concreteSpecialistDispatchRequired).toBe(true);
    expect(ROOT_ORCHESTRATION_POLICY.roleFamiliesAreLabelsOnly).toBe(true);
    expect(ROOT_ORCHESTRATION_POLICY.missingConcreteRouteIsBlocker).toBe(true);
    expect(ROOT_ORCHESTRATION_POLICY.registeredSpecialistAgentTypes).toBe(NATIVE_AGENT_TYPES);
    expect(ROOT_ORCHESTRATION_POLICY.registeredSpecialistAgentTypes).toEqual(
      ROLE_DEFINITIONS.flatMap((definition) =>
        definition.tasks.map((task) => `${definition.role}.${task.name}`),
      ) as typeof NATIVE_AGENT_TYPES,
    );
    expect(ROOT_ORCHESTRATION_POLICY.forbiddenGenericAgentTypes).toBe(GENERIC_BUILTIN_AGENT_TYPES);
    expect(ROOT_ORCHESTRATION_POLICY.forbiddenGenericAgentTypes).toEqual([
      "worker",
      "explorer",
      "reviewer",
      "librarian",
    ]);
  });

  test("keeps efficient specialist dispatch and terminal communication canonical", () => {
    expect(Either.isRight(decodeUnknown(ForkTurnsSchema, "none"))).toBe(true);
    expect(Either.isLeft(decodeUnknown(ForkTurnsSchema, "all"))).toBe(true);
    expect(ROOT_ORCHESTRATION_POLICY).toMatchObject({
      normalSpawnForkTurns: "none",
      normalSpawnRequiresExplicitForkTurns: true,
      normalSpawnUsesConcreteRegisteredAgentType: true,
      assignmentContextIsTaskSpecificOnly: true,
      configuredRouteModelAndEffortPreserved: true,
      routineWaitTool: "collaboration.wait_agent",
      routineWaitMaximumTimeoutMs: 1_200_000,
      routineWaitUsesMaximumRuntimeTimeout: true,
      earlySpecialistCompletionWakesWait: true,
      collectiveMailboxIncludesRelevantAgents: true,
      idleTimeoutRepeatsMaximumWait: true,
      shortRoutineWaitsForbidden: true,
      normalProgressMessages: false,
      normalHeartbeatMessages: false,
      normalIntermediateEvidence: false,
      userUpdatesUsefulOrImportantOnly: true,
      routinePerToolOrSubagentNarrationForbidden: true,
      routineStatusOnlyChatterForbidden: true,
      fixedCadenceUserUpdatesForbidden: true,
      outOfBoundaryRequiresNewAssignment: true,
      longestPracticalEventWait: true,
      busyPollingForbidden: true,
      statusOnlyCoordinationLoopsForbidden: true,
      batchIndependentLifecycleActions: true,
      releaseLeavesAfterAcceptedOutcome: true,
      evidenceFirstConciseStructuredReports: true,
      stableFactsReused: true,
      duplicatePolicyForbidden: true,
      stableBoundedComponentScopesAreCanonical: true,
      lifecycleWorkerOwnsDeterministicApi: true,
    });
    expect(ROOT_ORCHESTRATION_POLICY.specialistReportFields).toEqual([
      "changed paths",
      "checks",
      "observable evidence",
      "blockers",
      "Root decisions needed",
      "remaining risk",
    ]);
    expect(ROOT_ORCHESTRATION_POLICY.rootLargeReadsOnlyFor).toEqual([
      "material decisions",
      "conflicts",
      "failures",
      "findings",
    ]);
    expect(ROOT_ORCHESTRATION_POLICY.materialUserUpdateKinds).toEqual([
      "significant_findings_or_decisions",
      "consequential_blockers_or_input_needs",
      "release_milestones",
    ]);
  });

  test("keeps Context7, frontend, credential, and security policies typed and canonical", () => {
    for (const state of LIBRARIAN_CONTEXT7_POLICY.evidenceStates) {
      expect(Either.isRight(decodeUnknown(Context7EvidenceStateSchema, state))).toBe(true);
      expect(
        Either.isRight(
          decodeUnknown(Context7EvidenceSchema, {
            state,
            evidence: [`Context7 ${state} evidence`],
          }),
        ),
      ).toBe(true);
    }
    expect(
      Either.isLeft(decodeUnknown(Context7EvidenceSchema, { state: "used", evidence: [] })),
    ).toBe(true);
    expect(
      Either.isRight(
        decodeUnknown(Context7EvidenceSchema, {
          state: "used",
          evidence: ["ctx7 package docs, version 4.2"],
          library: "example",
          version: "4.2",
        }),
      ),
    ).toBe(true);
    expect(LIBRARIAN_CONTEXT7_POLICY.resolveIdentityBeforeQuery).toBe(true);
    expect(LIBRARIAN_CONTEXT7_POLICY.webFallbackEvidenceStates).toEqual([
      "no_coverage",
      "unavailable",
      "auth_or_quota_failure",
    ]);
    expect(LIBRARIAN_CONTEXT7_POLICY.successfulEvidenceAloneAllowsFallback).toBe(false);
    expect(LIBRARIAN_CONTEXT7_POLICY.missingRequiredVersionAllowsFallback).toBe(true);
    expect(LIBRARIAN_CONTEXT7_POLICY.checkFirstPartyDocsBeforeFallbackForConflict).toBe(true);
    expect(LIBRARIAN_CONTEXT7_POLICY.unresolvedConflictAfterFirstPartyAllowsFallback).toBe(true);
    expect(FRONTEND_WORKFLOW_POLICY.sourceChangesInvalidateRenderEvidence).toBe(true);
    expect(FRONTEND_WORKFLOW_POLICY.rootOwnsLiveVisualAndInteractionAcceptance).toBe(true);
    expect(CREDENTIAL_INTERACTION_POLICY.credentialEntryAndSubmissionRemainUserOwned).toBe(true);
    expect(CREDENTIAL_INTERACTION_POLICY.agentsMustNeverHandleCredentials).toBe(true);
    expect(SECURITY_WORKFLOW_POLICY.securityDiffScanRequiredForSecuritySensitiveDiffs).toBe(true);
    expect(SECURITY_WORKFLOW_POLICY.securityEditsInvalidateCodeReview).toBe(true);
    expect(SECURITY_WORKFLOW_POLICY.securitySensitiveCodeReviewEditsInvalidateSecurityReview).toBe(
      true,
    );
  });

  test("ties Context7 requirements to Librarian Assignment semantics", () => {
    const technical = {
      role: "Librarian" as const,
      task: "lookup",
      objective: "Resolve the current React API documentation",
      scope: [],
      constraints: [],
      exclusions: [],
      dependencies: [],
      acceptanceCriteria: ["Return the version and source evidence"],
    };
    expect(context7RequiredForAssignment(technical)).toBe(true);
    expect(
      context7RequiredForAssignment({
        ...technical,
        objective: "Find a historical fact about an author",
      }),
    ).toBe(false);
    expect(
      context7RequiredForAssignment({
        ...technical,
        role: "Explorer",
        objective: "Trace the current API implementation in the repository",
      }),
    ).toBe(false);
  });
});

describe("core route and boundary schemas", () => {
  test("owns capability registry references and one V2 result boundary", () => {
    expect(CAPABILITY_REGISTRY.frontend.semanticSkillIds).toEqual([
      "build-web-apps:frontend-app-builder",
      "build-web-apps:frontend-testing-debugging",
      "build-web-apps:react-best-practices",
    ]);
    expect(CAPABILITY_REGISTRY.frontend.applicability).toEqual([
      {
        skillId: "build-web-apps:frontend-app-builder",
        appliesWhen: "a new visually-driven UI or meaningful redesign",
      },
      {
        skillId: "build-web-apps:frontend-testing-debugging",
        appliesWhen: "a rendered UI or interaction defect",
      },
      {
        skillId: "build-web-apps:react-best-practices",
        appliesWhen: "a relevant React or Next implementation or review",
      },
    ]);
    expect(CAPABILITY_REGISTRY.frontend.semanticSkillIds).toEqual(
      CAPABILITY_REGISTRY.frontend.applicability.map(({ skillId }) => skillId),
    );
    const result = {
      protocol_version: SPECIALIST_OUTCOME_VERSION,
      capability: "frontend",
      route: { role: "Worker", task: "implementation" },
      evidence: ["verified"],
      data: { accepted: true },
      status: "completed",
      summary: "frontend completed",
    } as const;
    expect(Either.isRight(decodeUnknown(CapabilityResultV2Schema, result))).toBe(true);
    const parsed = parseCapabilityResultV2(result);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const capability of ["removed_capability", "unknown_capability"] as const) {
      expect(
        Either.isRight(decodeUnknown(CapabilityResultV2Schema, { ...result, capability })),
      ).toBe(false);
    }
    const normalized = specialistOutcomeFromCapabilityResult(parsed.value, "frontend", {
      role: "Worker",
      task: "implementation",
    });
    expect(normalized.ok).toBe(true);
    expect(normalized.ok && normalized.value.status).toBe("completed");
  });

  test("preserves stable error codes, safe details, and causes", () => {
    const cause = new Error("schema detail");
    const error = new CoreError("invalid_input", "Invalid input.", { field: "profile" }, { cause });
    expect(error.code).toBe("invalid_input");
    expect(error.details).toEqual({ field: "profile" });
    expect(error.cause).toBe(cause);
  });

  test("rejects invalid profiles, routes, and role/task combinations", () => {
    const invalidProfile = lookupProfile("turbo");
    expect(invalidProfile.ok).toBe(false);
    if (!invalidProfile.ok) {
      expect(invalidProfile.error.code).toBe("invalid_profile");
    }

    const invalidRoute = lookupRoute("default", "Worker:lookup");
    expect(invalidRoute.ok).toBe(false);
    if (!invalidRoute.ok) {
      expect(invalidRoute.error.code).toBe("invalid_route");
    }

    const removedGoRoute = lookupRoute("go", "Worker:implementation");
    expect(removedGoRoute.ok).toBe(false);

    expect(
      Either.isRight(decodeUnknown(RoleTaskSchema, { role: "Worker", task: "implementation" })),
    ).toBe(true);
    expect(Either.isLeft(decodeUnknown(RoleTaskSchema, { role: "Worker", task: "research" }))).toBe(
      true,
    );
    expect(Either.isRight(decodeUnknown(RouteKeySchema, "Reviewer:artifact"))).toBe(true);
    expect(Either.isLeft(decodeUnknown(RouteKeySchema, "Reviewer:research"))).toBe(true);
  });

  test("accepts and rejects external profile selections and identities", () => {
    expect(Either.isRight(decodeUnknown(ProfileNameSchema, "default"))).toBe(true);
    expect(Either.isLeft(decodeUnknown(ProfileNameSchema, "pro-20x"))).toBe(true);
    expect(Either.isRight(decodeUnknown(EffortSchema, "xhigh"))).toBe(true);
    expect(Either.isRight(decodeUnknown(EffortSchema, "max"))).toBe(true);
    expect(
      Either.isRight(
        decodeUnknown(ProfileSelectionSchema, { profile: "default", service_tier: "fast" }),
      ),
    ).toBe(true);
    expect(
      Either.isRight(
        decodeUnknown(ProfileSelectionSchema, { profile: "default", service_tier: "fast-all" }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeUnknown(ProfileSelectionSchema, { profile: "default", service_tier: "Turbo" }),
      ),
    ).toBe(true);

    const digest = "a".repeat(64);
    expect(
      Either.isRight(
        decodeUnknown(RunIdentityInputSchema, {
          run_id: "run-1",
          objective_lineage: "lineage-1",
          parent_run_id: null,
        }),
      ),
    ).toBe(true);
    expect(
      Either.isRight(
        decodeUnknown(TrustIdentityInputSchema, {
          project_id: "project-1",
          trust_id: "trust-1",
          trust_digest: digest,
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeUnknown(RunIdentityInputSchema, {
          run_id: "run-1",
          objective_lineage: "lineage-1",
          token: "secret",
        }),
      ),
    ).toBe(true);
    expect(parseIdentityInput({ run_id: "run-1", objective_lineage: "lineage-1" }).ok).toBe(true);
  });

  test("validates schema epochs and structured specialist outcomes", () => {
    expect(parseSchemaEpochId(STATE_SCHEMA_EPOCH).ok).toBe(true);
    const invalidEpoch = parseSchemaEpochId("state-latest");
    expect(invalidEpoch.ok).toBe(false);
    if (!invalidEpoch.ok) {
      expect(invalidEpoch.error.code).toBe("invalid_schema_epoch");
    }

    const outcome = {
      blocked: false,
      changed_files: ["packages/core/src/index.ts"],
      confidence: 0.95,
      context_owner: null,
      material_findings: [],
      needs_more_context: false,
      needs_root_decision: false,
      needs_verification: false,
      relevant_files: ["packages/core/src/index.test.ts"],
      remaining_risk: [],
      reuse_recommended: false,
      status: "completed",
      suggested_followup: null,
      suggested_luna_effort: "high",
      suggested_specialist: "Reviewer",
      verification: ["bun test"],
      verification_passed: true,
    };
    expect(Either.isRight(decodeUnknown(SpecialistOutcomeSchema, outcome))).toBe(true);
    expect(parseSpecialistOutcome({ ...outcome, status: "unknown" }).ok).toBe(false);
  });

  test("parses every SpecialistOutcome v2 terminal variant", () => {
    const common = {
      protocol_version: SPECIALIST_OUTCOME_VERSION,
      route: { role: "Worker", task: "implementation" },
      evidence: ["focused core test"],
    };
    const outcomes = [
      { ...common, status: "completed", summary: "Implemented the boundary." },
      { ...common, status: "blocked", reason: "Needs a root decision.", needs_root_decision: true },
      {
        ...common,
        status: "partial",
        summary: "Implemented the boundary.",
        completed: ["schema"],
        remaining: ["consumer migration"],
        needs_root_decision: false,
      },
      { ...common, status: "failed", error: "Test command failed." },
    ];

    for (const outcome of outcomes) {
      expect(parseSpecialistOutcomeV2(outcome).ok).toBe(true);
    }
    expect(
      parseSpecialistOutcomeV2({
        ...common,
        route: { role: "Librarian", task: "lookup" },
        context7: { state: "used", evidence: ["React 19 Context7 documentation"] },
        status: "completed",
        summary: "Current technical fact resolved.",
      }).ok,
    ).toBe(true);
    expect(
      parseSpecialistOutcomeV2({
        ...common,
        status: "failed",
        error: "Test command failed.",
        retryable: true,
      }).ok,
    ).toBe(false);
  });

  test("rejects invalid SpecialistOutcome v2 routes and terminal fields", () => {
    const common = {
      protocol_version: SPECIALIST_OUTCOME_VERSION,
      route: { role: "Worker", task: "research" },
      evidence: [],
      status: "completed",
      summary: "Implemented the boundary.",
    };
    expect(parseSpecialistOutcomeV2(common).ok).toBe(false);

    const completed = {
      protocol_version: SPECIALIST_OUTCOME_VERSION,
      route: { role: "Worker", task: "implementation" },
      evidence: [],
      status: "completed",
      summary: "Implemented the boundary.",
    };
    expect(parseSpecialistOutcomeV2({ ...completed, reason: "contradictory" }).ok).toBe(false);
    expect(
      parseSpecialistOutcomeV2({
        ...completed,
        status: "failed",
        error: "contradictory",
        retryable: false,
        summary: undefined,
      }).ok,
    ).toBe(false);
    expect(parseSpecialistOutcomeV2({ ...completed, protocol_version: "legacy" }).ok).toBe(false);
    expect(parseSpecialistOutcomeV2({ ...completed, summary: "" }).ok).toBe(false);
  });

  test("normalizes legacy outcomes only for the expected route", () => {
    const route = { role: "Worker" as const, task: "implementation" as const };
    const legacy = {
      blocked: false,
      changed_files: ["changed"],
      confidence: 0.5,
      context_owner: "legacy",
      material_findings: ["finding", "duplicate"],
      needs_more_context: true,
      needs_root_decision: true,
      needs_verification: true,
      relevant_files: ["relevant", "duplicate"],
      remaining_risk: ["risk"],
      reuse_recommended: true,
      status: "completed" as const,
      suggested_followup: null,
      suggested_luna_effort: "high" as const,
      suggested_specialist: "Reviewer" as const,
      verification: ["verified", "duplicate"],
      verification_passed: false,
    };
    expect(normalizeSpecialistOutcome(legacy, route)).toEqual({
      ok: true,
      value: {
        protocol_version: SPECIALIST_OUTCOME_VERSION,
        route,
        evidence: ["relevant", "duplicate", "verified", "finding"],
        status: "completed",
        summary: "finding",
      },
    });

    const variants = [
      {
        status: "blocked" as const,
        blocked: true,
        suggested_followup: "follow up",
        remaining_risk: ["risk"],
        expected: {
          status: "blocked" as const,
          reason: "follow up",
          needs_root_decision: true,
        },
      },
      {
        status: "partial" as const,
        suggested_followup: null,
        material_findings: [],
        remaining_risk: ["remaining"],
        expected: {
          status: "partial" as const,
          summary: "Partially completed assigned work.",
          completed: ["changed"],
          remaining: ["remaining"],
          needs_root_decision: true,
        },
      },
      {
        status: "failed" as const,
        suggested_followup: null,
        remaining_risk: ["failure risk"],
        expected: { status: "failed" as const, error: "failure risk" },
      },
    ];
    for (const variant of variants) {
      const { expected, ...legacyVariant } = variant;
      const result = normalizeSpecialistOutcome({ ...legacy, ...legacyVariant }, route);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject(expected);
      }
    }

    const v2 = {
      protocol_version: SPECIALIST_OUTCOME_VERSION,
      route,
      evidence: [],
      status: "completed" as const,
      summary: "done",
    };
    expect(normalizeSpecialistOutcome(v2, route).ok).toBe(true);
    expect(
      normalizeSpecialistOutcome({ ...legacy, blocked: true, status: "completed" }, route).ok,
    ).toBe(false);
    expect(
      normalizeSpecialistOutcome({ ...v2, route: { role: "Worker", task: "integration" } }, route)
        .ok,
    ).toBe(false);
  });
});

describe("core CLI envelopes", () => {
  test("validates versioned success and failure envelopes", () => {
    const successEnvelope = {
      schema_version: "0.15",
      ok: true,
      command: "doctor",
      data: {},
      warnings: [],
    };
    const failureEnvelope = {
      schema_version: "0.15",
      ok: false,
      command: "doctor",
      error: { code: "permission_denied", message: "Permission denied.", details: {} },
      warnings: ["read-only"],
    };
    expect(Either.isRight(decodeUnknown(CliSuccessEnvelopeSchema, successEnvelope))).toBe(true);
    expect(Either.isRight(decodeUnknown(CliFailureEnvelopeSchema, failureEnvelope))).toBe(true);
    expect(parseCliEnvelope(successEnvelope).ok).toBe(true);
    expect(parseCliEnvelope({ ...successEnvelope, ok: false }).ok).toBe(false);
    expect(parseCliEnvelope({ ...failureEnvelope, schema_version: "0.14" }).ok).toBe(false);
  });
});

describe("core canonical identity and hashing", () => {
  test("sorts object keys and emits UTF-8", () => {
    const canonical = canonicalJson({ z: 1, a: [true, null, "x"] });
    expect(canonical).toBe('{"a":[true,null,"x"],"z":1}');
    expect(new TextDecoder().decode(canonicalJsonUtf8({ b: 2, a: 1 }))).toBe('{"a":1,"b":2}');
  });

  test("rejects cycles, non-finite values, and non-JSON values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const invalidValues: readonly unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => undefined,
      Symbol("secret"),
      new Date(0),
      cyclic,
    ];
    for (const value of invalidValues) {
      expect(() => canonicalJson(value)).toThrowError(CoreError);
    }
    expect(() => canonicalJson({ token: undefined })).toThrowError(CoreError);
    expect(() => canonicalJson([undefined, 1])).toThrowError(CoreError);
  });

  test("keeps identity records limited to digests and hashes deterministically", async () => {
    const digest = "b".repeat(64);
    const identity = { project_id: "project-1", project_digest: digest };
    const sameIdentity = { project_digest: digest, project_id: "project-1" };
    expect(new TextDecoder().decode(canonicalIdentityUtf8(identity))).toBe(
      `{"project_digest":"${digest}","project_id":"project-1"}`,
    );
    expect(() => canonicalIdentityUtf8({ ...identity, token: "secret" })).toThrowError(CoreError);

    const first = await domainSeparatedSha256("identity", [canonicalJsonUtf8(identity)]);
    const same = await domainSeparatedSha256("identity", [canonicalJsonUtf8(sameIdentity)]);
    const otherDomain = await domainSeparatedSha256("other", [canonicalJsonUtf8(identity)]);
    const otherParts = await domainSeparatedSha256("identity", [
      new Uint8Array([1]),
      new Uint8Array([2]),
    ]);
    expect(first).toBe(same);
    expect(first).not.toBe(otherDomain);
    expect(first).not.toBe(otherParts);
    expect(composeDigestInput("identity", [new Uint8Array([1, 2])])).not.toEqual(
      composeDigestInput("identity", [new Uint8Array([1]), new Uint8Array([2])]),
    );
  });
});
