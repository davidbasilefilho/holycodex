// SPDX-License-Identifier: Apache-2.0

import * as Effect from "effect/Effect";
import { WorkflowHostError } from "./errors.ts";
import { changeState, loadRun } from "./lifecycle.ts";
import type { HostContext } from "./types.ts";
import type { WorkflowApprovalRequest } from "@holycodex/workflow-runtime";

/** The one host-owned gate used by native and compatibility dispatches. */
export async function approveBeforeDispatch(
  context: HostContext,
  request: WorkflowApprovalRequest,
): Promise<void> {
  if (context.approvalPolicy === "never") {
    return;
  }
  const previous = context.approvalLocks.get(request.runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const loaded = await loadRun(context, request.runId);
      if (loaded.snapshot.status !== "running") {
        throw new WorkflowHostError(
          "run_state_invalid",
          "The workflow is no longer running at its approval boundary.",
        );
      }
      const waiting = await changeState(
        context,
        loaded.snapshot,
        "waiting_for_approval",
        "approval requested before external dispatch",
      );
      const handler = context.approval;
      if (handler === undefined) {
        await denyApproval(context, waiting, "required approval handler unavailable");
        throw new WorkflowHostError(
          "approval_required",
          "The required workflow approval capability is unavailable.",
        );
      }
      let decision: unknown;
      try {
        decision = await Effect.runPromise(handler(request));
      } catch (error) {
        await denyApproval(context, waiting, "approval handler failed");
        throw new WorkflowHostError(
          "approval_required",
          "The workflow approval handler failed closed.",
          {},
          { cause: error },
        );
      }
      if (decision !== "approved") {
        await denyApproval(context, waiting, "approval denied");
        throw new WorkflowHostError("approval_denied", "The workflow approval was denied.");
      }
      const approved = await changeState(context, waiting, "approved", "approval granted");
      await changeState(context, approved, "running", "approved operation resumed");
    });
  context.approvalLocks.set(request.runId, next);
  try {
    await next;
  } finally {
    if (context.approvalLocks.get(request.runId) === next) {
      context.approvalLocks.delete(request.runId);
    }
  }
}

async function denyApproval(
  context: HostContext,
  waiting: Awaited<ReturnType<typeof loadRun>>["snapshot"],
  reason: string,
): Promise<void> {
  const current = await loadRun(context, waiting.definition.run_id);
  if (current.snapshot.status === "waiting_for_approval") {
    await changeState(context, current.snapshot, "denied", reason);
  }
}
