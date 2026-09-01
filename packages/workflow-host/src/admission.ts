// SPDX-License-Identifier: Apache-2.0

import type { PlanDefinition } from "@holycodex/core";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  isWorkflowFailure,
  type CapacityLease,
  type CapacityLedgerSnapshot,
  type CapacityRunReservation,
  type CompileOptions,
  type WorkflowLimitsInput,
} from "@holycodex/workflow-runtime";
import {
  conservativeSettlement,
  costJournal,
  costMaxToUnits,
  estimatePlanCost,
  settleUsage,
  type CostEstimate,
  type CostJournal,
  type CostSettlement,
} from "./cost.ts";
import { WorkflowHostError } from "./errors.ts";
import { decodeHostSchema, type JournalEvent, type OperationLifecycle } from "./schemas.ts";
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
  route: PlanDefinition["routes"][number],
  serviceTier: PlanDefinition["defaultServiceTier"],
): Promise<CapacityRunReservation> {
  const budget = plan.budget;
  if (!budget || !Number.isFinite(cost) || cost < 0) {
    throw new WorkflowHostError(
      "cost_limit",
      "The run exceeds the plan hard cost admission limit.",
    );
  }
  const maxCost = Math.min(
    costMaxToUnits(budget.costMax),
    context.capacity.costMax === undefined
      ? Number.MAX_SAFE_INTEGER
      : costMaxToUnits(context.capacity.costMax),
  );
  const maxCalls = Math.min(budget.maxCalls, context.capacity.maxCalls ?? budget.maxCalls);
  if (!Number.isInteger(calls) || calls < 0 || calls > maxCalls) {
    throw new WorkflowHostError("call_limit", "The run exceeds its live call capacity.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new WorkflowHostError(
      "concurrency_limit",
      "The run exceeds its live concurrency capacity.",
    );
  }
  if (!Number.isInteger(retries) || retries < 0 || retries > (context.capacity.maxRetries ?? 0)) {
    throw new WorkflowHostError("retry_limit", "The run exceeds its retry capacity.");
  }
  if (!Number.isInteger(fanOut) || fanOut < 1) {
    throw new WorkflowHostError("fan_out_limit", "The run exceeds its fan-out capacity.");
  }
  const derivedCost = estimatePlanCost({
    route,
    serviceTier,
    calls: Math.max(1, calls),
    retries,
  });
  const suppliedCost = cost === 0 ? 0 : costMaxToUnits(cost);
  const plannedCost = Math.max(derivedCost, suppliedCost);
  if (plannedCost > maxCost) {
    throw new WorkflowHostError(
      "cost_limit",
      "The run exceeds the plan hard cost admission limit.",
    );
  }
  try {
    return await Effect.runPromise(
      context.sharedCapacity.reserveRun({
        runId,
        calls,
        costUnits: plannedCost,
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
  estimate: CostEstimate,
): Promise<CapacityLease> {
  try {
    const lease = await Effect.runPromise(
      context.sharedCapacity.acquire({
        runId,
        maxCalls: active.maxCalls,
        maxConcurrency: active.maxConcurrency,
        maxCost: active.maxCost,
        estimatedCost: estimate.units,
      }),
    );
    active.calls += 1;
    active.inFlight += 1;
    active.costUnits += estimate.units;
    return lease;
  } catch (error) {
    throw capacityError(error);
  }
}

export function releaseDispatch(active: ActiveRun): void {
  active.inFlight = Math.max(0, active.inFlight - 1);
}

export async function capacitySnapshot(
  context: HostContext,
  runId: string,
): Promise<CapacityLedgerSnapshot> {
  const snapshot = await Effect.runPromise(context.sharedCapacity.snapshot(runId));
  if (snapshot === undefined) {
    throw new WorkflowHostError(
      "ledger_corruption",
      "The workflow capacity ledger has no entry for the active run.",
    );
  }
  return snapshot;
}

export async function settleDispatch(
  context: HostContext,
  runId: string,
  lease: CapacityLease,
  estimate: CostEstimate,
  usage: unknown,
): Promise<Readonly<{ readonly journal: CostJournal; readonly failure?: WorkflowHostError }>> {
  let settlement: CostSettlement;
  let failure: WorkflowHostError | undefined;
  try {
    settlement = settleUsage(usage, estimate);
  } catch (error) {
    settlement = conservativeSettlement(estimate, "partial");
    failure = new WorkflowHostError(
      "measurement_malformed",
      "The provider usage measurement is malformed; the conservative reservation was committed.",
      {},
      { cause: error },
    );
  }
  try {
    await Effect.runPromise(lease.settle({ costUnits: settlement.costUnits }));
  } catch (error) {
    failure ??= capacityError(error);
  }
  const snapshot = await capacitySnapshot(context, runId);
  return {
    journal: costJournal(estimate, settlement, snapshot),
    ...(failure === undefined ? {} : { failure }),
  };
}

export async function restoreReservation(
  context: HostContext,
  plan: PlanDefinition,
  runId: string,
  journal: readonly JournalEvent[],
): Promise<
  Readonly<{
    readonly calls: number;
    readonly committedCost: number;
    readonly reservedCost: number;
  }>
> {
  const budget = plan.budget;
  if (budget === null) {
    throw new WorkflowHostError("go_rejected", "Go workflows cannot use the workflow host.");
  }
  const ledger = ledgerFromJournal(journal);
  const maxCalls = Math.min(
    budget.maxCalls,
    context.capacity.maxCalls ?? budget.maxCalls,
    context.runtimeLimits.maxOperationCount ?? budget.maxCalls,
  );
  const maxConcurrency = Math.min(
    budget.maxConcurrency,
    context.capacity.maxConcurrency ?? budget.maxConcurrency,
    context.runtimeLimits.maxConcurrentOperations ?? budget.maxConcurrency,
  );
  const maxCost = Math.min(
    costMaxToUnits(budget.costMax),
    context.capacity.costMax === undefined
      ? Number.MAX_SAFE_INTEGER
      : costMaxToUnits(context.capacity.costMax),
  );
  try {
    await Effect.runPromise(
      context.sharedCapacity.restoreRun({
        runId,
        maxCalls,
        maxConcurrency,
        maxCost,
        ...ledger,
      }),
    );
  } catch (error) {
    throw capacityError(error);
  }
  return ledger;
}

function ledgerFromJournal(journal: readonly JournalEvent[]): Readonly<{
  readonly calls: number;
  readonly committedCost: number;
  readonly reservedCost: number;
  readonly overflow: boolean;
}> {
  const latestByOperation = new Map<string, OperationLifecycle>();
  let latestAccounting: NonNullable<OperationLifecycle["cost_accounting"]> | undefined;
  let overflow = false;
  for (const event of journal) {
    if (event.event !== "operation") {
      continue;
    }
    latestByOperation.set(event.lifecycle.operation.operation_id, event.lifecycle);
    const accounting = event.lifecycle.cost_accounting;
    if (accounting !== undefined) {
      latestAccounting = accounting;
      overflow ||= accounting.overflow;
    }
    overflow ||= event.lifecycle.error_code === "settlement_overflow";
  }
  const calls = [...latestByOperation.values()].filter(
    (lifecycle) =>
      lifecycle.cost_accounting !== undefined &&
      lifecycle.state !== "waiting_for_approval" &&
      lifecycle.state !== "approved" &&
      lifecycle.state !== "denied",
  ).length;
  return {
    calls,
    committedCost: latestAccounting?.committed_units ?? 0,
    reservedCost: latestAccounting?.reserved_units ?? 0,
    overflow,
  };
}

function capacityError(error: unknown): WorkflowHostError {
  if (error instanceof WorkflowHostError) {
    return error;
  }
  if (isWorkflowFailure(error)) {
    if (error.code === "settlement_overflow") {
      return new WorkflowHostError("settlement_overflow", error.message);
    }
    if (error.code === "ledger_corruption") {
      return new WorkflowHostError("ledger_corruption", error.message);
    }
    if (error.code === "measurement_malformed") {
      return new WorkflowHostError("measurement_malformed", error.message);
    }
    if (error.code === "estimate_unavailable") {
      return new WorkflowHostError("estimate_unavailable", error.message);
    }
    if (error.code === "admission_exceeded") {
      if (error.message.includes("call")) {
        return new WorkflowHostError("call_limit", error.message);
      }
      if (error.message.includes("concurr")) {
        return new WorkflowHostError("concurrency_limit", error.message);
      }
      return new WorkflowHostError("cost_limit", error.message);
    }
  }
  const message = error instanceof Error ? error.message : "The workflow capacity was exhausted.";
  if (message.includes("settlement") || message.includes("overage")) {
    return new WorkflowHostError("settlement_overflow", message);
  }
  if (message.includes("ledger")) {
    return new WorkflowHostError("ledger_corruption", message);
  }
  if (message.includes("measurement")) {
    return new WorkflowHostError("measurement_malformed", message);
  }
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
