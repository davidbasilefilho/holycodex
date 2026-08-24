// SPDX-License-Identifier: Apache-2.0

import { evaluateWorkflowCompatibility, makeCapacityService } from "@holycodex/workflow-runtime";
import { isAbsolute } from "node:path";
import * as Effect from "effect/Effect";
import { WorkflowHostError } from "./errors.ts";
import { normalizeHostCapacity, releaseReservation } from "./admission.ts";
import { costMaxToUnits } from "./cost.ts";
import { createContinuation } from "./continuation.ts";
import { createRun } from "./creation.ts";
import { runWorkflow } from "./execution.ts";
import { assertDigest, assertIdentifier, normalizeProjectTrust, safeText } from "./identity.ts";
import { changeState, inspect, list, loadRun, writeCheckpoint } from "./lifecycle.ts";
import { replay, reuseRetainedContext } from "./replay.ts";
import { createRefinement, setRefinementStatus } from "./refinements.ts";
import { FileRunStore } from "./store.ts";
import type {
  ContinuationDecision,
  CreateRunInput,
  HostContext,
  ReplayAdmission,
  ReplayDecision,
  RetainedReuseDecision,
  RetainedReuseInput,
  RefinementOperation,
  RunExecution,
  RunInput,
  WorkflowHostOptions,
} from "./types.ts";
import type { InspectionProjection, Refinement, RunDefinition } from "./schemas.ts";

export type {
  ContinuationDecision,
  CreateRunInput,
  HostCapacity,
  ProjectTrustInput,
  ReplayAdmission,
  ReplayDecision,
  RefinementOperation,
  RetainedReuseDecision,
  RetainedReuseInput,
  RunExecution,
  RunInput,
  RuntimeEvaluator,
  SpecialistAssignment,
  SpecialistExecutor,
  TelemetrySink,
  WorkflowHostOptions,
} from "./types.ts";

export class WorkflowHost {
  readonly store: FileRunStore;
  private readonly context: HostContext;

  constructor(options: WorkflowHostOptions) {
    const project = normalizeProjectTrust(options.projectTrust);
    if (typeof options.cwd !== "string" || options.cwd.length === 0 || !isAbsolute(options.cwd)) {
      throw new WorkflowHostError("invalid_input", "The workflow host cwd must be absolute.");
    }
    const compatibilityExecutor = options.executeSpecialist ?? options.specialistExecutor;
    const configuredAgent =
      options.codex ?? options.agentExecution ?? options.codexLayer ?? options.services?.agent;
    if (compatibilityExecutor === undefined && configuredAgent === undefined) {
      throw new WorkflowHostError(
        "capability_denied",
        "No workflow agent capability is configured.",
      );
    }
    const executor =
      compatibilityExecutor ??
      (() => {
        throw new WorkflowHostError(
          "capability_denied",
          "No compatibility specialist executor is configured.",
        );
      });
    const capacity = normalizeHostCapacity(options.capacity ?? {});
    const globalConcurrency = Math.max(1, capacity.maxConcurrency ?? 8);
    const sharedCapacity = Effect.runSync(
      makeCapacityService({
        planConcurrency: globalConcurrency,
        sessionConcurrency: globalConcurrency,
        codexConcurrency: globalConcurrency,
        maxRetries: capacity.maxRetries ?? 0,
        maxCalls: capacity.maxCalls ?? Number.MAX_SAFE_INTEGER,
        costMax:
          capacity.costMax === undefined
            ? Number.MAX_SAFE_INTEGER
            : costMaxToUnits(capacity.costMax),
      }),
    );
    this.store = options.store;
    this.context = {
      store: options.store,
      project,
      cwd: options.cwd,
      evaluator:
        options.compatibilityEvaluator ??
        options.evaluate ??
        options.runtimeEvaluator ??
        evaluateWorkflowCompatibility,
      compatibilityEvaluator:
        options.compatibilityEvaluator ??
        options.evaluate ??
        options.runtimeEvaluator ??
        (compatibilityExecutor === undefined ? undefined : evaluateWorkflowCompatibility),
      compatibilityEnabled:
        options.compatibilityEvaluator !== undefined ||
        options.evaluate !== undefined ||
        options.runtimeEvaluator !== undefined ||
        compatibilityExecutor !== undefined,
      executor,
      services: options.services ?? {},
      codex: options.codex ?? options.agentExecution,
      codexLayer: options.codexLayer,
      compileOptions: options.compileOptions ?? {},
      approval: options.approval,
      verification: options.verification,
      checkpoint: options.checkpoint,
      capacity,
      runtimeLimits: options.runtimeLimits ?? {},
      policyDigest: assertDigest(options.policyDigest, "policy digest"),
      promptProfile: assertIdentifier(options.promptProfile, "prompt profile"),
      toolProfile: assertIdentifier(options.toolProfile, "tool profile"),
      securityProfile: assertIdentifier(options.securityProfile, "security profile"),
      approvalPolicy: assertIdentifier(options.approvalPolicy ?? "never", "approval policy"),
      sandboxPolicy: assertIdentifier(options.sandboxPolicy, "sandbox policy"),
      codexCapabilityDigest: assertDigest(options.codexCapabilityDigest, "Codex capability digest"),
      telemetry: options.telemetry,
      refinementsEnabled: options.refinementsEnabled ?? false,
      pending: new Map(),
      active: new Map(),
      executionLocks: new Map(),
      journalSequences: new Map(),
      approvalLocks: new Map(),
      lifecycleLocks: new Map(),
      reservations: new Map(),
      sharedCapacity,
    };
  }

  async create(input: CreateRunInput): Promise<RunDefinition> {
    return await createRun(this.context, input);
  }

