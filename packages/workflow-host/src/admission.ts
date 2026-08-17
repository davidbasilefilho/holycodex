// SPDX-License-Identifier: Apache-2.0

import type { PlanDefinition } from "@holycodex/core";
import { type } from "arktype";
import type { WorkflowLimitsInput } from "@holycodex/workflow-runtime";
import { WorkflowHostError } from "./errors.ts";
import type { HostCapacity, HostContext } from "./types.ts";

const FiniteNonNegativeNumberSchema = type("number").narrow(
  (value): value is number => Number.isFinite(value) && value >= 0,
);
const HostCapacitySchema = type({
  "+": "reject",
  "maxCalls?": "number.integer >= 0",
  "maxConcurrency?": "number.integer >= 0",
  "maxRetries?": "number.integer >= 0",
  "maxFanOut?": "number.integer >= 0",
  "costMax?": FiniteNonNegativeNumberSchema,
});

export function normalizeHostCapacity(input: unknown): HostCapacity {
  const parsed = HostCapacitySchema(input);
  if (parsed instanceof type.errors) {
    throw new WorkflowHostError("invalid_input", "The workflow host capacity is invalid.");
  }
  return parsed;
}

export function admit(
  context: HostContext,
  plan: PlanDefinition,
  cost: number,
  calls: number,
  concurrency: number,
  retries: number,
  fanOut: number,
): void {
  const budget = plan.budget;
  if (!budget || !Number.isFinite(cost) || cost < 0 || cost > budget.costMax) {
    throw new WorkflowHostError(
      "cost_limit",
      "The run exceeds the plan hard cost admission limit.",
    );
  }
  const maxCost = Math.min(budget.costMax, context.capacity.costMax ?? Number.POSITIVE_INFINITY);
  if (context.reservedCost + cost > maxCost) {
    throw new WorkflowHostError("cost_limit", "Live cost capacity is exhausted.");
  }
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
}

export function releaseReservation(context: HostContext, runId: string): void {
  const reservation = context.reservations.get(runId);
  if (reservation === undefined) {
    return;
  }
  context.reservations.delete(runId);
  context.reservedCost = Math.max(0, context.reservedCost - reservation);
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
