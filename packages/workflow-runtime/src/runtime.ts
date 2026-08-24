// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "@holycodex/core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  readSymbolicSource,
  type Assignment,
  type WorkflowInputSource,
  type WorkflowOutput,
  type WorkflowOutputTarget,
} from "./dsl.ts";
import {
  type CompiledNode,
  type ExecutionPlan,
  type PlanCapacity,
  type PlanTerminal,
} from "./compiler.ts";
import { isWorkflowFailure, workflowFailure, type WorkflowFailure } from "./errors.ts";

export type CapacityDispatchRequest = Readonly<{
  readonly runId: string;
  readonly maxCalls: number;
  readonly maxConcurrency: number;
  readonly maxCost: number;
  readonly estimatedCost: number;
}>;

export type CapacitySettlement = Readonly<{
  readonly costUnits: number;
}>;

export type CapacityRunReservationRequest = Readonly<{
  readonly runId: string;
  readonly calls: number;
  readonly costUnits: number;
  readonly maxCalls: number;
  readonly maxCost: number;
}>;

export type CapacityLease = Readonly<{
  readonly estimatedCost: number;
  /** Commits measured or conservative cost; call exactly once per admitted dispatch. */
  readonly settle: (settlement: CapacitySettlement) => Effect.Effect<void, WorkflowFailure>;
  /** Releases only the live concurrency slot; calls and committed cost remain counted. */
  readonly release: Effect.Effect<void>;
}>;

export type CapacityRunReservation = Readonly<{
  readonly release: Effect.Effect<void>;
}>;

export type CapacityRunRestoreRequest = Readonly<{
  readonly runId: string;
  readonly maxCalls: number;
  readonly maxConcurrency: number;
  readonly maxCost: number;
  readonly calls: number;
  readonly committedCost: number;
  readonly reservedCost: number;
  readonly overflow: boolean;
}>;

export type CapacityLedgerSnapshot = Readonly<{
  readonly calls: number;
  readonly inFlight: number;
  readonly committedCost: number;
  readonly reservedCost: number;
  readonly overflow: boolean;
}>;

export type CapacityService = Readonly<{
  /** Retained public semaphores for callers that compose additional scopes. */
  readonly plan: Effect.Semaphore;
  readonly session: Effect.Semaphore;
  readonly codex: Effect.Semaphore;
  /** Atomic per-run dispatch admission and shared concurrency accounting. */
  readonly acquire: (
    request: CapacityDispatchRequest,
  ) => Effect.Effect<CapacityLease, WorkflowFailure>;
  /** Atomic admission for a run that has not started dispatching yet. */
  readonly reserveRun: (
    request: CapacityRunReservationRequest,
  ) => Effect.Effect<CapacityRunReservation, WorkflowFailure>;
  /** Restores persisted committed and outstanding ledger values without double charging. */
  readonly restoreRun: (request: CapacityRunRestoreRequest) => Effect.Effect<void, WorkflowFailure>;
  readonly snapshot: (
    runId: string,
  ) => Effect.Effect<CapacityLedgerSnapshot | undefined, WorkflowFailure>;
  /** Releases run-local reservations while shared committed totals remain counted. */
  readonly releaseRun: (runId: string) => Effect.Effect<void>;
}>;

export type WorkflowJournalEvent = Readonly<{
  readonly type: "started" | "completed" | "failed" | "skipped";
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly reason?: "condition_false" | "early_termination";
  readonly failure?: WorkflowFailure;
}>;

export type WorkflowApprovalRequest = Readonly<{
  readonly runId: string;
  readonly nodeId: string;
  readonly name: string;
}>;

export type WorkflowVerificationRequest = Readonly<{
  readonly runId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly output: unknown;
}>;

export type WorkflowCheckpoint = Readonly<{
  readonly runId: string;
  readonly nodeId: string;
  readonly output: unknown;
}>;

/** Internal scheduler ports are Effect-native; Promise adapters belong at host edges. */
export interface WorkflowHostServices {
  readonly route?: (
    node: Readonly<{ readonly nodeId: string; readonly name: string }>,
  ) => Effect.Effect<string, WorkflowFailure>;
  readonly agent?: Readonly<{
    readonly execute: (
      assignment: Assignment<unknown, unknown>,
    ) => Effect.Effect<unknown, WorkflowFailure>;
  }>;
  readonly journal?: (event: WorkflowJournalEvent) => Effect.Effect<void, WorkflowFailure>;
  readonly approval?: (request: WorkflowApprovalRequest) => Effect.Effect<void, WorkflowFailure>;
  readonly verification?: (
    request: WorkflowVerificationRequest,
  ) => Effect.Effect<void, WorkflowFailure>;
  readonly durability?: Readonly<{
    readonly checkpoint: (event: WorkflowCheckpoint) => Effect.Effect<void, WorkflowFailure>;
  }>;
}

