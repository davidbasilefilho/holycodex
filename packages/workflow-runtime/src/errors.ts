// SPDX-License-Identifier: Apache-2.0

export type WorkflowFailureCode =
  | "validation"
  | "compilation"
  | "capacity"
  | "admission_exceeded"
  | "estimate_unavailable"
  | "measurement_malformed"
  | "settlement_overflow"
  | "ledger_corruption"
  | "timeout"
  | "interruption"
  | "retry_exhausted"
  | "iteration_limit"
  | "no_progress"
  | "execution"
  | "cancellation";

export type WorkflowFailure = Readonly<{
  readonly _tag: "WorkflowFailure";
  readonly code: WorkflowFailureCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly nodeId?: string;
  readonly cause?: unknown;
}>;

export function workflowFailure(
  code: WorkflowFailureCode,
  message: string,
  details: Readonly<{
    readonly nodeId?: string;
    readonly cause?: unknown;
    readonly retryable?: boolean;
  }> = {},
): WorkflowFailure {
  return Object.freeze({ _tag: "WorkflowFailure" as const, code, message, ...details });
}

export function isWorkflowFailure(value: unknown): value is WorkflowFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("_tag" in value) || !("code" in value) || !("message" in value)) {
    return false;
  }
  return (
    value._tag === "WorkflowFailure" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}