  async run(input: RunInput): Promise<RunExecution> {
    return await runWorkflow(this.context, input);
  }

  async runNative(input: RunInput): Promise<RunExecution> {
    return await runWorkflow(this.context, { ...input, executionMode: "native" });
  }

  async runCompatibility(input: RunInput): Promise<RunExecution> {
    return await runWorkflow(this.context, { ...input, executionMode: "compatibility" });
  }

  async resume(input: RunInput): Promise<RunExecution> {
    return await runWorkflow(this.context, input);
  }

  async inspect(runId: string, replayed = false): Promise<InspectionProjection> {
    return await inspect(this.context, runId, replayed);
  }

  async list(): Promise<readonly InspectionProjection[]> {
    return await list(this.context);
  }

  async replay(runId: string, admission: ReplayAdmission): Promise<ReplayDecision> {
    return await replay(this.context, runId, admission);
  }

  async reuseRetainedContext(input: RetainedReuseInput): Promise<RetainedReuseDecision> {
    return await reuseRetainedContext(this.context, input);
  }

  async createContinuation(
    input: Readonly<{
      runId: string;
      sessionId: string;
      source: string;
      args: unknown;
      checkpointRevision?: number;
    }>,
  ): Promise<ContinuationDecision> {
    return await createContinuation(this.context, input);
  }

  async goal(runId: string, summary: string): Promise<InspectionProjection> {
    const loaded = await loadRun(this.context, runId);
    const checkpoint = loaded.snapshot.checkpoint;
    const nextCheckpoint = await writeCheckpoint(
      this.context,
      loaded.snapshot,
      safeText(summary),
      [],
      {
        verifiedEvidence: checkpoint?.verified_evidence ?? [],
        decisions: checkpoint?.decisions ?? [],
        phases: checkpoint?.phases ?? [],
        activeWork: checkpoint?.active_work ?? [],
        unresolvedWork: checkpoint?.unresolved_work ?? [],
        blockers: checkpoint?.blockers ?? [],
        verification: checkpoint?.verification ?? [],
        retainedSummaries: checkpoint?.retained_summaries ?? [],
        nextActions: checkpoint?.next_actions ?? [],
        usageCompleteness: checkpoint?.usage_completeness ?? "unknown",
        recoverableErrors: checkpoint?.recoverable_errors ?? [],
      },
    );
    void nextCheckpoint;
    return await inspect(this.context, runId);
  }

  async pause(runId: string): Promise<InspectionProjection> {
    const loaded = await loadRun(this.context, runId);
    if (loaded.snapshot.status !== "running") {
      throw new WorkflowHostError("run_state_invalid", "Only running runs may be paused.");
    }
    this.context.active.get(runId)?.controller.abort();
    const pending = this.context.pending.get(runId);
    await writeCheckpoint(
      this.context,
      loaded.snapshot,
      pending?.objective ?? "[redacted objective unavailable]",
      pending?.constraints ?? [],
      {
        verifiedEvidence: [],
        decisions: [],
        phases: ["paused"],
        activeWork: [],
        unresolvedWork: [],
        blockers: ["cooperative pause requested"],
        verification: [],
        retainedSummaries: [],
        nextActions: ["resume with the original source and args"],
        usageCompleteness: "partial",
        recoverableErrors: [],
      },
    );
    await changeState(
      this.context,
      (await loadRun(this.context, runId)).snapshot,
      "paused",
      "cooperative pause requested",
    );
    return await inspect(this.context, runId);
  }

  async restart(runId: string): Promise<InspectionProjection> {
    const loaded = await loadRun(this.context, runId);
    if (!["completed", "failed", "blocked", "stopped"].includes(loaded.snapshot.status)) {
      throw new WorkflowHostError("run_state_invalid", "Only terminal runs may restart.");
    }
    await changeState(this.context, loaded.snapshot, "reopened", "restart requested");
    return await inspect(this.context, runId);
  }

  async reopen(runId: string): Promise<InspectionProjection> {
    return await this.restart(runId);
  }

  async stop(runId: string): Promise<InspectionProjection> {
    const loaded = await loadRun(this.context, runId);
    if (["completed", "failed", "stopped"].includes(loaded.snapshot.status)) {
      return await inspect(this.context, runId);
    }
    const active = this.context.active.get(runId);
    active?.controller.abort();
    if (active && active.operationControllers.size > 0) {
      return await inspect(this.context, runId);
    }
    await changeState(this.context, loaded.snapshot, "stopped", "stop requested");
    await releaseReservation(this.context, runId);
    return await inspect(this.context, runId);
  }

  async stopAgent(runId: string, operationId: string): Promise<InspectionProjection> {
    const active = this.context.active.get(runId);
    if (!active) {
      throw new WorkflowHostError(
        "run_state_invalid",
        "The run has no active specialist operation.",
      );
    }
    const controller = active.operationControllers.get(operationId);
    if (!controller) {
      throw new WorkflowHostError(
        "run_state_invalid",
        "The requested specialist operation is not active.",
      );
    }
    controller.abort();
    return await inspect(this.context, runId);
  }

  async createRefinement(
    input: Readonly<{
      runId: string;
      proposal: unknown;
      attributableTo: string;
      source: string;
      args: unknown;
    }>,
  ): Promise<RefinementOperation> {
    return await createRefinement(this.context, input);
  }

  async enableRefinement(runId: string, refinementId: string): Promise<Refinement> {
    return await setRefinementStatus(this.context, runId, refinementId, "enabled");
  }

  async disableRefinement(runId: string, refinementId: string): Promise<Refinement> {
    return await setRefinementStatus(this.context, runId, refinementId, "disabled");
  }
}