export type WorkflowRuntimeOptions = Readonly<{
  readonly capacity: CapacityService;
  readonly services?: WorkflowHostServices;
  readonly runId?: string;
  /** Optional exact internal hard-cost units supplied by a public host boundary. */
  readonly costMax?: number;
  /** Host-owned provider bridges perform the single external admission themselves. */
  readonly externalAdmission?: boolean;
}>;

export function makeCapacityService(
  capacity: PlanCapacity,
): Effect.Effect<CapacityService, WorkflowFailure> {
  if (
    !Number.isSafeInteger(capacity.planConcurrency) ||
    capacity.planConcurrency < 1 ||
    !Number.isSafeInteger(capacity.sessionConcurrency) ||
    capacity.sessionConcurrency < 1 ||
    !Number.isSafeInteger(capacity.codexConcurrency) ||
    capacity.codexConcurrency < 1 ||
    !Number.isSafeInteger(capacity.maxRetries) ||
    capacity.maxRetries < 0 ||
    (capacity.maxCalls !== undefined &&
      (!Number.isSafeInteger(capacity.maxCalls) || capacity.maxCalls < 0)) ||
    (capacity.costMax !== undefined &&
      (!Number.isSafeInteger(capacity.costMax) || capacity.costMax < 0))
  ) {
    return Effect.fail(workflowFailure("capacity", "The shared workflow capacity is invalid."));
  }
  return Effect.gen(function* () {
    const plan = yield* Effect.makeSemaphore(capacity.planConcurrency);
    const session = yield* Effect.makeSemaphore(capacity.sessionConcurrency);
    const codex = yield* Effect.makeSemaphore(capacity.codexConcurrency);
    const transaction = yield* Effect.makeSemaphore(1);
    const state: CapacityState = {
      runs: new Map(),
      committedByRun: new Map(),
      inFlight: 0,
      globalCost: 0,
      globalCalls: 0,
      overflow: false,
    };
    const globalConcurrency = Math.min(
      capacity.planConcurrency,
      capacity.sessionConcurrency,
      capacity.codexConcurrency,
    );
    const globalCostMax = capacity.costMax ?? Number.MAX_SAFE_INTEGER;
    const globalCallsMax = capacity.maxCalls ?? Number.MAX_SAFE_INTEGER;

    const acquire = (
      request: CapacityDispatchRequest,
    ): Effect.Effect<CapacityLease, WorkflowFailure> =>
      transaction.withPermits(1)(
        Effect.gen(function* () {
          const invalid = validateDispatchRequest(request);
          if (invalid !== undefined) {
            return yield* Effect.fail(invalid);
          }
          if (state.overflow) {
            return yield* Effect.fail(
              workflowFailure(
                "settlement_overflow",
                "The workflow cost ledger is closed after an overage.",
                { retryable: false },
              ),
            );
          }
          const existing = state.runs.get(request.runId);
          const run = existing ?? createRunState(request);
          if (run.maxCalls !== request.maxCalls || run.maxCost !== request.maxCost) {
            run.maxCalls = Math.min(run.maxCalls, request.maxCalls);
            run.maxCost = Math.min(run.maxCost, request.maxCost);
          }
          if (run.calls >= run.maxCalls) {
            return yield* Effect.fail(
              workflowFailure("admission_exceeded", "The workflow call capacity was exhausted."),
            );
          }
          if (state.globalCalls >= globalCallsMax) {
            return yield* Effect.fail(
              workflowFailure(
                "admission_exceeded",
                "The shared workflow call capacity was exhausted.",
              ),
            );
          }
          if (run.inFlight >= request.maxConcurrency || state.inFlight >= globalConcurrency) {
            return yield* Effect.fail(
              workflowFailure(
                "admission_exceeded",
                "The workflow concurrency capacity was exhausted.",
              ),
            );
          }
          const plannedCoverage = Math.min(run.plannedCost, request.estimatedCost);
          const incrementalReservation = request.estimatedCost - plannedCoverage;
          const nextRunCost = safeSum([
            run.committedCost,
            run.plannedCost,
            run.outstandingCost,
            incrementalReservation,
          ]);
          if (nextRunCost === undefined || nextRunCost > run.maxCost) {
            return yield* Effect.fail(
              workflowFailure("admission_exceeded", "The workflow cost capacity was exhausted."),
            );
          }
          const nextGlobalCost = safeAdd(state.globalCost, incrementalReservation);
          if (nextGlobalCost === undefined || nextGlobalCost > globalCostMax) {
            return yield* Effect.fail(
              workflowFailure(
                "admission_exceeded",
                "The shared workflow cost capacity was exhausted.",
              ),
            );
          }
          if (existing === undefined) {
            state.runs.set(request.runId, run);
          }
          run.calls += 1;
          run.inFlight += 1;
          run.plannedCost -= plannedCoverage;
          run.outstandingCost += request.estimatedCost;
          state.inFlight += 1;
          state.globalCalls += 1;
          state.globalCost = nextGlobalCost;
          let released = false;
          let settled = false;
          return {
            estimatedCost: request.estimatedCost,
            settle: (settlement: CapacitySettlement) =>
              transaction.withPermits(1)(
                Effect.gen(function* () {
                  const invalidSettlement = validateSettlement(settlement);
                  if (invalidSettlement !== undefined) {
                    return yield* Effect.fail(invalidSettlement);
                  }
                  if (settled) {
                    return;
                  }
                  if (
                    state.runs.get(request.runId) !== run ||
                    run.outstandingCost < request.estimatedCost
                  ) {
                    return yield* Effect.fail(
                      workflowFailure(
                        "ledger_corruption",
                        "The workflow cost lease is no longer tracked.",
                      ),
                    );
                  }
                  settled = true;
                  run.outstandingCost -= request.estimatedCost;
                  const nextCommittedCost = safeAdd(run.committedCost, settlement.costUnits);
                  const remainingGlobalCost = state.globalCost - request.estimatedCost;
                  const nextGlobalCost = safeAdd(remainingGlobalCost, settlement.costUnits);
                  run.committedCost = nextCommittedCost ?? Number.MAX_SAFE_INTEGER;
                  state.globalCost = nextGlobalCost ?? Number.MAX_SAFE_INTEGER;
                  state.committedByRun.set(request.runId, {
                    calls: run.calls,
                    cost: run.committedCost,
                  });
                  const runTotal = safeSum([
                    run.committedCost,
                    run.plannedCost,
                    run.outstandingCost,
                  ]);
                  const runOverflow =
                    nextCommittedCost === undefined ||
                    runTotal === undefined ||
                    runTotal > run.maxCost;
                  const globalOverflow =
                    nextGlobalCost === undefined || state.globalCost > globalCostMax;
                  if (runOverflow || globalOverflow) {
                    run.overflow = true;
                    state.overflow = true;
                    return yield* Effect.fail(
                      workflowFailure(
                        "settlement_overflow",
                        "Measured workflow cost exceeded the hard budget.",
                        { retryable: false },
                      ),
                    );
                  }
                }),
              ),
            release: transaction.withPermits(1)(
              Effect.sync(() => {
                if (released) {
                  return;
                }
                released = true;
                run.inFlight = Math.max(0, run.inFlight - 1);
                state.inFlight = Math.max(0, state.inFlight - 1);
              }),
            ),
          } satisfies CapacityLease;
        }),
      );

    const reserveRun = (
      request: CapacityRunReservationRequest,
    ): Effect.Effect<CapacityRunReservation, WorkflowFailure> =>
      transaction.withPermits(1)(
        Effect.gen(function* () {
          const invalid = validateReservationRequest(request);
          if (invalid !== undefined) {
            return yield* Effect.fail(invalid);
          }
          if (request.calls > request.maxCalls || request.costUnits > request.maxCost) {
            return yield* Effect.fail(
              workflowFailure("admission_exceeded", "The run exceeds its admitted capacity."),
            );
          }
          const existing = state.runs.get(request.runId);
          if (existing !== undefined) {
            return yield* Effect.fail(
              workflowFailure("capacity", "The workflow run is already admitted."),
            );
          }
          const nextGlobalCost = safeAdd(state.globalCost, request.costUnits);
          if (state.overflow || nextGlobalCost === undefined || nextGlobalCost > globalCostMax) {
            return yield* Effect.fail(
              workflowFailure(
                "admission_exceeded",
                "The shared workflow cost capacity was exhausted.",
              ),
            );
          }
          const run: CapacityRunState = {
            calls: 0,
            inFlight: 0,
            plannedCost: request.costUnits,
            outstandingCost: 0,
            reservedCalls: request.calls,
            committedCost: 0,
            maxCalls: request.maxCalls,
            maxCost: request.maxCost,
            overflow: false,
          };
          state.runs.set(request.runId, run);
          state.globalCost = nextGlobalCost;
          let released = false;
          return {
            release: transaction.withPermits(1)(
              Effect.sync(() => {
                if (released) {
                  return;
                }
                released = true;
                const current = state.runs.get(request.runId);
                if (current !== run) {
                  return;
                }
                state.runs.delete(request.runId);
                state.inFlight = Math.max(0, state.inFlight - current.inFlight);
                state.globalCost = Math.max(
                  0,
                  state.globalCost - current.plannedCost - current.outstandingCost,
                );
              }),
            ),
          } satisfies CapacityRunReservation;
        }),
      );

    const restoreRun = (request: CapacityRunRestoreRequest): Effect.Effect<void, WorkflowFailure> =>
      transaction.withPermits(1)(
        Effect.gen(function* () {
          const invalid = validateRestoreRequest(request);
          if (invalid !== undefined) {
            return yield* Effect.fail(invalid);
          }
          const existing = state.runs.get(request.runId);
          if (existing !== undefined) {
            if (
              existing.calls !== request.calls ||
              existing.committedCost !== request.committedCost ||
              existing.outstandingCost + existing.plannedCost !== request.reservedCost
            ) {
              return yield* Effect.fail(
                workflowFailure(
                  "ledger_corruption",
                  "The persisted workflow ledger conflicts with live state.",
                ),
              );
            }
            return;
          }
          const prior = state.committedByRun.get(request.runId);
          if (
            prior !== undefined &&
            (prior.calls !== request.calls || prior.cost !== request.committedCost)
          ) {
            return yield* Effect.fail(
              workflowFailure(
                "ledger_corruption",
                "The persisted workflow ledger was changed unexpectedly.",
              ),
            );
          }
          const additionalCommitted = prior === undefined ? request.committedCost : 0;
          const additionalCalls = prior === undefined ? request.calls : 0;
          const nextGlobalCost = safeSum([
            state.globalCost,
            additionalCommitted,
            request.reservedCost,
          ]);
          const nextGlobalCalls = safeAdd(state.globalCalls, additionalCalls);
          if (
            nextGlobalCost === undefined ||
            nextGlobalCost > globalCostMax ||
            nextGlobalCalls === undefined ||
            nextGlobalCalls > globalCallsMax
          ) {
            return yield* Effect.fail(
              workflowFailure(
                "ledger_corruption",
                "The persisted workflow ledger exceeds shared capacity.",
              ),
            );
          }
          state.globalCost = nextGlobalCost;
          state.globalCalls = nextGlobalCalls;
          state.committedByRun.set(request.runId, {
            calls: request.calls,
            cost: request.committedCost,
          });
          state.runs.set(request.runId, {
            calls: request.calls,
            inFlight: 0,
            plannedCost: 0,
            outstandingCost: request.reservedCost,
            reservedCalls: 0,
            committedCost: request.committedCost,
            maxCalls: request.maxCalls,
            maxCost: request.maxCost,
            overflow: request.overflow,
          });
          if (request.overflow) {
            state.overflow = true;
          }
        }),
      );

    const snapshot = (
      runId: string,
    ): Effect.Effect<CapacityLedgerSnapshot | undefined, WorkflowFailure> =>
      transaction.withPermits(1)(
        Effect.sync(() => {
          const run = state.runs.get(runId);
          if (run === undefined) {
            return undefined;
          }
          return {
            calls: run.calls,
            inFlight: run.inFlight,
            committedCost: run.committedCost,
            reservedCost:
              safeSum([run.plannedCost, run.outstandingCost]) ?? Number.MAX_SAFE_INTEGER,
            overflow: state.overflow || run.overflow,
          } satisfies CapacityLedgerSnapshot;
        }),
      );

    const releaseRun = (runId: string): Effect.Effect<void> =>
      transaction.withPermits(1)(
        Effect.sync(() => {
          const run = state.runs.get(runId);
          if (run === undefined) {
            return;
          }
          state.runs.delete(runId);
          state.inFlight = Math.max(0, state.inFlight - run.inFlight);
          state.globalCost = Math.max(0, state.globalCost - run.plannedCost - run.outstandingCost);
        }),
      );

    return {
      plan,
      session,
      codex,
      acquire,
      reserveRun,
      restoreRun,
      snapshot,
      releaseRun,
    } satisfies CapacityService;
  });
}

