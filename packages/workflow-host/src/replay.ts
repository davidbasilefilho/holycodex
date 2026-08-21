// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "@holycodex/core";
import { decodeHostSchema, IdentityComponentsSchema } from "./schemas.ts";
import { assertDigest, assertIdentifier, inputDigest, normalizeProjectTrust } from "./identity.ts";
import { inspect, list, loadRun } from "./lifecycle.ts";
import type {
  HostContext,
  ReplayAdmission,
  ReplayDecision,
  RetainedReuseDecision,
  RetainedReuseInput,
} from "./types.ts";

export async function replay(
  context: HostContext,
  runId: string,
  admission: ReplayAdmission,
): Promise<ReplayDecision> {
  const loaded = await loadRun(context, runId);
  const identity = decodeHostSchema(IdentityComponentsSchema, admission.identity);
  if (
    identity === undefined ||
    canonicalJson(identity) !== canonicalJson(loaded.snapshot.definition.identity)
  ) {
    return {
      kind: "denied",
      code: "identity_mismatch",
      reason: "Replay identity does not match the run.",
    };
  }
  const digest = await inputDigest(admission.operationInput);
  const matching = loaded.journal.find(
    (event) =>
      event.event === "operation" &&
      event.lifecycle.state === "completed" &&
      event.lifecycle.operation.input_digest === digest &&
      event.outcome,
  );
  if (!matching || matching.event !== "operation" || !matching.outcome) {
    return {
      kind: "denied",
      code: "operation_input_mismatch",
      reason: "No exact retained operation input exists.",
    };
  }
  return {
    kind: "replayed",
    projection: await inspect(context, runId, true),
    outcome: matching.outcome,
  };
}

export async function reuseRetainedContext(
  context: HostContext,
  input: RetainedReuseInput,
): Promise<RetainedReuseDecision> {
  const project = normalizeProjectTrust(input.project);
  const projections = await list(context);
  for (const projection of projections) {
    for (const retained of projection.retained_contexts) {
      if (
        retained.status === "available" &&
        canonicalJson(retained.project) === canonicalJson(project) &&
        retained.route === input.route &&
        retained.role === input.role &&
        retained.policy_digest === assertDigest(input.policyDigest, "policy digest") &&
        retained.tool_profile === input.toolProfile &&
        retained.security_profile === input.securityProfile &&
        retained.prompt_profile === input.promptProfile &&
        retained.approval_policy ===
          assertIdentifier(input.approvalPolicy ?? context.approvalPolicy, "approval policy") &&
        retained.sandbox_policy ===
          assertIdentifier(input.sandboxPolicy ?? context.sandboxPolicy, "sandbox policy")
      ) {
        return { kind: "reused", context: retained };
      }
    }
  }
  return {
    kind: "new-context-required",
    code: "new_context_required",
    reason: "No retained context matches the complete project, route, and profile identity.",
  };
}
