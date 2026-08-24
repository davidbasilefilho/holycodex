// SPDX-License-Identifier: Apache-2.0

import type { RouteKey, SpecialistOutcomeV2 } from "@holycodex/core";
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
  type RetainedSessionRef,
  type RunDefinition,
  type RunSnapshot,
  type RunStatus,
  type Telemetry,
  type WorkflowDescriptor,
  type WorkflowProjection,
  type WorkflowRuntimeEvent,
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
    costAccounting?: NonNullable<OperationLifecycle["cost_accounting"]>;
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
    cost_units: input.costAccounting?.estimated_units ?? 0,
    ...(input.costAccounting === undefined ? {} : { cost_accounting: input.costAccounting }),
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
      case "workflow":
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
    const committed = await context.store.commitRevision(
      current.snapshot.definition.run_id,
      ({ current: latest, eventSequence, revision }) => {
        const next: RunSnapshot = {
          ...latest,
          status,
          revision,
          updated_at: now(),
        };
        const parsed = decodeHostSchema(RunSnapshotSchema, next);
        if (parsed === undefined) {
          throw new WorkflowHostError("state_corrupt", "The next run snapshot is invalid.");
        }
        return {
          snapshot: parsed,
          event: {
            schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
            event: "state-changed" as const,
            run_id: latest.definition.run_id,
            sequence: eventSequence,
            at: now(),
            from: latest.status,
            to: status,
            reason: safeText(reason),
          },
        };
      },
    );
    return committed.snapshot;
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
    const committed = await context.store.commitRevision(
      snapshot.definition.run_id,
      ({ current: latest, eventSequence, revision }) => {
        const candidate: Checkpoint = {
          schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.checkpoint,
          run_id: latest.definition.run_id,
          revision,
          journal_sequence: eventSequence,
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
        const nextSnapshot: RunSnapshot = {
          ...latest,
          checkpoint: parsed,
          revision,
          updated_at: now(),
        };
        const parsedSnapshot = decodeHostSchema(RunSnapshotSchema, nextSnapshot);
        if (parsedSnapshot === undefined) {
          throw new WorkflowHostError("state_corrupt", "The checkpoint snapshot is invalid.");
        }
        return {
          snapshot: parsedSnapshot,
          event: {
            schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
            event: "checkpoint" as const,
            run_id: latest.definition.run_id,
            sequence: eventSequence,
            at: now(),
            checkpoint: parsed,
          },
        };
      },
    );
    await emitTelemetry(context, {
      event: "checkpoint",
      run_id: snapshot.definition.run_id,
      route: snapshot.definition.identity.route,
      ...(current.snapshot.workflow?.delegation_mode === undefined
        ? {}
        : { delegation_mode: current.snapshot.workflow.delegation_mode }),
      status: "written",
      duration_ms: 0,
      count: 1,
      error_code: null,
      replayed: false,
    });
    const checkpoint = committed.snapshot.checkpoint;
    if (checkpoint === null) {
      throw new WorkflowHostError("state_corrupt", "The checkpoint transaction was empty.");
    }
    return checkpoint;
  });
}

export function contextFromOperation(
  definition: RunDefinition,
  lifecycle: OperationLifecycle,
  outcome: SpecialistOutcomeV2,
  session: RetainedSessionRef,
): RetainedContextIdentity {
  const summary = (() => {
    switch (outcome.status) {
      case "blocked":
        return [outcome.reason, ...outcome.evidence];
      case "completed":
        return [outcome.summary, ...outcome.evidence];
      case "failed":
        return [outcome.error, ...outcome.evidence];
      case "partial":
        return [outcome.summary, ...outcome.completed, ...outcome.remaining, ...outcome.evidence];
    }
  })();
  const context: RetainedContextIdentity = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.journal,
    context_id: `context-${lifecycle.operation.operation_id}`,
    run_id: definition.run_id,
    project: definition.identity.project,
    route: session.route,
    role: session.role_task.role,
    policy_digest: session.policy_digest,
    tool_profile: session.tool_profile,
    security_profile: session.security_profile,
    prompt_profile: session.prompt_profile,
    approval_policy: session.approval_policy,
    sandbox_policy: session.sandbox_policy,
    skill_profile_digest: session.skill_profile_digest,
    status: outcome.status === "completed" ? "available" : "blocked",
    summary: safeTextArray(summary),
    created_at: now(),
    session,
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
  const workflowEvents: WorkflowRuntimeEvent[] = [];
  const retained: RetainedContextIdentity[] = [];
  for (const event of loaded.journal) {
    if (event.event === "workflow") {
      workflowEvents.push(event);
      continue;
    }
    if (event.event !== "operation") {
      continue;
    }
    operations.push(event.lifecycle);
    if (event.lifecycle.state === "completed" && event.outcome && event.session) {
      retained.push(
        contextFromOperation(
          loaded.snapshot.definition,
          event.lifecycle,
          event.outcome,
          event.session,
        ),
      );
    }
  }
  const projection: InspectionProjection = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.run,
    definition: loaded.snapshot.definition,
    status: loaded.snapshot.status,
    revision: loaded.snapshot.revision,
    checkpoint: loaded.snapshot.checkpoint,
    ...(loaded.snapshot.workflow === undefined
      ? {}
      : { workflow: workflowProjection(loaded.snapshot.workflow, loaded.snapshot.definition) }),
    operations,
    workflow_events: workflowEvents,
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

function workflowProjection(
  descriptor: WorkflowDescriptor,
  definition: RunDefinition,
): WorkflowProjection {
  return {
    schema_epoch: "host-workflow-1.0",
    execution_mode: descriptor.execution_mode,
    ...(descriptor.delegation_mode === undefined
      ? {}
      : { delegation_mode: descriptor.delegation_mode }),
    ...(descriptor.compatibility_cardinality === undefined
      ? {}
      : { compatibility_cardinality: descriptor.compatibility_cardinality }),
    ...(descriptor.execution_identity === undefined
      ? {}
      : { execution_identity: descriptor.execution_identity }),
    source_digest: definition.identity.workflow_source_digest,
    args_digest: definition.identity.resupplied_args_digest,
    objective: descriptor.objective,
    constraints: descriptor.constraints,
    ...(definition.identity.native_workflow === undefined
      ? {}
      : { native_identity: definition.identity.native_workflow }),
  };
}

export async function list(context: HostContext): Promise<readonly InspectionProjection[]> {
  const snapshots = await context.store.listSnapshots();
  const projections: InspectionProjection[] = [];
  for (const snapshot of snapshots) {
    projections.push(await inspect(context, snapshot.definition.run_id));
  }
  return projections;
}