type CapacityRunState = {
  calls: number;
  inFlight: number;
  plannedCost: number;
  outstandingCost: number;
  reservedCalls: number;
  committedCost: number;
  maxCalls: number;
  maxCost: number;
  overflow: boolean;
};

type CapacityState = {
  readonly runs: Map<string, CapacityRunState>;
  readonly committedByRun: Map<string, Readonly<{ readonly calls: number; readonly cost: number }>>;
  inFlight: number;
  globalCost: number;
  globalCalls: number;
  overflow: boolean;
};

function createRunState(request: CapacityDispatchRequest): CapacityRunState {
  const run: CapacityRunState = {
    calls: 0,
    inFlight: 0,
    plannedCost: 0,
    outstandingCost: 0,
    reservedCalls: 0,
    committedCost: 0,
    maxCalls: request.maxCalls,
    maxCost: request.maxCost,
    overflow: false,
  };
  return run;
}

function validateDispatchRequest(request: CapacityDispatchRequest): WorkflowFailure | undefined {
  if (
    request.runId.length === 0 ||
    !Number.isSafeInteger(request.maxCalls) ||
    request.maxCalls < 0 ||
    !Number.isSafeInteger(request.maxConcurrency) ||
    request.maxConcurrency < 1 ||
    !Number.isSafeInteger(request.maxCost) ||
    request.maxCost < 0 ||
    !Number.isSafeInteger(request.estimatedCost) ||
    request.estimatedCost <= 0
  ) {
    return workflowFailure(
      "ledger_corruption",
      "The workflow dispatch capacity request is invalid.",
    );
  }
  return undefined;
}

