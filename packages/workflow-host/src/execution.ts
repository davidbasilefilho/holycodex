// SPDX-License-Identifier: Apache-2.0

import { resolvePlanSelection } from "@holycodex/core";
import { WorkflowRuntimeError, type WorkflowResult } from "@holycodex/workflow-runtime";
import { WorkflowHostError } from "./errors.ts";
import { effectiveRuntimeLimits, releaseReservation } from "./admission.ts";
import { asJsonValue, assertInputIdentity } from "./identity.ts";
import { changeState, inspect, loadRun, writeCheckpoint, emitTelemetry } from "./lifecycle.ts";
import { handleOperation } from "./operation.ts";
import { WORKFLOW_HOST_SCHEMA_EPOCH } from "./schemas.ts";
import type { HostContext, RunExecution, RunInput } from "./types.ts";

export async function runWorkflow(context: HostContext, input: RunInput): Promise<RunExecution> {
  const loaded = await loadRun(context, input.runId);
  if (loaded.snapshot.integrity !== "valid") {
    throw new WorkflowHostError(
      "integrity_uncertain",
      "The run cannot execute with uncertain state.",
    );
  }
  if (!["created", "reopened", "paused"].includes(loaded.snapshot.status)) {
    throw new WorkflowHostError(
      "run_state_invalid",
      "The run is not executable in its current state.",
    );
  }
  const pending = context.pending.get(input.runId);
  const source = input.source;
  const args = input.args === undefined ? undefined : asJsonValue(input.args, "resupplied args");
  if (source === undefined || args === undefined) {
    throw new WorkflowHostError(
      "resume_input_required",
      "The workflow source and args must be resupplied to resume this run.",
    );
  }
  await assertInputIdentity(loaded.snapshot.definition, source, args);
  const controller = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) {
      controller.abort();
    } else {
      input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  const active = {
    controller,
    operationControllers: new Map<string, AbortController>(),
    calls: 0,
    maxCalls: 0,
    maxConcurrency: 0,
  };
  context.active.set(input.runId, active);
  await changeState(context, loaded.snapshot, "running", "execution started");
  const definition = loaded.snapshot.definition;
  const planResult = resolvePlanSelection({
    plan: definition.identity.plan,
    service_tier: definition.identity.service_tier,
  });
  if (!planResult.ok) {
    context.active.delete(input.runId);
    throw new WorkflowHostError("invalid_plan", "The persisted plan is no longer recognized.");
  }
  const effectiveLimits = effectiveRuntimeLimits(context, planResult.value.plan);
  active.maxCalls =
    effectiveLimits.maxOperationCount ?? planResult.value.plan.budget?.maxCalls ?? 0;
  active.maxConcurrency =
    effectiveLimits.maxConcurrentOperations ?? planResult.value.plan.budget?.maxConcurrency ?? 0;
  const startedAt = Date.now();
  let result: WorkflowResult;
  try {
    result = await context.evaluator({
      source,
      args,
      cwd: context.cwd,
      runtime: {
        schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCH,
        run_id: input.runId,
        plan: definition.identity.plan,
        route: definition.identity.route,
      },
      limits: effectiveLimits,
      signal: controller.signal,
      operationHandler: (operation) =>
        handleOperation(context, definition, planResult.value.plan, active, operation),
    });
  } catch {
    result = {
      ok: false,
      error: new WorkflowRuntimeError("evaluation_failed", "The workflow evaluation failed."),
    };
  }
  context.active.delete(input.runId);
  const latest = await loadRun(context, input.runId);
  const uncertainOperation = latest.journal.some(
    (event) => event.event === "operation" && event.lifecycle.state === "uncertain",
  );
  if (uncertainOperation) {
    const blocked = await changeState(
      context,
      latest.snapshot,
      "blocked",
      "an external operation has uncertain effect",
    );
    releaseReservation(context, input.runId);
    await emitTelemetry(context, {
      event: "run",
      run_id: definition.run_id,
      route: definition.identity.route,
      status: "blocked",
      duration_ms: Date.now() - startedAt,
      count: 1,
      error_code: "uncertain-effect",
      replayed: false,
    });
    return {
      runId: definition.run_id,
      status: blocked.status,
      result,
      inspection: await inspect(context, definition.run_id),
    };
  }
  if (latest.snapshot.status === "paused" || latest.snapshot.status === "stopped") {
    if (latest.snapshot.status === "stopped") {
      releaseReservation(context, input.runId);
    }
    return {
      runId: definition.run_id,
      status: latest.snapshot.status,
      result,
      inspection: await inspect(context, definition.run_id),
    };
  }
  if (result.ok) {
    await writeCheckpoint(
      context,
      latest.snapshot,
      pending?.objective ?? "[redacted objective unavailable]",
      pending?.constraints ?? [],
      {
        verifiedEvidence: ["workflow evaluation completed"],
        decisions: [],
        phases: ["evaluation"],
        activeWork: [],
        unresolvedWork: [],
        blockers: [],
        verification: ["runtime returned a validated result"],
        retainedSummaries: [],
        nextActions: [],
        usageCompleteness: "complete",
        recoverableErrors: [],
      },
    );
    const completed = await changeState(
      context,
      (await loadRun(context, input.runId)).snapshot,
      "completed",
      "execution completed",
    );
    releaseReservation(context, input.runId);
    await emitTelemetry(context, {
      event: "run",
      run_id: definition.run_id,
      route: definition.identity.route,
      status: "completed",
      duration_ms: Date.now() - startedAt,
      count: 1,
      error_code: null,
      replayed: false,
    });
    return {
      runId: definition.run_id,
      status: completed.status,
      result,
      inspection: await inspect(context, definition.run_id),
    };
  }
  const failed = await changeState(
    context,
    (await loadRun(context, input.runId)).snapshot,
    "failed",
    "workflow evaluation failed",
  );
  releaseReservation(context, input.runId);
  await emitTelemetry(context, {
    event: "run",
    run_id: definition.run_id,
    route: definition.identity.route,
    status: "failed",
    duration_ms: Date.now() - startedAt,
    count: 1,
    error_code: "runtime-failure",
    replayed: false,
  });
  return {
    runId: definition.run_id,
    status: failed.status,
    result,
    inspection: await inspect(context, definition.run_id),
  };
}
