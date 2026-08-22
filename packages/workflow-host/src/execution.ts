// SPDX-License-Identifier: Apache-2.0

import { resolvePlanSelection } from "@holycodex/core";
import * as Effect from "effect/Effect";
import {
  CompileOptionsSchema,
  WorkflowRuntimeError,
  type CompileOptions,
  type WorkflowResult,
} from "@holycodex/workflow-runtime";
import { WorkflowHostError } from "./errors.ts";
import {
  effectiveCompileOptions,
  effectiveRuntimeLimits,
  releaseReservation,
} from "./admission.ts";
import { asJsonValue, assertInputIdentity } from "./identity.ts";
import { compileHostWorkflow, runCompiledWorkflow } from "./effect-runtime.ts";
import { normalizeDelegationMode, parseDelegationMode } from "./creation.ts";
import { changeState, inspect, loadRun, writeCheckpoint, emitTelemetry } from "./lifecycle.ts";
import { handleOperation } from "./operation.ts";
import { decodeHostSchema, WORKFLOW_HOST_SCHEMA_EPOCH } from "./schemas.ts";
import type { HostContext, RunExecution, RunInput } from "./types.ts";

function decodePersistedCompileOptions(input: unknown): CompileOptions | undefined {
  const parsed = decodeHostSchema(CompileOptionsSchema, input);
  if (parsed === undefined) {
    return undefined;
  }
  const capacity = parsed.capacity;
  return {
    ...(parsed.capabilities === undefined ? {} : { capabilities: parsed.capabilities }),
    ...(parsed.dependencies === undefined ? {} : { dependencies: parsed.dependencies }),
    ...(parsed.maxNodes === undefined ? {} : { maxNodes: parsed.maxNodes }),
    ...(capacity === undefined
      ? {}
      : {
          capacity: {
            ...(capacity.planConcurrency === undefined
              ? {}
              : { planConcurrency: capacity.planConcurrency }),
            ...(capacity.sessionConcurrency === undefined
              ? {}
              : { sessionConcurrency: capacity.sessionConcurrency }),
            ...(capacity.codexConcurrency === undefined
              ? {}
              : { codexConcurrency: capacity.codexConcurrency }),
            ...(capacity.maxRetries === undefined ? {} : { maxRetries: capacity.maxRetries }),
            ...(capacity.maxCalls === undefined ? {} : { maxCalls: capacity.maxCalls }),
            ...(capacity.costMax === undefined ? {} : { costMax: capacity.costMax }),
          },
        }),
  };
}

export async function runWorkflow(context: HostContext, input: RunInput): Promise<RunExecution> {
  const previous = context.executionLocks.get(input.runId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => runWorkflowExclusive(context, input));
  const next: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  context.executionLocks.set(input.runId, next);
  try {
    return await result;
  } finally {
    if (context.executionLocks.get(input.runId) === next) {
      context.executionLocks.delete(input.runId);
    }
  }
}