function validateSettlement(settlement: CapacitySettlement): WorkflowFailure | undefined {
  return Number.isSafeInteger(settlement.costUnits) && settlement.costUnits >= 0
    ? undefined
    : workflowFailure("measurement_malformed", "The measured workflow cost is invalid.");
}

function validateReservationRequest(
  request: CapacityRunReservationRequest,
): WorkflowFailure | undefined {
  if (
    request.runId.length === 0 ||
    !Number.isSafeInteger(request.calls) ||
    request.calls < 0 ||
    !Number.isSafeInteger(request.maxCalls) ||
    request.maxCalls < 0 ||
    !Number.isSafeInteger(request.costUnits) ||
    request.costUnits < 0 ||
    !Number.isSafeInteger(request.maxCost) ||
    request.maxCost < 0
  ) {
    return workflowFailure("ledger_corruption", "The workflow run capacity request is invalid.");
  }
  return undefined;
}

function validateRestoreRequest(request: CapacityRunRestoreRequest): WorkflowFailure | undefined {
  const totalCost = safeSum([request.committedCost, request.reservedCost]);
  if (
    request.runId.length === 0 ||
    !Number.isSafeInteger(request.maxCalls) ||
    request.maxCalls < 0 ||
    !Number.isSafeInteger(request.maxConcurrency) ||
    request.maxConcurrency < 1 ||
    !Number.isSafeInteger(request.maxCost) ||
    request.maxCost < 0 ||
    !Number.isSafeInteger(request.calls) ||
    request.calls < 0 ||
    !Number.isSafeInteger(request.committedCost) ||
    request.committedCost < 0 ||
    !Number.isSafeInteger(request.reservedCost) ||
    request.reservedCost < 0 ||
    request.calls > request.maxCalls ||
    totalCost === undefined ||
    totalCost > request.maxCost
  ) {
    return workflowFailure("ledger_corruption", "The persisted workflow ledger is invalid.");
  }
  return undefined;
}

