// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  CodexError,
  SemanticAssignmentPacketSchema,
  type AssignmentExecutionService,
  type SemanticAssignmentPacket,
  type SemanticExecutionOutcome,
} from "@holycodex/codex";
import { PONYTAIL_ROLE_SKILL } from "@holycodex/core";
import {
  FileRunStore,
  WorkflowHost,
  WorkflowHostError,
  decodeHostSchema,
  type WorkflowHostOptions,
} from "./index.ts";
import {
  createCodec,
  evaluateNativeWorkflowSource,
  workflow,
  type EvaluateWorkflowInput,
  type WorkflowResult,
} from "@holycodex/workflow-runtime";

const digest = "a".repeat(64);
const projectTrust = {
  project_id: "project-test",
  trust_id: "trust-test",
  project_digest: digest,
  trust_digest: "b".repeat(64),
};
const source = "return { ok: true };";
const args = { input: "safe" };

const outcome = {
  protocol_version: "holycodex-specialist-outcome-2" as const,
  route: { role: "Worker" as const, task: "implementation" as const },
  evidence: ["verified\u0000finding", "host test passed"],
  status: "completed" as const,
  summary: "verified finding",
};

function outcomeFor<R extends "Worker" | "Reviewer", T extends string>(role: R, task: T) {
  return { ...outcome, route: { role, task } };
}

