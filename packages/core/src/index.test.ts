// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import * as Either from "effect/Either";

import {
  CliFailureEnvelopeSchema,
  CliSuccessEnvelopeSchema,
  CapabilityResultV2Schema,
  CAPABILITY_REGISTRY,
  CoreError,
  DEFAULT_CAPABILITY_SELECTIONS,
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
  EffortSchema,
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
  ROOT_ORCHESTRATION_POLICY,
  SURGICAL_MUTATION_RULE,
  rootDelegationRequired,
  rootDirectExecutionAllowed,
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
} from "./index";
import { decodeUnknown } from "./schema";

const profileNames = ["low", "default", "high"] as const;
const expectedRouteEffortsByProfile = [
  {
    profile: "low",
    efforts: [
      "medium",
      "high",
      "medium",
      "high",
      "high",
      "high",
      "max",
      "high",
      "high",
      "max",
      "high",
    ],
  },
  {
    profile: "default",
    efforts: [
      "medium",
      "xhigh",
      "medium",
      "xhigh",
      "high",
      "xhigh",
      "max",
      "high",
      "xhigh",
      "max",
      "xhigh",
    ],
  },
  {
    profile: "high",
    efforts: [
      "medium",
      "max",
      "medium",
      "max",
      "xhigh",
      "max",
      "max",
      "xhigh",
      "max",
      "max",
      "max",
    ],
  },
] as const;