function runtimeEstimate(capacity: PlanCapacity): number {
  const maxCalls = Math.max(1, capacity.maxCalls ?? 1);
  const costMax =
    capacity.costMax === undefined || capacity.costMax === Number.MAX_SAFE_INTEGER
      ? maxCalls
      : capacity.costMax;
  const estimate = Math.max(1, Math.ceil(costMax / maxCalls));
  return Number.isSafeInteger(estimate) ? estimate : Number.MAX_SAFE_INTEGER;
}

function safeAdd(left: number, right: number): number | undefined {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    return undefined;
  }
  return left + right;
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    const next = safeAdd(total, value);
    if (next === undefined) {
      return undefined;
    }
    total = next;
  }
  return total;
}

export function runExecutionPlan<T>(
  plan: ExecutionPlan<T>,
  input: unknown,
  options: WorkflowRuntimeOptions,
): Effect.Effect<T, WorkflowFailure> {
  const runId = options.runId ?? plan.terminals[0]?.runId ?? "workflow-run";
  const program = Effect.scoped(
    Effect.gen(function* () {
      const results = new Map<string, unknown>();
      const nodes = new Map(plan.nodes.map((node) => [node.id, node] as const));
      const planGate = yield* Effect.makeSemaphore(plan.capacity.planConcurrency);

      for (let layerIndex = 0; layerIndex < plan.layers.length; layerIndex += 1) {
        const layer = plan.layers[layerIndex] ?? [];
        const outcomes = yield* Effect.forEach(
          layer,
          (nodeId) => {
            const node = nodes.get(nodeId);
            if (node === undefined) {
              return Effect.fail(
                workflowFailure("execution", "The execution plan node is missing.", {
                  nodeId,
                }),
              );
            }
            return runNode(node, results, input, runId, plan.capacity, planGate, options);
          },
          { concurrency: "unbounded" },
        );
        if (outcomes.some((outcome) => outcome.stop)) {
          for (let laterLayer = layerIndex + 1; laterLayer < plan.layers.length; laterLayer += 1) {
            for (const nodeId of plan.layers[laterLayer] ?? []) {
              if (results.has(nodeId)) {
                continue;
              }
              const node = nodes.get(nodeId);
              if (node === undefined) {
                return yield* Effect.fail(
                  workflowFailure("execution", "The execution plan node is missing.", {
                    nodeId,
                  }),
                );
              }
              yield* skipNode(node, results, runId, options.services, "early_termination");
            }
          }
          break;
        }
      }

      const rawResult = assembleTerminalResult(plan, results);
      return yield* Effect.try({
        try: () => plan.decodeResult(rawResult),
        catch: (cause) =>
          workflowFailure("validation", "The workflow result shape is invalid.", { cause }),
      });
    }),
  );

  return program.pipe(
    Effect.ensuring(options.capacity.releaseRun(runId)),
    Effect.catchAllCause((cause) => {
      for (const failure of Cause.failures(cause)) {
        if (isWorkflowFailure(failure)) {
          return Effect.fail(failure);
        }
      }
      if (Cause.isInterruptedOnly(cause)) {
        return Effect.fail(workflowFailure("interruption", "The workflow run was interrupted."));
      }
      return Effect.fail(workflowFailure("execution", "The workflow execution failed."));
    }),
  );
}

/** Sole public Promise adapter; all scheduler composition remains Effect-native. */
export function runExecutionPlanPromise<T>(
  plan: ExecutionPlan<T>,
  input: unknown,
  options: WorkflowRuntimeOptions,
): Promise<T> {
  return Effect.runPromise(runExecutionPlan(plan, input, options));
}

