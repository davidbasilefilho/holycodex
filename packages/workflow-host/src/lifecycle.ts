// SPDX-License-Identifier: Apache-2.0

import type { RouteKey, SpecialistOutcome } from "@holycodex/core";
import {
  CheckpointSchema,
  InspectionProjectionSchema,
  RetainedContextIdentitySchema,
  RunSnapshotSchema,
  TelemetrySchema,
  WORKFLOW_HOST_SCHEMA_EPOCHS,
  decodeHostSchema,
  type Checkpoint,
  type InspectionProjection,
  type OperationLifecycle,
  type RetainedContextIdentity,
  type RunDefinition,
  type RunSnapshot,
  type RunStatus,
  type Telemetry,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import { MAX_PENDING_TEXT, normalizeEpochs, now, safeText, safeTextArray } from "./identity.ts";
import type { CheckpointValues, HostContext, JournalInput } from "./types.ts";
import type { StoredRun } from "./store.ts";

export function operationLifecycle(
  input: Readonly<{
    operationId: string;
    digest: string;
    route: RouteKey;
    role: "Explorer" | "Librarian" | "Worker" | "Reviewer";
    task: string;
    attempt: number;
    retryLimit: number;
    fanOut: number;
    state: OperationLifecycle["state"];
    errorCode: string | null;
  }>,
): OperationLifecycle {
  return {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
    operation: {
      operation_id: input.operationId,
      input_digest: input.digest,
      route: input.route,
      role: input.role,
      task: input.task,
      attempt: input.attempt,
      retry_limit: input.retryLimit,
      fan_out: input.fanOut,
    },
    state: input.state,
    cost_units: 1,
    at: now(),
    error_code: input.errorCode,
  };
}

/** Refreshes the process-local journal cursor before any event is appended. */
export async function loadRun(context: HostContext, runId: string): Promise<StoredRun> {
  try {
    const loaded = await context.store.load(runId);
    context.journalSequences.set(runId, loaded.journal.at(-1)?.sequence ?? 0);
    return loaded;
  } catch (error) {
    if (error instanceof WorkflowHostError) {
      throw error;
    }
    throw new WorkflowHostError(
      "run_missing",
      "The run could not be loaded.",
      {},
      { cause: error },
    );
  }
}

export async function appendEvent(
  context: HostContext,
  runId: string,
  input: JournalInput,
): Promise<void> {
  const appended = await context.store.appendJournalNext(runId, (sequence) => {
    const base = {
      schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
      run_id: runId,
      sequence,
      at: now(),
    };
    switch (input.event) {
      case "state-changed":
        return { ...base, ...input };
      case "operation":
        return { ...base, ...input };
      case "checkpoint":
        return { ...base, ...input };
      case "continuation-claimed":
        return { ...base, ...input };
      case "refinement":
        return { ...base, ...input };
    }
  });
  context.journalSequences.set(runId, appended.sequence);
}

async function withLifecycleLock<T>(
  context: HostContext,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = context.lifecycleLocks.get(runId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const next: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  context.lifecycleLocks.set(runId, next);
  try {
    return await result;
  } finally {
    if (context.lifecycleLocks.get(runId) === next) {
      context.lifecycleLocks.delete(runId);
    }
  }
}

export async function emitTelemetry(
  context: HostContext,
  input: Omit<Telemetry, "schema_epoch" | "schema_epochs">,
): Promise<void> {
  if (!context.telemetry) {
    return;
  }
  const event: Telemetry = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.telemetry,
    schema_epochs: normalizeEpochs(),
    ...input,
  };
  const parsed = decodeHostSchema(TelemetrySchema, event);
  if (parsed === undefined) {
    return;
  }
  try {
    await context.telemetry(parsed);
  } catch {
    // Telemetry is descriptive and cannot affect scheduling, retries, or routing.
  }
}

export async function changeState(
  context: HostContext,
  snapshot: RunSnapshot,
  status: RunStatus,
  reason: string,
): Promise<RunSnapshot> {
  return await withLifecycleLock(context, snapshot.definition.run_id, async () => {
    const current = await loadRun(context, snapshot.definition.run_id);
    if (current.snapshot.status === status) {
      return current.snapshot;
    }
    const valid =
      (current.snapshot.status === "created" && (status === "running" || status === "stopped")) ||
      (current.snapshot.status === "reopened" && (status === "running" || status === "stopped")) ||
      (current.snapshot.status === "paused" && (status === "running" || status === "stopped")) ||
      (current.snapshot.status === "running" &&
        (status === "paused" ||
          status === "stopped" ||
          status === "waiting_for_approval" ||
          status === "completed" ||
          status === "failed" ||
          status === "blocked")) ||
      (current.snapshot.status === "waiting_for_approval" &&
        (status === "approved" || status === "denied" || status === "stopped")) ||
      (current.snapshot.status === "approved" &&
        (status === "running" || status === "completed" || status === "failed")) ||
      (current.snapshot.status === "denied" && (status === "reopened" || status === "blocked")) ||
      ((current.snapshot.status === "paused" || current.snapshot.status === "stopped") &&
        status === "blocked") ||
      (["completed", "failed", "stopped"].includes(current.snapshot.status) &&
        status === "reopened") ||
      (current.snapshot.status === "blocked" && status === "reopened");
    if (!valid) {
      throw new WorkflowHostError(
        "run_state_invalid",
        `The transition ${current.snapshot.status} -> ${status} is invalid.`,
      );
    }
    await appendEvent(context, current.snapshot.definition.run_id, {
      event: "state-changed",
      from: current.snapshot.status,
      to: status,
      reason: safeText(reason),
    });
    const next: RunSnapshot = {
      ...current.snapshot,
      status,
      revision: current.snapshot.revision + 1,
      updated_at: now(),
    };
    const parsed = decodeHostSchema(RunSnapshotSchema, next);
    if (parsed === undefined) {
      throw new WorkflowHostError("state_corrupt", "The next run snapshot is invalid.");
    }
    await context.store.saveSnapshot(parsed);
    return parsed;
  });
}

export async function writeCheckpoint(
  context: HostContext,
  snapshot: RunSnapshot,
  objective: string,
  constraints: readonly string[],
  values: CheckpointValues,
): Promise<Checkpoint> {
  return await withLifecycleLock(context, snapshot.definition.run_id, async () => {
    const current = await loadRun(context, snapshot.definition.run_id);
    const revision = current.snapshot.revision + 1;
    let checkpoint: Checkpoint | undefined;
    await context.store.appendJournalNext(snapshot.definition.run_id, (sequence) => {
      const candidate: Checkpoint = {
        schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.checkpoint,
        run_id: snapshot.definition.run_id,
        revision,
        journal_sequence: sequence,
        objective: safeText(objective, MAX_PENDING_TEXT),
        constraints: safeTextArray(constraints),
        decisions: safeTextArray(values.decisions),
        verified_evidence: safeTextArray(values.verifiedEvidence),
        phases: safeTextArray(values.phases),
        active_work: safeTextArray(values.activeWork),
        unresolved_work: safeTextArray(values.unresolvedWork),
        blockers: safeTextArray(values.blockers),
        verification: safeTextArray(values.verification),
        resources: {},
        retained_summaries: safeTextArray(values.retainedSummaries),
        next_actions: safeTextArray(values.nextActions),
        usage_completeness: values.usageCompleteness,
        recoverable_errors: safeTextArray(values.recoverableErrors),
        captured_at: now(),
      };
      const parsed = decodeHostSchema(CheckpointSchema, candidate);
      if (parsed === undefined) {
        throw new WorkflowHostError("state_corrupt", "The checkpoint is invalid.");
      }
      checkpoint = parsed;
      return {
        schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
        event: "checkpoint" as const,
        run_id: snapshot.definition.run_id,
        sequence,
        at: now(),
        checkpoint: parsed,
      };
    });
    if (checkpoint === undefined) {
      throw new WorkflowHostError("state_corrupt", "The checkpoint was not persisted.");
    }
    const nextSnapshot: RunSnapshot = {
      ...current.snapshot,
      checkpoint,
      revision,
      updated_at: now(),
    };
    const parsedSnapshot = decodeHostSchema(RunSnapshotSchema, nextSnapshot);
    if (parsedSnapshot === undefined) {
      throw new WorkflowHostError("state_corrupt", "The checkpoint snapshot is invalid.");
    }
    await context.store.saveSnapshot(parsedSnapshot);
    await emitTelemetry(context, {
      event: "checkpoint",
      run_id: snapshot.definition.run_id,
      route: snapshot.definition.identity.route,
      status: "written",
      duration_ms: 0,
      count: 1,
      error_code: null,
      replayed: false,
    });
    return checkpoint;
  });
}

export function contextFromOperation(
  definition: RunDefinition,
  lifecycle: OperationLifecycle,
  outcome: SpecialistOutcome,
): RetainedContextIdentity {
  const context: RetainedContextIdentity = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
    context_id: `context-${lifecycle.operation.operation_id}`,
    run_id: definition.run_id,
    project: definition.identity.project,
    route: lifecycle.operation.route,
    role: lifecycle.operation.role,
    policy_digest: definition.identity.policy_digest,
    tool_profile: definition.identity.tool_profile,
    security_profile: definition.identity.security_profile,
    prompt_profile: definition.identity.prompt_profile,
    approval_policy: definition.identity.approval_policy,
    sandbox_policy: definition.identity.sandbox_policy,
    status: outcome.blocked || outcome.status !== "completed" ? "blocked" : "available",
    summary: safeTextArray([
      ...outcome.verification,
      ...outcome.material_findings,
      ...outcome.remaining_risk,
    ]),
    created_at: now(),
  };
  const parsed = decodeHostSchema(RetainedContextIdentitySchema, context);
  if (parsed === undefined) {
    throw new WorkflowHostError("state_corrupt", "The retained context identity is invalid.");
  }
  return parsed;
}

