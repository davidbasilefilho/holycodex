// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonUtf8, domainSeparatedSha256 } from "@holycodex/core";
import {
  ContinuationPacketSchema,
  WORKFLOW_HOST_SCHEMA_EPOCHS,
  decodeHostSchema,
  type ContinuationClaim,
  type ContinuationPacket,
} from "./schemas.ts";
import { WorkflowHostError } from "./errors.ts";
import { asJsonValue, assertIdentifier, assertInputIdentity, now, randomId } from "./identity.ts";
import { emitTelemetry, loadRun } from "./lifecycle.ts";
import { buildDerivedDefinition } from "./creation.ts";
import type { ContinuationDecision, HostContext } from "./types.ts";

export async function createContinuation(
  context: HostContext,
  input: Readonly<{
    runId: string;
    sessionId: string;
    source: string;
    args: unknown;
    checkpointRevision?: number;
  }>,
): Promise<ContinuationDecision> {
  const loaded = await loadRun(context, input.runId);
  if (loaded.snapshot.integrity !== "valid") {
    return {
      kind: "denied",
      code: "integrity_uncertain",
      reason: "The run integrity is uncertain.",
    };
  }
  if (loaded.snapshot.status !== "paused" && loaded.snapshot.status !== "blocked") {
    return {
      kind: "denied",
      code: "continuation_denied",
      reason: "Only paused or blocked runs may continue.",
    };
  }
  const checkpoint = loaded.snapshot.checkpoint;
  if (!checkpoint || checkpoint.revision !== (input.checkpointRevision ?? checkpoint.revision)) {
    return {
      kind: "denied",
      code: "continuation_denied",
      reason: "The checkpoint is stale or missing.",
    };
  }
  if (checkpoint.unresolved_work.length > 0 || checkpoint.usage_completeness === "unknown") {
    return {
      kind: "denied",
      code: "continuation_denied",
      reason: "The checkpoint has ambiguous or unverified continuation state.",
    };
  }
  if (typeof input.source !== "string" || input.source.length === 0) {
    return {
      kind: "denied",
      code: "continuation_denied",
      reason: "The continuation source must be resupplied.",
    };
  }
  const args = asJsonValue(input.args, "continuation args");
  try {
    await assertInputIdentity(loaded.snapshot.definition, input.source, args);
  } catch (error: unknown) {
    if (error instanceof WorkflowHostError && error.code === "identity_mismatch") {
      return { kind: "denied", code: "continuation_denied", reason: error.message };
    }
    throw error;
  }
  const sessionId = assertIdentifier(input.sessionId, "continuation session id");
  const checkpointDigest = await domainSeparatedSha256("workflow-checkpoint", [
    canonicalJsonUtf8(checkpoint),
  ]);
  const packetSeed = await domainSeparatedSha256("workflow-continuation-seed", [
    canonicalJsonUtf8({
      run_id: loaded.snapshot.definition.run_id,
      session_id: sessionId,
      checkpoint_revision: checkpoint.revision,
      checkpoint_digest: checkpointDigest,
    }),
  ]);
  const packetWithoutDigest = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.continuation,
    packet_id: `packet-${packetSeed.slice(0, 48)}`,
    session_id: sessionId,
    parent_run_id: loaded.snapshot.definition.run_id,
    objective_lineage: loaded.snapshot.definition.objective_lineage,
    project: loaded.snapshot.definition.identity.project,
    source_digest: loaded.snapshot.definition.identity.workflow_source_digest,
    checkpoint_revision: checkpoint.revision,
    checkpoint_digest: checkpointDigest,
    verified_evidence: checkpoint.verified_evidence,
    decisions: checkpoint.decisions,
    next_actions: checkpoint.next_actions,
    created_at: now(),
  };
  const packetDigest = await domainSeparatedSha256("workflow-continuation-packet", [
    canonicalJsonUtf8(packetWithoutDigest),
  ]);
  const packet: ContinuationPacket = { ...packetWithoutDigest, packet_digest: packetDigest };
  const parsedPacket = decodeHostSchema(ContinuationPacketSchema, packet);
  if (parsedPacket === undefined) {
    return {
      kind: "denied",
      code: "continuation_denied",
      reason: "The continuation packet is malformed.",
    };
  }
  const claim: ContinuationClaim = {
    schema_epoch: WORKFLOW_HOST_SCHEMA_EPOCHS.continuation,
    claim_id: randomId("claim"),
    packet_id: packet.packet_id,
    session_id: packet.session_id,
    parent_run_id: packet.parent_run_id,
    project: packet.project,
    source_digest: packet.source_digest,
    checkpoint_digest: packet.checkpoint_digest,
    checkpoint_revision: packet.checkpoint_revision,
    packet_digest: packet.packet_digest,
    claimed_at: now(),
  };
  const derived = buildDerivedDefinition(loaded.snapshot.definition);
  try {
    await context.store.claimContinuationAndCreateRun({ claim, derivedDefinition: derived });
  } catch (error) {
    if (error instanceof WorkflowHostError && error.code === "claim_conflict") {
      return {
        kind: "denied",
        code: "claim_conflict",
        reason: "The continuation packet was already claimed.",
      };
    }
    throw error;
  }
  context.journalSequences.set(input.runId, (loaded.journal.at(-1)?.sequence ?? 0) + 1);
  context.journalSequences.set(derived.run_id, 1);
  await emitTelemetry(context, {
    event: "continuation",
    run_id: input.runId,
    route: loaded.snapshot.definition.identity.route,
    status: "claimed",
    duration_ms: 0,
    count: 1,
    error_code: null,
    replayed: false,
  });
  return { kind: "claimed", packet, claim, derived };
}