function runNode(
  node: CompiledNode,
  results: Map<string, unknown>,
  rootInput: unknown,
  runId: string,
  capacity: PlanCapacity,
  planGate: Effect.Semaphore,
  options: WorkflowRuntimeOptions,
): Effect.Effect<NodeRunResult, WorkflowFailure> {
  let attempt = 0;
  const program: Effect.Effect<NodeRunResult, WorkflowFailure> = Effect.gen(function* () {
    const condition = node.metadata.when;
    if (condition !== undefined) {
      const sourceOutput = results.get(condition.source);
      const matches = yield* predicateMatches(
        sourceOutput,
        condition.path,
        condition.equals,
        node.id,
      );
      if (!matches) {
        yield* skipNode(node, results, runId, options.services, "condition_false");
        return { stop: false } satisfies NodeRunResult;
      }
    }
    const input = yield* Effect.try({
      try: () => nodeInput(node, results, rootInput),
      catch: (cause) =>
        isWorkflowFailure(cause)
          ? cause
          : workflowFailure("compilation", "The workflow dependency graph is malformed.", {
              nodeId: node.id,
              cause,
            }),
    });
    const services = options.services;
    const agent = services?.agent;
    const repeatUntil = node.metadata.repeatUntil;
    let previousFingerprint: string | undefined;
    const maxIterations = repeatUntil?.maxIterations ?? 1;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const output = yield* runNodeIteration(
        node,
        input,
        results,
        runId,
        capacity,
        planGate,
        options,
        agent,
        () => {
          attempt += 1;
          return attempt;
        },
      );
      results.set(node.id, output);
      const stop =
        node.metadata.stopWhen === undefined
          ? false
          : yield* predicateMatches(
              output,
              node.metadata.stopWhen.path,
              node.metadata.stopWhen.equals,
              node.id,
            );
      if (stop || repeatUntil === undefined) {
        return { stop } satisfies NodeRunResult;
      }
      const repeated = yield* predicateMatches(
        output,
        repeatUntil.path,
        repeatUntil.equals,
        node.id,
      );
      if (repeated) {
        return { stop: false } satisfies NodeRunResult;
      }
      const fingerprint = yield* outputFingerprint(output, node.id);
      if (previousFingerprint === fingerprint) {
        return yield* Effect.fail(
          workflowFailure("no_progress", "The workflow repeat condition made no progress.", {
            nodeId: node.id,
            retryable: false,
          }),
        );
      }
      previousFingerprint = fingerprint;
    }
    return yield* Effect.fail(
      workflowFailure("iteration_limit", "The workflow repeat iteration limit was exhausted.", {
        nodeId: node.id,
        retryable: false,
      }),
    );
  });
  return program.pipe(
    Effect.catchAll((failure) =>
      notifyJournal(options.services, {
        type: "failed",
        runId,
        nodeId: node.id,
        attempt: Math.max(1, attempt),
        failure,
      }).pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.andThen(Effect.fail(failure)),
      ),
    ),
  );
}

type NodeRunResult = Readonly<{ readonly stop: boolean }>;