export async function inspect(
  context: HostContext,
  runId: string,
  replayed = false,
): Promise<InspectionProjection> {
  const loaded = await loadRun(context, runId);
  const operations: OperationLifecycle[] = [];
  const retained: RetainedContextIdentity[] = [];
  for (const event of loaded.journal) {
    if (event.event !== "operation") {
      continue;
    }
    operations.push(event.lifecycle);
    if (event.lifecycle.state === "completed" && event.outcome) {
      retained.push(
        contextFromOperation(loaded.snapshot.definition, event.lifecycle, event.outcome),
      );
    }
  }
  const projection: InspectionProjection = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    definition: loaded.snapshot.definition,
    status: loaded.snapshot.status,
    revision: loaded.snapshot.revision,
    checkpoint: loaded.snapshot.checkpoint,
    operations,
    retained_contexts: retained,
    integrity: loaded.snapshot.integrity,
    replayed,
  };
  const parsed = decodeHostSchema(InspectionProjectionSchema, projection);
  if (parsed === undefined) {
    throw new WorkflowHostError("state_corrupt", "The inspection projection is invalid.");
  }
  return parsed;
}

export async function list(context: HostContext): Promise<readonly InspectionProjection[]> {
  const snapshots = await context.store.listSnapshots();
  const projections: InspectionProjection[] = [];
  for (const snapshot of snapshots) {
    projections.push(await inspect(context, snapshot.definition.run_id));
  }
  return projections;
}