const legacyOutcome = {
  blocked: false,
  changed_files: ["packages/workflow-host/src/index.ts"],
  confidence: 0.9,
  context_owner: "worker",
  material_findings: ["verified finding"],
  needs_more_context: false,
  needs_root_decision: false,
  needs_verification: false,
  relevant_files: ["packages/workflow-host/src/host.ts"],
  remaining_risk: [],
  reuse_recommended: true,
  status: "completed" as const,
  suggested_followup: null,
  suggested_luna_effort: null,
  suggested_specialist: null,
  verification: ["host test passed"],
  verification_passed: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function tempStore(): Promise<{ readonly root: string; readonly store: FileRunStore }> {
  const root = await mkdtemp(join(tmpdir(), "holycodex-workflow-host-"));
  return { root, store: new FileRunStore(root) };
}

function fakeEvaluator(): (input: EvaluateWorkflowInput) => Promise<WorkflowResult> {
  return async (input) => {
    const value = await input.operationHandler({
      name: "agent",
      prompt: "private workflow prompt",
      options: { role: "Worker", task: "implementation", channel: "test" },
    });
    return { ok: true, value };
  };
}

function hostOptions(
  root: string,
  evaluator: WorkflowHostOptions["evaluate"] = fakeEvaluator(),
  overrides: Partial<WorkflowHostOptions> = {},
): WorkflowHostOptions {
  return {
    store: new FileRunStore(root),
    projectTrust,
    cwd: process.cwd(),
    evaluate: evaluator,
    executeSpecialist: async () => outcome,
    policyDigest: "c".repeat(64),
    codexCapabilityDigest: "d".repeat(64),
    ...overrides,
  };
}

describe("workflow-host", () => {
  test("initializes concurrent run-store owners without directory races", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-workflow-host-init-"));
    try {
      const stores = Array.from({ length: 4 }, () => new FileRunStore(root));
      await Promise.all(stores.flatMap((store) => [store.init(), store.init()]));
      expect((await readdir(root)).sort()).toEqual(["claims", "quarantine", "runs"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs an immutable Effect workflow through the real Codex assignment seam", async () => {
    const { root } = await tempStore();
    try {
      const packets: SemanticAssignmentPacket[] = [];
      const telemetry: unknown[] = [];
      const json = createCodec("json", (value: unknown): unknown => value);
      const terminal = workflow.wait(
        workflow.step({
          id: "codex-dispatch",
          assignment: {
            payload: {
              objective: "dispatch through Codex",
              scope: ["packages/core/src/routes.ts", "packages/core/src/routes.ts"],
              files: ["packages/core/src/routes.ts", "packages/workflow-host/src/index.ts"],
              references: "docs/ARCHITECTURE.md",
              constraints: ["run constraint", "assignment constraint"],
              internal: "must not cross the semantic boundary",
              options: {
                scope: "nested scope ignored when direct scope exists",
                symbols: [
                  "packages/workflow-host/src/effect-runtime.ts",
                  "packages/workflow-host/src/index.ts",
                ],
                references: "nested reference ignored when direct references exist",
                constraints: "nested constraint ignored when direct constraints exist",
                evidence: "nested evidence",
                completion: ["nested acceptance", "nested acceptance"],
                exclusions: "nested exclusion",
                escalation: ["nested escalation", "nested escalation"],
                delta: ["nested delta", "nested delta"],
                raw: "must not cross the semantic boundary",
              },
            },
            input: json,
            output: json,
            route: "Worker:integration",
          },
        }),
      );
      const codex: AssignmentExecutionService = {
        execute: (input: unknown) => {
          const packet = decodeHostSchema(SemanticAssignmentPacketSchema, input);
          if (packet === undefined) {
            return Effect.fail(
              new CodexError("invalid_external_data", "The fake Codex packet was invalid."),
            );
          }
          packets.push(packet);
          const result: SemanticExecutionOutcome = {
            assignment_id: packet.assignment.id,
            route_key: packet.route.key,
            thread_id: "thread-test",
            turn_id: "turn-test",
            backend: "app-server-v1-fallback",
            session_mode: "fresh",
            duration_ms: 7,
            usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 2,
              reasoning_output_tokens: 0,
            },
            outcome: outcomeFor("Worker", "integration"),
          };
          return Effect.succeed(result);
        },
      };
      const host = new WorkflowHost(
        hostOptions(root, undefined, {
          codex,
          approvalPolicy: "never",
          telemetry: (event) => {
            telemetry.push(event);
          },
        }),
      );
      const definition = await host.create({
        source,
        args,
        objective: "effect-native host",
        constraints: ["run constraint", "run constraint", "run-only constraint"],
        workflow: terminal,
      });
      const execution = await host.run({ runId: definition.run_id, source, args });
      expect(execution.status).toBe("completed");
      expect(packets).toHaveLength(1);
      const packet = packets[0];
      expect(packet).toBeDefined();
      if (packet === undefined) return;
      expect(packet.assignment).toEqual({
        id: expect.any(String),
        objective: "dispatch through Codex",
        role_task: { role: "Worker", task: "integration" },
        authority: "Change only the assigned seam; Root owns material choices.",
        scope: [
          "packages/core/src/routes.ts",
          "packages/workflow-host/src/index.ts",
          "packages/workflow-host/src/effect-runtime.ts",
        ],
        references: ["docs/ARCHITECTURE.md"],
        constraints: ["run constraint", "run-only constraint", "assignment constraint"],
        required_evidence: ["nested evidence"],
        acceptance: ["nested acceptance"],
        exclusions: ["nested exclusion"],
        escalation: ["nested escalation"],
        delta: ["nested delta"],
      });
      expect(packet.route.key).toBe("Worker:integration");
      expect(packet.skill_profile).toEqual(PONYTAIL_ROLE_SKILL);
      expect(packet.tools.allowed).toEqual(["read", "write", "execute"]);
      expect(packet.security.network).toBe(false);
      expect(packet.tools.specialist_spawn).toBe(false);
      expect(packet.security.workflow).toBe(false);
      expect(packet).not.toHaveProperty("context");
      expect(JSON.stringify(packet)).not.toContain("internal");
      expect(JSON.stringify(packet)).not.toContain("nested scope ignored");
      expect(telemetry).toContainEqual(
        expect.objectContaining({
          event: "operation",
          session_mode: "fresh",
          duration_ms: 7,
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 0,
          },
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists approval transitions and deterministic Reviewer verification", async () => {
    const { root } = await tempStore();
    try {
      let verified = false;
      const packets: SemanticAssignmentPacket[] = [];
      const json = createCodec("json", (value: unknown): unknown => value);
      const terminal = workflow.wait(
        workflow.step({
          id: "review-dispatch",
          assignment: {
            payload: { objective: "review through Codex" },
            input: json,
            output: json,
            route: "Reviewer:code",
          },
        }),
      );
      const codex: AssignmentExecutionService = {
        execute: (input: unknown) => {
          const packet = decodeHostSchema(SemanticAssignmentPacketSchema, input);
          if (packet === undefined) {
            return Effect.fail(
              new CodexError("invalid_external_data", "The fake Codex packet was invalid."),
            );
          }
          packets.push(packet);
          return Effect.succeed({
            assignment_id: packet.assignment.id,
            route_key: packet.route.key,
            thread_id: "thread-review",
            turn_id: "turn-review",
            backend: "app-server-v1-fallback" as const,
            outcome: outcomeFor("Reviewer", "code"),
          });
        },
      };
      const host = new WorkflowHost(
        hostOptions(root, undefined, {
          codex,
          approvalPolicy: "root",
          approval: () => {
            const decision = "approved" as const;
            return Effect.succeed(decision);
          },
          verification: () =>
            Effect.sync(() => {
              verified = true;
            }),
        }),
      );
      const definition = await host.create({
        source,
        args,
        objective: "review lifecycle",
        route: "Reviewer:code",
        workflow: terminal,
      });
      const execution = await host.run({ runId: definition.run_id, source, args });
      const journal = await readFile(
        join(root, "runs", definition.run_id, "journal.ndjson"),
        "utf8",
      );
      expect(execution.status).toBe("completed");
      expect(verified).toBe(true);
      expect(packets[0]?.skill_profile).toEqual(PONYTAIL_ROLE_SKILL);
      expect(packets[0]?.assignment.required_evidence).toEqual([
        "Return findings, repaired paths, verification, and residual risk.",
      ]);
      expect(packets[0]?.assignment.acceptance).toEqual([
        "Reach a fixed point or report each reproducible blocker.",
      ]);
      expect(journal).toContain("waiting_for_approval");
      expect(journal).toContain("approved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("admits catalog routes, integrates runtime operations, and sanitizes persisted state", async () => {
    const { root } = await tempStore();
    try {
      const telemetry: unknown[] = [];
      const host = new WorkflowHost(
        hostOptions(root, fakeEvaluator(), {
          telemetry: (event) => {
            telemetry.push(event);
          },
        }),
      );
      const definition = await host.create({
        source,
        args,
        objective: "test host",
        route: "Worker:implementation",
        plan: { plan: "plus" },
      });
      const execution = await host.run({ runId: definition.run_id, source, args });

      expect(execution.status).toBe("completed");
      expect(execution.result.ok).toBe(true);
      expect(execution.inspection.operations.some((item) => item.state === "completed")).toBe(true);
      expect(execution.inspection.workflow?.delegation_mode).toBe("DYNAMIC_WORKFLOW");
      expect(
        telemetry.some(
          (event) => isRecord(event) && event["delegation_mode"] === "DYNAMIC_WORKFLOW",
        ),
      ).toBe(true);
      expect(telemetry.length).toBeGreaterThan(0);

      const files = await readFile(join(root, "runs", definition.run_id, "journal.ndjson"), "utf8");
      expect(files).not.toContain("private workflow prompt");
      expect(files).not.toContain(source);
      expect(files).not.toContain("safe");
      expect(files).toContain("verified finding");

      const reused = await host.reuseRetainedContext({
        project: projectTrust,
        route: "Worker:implementation",
        role: "Worker",
        policyDigest: "c".repeat(64),
        toolProfile: "default",
        securityProfile: "default",
        promptProfile: "default",
        skillProfileDigest: PONYTAIL_ROLE_SKILL.digest,
      });
      expect(reused.kind).toBe("new-context-required");
      const policyMismatch = await host.reuseRetainedContext({
        project: projectTrust,
        route: "Worker:implementation",
        role: "Worker",
        policyDigest: "c".repeat(64),
        toolProfile: "default",
        securityProfile: "default",
        promptProfile: "default",
        approvalPolicy: "other",
        skillProfileDigest: PONYTAIL_ROLE_SKILL.digest,
      });
      expect(policyMismatch.kind).toBe("new-context-required");
      const newContext = await host.reuseRetainedContext({
        project: projectTrust,
        route: "Worker:implementation",
        role: "Worker",
        policyDigest: "c".repeat(64),
        toolProfile: "other",
        securityProfile: "default",
        promptProfile: "default",
        skillProfileDigest: PONYTAIL_ROLE_SKILL.digest,
      });
      expect(newContext.kind).toBe("new-context-required");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects Go and hard admission violations", async () => {
    const { root } = await tempStore();
    try {
      const host = new WorkflowHost(hostOptions(root));
      expect(
        () => new WorkflowHost(hostOptions(root, undefined, { capacity: { maxCalls: NaN } })),
      ).toThrow(WorkflowHostError);
      await expect(
        host.create({ source, args, objective: "go", plan: "Go" }),
      ).rejects.toMatchObject({
        code: "go_rejected",
      });
      await expect(
        host.create({ source, args, objective: "direct", delegationMode: "DIRECT" }),
      ).rejects.toMatchObject({ code: "admission_denied" });
      await expect(
        host.create({ source, args, objective: "cost", estimatedCost: 99 }),
      ).rejects.toMatchObject({ code: "cost_limit" });
      const limited = new WorkflowHost(
        hostOptions(root, undefined, { capacity: { maxCalls: 1, maxConcurrency: 1 } }),
      );
      await expect(
        limited.create({ source, args, objective: "calls", expectedCalls: 2 }),
      ).rejects.toMatchObject({ code: "call_limit" });
      await expect(
        limited.create({ source, args, objective: "concurrency", expectedConcurrency: 2 }),
      ).rejects.toMatchObject({ code: "concurrency_limit" });
      await expect(
        limited.create({ source, args, objective: "negative retry", expectedRetries: -1 }),
      ).rejects.toMatchObject({ code: "retry_limit" });
      await expect(
        limited.create({ source, args, objective: "empty fan out", expectedFanOut: 0 }),
      ).rejects.toMatchObject({ code: "fan_out_limit" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists and validates delegation cardinality across native and compatibility runs", async () => {
    const { root } = await tempStore();
    try {
      const json = createCodec("json", (value: unknown): unknown => value);
      const single = workflow.wait(
        workflow.step({
          id: "mode-single",
          assignment: { payload: {}, input: json, output: json, route: "Worker:implementation" },
        }),
      );
      const left = workflow.step({
        id: "mode-left",
        assignment: { payload: {}, input: json, output: json, route: "Worker:implementation" },
      });
      const right = workflow.step({
        id: "mode-right",
        assignment: { payload: {}, input: json, output: json, route: "Reviewer:code" },
      });
      const dynamic = workflow.wait({ left: workflow.start(left), right: workflow.start(right) });
      const host = new WorkflowHost(hostOptions(root));

      const singleRun = await host.create({
        source,
        args,
        objective: "native single",
        workflow: single,
        delegationMode: "SINGLE",
      });
      expect((await host.inspect(singleRun.run_id)).workflow?.delegation_mode).toBe("SINGLE");
      const dynamicRun = await host.create({
        source,
        args,
        objective: "native dynamic",
        workflow: dynamic,
        delegationMode: "DYNAMIC_WORKFLOW",
      });
      expect((await host.inspect(dynamicRun.run_id)).workflow?.delegation_mode).toBe(
        "DYNAMIC_WORKFLOW",
      );
      await expect(
        host.create({
          source,
          args,
          objective: "native mismatch",
          workflow: dynamic,
          delegationMode: "SINGLE",
        }),
      ).rejects.toMatchObject({ code: "admission_denied" });

      const compatibilitySingle = await host.create({
        source,
        args,
        objective: "compat single",
        executionMode: "compatibility",
        expectedCalls: 1,
        delegationMode: "SINGLE",
      });
      expect((await host.inspect(compatibilitySingle.run_id)).workflow?.delegation_mode).toBe(
        "SINGLE",
      );
      const compatibilityZero = await host.create({
        source,
        args,
        objective: "compat zero",
        executionMode: "compatibility",
        expectedCalls: 0,
        delegationMode: "SINGLE",
      });
      expect((await host.inspect(compatibilityZero.run_id)).workflow).toMatchObject({
        delegation_mode: "SINGLE",
        compatibility_cardinality: { status: "proven", expected_calls: 0 },
      });
      const compatibilityUnknown = await host.create({
        source,
        args,
        objective: "compat unknown",
        executionMode: "compatibility",
        delegationMode: "DYNAMIC_WORKFLOW",
      });
      expect((await host.inspect(compatibilityUnknown.run_id)).workflow).toMatchObject({
        delegation_mode: "DYNAMIC_WORKFLOW",
        compatibility_cardinality: { status: "unknown" },
      });
      const compatibilityLegacy = await host.create({
        source,
        args,
        objective: "compat legacy dynamic",
        executionMode: "compatibility",
        expectedCalls: 2,
      });
      expect((await host.inspect(compatibilityLegacy.run_id)).workflow?.delegation_mode).toBe(
        "DYNAMIC_WORKFLOW",
      );
      await expect(
        host.create({
          source,
          args,
          objective: "compat mismatch",
          executionMode: "compatibility",
          expectedCalls: 2,
          delegationMode: "SINGLE",
        }),
      ).rejects.toMatchObject({ code: "admission_denied" });

      await expect(
        host.run({
          runId: singleRun.run_id,
          source,
          args,
          delegationMode: "DYNAMIC_WORKFLOW",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      const stored = await host.store.load(compatibilitySingle.run_id);
      const descriptor = stored.snapshot.workflow;
      expect(descriptor).toBeDefined();
      if (!descriptor) return;
      const { delegation_mode: _legacyMode, ...legacyDescriptor } = descriptor;
      await host.store.saveSnapshot({ ...stored.snapshot, workflow: legacyDescriptor });
      expect((await host.inspect(compatibilitySingle.run_id)).workflow).toMatchObject({
        delegation_mode: "SINGLE",
        compatibility_cardinality: { status: "proven", expected_calls: 1 },
      });
      await expect(
        host.run({ runId: compatibilitySingle.run_id, source, args }),
      ).resolves.toMatchObject({ status: "completed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires exact resupplied args and admits exact replay only", async () => {
    const { root } = await tempStore();
    try {
      const host = new WorkflowHost(hostOptions(root));
      const definition = await host.create({ source, args, objective: "identity" });
      await expect(
        host.run({ runId: definition.run_id, source, args: { input: "different" } }),
      ).rejects.toMatchObject({
        code: "identity_mismatch",
      });
      await host.run({ runId: definition.run_id, source, args });
      const inspection = await host.inspect(definition.run_id);
      expect(inspection.workflow).not.toHaveProperty("source");
      expect(inspection.workflow).not.toHaveProperty("args");
      const completed = inspection.operations.find((item) => item.state === "completed");
      expect(completed).toBeDefined();
      if (!completed) return;
      const replay = await host.replay(definition.run_id, {
        identity: definition.identity,
        operationInput: {
          prompt: "private workflow prompt",
          options: { role: "Worker", task: "implementation", channel: "test" },
          route: "Worker:implementation",
        },
      });
      expect(replay.kind).toBe("replayed");
      const denied = await host.replay(definition.run_id, {
        identity: { ...definition.identity, prompt_profile: "other" },
        operationInput: {},
      });
      expect(denied).toMatchObject({ kind: "denied", code: "identity_mismatch" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for invalid runtime assignments and malformed specialist outcomes", async () => {
    const { root } = await tempStore();
    try {
      const invalidRouteHost = new WorkflowHost(
        hostOptions(root, async (input) => {
          await input.operationHandler({
            name: "agent",
            prompt: "private",
            options: { role: "Worker", task: "lookup" },
          });
          return { ok: true, value: null };
        }),
      );
      const invalidRouteRun = await invalidRouteHost.create({ source, args, objective: "route" });
      const invalidRouteResult = await invalidRouteHost.run({
        runId: invalidRouteRun.run_id,
        source,
        args,
      });
      expect(invalidRouteResult.status).toBe("failed");

      const malformedHost = new WorkflowHost(
        hostOptions(root, fakeEvaluator(), {
          executeSpecialist: async () => ({ malformed: true }),
        }),
      );
      const malformedRun = await malformedHost.create({ source, args, objective: "outcome" });
      const malformedResult = await malformedHost.run({
        runId: malformedRun.run_id,
        source,
        args,
      });
      expect(malformedResult.status).toBe("blocked");
      expect(
        (await malformedHost.inspect(malformedRun.run_id)).operations.some(
          (item) => item.state === "uncertain",
        ),
      ).toBe(true);

      const blockedHost = new WorkflowHost(
        hostOptions(root, fakeEvaluator(), {
          executeSpecialist: async () => ({
            protocol_version: "holycodex-specialist-outcome-2" as const,
            route: { role: "Worker" as const, task: "implementation" as const },
            evidence: [],
            status: "blocked" as const,
            reason: "Needs a root decision.",
            needs_root_decision: true,
          }),
        }),
      );
      const blockedRun = await blockedHost.create({ source, args, objective: "blocked outcome" });
      const blockedResult = await blockedHost.run({ runId: blockedRun.run_id, source, args });
      expect(blockedResult.status).toBe("failed");
      expect(
        (await blockedHost.inspect(blockedRun.run_id)).operations.some(
          (item) => item.state === "failed",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes legacy compatibility execution before journal storage", async () => {
    const { root } = await tempStore();
    try {
      const host = new WorkflowHost(
        hostOptions(root, fakeEvaluator(), {
          executeSpecialist: async () => legacyOutcome,
        }),
      );
      const definition = await host.create({ source, args, objective: "legacy compatibility" });
      const execution = await host.runCompatibility({ runId: definition.run_id });
      expect(execution.status).toBe("completed");
      const operation = (await host.store.load(definition.run_id)).journal.find(
        (event) => event.event === "operation" && event.lifecycle.state === "completed",
      );
      expect(operation?.event === "operation" ? operation.outcome : undefined).toEqual({
        protocol_version: "holycodex-specialist-outcome-2",
        route: { role: "Worker", task: "implementation" },
        evidence: ["packages/workflow-host/src/host.ts", "host test passed", "verified finding"],
        status: "completed",
        summary: "verified finding",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads legacy journal operation outcomes as canonical v2", async () => {
    const { root } = await tempStore();
    try {
      const host = new WorkflowHost(hostOptions(root));
      const definition = await host.create({ source, args, objective: "legacy journal" });
      await host.run({ runId: definition.run_id, source, args });
      const journalPath = join(root, "runs", definition.run_id, "journal.ndjson");
      const records = (await readFile(journalPath, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line): unknown => JSON.parse(line));
      let migrated = false;
      const legacyRecords = records.map((record) => {
        if (!isRecord(record) || record["event"] !== "operation") {
          return record;
        }
        const lifecycle = record["lifecycle"];
        if (!isRecord(lifecycle) || lifecycle["state"] !== "completed") {
          return record;
        }
        migrated = true;
        return { ...record, outcome: legacyOutcome };
      });
      expect(migrated).toBe(true);
      await writeFile(
        journalPath,
        `${legacyRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      const loaded = await host.store.load(definition.run_id);
      expect(loaded.snapshot.integrity).toBe("uncertain");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks after an explicitly cancelled specialist becomes ambiguous", async () => {
    const { root } = await tempStore();
    try {
      let operationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        operationStarted = resolve;
      });
      const host = new WorkflowHost(
        hostOptions(
          root,
          async (input) => {
            const value = await input.operationHandler({
              name: "agent",
              prompt: "private workflow prompt",
              options: { role: "Worker", task: "implementation" },
            });
            return { ok: true, value };
          },
          {
            executeSpecialist: async (assignment) => {
              operationStarted();
              await new Promise<void>((resolve) => {
                assignment.signal.addEventListener("abort", () => resolve(), { once: true });
              });
              return outcome;
            },
          },
        ),
      );
      const definition = await host.create({ source, args, objective: "ambiguous" });
      const running = host.run({ runId: definition.run_id, source, args });
      await started;
      await host.stop(definition.run_id);
      const execution = await running;
      expect(execution.status).toBe("blocked");
      expect(execution.inspection.operations.some((item) => item.state === "uncertain")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quarantines corrupt journal records and rejects unsafe roots", async () => {
    const { root } = await tempStore();
    const outside = await mkdtemp(join(tmpdir(), "holycodex-outside-"));
    try {
      const host = new WorkflowHost(hostOptions(root));
      const definition = await host.create({ source, args, objective: "corruption" });
      const journalPath = join(root, "runs", definition.run_id, "journal.ndjson");
      const journal = await readFile(journalPath, "utf8");
      await writeFile(journalPath, `${journal}{broken\n`);
      const loaded = await host.store.load(definition.run_id);
      expect(loaded.snapshot.integrity).toBe("uncertain");
      expect((await readdir(join(root, "quarantine"))).length).toBeGreaterThan(0);
      const firstEvent = loaded.journal[0];
      if (!firstEvent) return;
      await expect(host.store.appendJournal(definition.run_id, firstEvent)).rejects.toMatchObject({
        code: "state_corrupt",
      });
      await rm(journalPath);
      expect((await host.store.load(definition.run_id)).snapshot.integrity).toBe("uncertain");
      expect(() => new FileRunStore("relative-root")).toThrow(WorkflowHostError);
      await symlink(
        outside,
        join(root, "runs", "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(host.store.load("escape")).rejects.toMatchObject({ code: "path_rejected" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("commits checkpoint revisions with a verifiable intent and record", async () => {
    const { root } = await tempStore();
    try {
      const host = new WorkflowHost(hostOptions(root));
      const definition = await host.create({ source, args, objective: "transaction" });
      const created = await host.store.load(definition.run_id);
      expect(created.snapshot.integrity).toBe("valid");
      expect(created.journal.some((event) => event.event === "commit-intent")).toBe(true);
      expect(created.journal.some((event) => event.event === "commit-record")).toBe(true);

      const inspected = await host.goal(definition.run_id, "checkpoint transaction");
      expect(inspected.checkpoint?.revision).toBe(1);
      const committed = await host.store.load(definition.run_id);
      expect(committed.snapshot.integrity).toBe("valid");
      expect(committed.diagnostics).toEqual([]);

      await host.store.saveSnapshot({ ...committed.snapshot, revision: 0 });
      const forged = await host.store.load(definition.run_id);
      expect(forged.snapshot.integrity).toBe("uncertain");
      await expect(host.run({ runId: definition.run_id, source, args })).rejects.toMatchObject({
        code: "integrity_uncertain",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("continuations are bounded, redacted, stale-safe, and claimed once", async () => {
    const { root } = await tempStore();
    try {
      let release: (() => void) | undefined;
      const evaluator = async (): Promise<WorkflowResult> =>
        await new Promise<WorkflowResult>((resolve) => {
          release = () => resolve({ ok: true, value: null });
        });
      const host = new WorkflowHost(hostOptions(root, evaluator));
      const definition = await host.create({ source, args, objective: "continuation secret" });
      const running = host.run({ runId: definition.run_id, source, args });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await host.inspect(definition.run_id)).status === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await host.pause(definition.run_id);
      release?.();
      await running;
      const first = await host.createContinuation({
        runId: definition.run_id,
        sessionId: "session-1",
        source,
        args,
      });
      expect(first.kind).toBe("claimed");
      if (first.kind !== "claimed") return;
      expect(first.derived.run_id).not.toBe(definition.run_id);
      expect(first.derived.parent_run_id).toBe(definition.run_id);
      expect(first.derived.objective_lineage).toBe(definition.objective_lineage);
      expect(first.derived.identity).toEqual(definition.identity);
      expect((await host.inspect(first.derived.run_id)).status).toBe("created");
      expect(JSON.stringify(first.packet)).not.toContain("continuation secret");
      expect(JSON.stringify(first.packet)).not.toContain("safe");
      const second = await host.createContinuation({
        runId: definition.run_id,
        sessionId: "session-1",
        source,
        args,
      });
      expect(second).toMatchObject({ kind: "denied", code: "claim_conflict" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps refinements disabled unless explicitly enabled and reversible", async () => {
    const { root } = await tempStore();
    try {
      const disabled = new WorkflowHost(hostOptions(root));
      const definition = await disabled.create({ source, args, objective: "refinement" });
      await expect(
        disabled.createRefinement({
          runId: definition.run_id,
          source,
          args,
          proposal: { kind: "clarification", summary: "one", rationale: "because" },
          attributableTo: "root",
        }),
      ).rejects.toMatchObject({ code: "refinement_disabled" });

      const enabled = new WorkflowHost(hostOptions(root, undefined, { refinementsEnabled: true }));
      const refinement = await enabled.createRefinement({
        runId: definition.run_id,
        source,
        args,
        proposal: { kind: "clarification", summary: "one", rationale: "because" },
        attributableTo: "root",
      });
      const activated = await enabled.enableRefinement(
        refinement.refinement.run_id,
        refinement.refinement.refinement_id,
      );
      expect(activated.status).toBe("enabled");
      const deactivated = await enabled.disableRefinement(
        refinement.refinement.run_id,
        activated.refinement_id,
      );
      expect(deactivated.status).toBe("disabled");
      expect(deactivated.reversible).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies compatibility dispatch before the specialist effect", async () => {
    const { root } = await tempStore();
    try {
      let dispatched = 0;
      const host = new WorkflowHost(
        hostOptions(root, fakeEvaluator(), {
          approvalPolicy: "root",
          approval: () => Effect.succeed("denied" as const),
          executeSpecialist: async () => {
            dispatched += 1;
            return outcome;
          },
        }),
      );
      const definition = await host.create({ source, args, objective: "deny before effect" });
      const execution = await host.runCompatibility({ runId: definition.run_id });
      expect(execution.status).toBe("denied");
      expect(dispatched).toBe(0);
      const journal = await readFile(
        join(root, "runs", definition.run_id, "journal.ndjson"),
        "utf8",
      );
      expect(journal).toContain("waiting_for_approval");
      expect(journal).toContain("denied");
      expect(journal).not.toContain('"state":"completed"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allocates concurrent journal sequences inside the store lock", async () => {
    const { root } = await tempStore();
    try {
      const host = new WorkflowHost(hostOptions(root));
      const definition = await host.create({ source, args, objective: "journal lock" });
      const appended = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          host.store.appendJournalNext(definition.run_id, (sequence) => ({
            schema_epoch: "host-journal-1.0" as const,
            event: "state-changed" as const,
            run_id: definition.run_id,
            sequence,
            at: new Date().toISOString(),
            from: "running" as const,
            to: "paused" as const,
            reason: `sibling-${index}`,
          })),
        ),
      );
      const sequences = appended.map((event) => event.sequence).sort((left, right) => left - right);
      expect(sequences).toEqual(Array.from({ length: 24 }, (_, index) => index + 4));
      const loaded = await host.store.load(definition.run_id);
      expect(loaded.journal.map((event) => event.sequence)).toEqual(
        Array.from({ length: 27 }, (_, index) => index + 1),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes and replays from the persisted descriptor in a new host", async () => {
    const { root } = await tempStore();
    try {
      const firstHost = new WorkflowHost(hostOptions(root));
      const definition = await firstHost.create({
        source,
        args,
        objective: "restart descriptor",
        executionMode: "compatibility",
      });
      const restarted = new WorkflowHost(hostOptions(root));
      const execution = await restarted.run({ runId: definition.run_id });
      expect(execution.status).toBe("completed");
      const replay = await restarted.replay(definition.run_id, {
        identity: definition.identity,
        operationInput: {
          prompt: "private workflow prompt",
          options: { role: "Worker", task: "implementation", channel: "test" },
          route: "Worker:implementation",
        },
      });
      expect(replay.kind).toBe("replayed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires an explicit compatibility adapter when no native terminal is supplied", async () => {
    const { root } = await tempStore();
    try {
      const json = createCodec("json", (value: unknown): unknown => value);
      const terminal = workflow.wait(
        workflow.step({
          id: "native-default",
          assignment: { payload: {}, input: json, output: json, route: "Worker:integration" },
        }),
      );
      const native = new WorkflowHost(
        hostOptions(root, undefined, {
          codex: {
            execute: (input) => {
              const packet = decodeHostSchema(SemanticAssignmentPacketSchema, input);
              if (packet === undefined) {
                return Effect.fail(
                  new CodexError("invalid_external_data", "The fake packet was invalid."),
                );
              }
              return Effect.succeed({
                assignment_id: packet.assignment.id,
                route_key: packet.route.key,
                thread_id: "thread",
                turn_id: "turn",
                backend: "app-server-v1-fallback" as const,
                outcome: outcomeFor("Worker", "integration"),
              });
            },
          },
          approvalPolicy: "never",
        }),
      );
      const definition = await native.create({
        source,
        args,
        objective: "native default",
        workflow: terminal,
      });
      await expect(native.runNative({ runId: definition.run_id })).resolves.toMatchObject({
        status: "completed",
      });
      const compatibilityOnly = new WorkflowHost({
        store: new FileRunStore(root),
        projectTrust,
        cwd: process.cwd(),
        codex: {
          execute: () =>
            Effect.succeed({
              assignment_id: "native-default",
              route_key: "Worker:integration",
              thread_id: "thread",
              turn_id: "turn",
              backend: "app-server-v1-fallback" as const,
              outcome: outcomeFor("Worker", "integration"),
            }),
        },
      });
      await expect(
        compatibilityOnly.create({ source, args, objective: "must be native" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hydrates native QuickJS IR before the host specialist seam", async () => {
    const { root } = await tempStore();
    const native = await evaluateNativeWorkflowSource({
      source: `
        import { createCodec, workflow } from "@holycodex/workflow-runtime";
        const number = createCodec("number", (value: unknown): number => Number(value));
        const step = workflow.step({ id: "native-ir-step", assignment: { input: number, output: number } });
        export default workflow.wait(step);
      `,
    });
    try {
      const host = new WorkflowHost(
        hostOptions(root, undefined, {
          services: {
            agent: {
              execute: (assignment) => Effect.succeed(assignment.payload),
            },
          },
        }),
      );
      const created = await host.create({
        source: "native source",
        args: 9,
        objective: "native IR",
        workflow: native,
      });
      await expect(
        host.run({
          runId: created.run_id,
          source: "changed native source",
          args: 9,
          workflow: native,
        }),
      ).rejects.toMatchObject({ code: "identity_mismatch" });
      const execution = await host.run({
        runId: created.run_id,
        source: "native source",
        args: 9,
        workflow: native,
      });
      expect(execution.result).toEqual({ ok: true, value: 9 });
    } finally {
      native.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
