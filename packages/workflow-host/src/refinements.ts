// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "@holycodex/core";
import {
  RefinementProposalSchema,
  WORKFLOW_HOST_SCHEMA_EPOCHS,
  type Refinement,
  type RefinementProposal,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import {
  asJsonValue,
  assertIdentifier,
  assertInputIdentity,
  isArkErrors,
  now,
  randomId,
  safeText,
} from "./identity.ts";
import { appendEvent, emitTelemetry, loadRun } from "./lifecycle.ts";
import { createDerivedRun } from "./creation.ts";
import type { HostContext, RefinementOperation } from "./types.ts";

export async function createRefinement(
  context: HostContext,
  input: Readonly<{
    runId: string;
    proposal: unknown;
    attributableTo: string;
    source: string;
    args: unknown;
  }>,
): Promise<RefinementOperation> {
  if (!context.refinementsEnabled) {
    throw new WorkflowHostError("refinement_disabled", "Refinements are disabled by default.");
  }
  const loaded = await loadRun(context, input.runId);
  if (
    canonicalJson(loaded.snapshot.definition.identity.project) !== canonicalJson(context.project)
  ) {
    throw new WorkflowHostError(
      "refinement_scope",
      "The refinement is outside this project/trust scope.",
    );
  }
  if (typeof input.source !== "string" || input.source.length === 0) {
    throw new WorkflowHostError("resume_input_required", "Refinements require resupplied source.");
  }
  const args = asJsonValue(input.args, "refinement args");
  await assertInputIdentity(loaded.snapshot.definition, input.source, args);
  const proposal = RefinementProposalSchema(input.proposal);
  if (isArkErrors(proposal)) {
    throw new WorkflowHostError("invalid_input", "The refinement proposal is invalid.");
  }
  const sanitizedProposal: RefinementProposal = {
    kind: proposal.kind,
    summary: safeText(proposal.summary),
    rationale: safeText(proposal.rationale),
  };
  const attributableTo = assertIdentifier(input.attributableTo, "refinement attribution");
  const checkpoint = loaded.snapshot.checkpoint;
  const derived = await createDerivedRun(context, {
    parent: loaded.snapshot.definition,
    objective: safeText(`${checkpoint?.objective ?? "workflow"}: ${sanitizedProposal.summary}`),
    constraints: [
      ...(checkpoint?.constraints ?? []),
      safeText(`refinement rationale: ${sanitizedProposal.rationale}`),
    ],
  });
  const refinement: Refinement = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.refinement,
    refinement_id: randomId("refinement"),
    project: loaded.snapshot.definition.identity.project,
    run_id: derived.run_id,
    proposal: sanitizedProposal,
    status: "disabled",
    reversible: true,
    attributable_to: attributableTo,
    created_at: now(),
    updated_at: now(),
  };
  await appendEvent(context, derived.run_id, { event: "refinement", refinement });
  return { refinement, enabled: false };
}

export async function setRefinementStatus(
  context: HostContext,
  runId: string,
  refinementId: string,
  status: "enabled" | "disabled",
): Promise<Refinement> {
  if (!context.refinementsEnabled) {
    throw new WorkflowHostError("refinement_disabled", "Refinements are disabled by default.");
  }
  const loaded = await loadRun(context, runId);
  if (
    canonicalJson(loaded.snapshot.definition.identity.project) !== canonicalJson(context.project)
  ) {
    throw new WorkflowHostError(
      "refinement_scope",
      "The refinement is outside this project/trust scope.",
    );
  }
  const previous = [...loaded.journal]
    .reverse()
    .find(
      (event) => event.event === "refinement" && event.refinement.refinement_id === refinementId,
    );
  if (!previous || previous.event !== "refinement") {
    throw new WorkflowHostError("invalid_input", "The refinement does not exist.");
  }
  if (
    canonicalJson(previous.refinement.project) !==
    canonicalJson(loaded.snapshot.definition.identity.project)
  ) {
    throw new WorkflowHostError(
      "refinement_scope",
      "The refinement belongs to another project/trust scope.",
    );
  }
  const refinement: Refinement = { ...previous.refinement, status, updated_at: now() };
  await appendEvent(context, runId, { event: "refinement", refinement });
  await emitTelemetry(context, {
    event: "refinement",
    run_id: runId,
    route: loaded.snapshot.definition.identity.route,
    status,
    duration_ms: 0,
    count: 1,
    error_code: null,
    replayed: false,
  });
  return refinement;
}
