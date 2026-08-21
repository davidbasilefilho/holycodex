// SPDX-License-Identifier: Apache-2.0

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
  readonly release: Effect.Effect<void>;
}>;

export type CapacityRunReservation = Readonly<{
  readonly release: Effect.Effect<void>;
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
  /** Releases all reservations and observed accounting for a completed run. */
  readonly releaseRun: (runId: string) => Effect.Effect<void>;
}>;

export type WorkflowJournalEvent = Readonly<{
  readonly type: "started" | "completed" | "failed";
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
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
}>;

export function makeCapacityService(
  capacity: PlanCapacity,
): Effect.Effect<CapacityService, WorkflowFailure> {
  if (
    !Number.isInteger(capacity.planConcurrency) ||
    capacity.planConcurrency < 1 ||
    !Number.isInteger(capacity.sessionConcurrency) ||
    capacity.sessionConcurrency < 1 ||
    !Number.isInteger(capacity.codexConcurrency) ||
    capacity.codexConcurrency < 1 ||
    !Number.isInteger(capacity.maxRetries) ||
    capacity.maxRetries < 0 ||
    (capacity.maxCalls !== undefined &&
      (!Number.isInteger(capacity.maxCalls) || capacity.maxCalls < 0)) ||
    (capacity.costMax !== undefined && (!Number.isFinite(capacity.costMax) || capacity.costMax < 0))
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
      inFlight: 0,
      globalCost: 0,
    };
    const globalConcurrency = Math.min(
      capacity.planConcurrency,
      capacity.sessionConcurrency,
      capacity.codexConcurrency,
    );
    const globalCostMax = capacity.costMax ?? Number.MAX_SAFE_INTEGER;

    const acquire = (
      request: CapacityDispatchRequest,
    ): Effect.Effect<CapacityLease, WorkflowFailure> =>
      transaction.withPermits(1)(
        Effect.gen(function* () {
          const invalid = validateDispatchRequest(request);
          if (invalid !== undefined) {
            return yield* Effect.fail(invalid);
          }
          const existing = state.runs.get(request.runId);
          const run = existing ?? createRunState(request);
          if (existing === undefined) {
            state.runs.set(request.runId, run);
          }
          if (run.maxCalls !== request.maxCalls || run.maxCost !== request.maxCost) {
            run.maxCalls = Math.min(run.maxCalls, request.maxCalls);
            run.maxCost = Math.min(run.maxCost, request.maxCost);
          }
          if (run.calls >= run.maxCalls) {
            return yield* Effect.fail(
              workflowFailure("capacity", "The workflow call capacity was exhausted."),
            );
          }
          if (run.inFlight >= request.maxConcurrency || state.inFlight >= globalConcurrency) {
            return yield* Effect.fail(
              workflowFailure("capacity", "The workflow concurrency capacity was exhausted."),
            );
          }
          const nextCost = run.costUnits + request.costUnits;
          if (nextCost > run.maxCost) {
            return yield* Effect.fail(
              workflowFailure("capacity", "The workflow cost capacity was exhausted."),
            );
          }
          const nextCommittedCost = additionalCost(run, nextCost);
          const nextGlobalCost = state.globalCost + nextCommittedCost - run.committedCost;
          if (nextGlobalCost > globalCostMax) {
            return yield* Effect.fail(
              workflowFailure("capacity", "The shared workflow cost capacity was exhausted."),
            );
          }
          run.calls += 1;
          run.inFlight += 1;
          run.costUnits = nextCost;
          run.committedCost = nextCommittedCost;
          state.inFlight += 1;
          state.globalCost = nextGlobalCost;
          let released = false;
          return {
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
              workflowFailure("capacity", "The run exceeds its admitted capacity."),
            );
          }
          const existing = state.runs.get(request.runId);
          if (existing !== undefined) {
            return yield* Effect.fail(
              workflowFailure("capacity", "The workflow run is already admitted."),
            );
          }
          if (state.globalCost + request.costUnits > globalCostMax) {
            return yield* Effect.fail(
              workflowFailure("capacity", "The shared workflow cost capacity was exhausted."),
            );
          }
          const run: CapacityRunState = {
            calls: 0,
            inFlight: 0,
            costUnits: 0,
            reservedCalls: request.calls,
            reservedCost: request.costUnits,
            committedCost: 0,
            maxCalls: request.maxCalls,
            maxCost: request.maxCost,
          };
          state.runs.set(request.runId, run);
          state.globalCost += request.costUnits;
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
                  state.globalCost - current.reservedCost - current.committedCost,
                );
              }),
            ),
          } satisfies CapacityRunReservation;
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
          state.globalCost = Math.max(0, state.globalCost - run.reservedCost - run.committedCost);
        }),
      );

    return { plan, session, codex, acquire, reserveRun, releaseRun } satisfies CapacityService;
  });
}

