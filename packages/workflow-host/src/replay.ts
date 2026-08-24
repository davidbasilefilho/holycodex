// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "@holycodex/core";
import { decodeHostSchema, IdentityComponentsSchema } from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import {
  admitOperationEvent,
  assertDigest,
  assertIdentifier,
  findOperationEvent,
  inputDigest,
  normalizeOperationInput,
  normalizeProjectTrust,
  operationFingerprint,
} from "./identity.ts";
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
  if (loaded.snapshot.integrity !== "valid") {
    return {
      kind: "denied",
      code: "integrity_uncertain",
      reason: "The run integrity is uncertain.",
    };
  }
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
  let digest: string;
  try {
    digest = await operationFingerprint(
      loaded.snapshot.definition,
      normalizeOperationInput(admission.operationInput),
    );
  } catch {
    return {
      kind: "denied",
      code: "operation_input_mismatch",
      reason: "No exact retained operation input exists.",
    };
  }
  const matching = findOperationEvent(
    loaded.journal,
    digest,
    await inputDigest(admission.operationInput),
  );
  if (matching === undefined) {
    return {
      kind: "denied",
      code: "operation_input_mismatch",
      reason: "No exact retained operation input exists.",
    };
  }
  try {
    const outcome = admitOperationEvent(matching);
    if (outcome === undefined) {
      return {
        kind: "denied",
        code: "operation_input_mismatch",
        reason: "No completed retained operation exists for the input.",
      };
    }
    return {
      kind: "replayed",
      projection: await inspect(context, runId, true),
      outcome,
    };
  } catch (error) {
    if (error instanceof WorkflowHostError) {
      return {
        kind: "denied",
        code:
          error.code === "no_progress" || error.code === "integrity_uncertain"
            ? error.code
            : "identity_mismatch",
        reason: error.message,
      };
    }
    throw error;
  }
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
        retained.session !== undefined &&
        canonicalJson(retained.project) === canonicalJson(project) &&
        retained.route === input.route &&
        retained.role === input.role &&
        (input.task === undefined || retained.session.role_task.task === input.task) &&
        (input.objectiveLineage === undefined ||
          retained.session.objective_lineage ===
            assertIdentifier(input.objectiveLineage, "objective lineage")) &&
        (input.authorityScopeDigest === undefined ||
          retained.session.authority_scope_digest ===
            assertDigest(input.authorityScopeDigest, "authority scope digest")) &&
        retained.policy_digest === assertDigest(input.policyDigest, "policy digest") &&
        retained.tool_profile === input.toolProfile &&
        retained.security_profile === input.securityProfile &&
        retained.prompt_profile === input.promptProfile &&
        retained.approval_policy ===
          assertIdentifier(input.approvalPolicy ?? context.approvalPolicy, "approval policy") &&
        retained.sandbox_policy ===
          assertIdentifier(input.sandboxPolicy ?? context.sandboxPolicy, "sandbox policy") &&
        (input.codexCapabilityDigest === undefined ||
          retained.session.codex_capability_digest ===
            assertDigest(input.codexCapabilityDigest, "Codex capability digest")) &&
        retained.skill_profile_digest === input.skillProfileDigest &&
        retained.session.skill_profile_digest === input.skillProfileDigest
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
