// SPDX-License-Identifier: Apache-2.0

import {
  lookupRoute,
  parseSpecialistOutcome,
  RoleTaskSchema,
  type JsonValue,
  type PlanDefinition,
} from "@holycodex/core";
import type { WorkflowOperation } from "@holycodex/workflow-runtime";
import type { RunDefinition } from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import {
  inputDigest,
  isArkErrors,
  jsonObject,
  operationRoute,
  optionInteger,
  randomId,
  sanitizeOutcome,
} from "./identity.ts";
import { appendEvent, emitTelemetry, operationLifecycle } from "./lifecycle.ts";
import type { ActiveRun, HostContext } from "./types.ts";

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
  if (active.calls >= active.maxCalls) {
    throw new WorkflowHostError("call_limit", "The live workflow call limit was exceeded.");
  }
  if (active.operationControllers.size >= active.maxConcurrency) {
    throw new WorkflowHostError(
      "concurrency_limit",
      "The live workflow concurrency limit was exceeded.",
    );
  }
  active.calls += 1;
  const options = jsonObject(operation.options, "workflow operation options");
  const role = options["role"];
  const task = options["task"];
  if (typeof role !== "string" || typeof task !== "string") {
    throw new WorkflowHostError(
      "invalid_route",
      "Workflow operations must carry a role/task assignment.",
    );
  }
  const parsedRoleTask = RoleTaskSchema({ role, task });
  if (isArkErrors(parsedRoleTask)) {
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
  const retryLimit = optionInteger(options, "retries", 0);
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
  const digest = await inputDigest({ prompt: operation.prompt, options, route });
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
    retryLimit,
    fanOut,
  } as const;
  try {
    const attempt = 1;
    await appendEvent(context, definition.run_id, {
      event: "operation",
      lifecycle: operationLifecycle({
        ...operationInput,
        attempt,
        state: "requested",
        errorCode: null,
      }),
    });
    try {
      const rawOutcome = await context.executor({
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
      if (operationController.signal.aborted) {
        throw new WorkflowHostError(
          "external_failed",
          "The specialist operation was cancelled ambiguously.",
        );
      }
      const outcomeResult = parseSpecialistOutcome(rawOutcome);
      if (!outcomeResult.ok) {
        throw new WorkflowHostError(
          "specialist_invalid",
          "The specialist outcome failed schema validation.",
        );
      }
      const outcome = sanitizeOutcome(outcomeResult.value);
      await appendEvent(context, definition.run_id, {
        event: "operation",
        lifecycle: operationLifecycle({
          ...operationInput,
          attempt,
          state: "completed",
          errorCode: null,
        }),
        outcome,
      });
      await emitTelemetry(context, {
        event: "operation",
        run_id: definition.run_id,
        route,
        status: "completed",
        duration_ms: 0,
        count: 1,
        error_code: null,
        replayed: false,
      });
      return outcome;
    } catch (error) {
      const errorCode = error instanceof WorkflowHostError ? error.code : "external-failed";
      await appendEvent(context, definition.run_id, {
        event: "operation",
        lifecycle: operationLifecycle({
          ...operationInput,
          attempt,
          state: "uncertain",
          errorCode,
        }),
      });
      throw new WorkflowHostError(
        "external_failed",
        "The specialist operation has an uncertain effect and cannot be retried.",
        { uncertain: true },
        { cause: error },
      );
    }
  } finally {
    active.controller.signal.removeEventListener("abort", abortOperation);
    active.operationControllers.delete(operationId);
  }
}
