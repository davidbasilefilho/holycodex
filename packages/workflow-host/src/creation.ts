// SPDX-License-Identifier: Apache-2.0

import {
  DelegationModeSchema,
  lookupRoute,
  resolvePlanSelection,
  type DelegationMode,
} from "@holycodex/core";
import * as Effect from "effect/Effect";
import type { ExecutionPlan } from "@holycodex/workflow-runtime";
import { compileHostWorkflow } from "./effect-runtime.ts";
import {
  IdentityComponentsSchema,
  JournalEventSchema,
  RunSnapshotSchema,
  WORKFLOW_HOST_SCHEMA_EPOCHS,
  decodeHostSchema,
  type IdentityComponents,
  type CompatibilityCardinality,
  type JournalEvent,
  type RunDefinition,
  type RunSnapshot,
  type WorkflowDescriptor,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import { admit, effectiveCompileOptions } from "./admission.ts";
import {
  asJsonValue,
  assertIdentifier,
  buildIdentity,
  DEFAULT_ROUTE,
  MAX_PENDING_TEXT,
  now,
  randomId,
  jsonObject,
  safeText,
  safeTextArray,
  classifyCompatibilityCardinality,
} from "./identity.ts";
import type { CreateRunInput, HostContext, WorkflowExecutionMode } from "./types.ts";
import { emitTelemetry } from "./lifecycle.ts";

export function parseDelegationMode(value: unknown): DelegationMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = decodeHostSchema(DelegationModeSchema, value);
  if (parsed === undefined) {
    throw new WorkflowHostError("invalid_input", "The delegation mode is invalid.");
  }
  return parsed;
}

export function normalizeDelegationMode(
  input: Readonly<{
    readonly requested: unknown;
    readonly executionMode: WorkflowExecutionMode;
    readonly nativeNodeCount?: number;
    readonly compatibilityCardinality?: CompatibilityCardinality;
  }>,
): DelegationMode {
  const requested = parseDelegationMode(input.requested);
  if (requested === "DIRECT") {
    throw new WorkflowHostError(
      "admission_denied",
      "DIRECT delegation remains with Root and cannot enter the workflow host.",
    );
  }
  if (input.executionMode === "native") {
    const nodeCount = input.nativeNodeCount;
    if (nodeCount === undefined || nodeCount < 1) {
      throw new WorkflowHostError(
        "invalid_input",
        "A native workflow must contain at least one compiled node.",
      );
    }
    const derived = nodeCount === 1 ? "SINGLE" : "DYNAMIC_WORKFLOW";
    if (requested !== undefined && requested !== derived) {
      throw new WorkflowHostError(
        "admission_denied",
        "The requested delegation mode does not match native workflow cardinality.",
      );
    }
    return requested ?? derived;
  }
  const cardinality = input.compatibilityCardinality;
  const derived =
    cardinality?.status === "proven" && cardinality.expected_calls <= 1
      ? "SINGLE"
      : "DYNAMIC_WORKFLOW";
  if (requested === undefined) {
    return derived;
  }
  const matches = requested === derived;
  if (!matches) {
    throw new WorkflowHostError(
      "admission_denied",
      "The requested delegation mode does not match compatibility call cardinality.",
    );
  }
  return requested;
}