async function runWorkflowExclusive(context: HostContext, input: RunInput): Promise<RunExecution> {
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
  const descriptor = loaded.snapshot.workflow;
  const source = input.source ?? descriptor?.source;
  const args =
    input.args === undefined ? descriptor?.args : asJsonValue(input.args, "resupplied args");
  const executionMode =
    input.executionMode ??
    descriptor?.execution_mode ??
    (input.workflow ? "native" : context.compatibilityEnabled ? "compatibility" : undefined);
  const objective = pending?.objective ?? descriptor?.objective ?? "workflow";
  const constraints = pending?.constraints ?? descriptor?.constraints ?? [];
  const persistedCompileOptions: CompileOptions | undefined =
    descriptor?.compile_options === undefined
      ? undefined
      : decodePersistedCompileOptions(descriptor.compile_options);
  const suppliedDelegationMode = parseDelegationMode(input.delegationMode);
  const persistedDelegationMode = descriptor?.delegation_mode;
  if (
    persistedDelegationMode !== undefined &&
    suppliedDelegationMode !== undefined &&
    persistedDelegationMode !== suppliedDelegationMode
  ) {
    throw new WorkflowHostError(
      "invalid_input",
      "The supplied delegation mode conflicts with the persisted workflow mode.",
    );
  }
  if (source === undefined || args === undefined || executionMode === undefined) {
    throw new WorkflowHostError(
      "resume_input_required",
      "The persisted workflow descriptor is incomplete; source and args are required to resume.",
    );
  }
  await assertInputIdentity(loaded.snapshot.definition, source, args);
  const definition = loaded.snapshot.definition;
  const planResult = resolvePlanSelection({
    plan: definition.identity.plan,
    service_tier: definition.identity.service_tier,
  });
  if (!planResult.ok) {
    throw new WorkflowHostError("invalid_plan", "The persisted plan is no longer recognized.");
  }
  const effectiveLimits = effectiveRuntimeLimits(context, planResult.value.plan);
  const workflow = input.workflow ?? pending?.workflow;
  let compiledPlan = pending?.compiledPlan;
  let compileOptions: CompileOptions | undefined;
  let delegationMode: NonNullable<typeof persistedDelegationMode>;
  if (executionMode !== "native" && executionMode !== "compatibility") {
    throw new WorkflowHostError("invalid_input", "The workflow execution mode is invalid.");
  }
  if (executionMode === "native") {
    if (workflow === undefined) {
      throw new WorkflowHostError(
        "resume_input_required",
        "The native workflow terminal must be supplied when resuming in a new host process.",
      );
    }
    compileOptions = effectiveCompileOptions(
      context,
      planResult.value.plan,
      input.compileOptions ??
        pending?.compileOptions ??
        persistedCompileOptions ??
        context.compileOptions,
    );
    if (
      input.workflow !== undefined ||
      compiledPlan === undefined ||
      input.compileOptions !== undefined
    ) {
      try {
        compiledPlan = await Effect.runPromise(compileHostWorkflow(workflow, compileOptions));
      } catch (error) {
        throw new WorkflowHostError(
          "invalid_input",
          "The immutable workflow could not be compiled under the persisted delegation mode.",
          {},
          { cause: error },
        );
      }
    }
    delegationMode = normalizeDelegationMode({
      requested: persistedDelegationMode ?? suppliedDelegationMode,
      executionMode,
      nativeNodeCount: compiledPlan?.nodes.length,
      expectedCalls: 0,
      expectedCallsProvided: false,
    });
  } else if (persistedDelegationMode !== undefined) {
    if (persistedDelegationMode === "DIRECT") {
      normalizeDelegationMode({
        requested: persistedDelegationMode,
        executionMode,
        expectedCalls: 0,
        expectedCallsProvided: false,
      });
    }
    delegationMode = persistedDelegationMode;
  } else {
    delegationMode = normalizeDelegationMode({
      requested: suppliedDelegationMode,
      executionMode,
      expectedCalls: 0,
      expectedCallsProvided: false,
    });
  }
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
    maxCalls: effectiveLimits.maxOperationCount ?? planResult.value.plan.budget?.maxCalls ?? 0,
    maxConcurrency:
      effectiveLimits.maxConcurrentOperations ?? planResult.value.plan.budget?.maxConcurrency ?? 0,
    maxCost: Math.min(
      planResult.value.plan.budget?.costMax ?? 0,
      context.capacity.costMax ?? planResult.value.plan.budget?.costMax ?? 0,
    ),
    inFlight: 0,
    costUnits: 0,
  };
  context.active.set(input.runId, active);
  try {
    await changeState(context, loaded.snapshot, "running", "execution started");
  } catch (error) {
    context.active.delete(input.runId);
    throw error;
  }
  const startedAt = Date.now();
  let result: WorkflowResult;
  try {
    if (executionMode === "native") {
      const runtimePending = {
        objective,
        constraints,
        ...(workflow === undefined ? {} : { workflow }),
        ...(compileOptions === undefined ? {} : { compileOptions }),
        ...(compiledPlan === undefined ? {} : { compiledPlan }),
      };
      const compiled = await Effect.runPromise(
        runCompiledWorkflow(
          context,
          definition,
          runtimePending,
          active,
          args,
          compileOptions ?? context.compileOptions,
        ),
      );
      result = {
        ok: true,
        value: asJsonValue(compiled.value, "workflow result"),
      };
    } else if (executionMode === "compatibility") {
      const evaluator = context.compatibilityEvaluator;
      if (evaluator === undefined) {
        throw new WorkflowHostError(
          "capability_denied",
          "The explicitly requested compatibility evaluator is unavailable.",
        );
      }
      result = await evaluator({
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
    } else {
      throw new WorkflowHostError("invalid_input", "The workflow execution mode is invalid.");
    }
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
    await releaseReservation(context, input.runId);
    await emitTelemetry(context, {
      event: "run",
      run_id: definition.run_id,
      route: definition.identity.route,
      delegation_mode: delegationMode,
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
  if (latest.snapshot.status === "denied") {
    await releaseReservation(context, input.runId);
    return {
      runId: definition.run_id,
      status: latest.snapshot.status,
      result,
      inspection: await inspect(context, definition.run_id),
    };
  }
  if (latest.snapshot.status === "paused" || latest.snapshot.status === "stopped") {
    if (latest.snapshot.status === "stopped") {
      await releaseReservation(context, input.runId);
    }
    return {
      runId: definition.run_id,
      status: latest.snapshot.status,
      result,
      inspection: await inspect(context, definition.run_id),
    };
  }
  if (result.ok) {
    await writeCheckpoint(context, latest.snapshot, objective, constraints, {
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
    });
    const completed = await changeState(
      context,
      (await loadRun(context, input.runId)).snapshot,
      "completed",
      "execution completed",
    );
    await releaseReservation(context, input.runId);
    await emitTelemetry(context, {
      event: "run",
      run_id: definition.run_id,
      route: definition.identity.route,
      delegation_mode: delegationMode,
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
  await releaseReservation(context, input.runId);
  await emitTelemetry(context, {
    event: "run",
    run_id: definition.run_id,
    route: definition.identity.route,
    delegation_mode: delegationMode,
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
