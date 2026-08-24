// SPDX-License-Identifier: Apache-2.0

import { lookupRoute, RoleTaskSchema, type JsonValue, type PlanDefinition } from "@holycodex/core";
import * as Effect from "effect/Effect";
import type { CapacityLease, WorkflowOperation } from "@holycodex/workflow-runtime";
import { executeCodexOperation } from "./effect-runtime.ts";
import { acquireDispatch, capacitySnapshot, releaseDispatch, settleDispatch } from "./admission.ts";
import { approveBeforeDispatch } from "./approval.ts";
import {
  CostAccountingError,
  costJournal,
  estimateRouteCost,
  type CostEstimate,
  type CostJournal,
} from "./cost.ts";
import { decodeHostSchema, type RunDefinition } from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import {
  admitOperationEvent,
  findOperationEvent,
  inputDigest,
  jsonObject,
  normalizeCompatibilityOperation,
  operationFingerprint,
  operationRoute,
  optionInteger,
  randomId,
  sanitizeOutcome,
} from "./identity.ts";
import { appendEvent, emitTelemetry, loadRun, operationLifecycle } from "./lifecycle.ts";
import type { ActiveRun, HostContext } from "./types.ts";
import type { SpecialistOutcomeV2 } from "@holycodex/core";

export async function handleOperation(
  context: HostContext,
  definition: RunDefinition,
  plan: PlanDefinition,
  active: ActiveRun,
  operation: WorkflowOperation,
): Promise<JsonValue> {
  if (operation.name !== "agent") {
    throw new WorkflowHostError(
      "invalid_input",
      "The workflow requested an unsupported operation.",
    );
  }
  if (
    typeof operation.prompt !== "string" ||
    new TextEncoder().encode(operation.prompt).byteLength > 128 * 1024
  ) {
    throw new WorkflowHostError("invalid_input", "The workflow operation prompt is invalid.");
  }
  const options = jsonObject(operation.options, "workflow operation options");
  const role = options["role"];
  const task = options["task"];
  if (typeof role !== "string" || typeof task !== "string") {
    throw new WorkflowHostError(
      "invalid_route",
      "Workflow operations must carry a role/task assignment.",
    );
  }
  const parsedRoleTask = decodeHostSchema(RoleTaskSchema, { role, task });
  if (parsedRoleTask === undefined) {
    throw new WorkflowHostError("invalid_route", "The role/task assignment is malformed.");
  }
  const route = operationRoute(options, parsedRoleTask.role, parsedRoleTask.task);
  const routeResult = lookupRoute(plan.name, route);
  if (!routeResult.ok || routeResult.value.role !== role || routeResult.value.task !== task) {
    throw new WorkflowHostError(
      "invalid_route",
      "The workflow operation route is not admitted by the plan.",
    );
  }
  let estimate: CostEstimate;
  try {
    estimate = estimateRouteCost({
      route: routeResult.value,
      serviceTier: definition.identity.service_tier,
    });
  } catch (error) {
    throw new WorkflowHostError(
      error instanceof CostAccountingError ? error.code : "estimate_unavailable",
      "The workflow operation has no conservative pricing estimate.",
      {},
      { cause: error },
    );
  }
  const retryLimit = optionInteger(options, "retries", 0);
  if (retryLimit > 0) {
    throw new WorkflowHostError(
      "retry_limit",
      "Compatibility workflow retries are unsupported; use native workflow retries.",
    );
  }
  const fanOut = Math.max(1, optionInteger(options, "fan_out", 1));
  if (retryLimit > (context.capacity.maxRetries ?? 0)) {
    throw new WorkflowHostError(
      "retry_limit",
      "The workflow operation retry request is not admitted.",
    );
  }
  if (fanOut > (context.capacity.maxFanOut ?? plan.budget?.maxConcurrency ?? 1)) {
    throw new WorkflowHostError(
      "fan_out_limit",
      "The workflow operation fan-out request is not admitted.",
    );
  }
  const normalizedInput = normalizeCompatibilityOperation({
    prompt: operation.prompt,
    options,
    route,
    roleTask: parsedRoleTask,
  });
  const digest = await operationFingerprint(definition, normalizedInput);
  const legacyDigest = await inputDigest({ prompt: operation.prompt, options, route });
  const existing = findOperationEvent(
    (await loadRun(context, definition.run_id)).journal,
    digest,
    legacyDigest,
  );
  const retained = admitOperationEvent(existing);
  if (retained !== undefined) {
    return retained;
  }
  const operationId = randomId("operation");
  const operationController = new AbortController();
  const abortOperation = (): void => operationController.abort();
  active.controller.signal.addEventListener("abort", abortOperation, { once: true });
  active.operationControllers.set(operationId, operationController);
  const operationInput = {
    operationId,
    digest,
    route,
    role: routeResult.value.role,
    task: routeResult.value.task,
    attempt: 1,
    retryLimit,
    fanOut,
  } as const;
  const runtimeAgent = context.services.agent;
  const startedAt = Date.now();
  try {
    const attempt = 1;
    await appendEvent(context, definition.run_id, {
      event: "operation",
      lifecycle: operationLifecycle({
        ...operationInput,
        attempt,
        state: "waiting_for_approval",
        errorCode: null,
      }),
    });
    const competing = findOperationEvent(
      (await loadRun(context, definition.run_id)).journal,
      digest,
      legacyDigest,
    );
    const competingOutcome = admitOperationEvent(competing, operationId);
    if (competingOutcome !== undefined) {
      return competingOutcome;
    }
    try {
      await approveBeforeDispatch(context, {
        runId: definition.run_id,
        nodeId: operationId,
        name: operationId,
      });
    } catch (error) {
      await appendEvent(context, definition.run_id, {
        event: "operation",
        lifecycle: operationLifecycle({
          ...operationInput,
          attempt,
          state: "denied",
          errorCode: error instanceof WorkflowHostError ? error.code : "approval_denied",
        }),
      });
      throw error;
    }
    await appendEvent(context, definition.run_id, {
      event: "operation",
      lifecycle: operationLifecycle({
        ...operationInput,
        attempt,
        state: "approved",
        errorCode: null,
      }),
    });
    let lease: CapacityLease | undefined;
    let dispatched = false;
    let effectClassified = false;
    let normalizedOutcome: SpecialistOutcomeV2 | undefined;
    let settled = false;
    let costAccounting: CostJournal | undefined;
    try {
      lease = await acquireDispatch(context, active, definition.run_id, estimate);
      dispatched = true;
      costAccounting = costJournal(
        estimate,
        undefined,
        await capacitySnapshot(context, definition.run_id),
      );
      await appendEvent(context, definition.run_id, {
        event: "operation",
        lifecycle: operationLifecycle({
          ...operationInput,
          attempt,
          state: "reserved",
          errorCode: null,
          costAccounting,
        }),
      });
      let rawOutcome: unknown;
      if (context.codex === undefined && runtimeAgent === undefined) {
        rawOutcome = await context.executor({
          runId: definition.run_id,
          project: definition.identity.project,
          plan,
          serviceTier: definition.identity.service_tier,
          route,
          role: routeResult.value.role,
          task: routeResult.value.task,
          prompt: operation.prompt,
          options,
          promptProfile: definition.identity.prompt_profile,
          toolProfile: definition.identity.tool_profile,
          securityProfile: definition.identity.security_profile,
          approvalPolicy: definition.identity.approval_policy,
          sandboxPolicy: definition.identity.sandbox_policy,
          signal: operationController.signal,
        });
      } else if (context.codex !== undefined) {
        rawOutcome = await Effect.runPromise(
          executeCodexOperation(
            context,
            definition,
            context.pending.get(definition.run_id) ?? {
              objective: operation.prompt,
              constraints: [],
            },
            active,
            {
              operationId,
              prompt: operation.prompt,
              options,
              route,
            },
          ),
        );
      } else {
        const agent = runtimeAgent;
        if (agent === undefined) {
          throw new WorkflowHostError(
            "capability_denied",
            "No runtime workflow agent service is configured.",
          );
        }
        rawOutcome = await Effect.runPromise(
          agent.execute({
            payload: { objective: operation.prompt, options },
            input: { name: "json", decode: (value: unknown): unknown => value },
            output: { name: "json", decode: (value: unknown): unknown => value },
            metadata: { id: operationId },
            route,
          }),
        );
      }
      if (operationController.signal.aborted) {
        throw new WorkflowHostError(
          "external_failed",
          "The specialist operation was cancelled ambiguously.",
        );
      }
      const outcome = sanitizeOutcome(rawOutcome, parsedRoleTask);
      normalizedOutcome = outcome;
      effectClassified = true;
      const settledResult = await settleDispatch(
        context,
        definition.run_id,
        lease,
        estimate,
        usageFromResult(rawOutcome),
      );
      settled = true;
      costAccounting = settledResult.journal;
      active.costUnits = settledResult.journal.committed_units;
      if (settledResult.failure !== undefined) {
        throw settledResult.failure;
      }
      if (outcome.status !== "completed") {
        throw new WorkflowHostError(
          "specialist_invalid",
          "The specialist outcome did not complete.",
        );
      }
      await appendEvent(context, definition.run_id, {
        event: "operation",
        lifecycle: operationLifecycle({
          ...operationInput,
          attempt,
          state: "completed",
          errorCode: null,
          costAccounting,
        }),
        outcome,
      });
      await emitTelemetry(context, {
        event: "operation",
        run_id: definition.run_id,
        route,
        status: "completed",
        duration_ms: Date.now() - startedAt,
        count: 1,
        error_code: null,
        replayed: false,
      });
      return outcome;
    } catch (error) {
      let operationError: unknown = error;
      if (lease !== undefined && !settled) {
        const settledResult = await settleDispatch(
          context,
          definition.run_id,
          lease,
          estimate,
          undefined,
        );
        settled = true;
        costAccounting = settledResult.journal;
        active.costUnits = settledResult.journal.committed_units;
        if (settledResult.failure !== undefined) {
          operationError = settledResult.failure;
        }
      }
      const errorCode =
        operationError instanceof WorkflowHostError ? operationError.code : "external-failed";
      await appendEvent(context, definition.run_id, {
        event: "operation",
        lifecycle: operationLifecycle({
          ...operationInput,
          attempt,
          state: dispatched && !effectClassified ? "uncertain" : "failed",
          errorCode,
          ...(costAccounting === undefined ? {} : { costAccounting }),
        }),
        ...(normalizedOutcome === undefined ? {} : { outcome: normalizedOutcome }),
      });
      await emitTelemetry(context, {
        event: "operation",
        run_id: definition.run_id,
        route,
        status: dispatched && !effectClassified ? "uncertain" : "failed",
        duration_ms: Date.now() - startedAt,
        count: 1,
        error_code: errorCode,
        replayed: false,
      });
      if (!dispatched || effectClassified) {
        throw operationError;
      }
      throw new WorkflowHostError(
        "external_failed",
        "The specialist operation has an uncertain effect and cannot be retried.",
        { uncertain: true },
        { cause: operationError },
      );
    } finally {
      if (lease !== undefined) {
        await Effect.runPromise(lease.release);
        releaseDispatch(active);
      }
    }
  } finally {
    active.controller.signal.removeEventListener("abort", abortOperation);
    active.operationControllers.delete(operationId);
  }
}

function usageFromResult(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return "usage" in value ? value.usage : undefined;
}