export async function createRun(
  context: HostContext,
  input: CreateRunInput,
): Promise<RunDefinition> {
  if (
    typeof input.source !== "string" ||
    input.source.length === 0 ||
    input.source.length > 1024 * 1024
  ) {
    throw new WorkflowHostError("invalid_input", "The workflow source is empty or too large.");
  }
  const args = asJsonValue(input.args, "workflow args");
  if (typeof input.objective !== "string") {
    throw new WorkflowHostError("invalid_input", "The workflow objective is required.");
  }
  const objective = safeText(input.objective, MAX_PENDING_TEXT);
  if (objective.length === 0) {
    throw new WorkflowHostError("invalid_input", "The workflow objective is required.");
  }
  const requestedPlan =
    typeof input.plan === "string" ? { plan: input.plan } : (input.plan ?? { plan: "plus" });
  const selection = resolvePlanSelection(requestedPlan);
  if (!selection.ok) {
    throw new WorkflowHostError("invalid_plan", "The requested plan is not in the core catalog.");
  }
  if (selection.value.plan.name === "Go" || !selection.value.plan.workflowEnabled) {
    throw new WorkflowHostError("go_rejected", "Go workflows cannot use the workflow host.");
  }
  const serviceTier = input.serviceTier ?? selection.value.serviceTier;
  const route = input.route ?? DEFAULT_ROUTE;
  const routeResult = lookupRoute(selection.value.plan.name, route);
  if (!routeResult.ok) {
    throw new WorkflowHostError(
      "invalid_route",
      "The requested route is unavailable for the plan.",
    );
  }
  const estimatedCost = input.estimatedCost ?? 0;
  const expectedCalls = input.expectedCalls;
  const expectedConcurrency = input.expectedConcurrency ?? 1;
  const expectedRetries = input.expectedRetries ?? 0;
  const expectedFanOut = input.expectedFanOut ?? 1;
  const requestedDelegationMode = parseDelegationMode(input.delegationMode);
  const executionMode =
    input.executionMode ??
    (input.workflow === undefined
      ? context.compatibilityEnabled
        ? "compatibility"
        : undefined
      : "native");
  if (executionMode === undefined) {
    throw new WorkflowHostError(
      "invalid_input",
      "A native workflow terminal or explicit compatibility mode is required.",
    );
  }
  if (executionMode === "native" && input.workflow === undefined) {
    throw new WorkflowHostError(
      "invalid_input",
      "The native workflow execution path requires an immutable workflow terminal.",
    );
  }
  if (executionMode === "compatibility" && expectedRetries > 0) {
    throw new WorkflowHostError(
      "retry_limit",
      "Compatibility workflow retries are unsupported; use native workflow retries.",
    );
  }
  const runId = randomId("run");
  const compileOptions = effectiveCompileOptions(
    context,
    selection.value.plan,
    input.compileOptions ?? context.compileOptions,
  );
  let compiledPlan: ExecutionPlan<unknown> | undefined;
  if (input.workflow !== undefined) {
    try {
      compiledPlan = await Effect.runPromise(compileHostWorkflow(input.workflow, compileOptions));
    } catch (error) {
      throw new WorkflowHostError(
        "invalid_input",
        "The immutable workflow could not be compiled under the selected plan.",
        {},
        { cause: error },
      );
    }
  }
  const compatibilityCardinality =
    executionMode === "compatibility"
      ? await classifyCompatibilityCardinality({
          source: input.source,
          expectedCalls,
          proofDigest: input.expectedCallsProofDigest,
        })
      : undefined;
  const delegationMode = normalizeDelegationMode({
    requested: requestedDelegationMode,
    executionMode,
    ...(compiledPlan === undefined ? {} : { nativeNodeCount: compiledPlan.nodes.length }),
    ...(compatibilityCardinality === undefined ? {} : { compatibilityCardinality }),
  });
  const workflowExecution: import("./schemas.ts").WorkflowExecutionIdentity = {
    execution_mode: executionMode,
    delegation_mode: delegationMode,
    compatibility_cardinality:
      executionMode === "compatibility"
        ? (compatibilityCardinality ?? { status: "unknown" })
        : null,
  };

  const lineage = input.objectiveLineage ?? randomId("lineage");
  const parentRunId = input.parentRunId ?? null;
  const identity: IdentityComponents = await buildIdentity({
    source: input.source,
    args,
    plan: selection.value.plan,
    route,
    serviceTier,
    role: routeResult.value.role,
    context,
    ...(input.workflow === undefined ? {} : { nativeWorkflow: input.workflow }),
    ...(compileOptions === undefined ? {} : { compileOptions }),
    ...(workflowExecution === undefined ? {} : { workflowExecution }),
  });
  const definition: RunDefinition = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    run_id: runId,
    objective_lineage: assertIdentifier(lineage, "objective lineage"),
    parent_run_id: parentRunId === null ? null : assertIdentifier(parentRunId, "parent run id"),
    created_at: now(),
    identity,
  };
  const descriptor: WorkflowDescriptor = {
    schema_epoch: "host-workflow-1.0",
    execution_mode: executionMode,
    delegation_mode: delegationMode,
    ...(compatibilityCardinality === undefined
      ? {}
      : { compatibility_cardinality: compatibilityCardinality }),
    execution_identity: workflowExecution,
    source: input.source,
    args,
    ...(input.sourcePath === undefined ? {} : { source_path: input.sourcePath }),
    objective,
    constraints: safeTextArray(input.constraints),
    ...(input.compileOptions === undefined
      ? {}
      : {
          compile_options: jsonObject(
            asJsonValue(input.compileOptions, "compile options"),
            "compile options",
          ),
        }),
  };
  const snapshot: RunSnapshot = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    definition,
    status: "created",
    revision: 0,
    checkpoint: null,
    integrity: "valid",
    updated_at: now(),
    workflow: descriptor,
  };
  const parsedSnapshot = decodeHostSchema(RunSnapshotSchema, snapshot);
  if (parsedSnapshot === undefined) {
    throw new WorkflowHostError("invalid_input", "The run snapshot could not be formed.");
  }
  const event: JournalEvent = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
    event: "run-created",
    run_id: runId,
    sequence: 1,
    at: now(),
    definition,
  };
  const parsedEvent = decodeHostSchema(JournalEventSchema, event);
  if (parsedEvent === undefined) {
    throw new WorkflowHostError("invalid_input", "The run journal could not be formed.");
  }
  const reservation = await admit(
    context,
    selection.value.plan,
    estimatedCost,
    executionMode === "native"
      ? (compiledPlan?.nodes.length ?? 0)
      : compatibilityCardinality?.status === "proven"
        ? compatibilityCardinality.expected_calls
        : 0,
    expectedConcurrency,
    expectedRetries,
    expectedFanOut,
    runId,
    routeResult.value,
    serviceTier,
  );
  try {
    await context.store.createRun(parsedSnapshot, parsedEvent);
  } catch (error) {
    await Effect.runPromise(reservation.release);
    throw error;
  }
  context.journalSequences.set(runId, 1);
  context.reservations.set(runId, reservation);
  context.pending.set(runId, {
    objective,
    constraints: safeTextArray(input.constraints),
    ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
    ...(input.compileOptions === undefined ? {} : { compileOptions: input.compileOptions }),
    ...(compiledPlan === undefined ? {} : { compiledPlan }),
  });
  await emitTelemetry(context, {
    event: "run",
    run_id: runId,
    route,
    delegation_mode: delegationMode,
    status: "created",
    duration_ms: 0,
    count: 1,
    error_code: null,
    replayed: false,
  });
  return definition;
}

