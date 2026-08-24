// SPDX-License-Identifier: Apache-2.0

import type { JsonObject } from "@holycodex/core";

export type WorkflowHostErrorCode =
  | "invalid_input"
  | "invalid_plan"
  | "go_rejected"
  | "invalid_route"
  | "admission_denied"
  | "capability_denied"
  | "approval_required"
  | "approval_denied"
  | "verification_failed"
  | "cost_limit"
  | "estimate_unavailable"
  | "measurement_malformed"
  | "settlement_overflow"
  | "ledger_corruption"
  | "call_limit"
  | "concurrency_limit"
  | "retry_limit"
  | "fan_out_limit"
  | "run_missing"
  | "run_state_invalid"
  | "resume_input_required"
  | "identity_mismatch"
  | "operation_input_mismatch"
  | "no_progress"
  | "new_context_required"
  | "specialist_invalid"
  | "state_corrupt"
  | "integrity_uncertain"
  | "effect_uncertain"
  | "path_rejected"
  | "continuation_denied"
  | "claim_conflict"
  | "refinement_disabled"
  | "refinement_scope"
  | "persistence_failed"
  | "external_failed";

export class WorkflowHostError extends Error {
  readonly code: WorkflowHostErrorCode;
  readonly details: JsonObject;
  readonly retryable: boolean;

  constructor(
    code: WorkflowHostErrorCode,
    message: string,
    details: JsonObject = {},
    options: Readonly<{ cause?: unknown; retryable?: boolean }> = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkflowHostError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.retryable = options.retryable ?? false;
    Object.freeze(this);
  }
}