function runNodeIteration(
  node: CompiledNode,
  input: unknown,
  results: Map<string, unknown>,
  runId: string,
  capacity: PlanCapacity,
  planGate: Effect.Semaphore,
  options: WorkflowRuntimeOptions,
  agent: WorkflowHostServices["agent"] | undefined,
  nextAttempt: () => number,
): Effect.Effect<unknown, WorkflowFailure> {
  const services = options.services;
  let currentAttempt = 0;
  const task = Effect.suspend(() => {
    const attempt = nextAttempt();
    currentAttempt = attempt;
    const validatedInput = decodeInput(node, input);
    const routed: Effect.Effect<string | undefined, WorkflowFailure> =
      services?.route === undefined
        ? Effect.succeed(undefined)
        : services
            .route({ nodeId: node.id, name: node.name })
            .pipe(Effect.mapError((cause) => toExecutionFailure(cause, node.id)));
    const dispatch = routed.pipe(
      Effect.flatMap((route) => {
        if (agent === undefined) {
          return Effect.fail(
            workflowFailure("execution", "The workflow host agent service is required.", {
              nodeId: node.id,
            }),
          );
        }
        const assignment = materializeAssignment(
          node.assignment,
          validatedInput,
          results,
          route,
          attempt,
        );
        const approval =
          services?.approval === undefined
            ? Effect.void
            : services.approval({ runId, nodeId: node.id, name: node.name });
        const admitted = Effect.gen(function* () {
          const executed = agent.execute(assignment).pipe(
            Effect.mapError((cause) => toExecutionFailure(cause, node.id)),
            Effect.flatMap((raw) =>
              Effect.try({
                try: () => decodeOutput(node, raw),
                catch: (cause) => toExecutionFailure(cause, node.id),
              }),
            ),
          );
          if (options.externalAdmission === true) {
            return yield* executed;
          }
          const runtimeCostMax = options.costMax ?? capacity.costMax ?? Number.MAX_SAFE_INTEGER;
          const estimatedCost = runtimeEstimate({ ...capacity, costMax: runtimeCostMax });
          const lease = yield* options.capacity.acquire({
            runId,
            maxCalls: capacity.maxCalls ?? Number.MAX_SAFE_INTEGER,
            maxConcurrency: Math.min(
              capacity.planConcurrency,
              capacity.sessionConcurrency,
              capacity.codexConcurrency,
            ),
            maxCost: runtimeCostMax,
            estimatedCost,
          });
          return yield* executed.pipe(
            Effect.catchAllCause((cause) =>
              lease
                .settle({ costUnits: estimatedCost })
                .pipe(Effect.andThen(Effect.failCause(cause))),
            ),
            Effect.tap(() => lease.settle({ costUnits: estimatedCost })),
            Effect.ensuring(lease.release),
          );
        });
        return approval.pipe(Effect.andThen(admitted));
      }),
    );
    return notifyJournal(services, {
      type: "started",
      runId,
      nodeId: node.id,
      attempt,
    }).pipe(Effect.andThen(dispatch));
  });
  const retried =
    node.metadata.retries === 0
      ? task
      : Effect.retryOrElse(
          task,
          Schedule.recurs(node.metadata.retries).pipe(
            Schedule.whileInput((failure: WorkflowFailure) => failure.retryable !== false),
          ),
          () =>
            Effect.fail(
              workflowFailure("retry_exhausted", "The workflow retry schedule was exhausted.", {
                nodeId: node.id,
              }),
            ),
        );
  const timed =
    node.metadata.timeoutMs === undefined
      ? retried
      : Effect.timeoutFail({
          duration: `${node.metadata.timeoutMs} millis`,
          onTimeout: () =>
            workflowFailure("timeout", "The workflow step timed out.", { nodeId: node.id }),
        })(retried);
  return options.capacity.codex
    .withPermits(1)(
      options.capacity.session.withPermits(1)(
        options.capacity.plan.withPermits(1)(planGate.withPermits(1)(timed)),
      ),
    )
    .pipe(
      Effect.flatMap((output) =>
        notifyJournal(services, {
          type: "completed",
          runId,
          nodeId: node.id,
          attempt: currentAttempt,
        }).pipe(
          Effect.andThen(
            services?.verification === undefined
              ? Effect.void
              : services.verification({ runId, nodeId: node.id, name: node.name, output }),
          ),
          Effect.andThen(
            services?.durability === undefined
              ? Effect.void
              : services.durability.checkpoint({ runId, nodeId: node.id, output }),
          ),
          Effect.andThen(Effect.succeed(output)),
        ),
      ),
    );
}

function skipNode(
  node: CompiledNode,
  results: Map<string, unknown>,
  runId: string,
  services: WorkflowHostServices | undefined,
  reason: "condition_false" | "early_termination",
): Effect.Effect<void, WorkflowFailure> {
  return notifyJournal(services, {
    type: "skipped",
    runId,
    nodeId: node.id,
    attempt: 0,
    reason,
  }).pipe(
    Effect.andThen(
      Effect.sync(() => {
        results.set(node.id, {
          status: "skipped",
          reason,
          node_id: node.id,
        });
      }),
    ),
  );
}

function predicateMatches(
  value: unknown,
  path: readonly string[],
  expected: unknown,
  nodeId: string,
): Effect.Effect<boolean, WorkflowFailure> {
  return Effect.try({
    try: () => {
      const resolved = resolvePath(value, path);
      return resolved.found && canonicalJson(resolved.value) === canonicalJson(expected);
    },
    catch: (cause) =>
      workflowFailure("validation", "A workflow condition value is not JSON-compatible.", {
        nodeId,
        cause,
      }),
  });
}

function outputFingerprint(value: unknown, nodeId: string): Effect.Effect<string, WorkflowFailure> {
  return Effect.try({
    try: () => canonicalJson(value),
    catch: (cause) =>
      workflowFailure("validation", "A workflow output is not JSON-compatible.", {
        nodeId,
        cause,
      }),
  });
}

type ResolvedPath = Readonly<{ readonly found: boolean; readonly value?: unknown }>;

function resolvePath(value: unknown, path: readonly string[]): ResolvedPath {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!isArrayIndex(segment) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        return { found: false };
      }
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || current === null) {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { found: false };
    }
    current = descriptor.value;
  }
  return { found: true, value: current };
}

function isArrayIndex(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index < 4_294_967_295;
}

function nodeInput(
  node: CompiledNode,
  results: ReadonlyMap<string, unknown>,
  rootInput: unknown,
): unknown {
  return readInputSource(node.input, results, rootInput);
}

