// SPDX-License-Identifier: Apache-2.0

import type { PlanDefinition } from "@holycodex/core";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type {
  CapacityLease,
  CapacityRunReservation,
  CompileOptions,
  WorkflowLimitsInput,
} from "@holycodex/workflow-runtime";
import { WorkflowHostError } from "./errors.ts";
import { decodeHostSchema } from "./schemas.ts";
import type { ActiveRun, HostCapacity, HostContext } from "./types.ts";

const FiniteNonNegativeNumberSchema = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && value >= 0),
);
const HostCapacitySchema = Schema.Struct({
  maxCalls: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  maxConcurrency: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  maxRetries: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  maxFanOut: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  costMax: Schema.optional(FiniteNonNegativeNumberSchema),
});

export function normalizeHostCapacity(input: unknown): HostCapacity {
  const parsed = decodeHostSchema(HostCapacitySchema, input);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The workflow host capacity is invalid.");
  }
  return {
    ...(parsed.maxCalls === undefined ? {} : { maxCalls: parsed.maxCalls }),
    ...(parsed.maxConcurrency === undefined ? {} : { maxConcurrency: parsed.maxConcurrency }),
    ...(parsed.maxRetries === undefined ? {} : { maxRetries: parsed.maxRetries }),
    ...(parsed.maxFanOut === undefined ? {} : { maxFanOut: parsed.maxFanOut }),
    ...(parsed.costMax === undefined ? {} : { costMax: parsed.costMax }),
  };
}

export async function admit(
  context: HostContext,
  plan: PlanDefinition,
  cost: number,
  calls: number,
  concurrency: number,
  retries: number,
  fanOut: number,
  runId: string,
): Promise<CapacityRunReservation> {
  const budget = plan.budget;
  if (!budget || !Number.isFinite(cost) || cost < 0 || cost > budget.costMax) {
    throw new WorkflowHostError(
      "cost_limit",
      "The run exceeds the plan hard cost admission limit.",
    );
  }
  const maxCost = Math.min(budget.costMax, context.capacity.costMax ?? Number.POSITIVE_INFINITY);
  const maxCalls = Math.min(budget.maxCalls, context.capacity.maxCalls ?? budget.maxCalls);
  const maxConcurrency = Math.min(
    budget.maxConcurrency,
    context.capacity.maxConcurrency ?? budget.maxConcurrency,
  );
  if (!Number.isInteger(calls) || calls < 0 || calls > maxCalls) {
    throw new WorkflowHostError("call_limit", "The run exceeds its live call capacity.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxConcurrency) {
    throw new WorkflowHostError(
      "concurrency_limit",
      "The run exceeds its live concurrency capacity.",
    );
  }
  if (!Number.isInteger(retries) || retries < 0 || retries > (context.capacity.maxRetries ?? 0)) {
    throw new WorkflowHostError("retry_limit", "The run exceeds its retry capacity.");
  }
  if (
    !Number.isInteger(fanOut) ||
    fanOut < 1 ||
    fanOut > (context.capacity.maxFanOut ?? maxConcurrency)
  ) {
    throw new WorkflowHostError("fan_out_limit", "The run exceeds its fan-out capacity.");
  }
  try {
    return await Effect.runPromise(
      context.sharedCapacity.reserveRun({
        runId,
        calls,
        costUnits: cost,
        maxCalls,
        maxCost,
      }),
    );
  } catch (error) {
    throw capacityError(error);
  }
}

export async function releaseReservation(context: HostContext, runId: string): Promise<void> {
  const reservation = context.reservations.get(runId);
  context.reservations.delete(runId);
  if (reservation !== undefined) {
    await Effect.runPromise(reservation.release);
  } else {
    await Effect.runPromise(context.sharedCapacity.releaseRun(runId));
  }
}

export async function acquireDispatch(
  context: HostContext,
  active: ActiveRun,
  runId: string,
): Promise<CapacityLease> {
  try {
    const lease = await Effect.runPromise(
      context.sharedCapacity.acquire({
        runId,
        maxCalls: active.maxCalls,
        maxConcurrency: active.maxConcurrency,
        maxCost: active.maxCost,
        costUnits: 1,
      }),
    );
    active.calls += 1;
    active.inFlight += 1;
    active.costUnits += 1;
    return lease;
  } catch (error) {
    throw capacityError(error);
  }
}

export function releaseDispatch(active: ActiveRun): void {
  active.inFlight = Math.max(0, active.inFlight - 1);
}

function capacityError(error: unknown): WorkflowHostError {
  const message = error instanceof Error ? error.message : "The workflow capacity was exhausted.";
  if (message.includes("call")) {
    return new WorkflowHostError("call_limit", message);
  }
  if (message.includes("concurr")) {
    return new WorkflowHostError("concurrency_limit", message);
  }
  return new WorkflowHostError("cost_limit", message);
}

export function effectiveRuntimeLimits(
  context: HostContext,
  plan: PlanDefinition,
): WorkflowLimitsInput {
  const budget = plan.budget;
  if (!budget) {
    throw new WorkflowHostError("go_rejected", "Go workflows cannot use the workflow host.");
  }
  const maxOperationCount = Math.min(
    budget.maxCalls,
    context.capacity.maxCalls ?? budget.maxCalls,
    context.runtimeLimits.maxOperationCount ?? budget.maxCalls,
  );
  const maxConcurrentOperations = Math.min(
    budget.maxConcurrency,
    context.capacity.maxConcurrency ?? budget.maxConcurrency,
    context.runtimeLimits.maxConcurrentOperations ?? budget.maxConcurrency,
  );
  return {
    ...context.runtimeLimits,
    maxOperationCount,
    maxConcurrentOperations,
  };
}

export function effectiveCompileOptions(
  context: HostContext,
  plan: PlanDefinition,
  requested: CompileOptions,
): CompileOptions {
  const budget = plan.budget;
  if (!budget) {
    throw new WorkflowHostError("go_rejected", "Go workflows cannot use the workflow host.");
  }
  const maxConcurrency = Math.min(
    budget.maxConcurrency,
    context.capacity.maxConcurrency ?? budget.maxConcurrency,
  );
  const maxRetries = Math.min(
    context.capacity.maxRetries ?? 0,
    requested.capacity?.maxRetries ?? 0,
  );
  const maxCalls = Math.min(
    budget.maxCalls,
    context.capacity.maxCalls ?? budget.maxCalls,
    requested.capacity?.maxCalls ?? budget.maxCalls,
  );
  const costMax = Math.min(
    budget.costMax,
    context.capacity.costMax ?? budget.costMax,
    requested.capacity?.costMax ?? budget.costMax,
  );
  return {
    ...requested,
    capacity: {
      ...requested.capacity,
      planConcurrency: Math.min(
        requested.capacity?.planConcurrency ?? maxConcurrency,
        maxConcurrency,
      ),
      sessionConcurrency: Math.min(
        requested.capacity?.sessionConcurrency ?? maxConcurrency,
        maxConcurrency,
      ),
      codexConcurrency: Math.min(
        requested.capacity?.codexConcurrency ?? maxConcurrency,
        maxConcurrency,
      ),
      maxRetries,
      maxCalls,
      costMax,
    },
  };
}
