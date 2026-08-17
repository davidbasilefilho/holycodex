// SPDX-License-Identifier: Apache-2.0

import { lookupRoute, resolvePlanSelection } from "@holycodex/core";
import {
  IdentityComponentsSchema,
  JournalEventSchema,
  RunSnapshotSchema,
  WORKFLOW_HOST_SCHEMA_EPOCHS,
  type IdentityComponents,
  type JournalEvent,
  type RunDefinition,
  type RunSnapshot,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import { admit } from "./admission.ts";
import {
  asJsonValue,
  assertIdentifier,
  buildIdentity,
  DEFAULT_ROUTE,
  isArkErrors,
  MAX_PENDING_TEXT,
  now,
  randomId,
  safeText,
  safeTextArray,
} from "./identity.ts";
import type { CreateRunInput, HostContext } from "./types.ts";
import { emitTelemetry } from "./lifecycle.ts";

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
  const expectedCalls = input.expectedCalls ?? 0;
  const expectedConcurrency = input.expectedConcurrency ?? 1;
  const expectedRetries = input.expectedRetries ?? 0;
  const expectedFanOut = input.expectedFanOut ?? 1;
  admit(
    context,
    selection.value.plan,
    estimatedCost,
    expectedCalls,
    expectedConcurrency,
    expectedRetries,
    expectedFanOut,
  );

  const runId = randomId("run");
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
  });
  const definition: RunDefinition = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    run_id: runId,
    objective_lineage: assertIdentifier(lineage, "objective lineage"),
    parent_run_id: parentRunId === null ? null : assertIdentifier(parentRunId, "parent run id"),
    created_at: now(),
    identity,
  };
  const snapshot: RunSnapshot = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    definition,
    status: "created",
    revision: 0,
    checkpoint: null,
    integrity: "valid",
    updated_at: now(),
  };
  const parsedSnapshot = RunSnapshotSchema(snapshot);
  if (isArkErrors(parsedSnapshot)) {
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
  const parsedEvent = JournalEventSchema(event);
  if (isArkErrors(parsedEvent)) {
    throw new WorkflowHostError("invalid_input", "The run journal could not be formed.");
  }
  await context.store.createRun(parsedSnapshot, parsedEvent);
  context.journalSequences.set(runId, 1);
  context.reservations.set(runId, estimatedCost);
  context.pending.set(runId, {
    objective,
    constraints: safeTextArray(input.constraints),
  });
  context.reservedCost += estimatedCost;
  await emitTelemetry(context, {
    event: "run",
    run_id: runId,
    route,
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
  const parsedSnapshot = RunSnapshotSchema(snapshot);
  if (isArkErrors(parsedSnapshot)) {
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
  const parsedEvent = JournalEventSchema(event);
  if (isArkErrors(parsedEvent)) {
    throw new WorkflowHostError("invalid_input", "The derived run journal is invalid.");
  }
  await context.store.createRun(parsedSnapshot, parsedEvent);
  context.journalSequences.set(definition.run_id, 1);
  context.pending.set(definition.run_id, {
    objective: safeText(input.objective, MAX_PENDING_TEXT),
    constraints: safeTextArray(input.constraints),
  });
  context.reservations.set(definition.run_id, 0);
  return definition;
}

export function buildDerivedDefinition(
  parent: RunDefinition,
  identity: IdentityComponents = parent.identity,
): RunDefinition {
  const parsedIdentity = IdentityComponentsSchema(identity);
  if (isArkErrors(parsedIdentity)) {
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
