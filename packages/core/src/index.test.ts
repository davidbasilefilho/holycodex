// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { describe, expect, test } from "vite-plus/test";
import {
  CliFailureEnvelopeSchema,
  CliSuccessEnvelopeSchema,
  CoreError,
  EffortSchema,
  PLAN_CATALOG,
  PlanNameSchema,
  PlanSelectionSchema,
  RoleTaskSchema,
  ROUTE_KEYS,
  RouteKeySchema,
  RunIdentityInputSchema,
  SpecialistOutcomeSchema,
  STATE_SCHEMA_EPOCH,
  TrustIdentityInputSchema,
  canonicalIdentityUtf8,
  canonicalJson,
  canonicalJsonUtf8,
  composeDigestInput,
  domainSeparatedSha256,
  lookupPlan,
  lookupRoute,
  parseCliEnvelope,
  parseIdentityInput,
  parseSchemaEpochId,
  parseSpecialistOutcome,
} from "./index";

const planNames = ["Go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"] as const;

describe("core plan catalog", () => {
  test("contains every frozen plan and exact budgets", () => {
    expect(PLAN_CATALOG.map((plan) => plan.name)).toEqual(planNames);
    expect(PLAN_CATALOG[0]).toMatchObject({
      name: "Go",
      root: { model: "Terra", effort: "high" },
      workflowEnabled: false,
      budget: null,
    });

    expect(PLAN_CATALOG.slice(1).map((plan) => plan.budget)).toEqual([
      { costTarget: 1.0, costMax: 1.5, maxCalls: 10, maxConcurrency: 3 },
      { costTarget: 1.6, costMax: 2.5, maxCalls: 16, maxConcurrency: 3 },
      { costTarget: 3.0, costMax: 4.5, maxCalls: 24, maxConcurrency: 4 },
      { costTarget: 5.0, costMax: 7.5, maxCalls: 40, maxConcurrency: 6 },
      { costTarget: 12.0, costMax: 20.0, maxCalls: 64, maxConcurrency: 8 },
    ]);
    expect(PLAN_CATALOG.map((plan) => plan.root)).toEqual([
      { model: "Terra", effort: "high" },
      { model: "Sol", effort: "low" },
      { model: "Sol", effort: "medium" },
      { model: "Sol", effort: "high" },
      { model: "Sol", effort: "high" },
      { model: "Sol", effort: "xhigh" },
    ]);
  });

  test("contains all eleven route slots and the frozen Plus efforts", () => {
    expect(ROUTE_KEYS).toHaveLength(11);
    expect(new Set(ROUTE_KEYS).size).toBe(11);
    for (const plan of PLAN_CATALOG.slice(1)) {
      expect(plan.routes.map((route) => route.key)).toEqual(ROUTE_KEYS);
      expect(plan.routes.every((route) => route.model === "Luna")).toBe(true);
    }

    const plus = lookupPlan("plus");
    expect(plus.ok).toBe(true);
    if (!plus.ok) {
      return;
    }
    expect(plus.value.routes.map((route) => route.effort)).toEqual([
      "medium",
      "high",
      "medium",
      "high",
      "high",
      "xhigh",
      "xhigh",
      "high",
      "high",
      "xhigh",
      "high",
    ]);
  });

  test("deep-freezes catalog values", () => {
    expect(Object.isFrozen(PLAN_CATALOG)).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG[2])).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG[2]?.root)).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG[2]?.budget)).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG[2]?.routes)).toBe(true);
    expect(Object.isFrozen(PLAN_CATALOG[2]?.routes[0])).toBe(true);

    const plan = PLAN_CATALOG[2];
    if (!plan) {
      return;
    }
    expect(Reflect.set(plan, "name", "Go")).toBe(false);
    expect(Reflect.set(plan.routes[0] ?? {}, "effort", "low")).toBe(false);
  });
});

describe("core route and boundary schemas", () => {
  test("preserves stable error codes, safe details, and causes", () => {
    const cause = new Error("schema detail");
    const error = new CoreError("invalid_input", "Invalid input.", { field: "plan" }, { cause });
    expect(error.code).toBe("invalid_input");
    expect(error.details).toEqual({ field: "plan" });
    expect(error.cause).toBe(cause);
  });

  test("rejects invalid plans, routes, and role/task combinations", () => {
    const invalidPlan = lookupPlan("turbo");
    expect(invalidPlan.ok).toBe(false);
    if (!invalidPlan.ok) {
      expect(invalidPlan.error.code).toBe("invalid_plan");
    }

    const invalidRoute = lookupRoute("plus", "Worker:lookup");
    expect(invalidRoute.ok).toBe(false);
    if (!invalidRoute.ok) {
      expect(invalidRoute.error.code).toBe("invalid_route");
    }

    const disabledRoute = lookupRoute("Go", "Worker:implementation");
    expect(disabledRoute.ok).toBe(false);
    if (!disabledRoute.ok) {
      expect(disabledRoute.error.code).toBe("route_unavailable");
    }

    expect(RoleTaskSchema({ role: "Worker", task: "implementation" })).not.toBeInstanceOf(
      type.errors,
    );
    expect(RoleTaskSchema({ role: "Worker", task: "research" })).toBeInstanceOf(type.errors);
    expect(RouteKeySchema("Reviewer:artifact")).not.toBeInstanceOf(type.errors);
    expect(RouteKeySchema("Reviewer:research")).toBeInstanceOf(type.errors);
  });

  test("accepts and rejects external plan selections and identities", () => {
    expect(PlanNameSchema("pro-20x")).not.toBeInstanceOf(type.errors);
    expect(PlanNameSchema("pro")).toBeInstanceOf(type.errors);
    expect(EffortSchema("xhigh")).not.toBeInstanceOf(type.errors);
    expect(EffortSchema("max")).not.toBeInstanceOf(type.errors);
    expect(PlanSelectionSchema({ plan: "plus", service_tier: "Fast" })).not.toBeInstanceOf(
      type.errors,
    );
    expect(PlanSelectionSchema({ plan: "plus", service_tier: "Turbo" })).toBeInstanceOf(
      type.errors,
    );

    const digest = "a".repeat(64);
    expect(
      RunIdentityInputSchema({
        run_id: "run-1",
        objective_lineage: "lineage-1",
        parent_run_id: null,
      }),
    ).not.toBeInstanceOf(type.errors);
    expect(
      TrustIdentityInputSchema({
        project_id: "project-1",
        trust_id: "trust-1",
        trust_digest: digest,
      }),
    ).not.toBeInstanceOf(type.errors);
    expect(
      RunIdentityInputSchema({ run_id: "run-1", objective_lineage: "lineage-1", token: "secret" }),
    ).toBeInstanceOf(type.errors);
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
      verification: ["vp test"],
      verification_passed: true,
    };
    expect(SpecialistOutcomeSchema(outcome)).not.toBeInstanceOf(type.errors);
    expect(parseSpecialistOutcome({ ...outcome, status: "unknown" }).ok).toBe(false);
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
    expect(CliSuccessEnvelopeSchema(successEnvelope)).not.toBeInstanceOf(type.errors);
    expect(CliFailureEnvelopeSchema(failureEnvelope)).not.toBeInstanceOf(type.errors);
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