function readInputSource(
  source: WorkflowInputSource,
  results: ReadonlyMap<string, unknown>,
  rootInput: unknown,
): unknown {
  if (source.kind === "root") {
    return rootInput;
  }
  if (source.kind === "single") {
    if (!results.has(source.nodeId)) {
      throw workflowFailure("execution", "A workflow dependency has no completed result.", {
        nodeId: source.nodeId,
      });
    }
    return results.get(source.nodeId);
  }
  return assembleOutputTargets(source.targets, results);
}

function materializeAssignment(
  assignment: Assignment<unknown, unknown>,
  input: unknown,
  results: ReadonlyMap<string, unknown>,
  route: string | undefined,
  attempt: number,
): Assignment<unknown, unknown> {
  const payload =
    assignment.payload === undefined ? input : resolvePayload(assignment.payload, results);
  return Object.freeze({
    ...assignment,
    payload,
    metadata: { ...(assignment.metadata ?? {}), attempt },
    ...(route === undefined ? {} : { route }),
  });
}

function resolvePayload(
  value: unknown,
  results: ReadonlyMap<string, unknown>,
  seen = new Set<object>(),
): unknown {
  if (typeof value === "object" && value !== null) {
    const source = readSymbolicSource(value);
    if (source !== undefined) {
      return assembleWorkflowOutput(source, results);
    }
    if (seen.has(value)) {
      throw workflowFailure("validation", "The workflow assignment payload is cyclic.");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry) => resolvePayload(entry, results, seen));
      }
      const pairs = Object.entries(value).map(
        ([key, entry]) => [key, resolvePayload(entry, results, seen)] as const,
      );
      return Object.fromEntries(pairs);
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "function") {
    throw workflowFailure("validation", "The workflow assignment payload is executable.");
  }
  return value;
}

function assembleTerminalResult<T>(
  plan: ExecutionPlan<T>,
  results: ReadonlyMap<string, unknown>,
): unknown {
  if (plan.terminals.length === 1 && plan.terminals[0]?.key === "") {
    const terminal = plan.terminals[0];
    if (terminal === undefined) {
      throw workflowFailure("execution", "The workflow terminal has no result.");
    }
    return assembleTerminalValue(terminal, results);
  }
  const pairs: Array<readonly [string, unknown]> = [];
  for (const terminal of plan.terminals) {
    pairs.push([terminal.key, assembleTerminalValue(terminal, results)]);
  }
  return Object.fromEntries(pairs);
}

function assembleTerminalValue(
  terminal: PlanTerminal,
  results: ReadonlyMap<string, unknown>,
): unknown {
  const target = terminal.targets.length === 1 ? terminal.targets[0] : undefined;
  return target?.key === ""
    ? assembleOutputTarget(target, results)
    : assembleOutputTargets(terminal.targets, results);
}

function assembleWorkflowOutput(
  output: WorkflowOutput,
  results: ReadonlyMap<string, unknown>,
): unknown {
  if (output.kind === "single") {
    const value = results.get(output.nodeId);
    if (value === undefined && !results.has(output.nodeId)) {
      throw workflowFailure("execution", "A workflow output has no completed result.", {
        nodeId: output.nodeId,
      });
    }
    return value;
  }
  return assembleOutputTargets(output.targets, results);
}

function assembleOutputTargets(
  targets: readonly WorkflowOutputTarget[],
  results: ReadonlyMap<string, unknown>,
): unknown {
  const pairs: Array<readonly [string, unknown]> = [];
  for (const target of targets) {
    pairs.push([target.key, assembleOutputTarget(target, results)]);
  }
  return Object.fromEntries(pairs);
}

function assembleOutputTarget(
  target: WorkflowOutputTarget,
  results: ReadonlyMap<string, unknown>,
): unknown {
  if (target.source !== undefined) {
    return assembleWorkflowOutput(target.source, results);
  }
  if (!results.has(target.nodeId)) {
    throw workflowFailure("execution", "A workflow output target has no completed result.", {
      nodeId: target.nodeId,
    });
  }
  return results.get(target.nodeId);
}

function notifyJournal(
  services: WorkflowHostServices | undefined,
  event: WorkflowJournalEvent,
): Effect.Effect<void, WorkflowFailure> {
  if (services?.journal === undefined) {
    return Effect.void;
  }
  return services
    .journal(event)
    .pipe(Effect.mapError((cause) => toExecutionFailure(cause, event.nodeId)));
}

function decodeInput(node: CompiledNode, value: unknown): unknown {
  try {
    return node.inputCodec.decode(value);
  } catch (cause) {
    throw workflowFailure("validation", "The workflow assignment input is invalid.", {
      nodeId: node.id,
      cause,
    });
  }
}

function decodeOutput(node: CompiledNode, value: unknown): unknown {
  try {
    return node.outputCodec.decode(value);
  } catch (cause) {
    throw workflowFailure("validation", "The workflow assignment output is invalid.", {
      nodeId: node.id,
      cause,
    });
  }
}

function toExecutionFailure(cause: unknown, nodeId: string): WorkflowFailure {
  if (isWorkflowFailure(cause)) {
    return cause;
  }
  return workflowFailure("execution", "The workflow host operation failed.", { nodeId, cause });
}
