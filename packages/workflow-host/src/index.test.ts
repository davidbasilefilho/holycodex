// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  FileRunStore,
  WorkflowHost,
  WorkflowHostError,
  type WorkflowHostOptions,
} from "./index.ts";
import type { EvaluateWorkflowInput, WorkflowResult } from "@holycodex/workflow-runtime";

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
  blocked: false,
  changed_files: ["packages/workflow-host/src/index.ts"],
  confidence: 0.9,
  context_owner: "worker",
  material_findings: ["verified\u0000finding"],
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
      });
      expect(reused.kind).toBe("reused");
      const policyMismatch = await host.reuseRetainedContext({
        project: projectTrust,
        route: "Worker:implementation",
        role: "Worker",
        policyDigest: "c".repeat(64),
        toolProfile: "default",
        securityProfile: "default",
        promptProfile: "default",
        approvalPolicy: "other",
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
      await symlink(outside, join(root, "runs", "escape"));
      await expect(host.store.load("escape")).rejects.toMatchObject({ code: "path_rejected" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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
});