describe("core profile catalog", () => {
  test("contains every profile with Astra routing and reasoning policy", () => {
    expect(PROFILE_CATALOG.map((profile) => profile.name)).toEqual([...profileNames]);
    expect(PROFILE_CATALOG.map((profile) => profile.root)).toEqual([
      { model: "gpt-6-astra", effort: "low" },
      { model: "gpt-6-astra", effort: "medium" },
      { model: "gpt-6-astra", effort: "high" },
    ]);
    for (const profile of PROFILE_CATALOG) {
      expect(profile).not.toHaveProperty("budget");
    }
  });

  test("contains all eleven route slots and exact parity-floor efforts", () => {
    expect(ROUTE_KEYS).toHaveLength(11);
    expect(new Set(ROUTE_KEYS).size).toBe(11);
    for (const profile of PROFILE_CATALOG) {
      expect(profile.routes.map((route) => route.key)).toEqual([...ROUTE_KEYS]);
      expect(profile.routes.every((route) => route.model === "gpt-5.6-luna")).toBe(true);
    }

    expect(PROFILE_CATALOG[0]?.routes.map((route) => route.effort)).toEqual([
      "medium",
      "high",
      "medium",
      "high",
      "high",
      "high",
      "max",
      "high",
      "high",
      "max",
      "high",
    ]);

    for (const expected of expectedRouteEffortsByProfile) {
      const profile = lookupProfile(expected.profile);
      expect(profile.ok).toBe(true);
      if (!profile.ok) {
        continue;
      }
      expect(profile.value.routes.map((route) => route.effort)).toEqual([...expected.efforts]);
    }
  });

  test("derives every role/task route from one capability registry", () => {
    expect(
      ROLE_DEFINITIONS.flatMap((definition) =>
        definition.tasks.map((task) => `${definition.role}:${task.name}`),
      ),
    ).toEqual([...ROUTE_KEYS]);
    expect(ROLE_DEFINITIONS.map((definition) => definition.permissions.write)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    for (const definition of ROLE_DEFINITIONS) {
      expect(definition).not.toHaveProperty("skills");
      expect(definition).not.toHaveProperty("skill_profile");
    }
    for (const definition of ROLE_DEFINITIONS.filter((candidate) => candidate.permissions.write)) {
      expect(definition.authority).toContain("delegated Assignment");
      expect(definition.authority).toContain("Git/VCS");
    }
  });

  test("derives canonical native agent types from valid semantic routes", () => {
    expect(nativeAgentTypeFor({ role: "Worker", task: "implementation" })).toBe(
      "Worker.implementation",
    );
    expect(NATIVE_AGENT_TYPES).toContain("Worker.mechanical");
    expect(NATIVE_AGENT_TYPES).not.toContain("Worker.research" as never);
  });

  test("grants network only to the exact-ref operations task", () => {
    expect(taskPermissionsFor({ role: "Worker", task: "operations" })).toEqual({
      network: true,
      write: true,
      networkScope: "exact_ref_or_sha",
    });
    for (const task of ["mechanical", "implementation", "integration"] as const) {
      expect(taskPermissionsFor({ role: "Worker", task })).toEqual({
        network: false,
        write: true,
        networkScope: "disabled",
      });
    }
    expect(taskPermissionsFor({ role: "Librarian", task: "lookup" })).toEqual({
      network: true,
      write: false,
      networkScope: "current_sources",
    });
  });

  test("keeps profile route parity in the single effort policy source", () => {
    for (const profile of PROFILE_CATALOG) {
      const override = ROUTE_EFFORT_OVERRIDES.find(
        (candidate) => candidate.profile === profile.name,
      );
      expect(override).toBeDefined();
      if (!override) continue;
      expect(profile.routes.map((route) => route.model)).toEqual(
        Array(ROUTE_KEYS.length).fill("gpt-5.6-luna"),
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
      work: false,
      frontend: true,
      security: true,
    });
    expect(DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS).toEqual({
      computer_use: DEFAULT_CAPABILITY_SELECTIONS.computer_use,
      work: DEFAULT_CAPABILITY_SELECTIONS.work,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
      security: DEFAULT_CAPABILITY_SELECTIONS.security,
    });
    for (const name of ["computer_use", "work", "frontend", "security"] as const) {
      expect(CAPABILITY_REGISTRY[name].defaultSelected).toBe(DEFAULT_CAPABILITY_SELECTIONS[name]);
    }
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
      trivialWorkRequiresDelegation: true,
      materialDecisionsRemainRootOwned: true,
      lifecycleRemainsRootOwned: true,
      integrationAndCompletionRemainRootOwned: true,
      codeReviewRequiredForImplementation: true,
      codeReviewRequiredBeforeVcs: true,
      externalVerificationMustBeTerminal: true,
      postVcsFlow: "discover_topology_observe_repair_repeat",
    });
    expect(ROOT_ORCHESTRATION_POLICY.directExecutionExceptions).toEqual([
      "git_vcs",
      "computer_use",
    ]);
    expect(Either.isRight(decodeUnknown(RootDirectExecutionExceptionSchema, "git_vcs"))).toBe(true);
    expect(Either.isLeft(decodeUnknown(RootDirectExecutionExceptionSchema, "shell"))).toBe(true);
    expect(rootDirectExecutionAllowed("git_vcs")).toBe(true);
    expect(rootDirectExecutionAllowed("computer_use")).toBe(false);
    expect(rootDirectExecutionAllowed("computer_use", true)).toBe(true);
    expect(rootDelegationRequired()).toBe(true);
    expect(rootDelegationRequired("git_vcs")).toBe(false);
    expect(rootDelegationRequired("computer_use")).toBe(true);
    expect(rootDelegationRequired("computer_use", true)).toBe(false);
    expect(ROOT_ORCHESTRATION_POLICY.requestUserInputGates).toEqual([
      "plan_approval",
      "installation_profile_approval",
      "remote_origin_server_vcs_mutation",
      "public_publication_or_release",
      "ambiguity_or_missing_material_input",
    ]);
    expect(ROOT_ORCHESTRATION_POLICY.surgicalMutationRule).toBe(SURGICAL_MUTATION_RULE);
    expect(SURGICAL_MUTATION_RULE).toContain("smallest complete edit set");
    expect(ROOT_ORCHESTRATION_POLICY.specialistOutcomes).toEqual([
      "completed",
      "blocked",
      "needs_root_input",
      "failed",
    ]);
  });
});

describe("core route and boundary schemas", () => {
  test("owns capability registry references and one V2 result boundary", () => {
    expect(CAPABILITY_REGISTRY.frontend.semanticSkillIds).toEqual([
      "build-web-apps:frontend-app-builder",
      "build-web-apps:frontend-testing-debugging",
      "build-web-apps:react-best-practices",
    ]);
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