type CapacityRunState = {
  calls: number;
  inFlight: number;
  costUnits: number;
  reservedCalls: number;
  reservedCost: number;
  committedCost: number;
  maxCalls: number;
  maxCost: number;
};

type CapacityState = {
  readonly runs: Map<string, CapacityRunState>;
  inFlight: number;
  globalCost: number;
};

function createRunState(request: CapacityDispatchRequest): CapacityRunState {
  const run: CapacityRunState = {
    calls: 0,
    inFlight: 0,
    costUnits: 0,
    reservedCalls: 0,
    reservedCost: 0,
    committedCost: 0,
    maxCalls: request.maxCalls,
    maxCost: request.maxCost,
  };
  return run;
}

function additionalCost(run: CapacityRunState, nextCost: number): number {
  return Math.max(0, nextCost - run.reservedCost);
}

function validateDispatchRequest(request: CapacityDispatchRequest): WorkflowFailure | undefined {
  if (
    request.runId.length === 0 ||
    !Number.isInteger(request.maxCalls) ||
    request.maxCalls < 0 ||
    !Number.isInteger(request.maxConcurrency) ||
    request.maxConcurrency < 1 ||
    !Number.isFinite(request.maxCost) ||
    request.maxCost < 0 ||
    !Number.isFinite(request.costUnits) ||
    request.costUnits <= 0
  ) {
    return workflowFailure("capacity", "The workflow dispatch capacity request is invalid.");
  }
  return undefined;
}

function validateReservationRequest(
  request: CapacityRunReservationRequest,
): WorkflowFailure | undefined {
  if (
    request.runId.length === 0 ||
    !Number.isInteger(request.calls) ||
    request.calls < 0 ||
    !Number.isInteger(request.maxCalls) ||
    request.maxCalls < 0 ||
    !Number.isFinite(request.costUnits) ||
    request.costUnits < 0 ||
    !Number.isFinite(request.maxCost) ||
    request.maxCost < 0
  ) {
    return workflowFailure("capacity", "The workflow run capacity request is invalid.");
  }
  return undefined;
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

      for (const layer of plan.layers) {
        yield* Effect.forEach(
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
          { concurrency: "unbounded", discard: true },
        );
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
): Effect.Effect<void, WorkflowFailure> {
  let attempt = 0;
  const program: Effect.Effect<void, WorkflowFailure> = Effect.gen(function* () {
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
    const task = Effect.suspend(() => {
      attempt += 1;
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
            const lease = yield* options.capacity.acquire({
              runId,
              maxCalls: capacity.maxCalls ?? Number.MAX_SAFE_INTEGER,
              maxConcurrency: Math.min(
                capacity.planConcurrency,
                capacity.sessionConcurrency,
                capacity.codexConcurrency,
              ),
              maxCost: capacity.costMax ?? Number.MAX_SAFE_INTEGER,
              costUnits: 1,
            });
            const executed = agent.execute(assignment).pipe(
              Effect.mapError((cause) => toExecutionFailure(cause, node.id)),
              Effect.flatMap((raw) =>
                Effect.try({
                  try: () => decodeOutput(node, raw),
                  catch: (cause) => toExecutionFailure(cause, node.id),
                }),
              ),
            );
            return yield* executed.pipe(Effect.ensuring(lease.release));
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
        : Effect.retryOrElse(task, Schedule.recurs(node.metadata.retries), () =>
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
    const output = yield* options.capacity.codex.withPermits(1)(
      options.capacity.session.withPermits(1)(
        options.capacity.plan.withPermits(1)(planGate.withPermits(1)(timed)),
      ),
    );
    yield* notifyJournal(services, {
      type: "completed",
      runId,
      nodeId: node.id,
      attempt,
    });
    if (services?.verification !== undefined) {
      yield* services.verification({ runId, nodeId: node.id, name: node.name, output });
    }
    if (services?.durability !== undefined) {
      yield* services.durability.checkpoint({ runId, nodeId: node.id, output });
    }
    results.set(node.id, output);
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