export async function createDerivedRun(
  context: HostContext,
  input: Readonly<{
    readonly parent: RunDefinition;
    readonly objective: string;
    readonly constraints: readonly string[];
    readonly identity?: IdentityComponents;
  }>,
): Promise<RunDefinition> {
  const definition = buildDerivedDefinition(input.parent, input.identity);
  const snapshot: RunSnapshot = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    definition,
    status: "created",
    revision: 0,
    checkpoint: null,
    integrity: "valid",
    updated_at: now(),
  };
  const parsedSnapshot = decodeHostSchema(RunSnapshotSchema, snapshot);
  if (parsedSnapshot === undefined) {
    throw new WorkflowHostError("invalid_input", "The derived run snapshot is invalid.");
  }
  const event: JournalEvent = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
    event: "run-created",
    run_id: definition.run_id,
    sequence: 1,
    at: now(),
    definition,
  };
  const parsedEvent = decodeHostSchema(JournalEventSchema, event);
  if (parsedEvent === undefined) {
    throw new WorkflowHostError("invalid_input", "The derived run journal is invalid.");
  }
  await context.store.createRun(parsedSnapshot, parsedEvent);
  context.journalSequences.set(definition.run_id, 1);
  context.pending.set(definition.run_id, {
    objective: safeText(input.objective, MAX_PENDING_TEXT),
    constraints: safeTextArray(input.constraints),
  });
  return definition;
}

export function buildDerivedDefinition(
  parent: RunDefinition,
  identity: IdentityComponents = parent.identity,
): RunDefinition {
  const parsedIdentity = decodeHostSchema(IdentityComponentsSchema, identity);
  if (parsedIdentity === undefined) {
    throw new WorkflowHostError("invalid_input", "The derived run identity is invalid.");
  }
  return {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    run_id: randomId("run"),
    objective_lineage: parent.objective_lineage,
    parent_run_id: parent.run_id,
    created_at: now(),
    identity: parsedIdentity,
  };
}
