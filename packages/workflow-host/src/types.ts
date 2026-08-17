// SPDX-License-Identifier: Apache-2.0

import type {
  JsonObject,
  PlanDefinition,
  RouteKey,
  ServiceTier,
  SpecialistOutcome,
} from "@holycodex/core";
import type { ProjectTrustIdentity } from "@holycodex/codex";
import type {
  EvaluateWorkflowInput,
  WorkflowLimitsInput,
  WorkflowResult,
} from "@holycodex/workflow-runtime";
import type {
  Checkpoint,
  ContinuationClaim,
  ContinuationPacket,
  InspectionProjection,
  OperationLifecycle,
  ProjectTrustRef,
  Refinement,
  RetainedContextIdentity,
  RunDefinition,
  RunId,
  RunStatus,
  Telemetry,
} from "./schemas.ts";
import type { FileRunStore } from "./store.ts";

export type ProjectTrustInput = Readonly<
  | ProjectTrustRef
  | ProjectTrustIdentity
  | {
      readonly projectId: string;
      readonly trustId: string;
      readonly projectDigest: string;
      readonly trustDigest: string;
    }
>;

export type SpecialistAssignment = Readonly<{
  readonly runId: RunId;
  readonly project: ProjectTrustRef;
  readonly plan: PlanDefinition;
  readonly serviceTier: ServiceTier;
  readonly route: RouteKey;
  readonly role: "Explorer" | "Librarian" | "Worker" | "Reviewer";
  readonly task: string;
  readonly prompt: string;
  readonly options: JsonObject;
  readonly promptProfile: string;
  readonly toolProfile: string;
  readonly securityProfile: string;
  readonly approvalPolicy: string;
  readonly sandboxPolicy: string;
  readonly signal: AbortSignal;
}>;

export type SpecialistExecutor = (assignment: SpecialistAssignment) => unknown | Promise<unknown>;

export type RuntimeEvaluator = (input: EvaluateWorkflowInput) => Promise<WorkflowResult>;

export type TelemetrySink = (event: Telemetry) => void | Promise<void>;

export type HostCapacity = Readonly<{
  readonly maxCalls?: number;
  readonly maxConcurrency?: number;
  readonly maxRetries?: number;
  readonly maxFanOut?: number;
  readonly costMax?: number;
}>;

export type WorkflowHostOptions = Readonly<{
  readonly store: FileRunStore;
  readonly projectTrust: ProjectTrustInput;
  readonly cwd: string;
  readonly evaluate?: RuntimeEvaluator;
  readonly runtimeEvaluator?: RuntimeEvaluator;
  readonly executeSpecialist?: SpecialistExecutor;
  readonly specialistExecutor?: SpecialistExecutor;
  readonly capacity?: HostCapacity;
  readonly runtimeLimits?: WorkflowLimitsInput;
  readonly policyDigest?: string;
  readonly promptProfile?: string;
  readonly toolProfile?: string;
  readonly securityProfile?: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
  readonly codexCapabilityDigest?: string;
  readonly telemetry?: TelemetrySink;
  readonly refinementsEnabled?: boolean;
}>;

export type CreateRunInput = Readonly<{
  readonly source: string;
  readonly args: unknown;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly plan?: unknown;
  readonly route?: RouteKey;
  readonly serviceTier?: ServiceTier;
  readonly objectiveLineage?: string;
  readonly parentRunId?: string | null;
  readonly estimatedCost?: number;
  readonly expectedCalls?: number;
  readonly expectedConcurrency?: number;
  readonly expectedRetries?: number;
  readonly expectedFanOut?: number;
}>;

export type RunInput = Readonly<{
  readonly runId: string;
  readonly source: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
}>;

export type RunExecution = Readonly<{
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly result: WorkflowResult;
  readonly inspection: InspectionProjection;
}>;

export type ReplayAdmission = Readonly<{
  readonly identity: unknown;
  readonly operationInput: unknown;
}>;

export type ReplayDecision =
  | Readonly<{
      readonly kind: "replayed";
      readonly projection: InspectionProjection;
      readonly outcome: SpecialistOutcome;
    }>
  | Readonly<{
      readonly kind: "denied";
      readonly code: "identity_mismatch" | "operation_input_mismatch" | "new_context_required";
      readonly reason: string;
    }>;

export type RetainedReuseInput = Readonly<{
  readonly project: ProjectTrustInput;
  readonly route: RouteKey;
  readonly role: "Explorer" | "Librarian" | "Worker" | "Reviewer";
  readonly policyDigest: string;
  readonly toolProfile: string;
  readonly securityProfile: string;
  readonly promptProfile: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
}>;

export type RetainedReuseDecision =
  | Readonly<{ readonly kind: "reused"; readonly context: RetainedContextIdentity }>
  | Readonly<{
      readonly kind: "new-context-required";
      readonly code: "identity_mismatch" | "new_context_required";
      readonly reason: string;
    }>;

export type ContinuationDecision =
  | Readonly<{
      readonly kind: "claimed";
      readonly packet: ContinuationPacket;
      readonly claim: ContinuationClaim;
      readonly derived: RunDefinition;
    }>
  | Readonly<{
      readonly kind: "denied";
      readonly code: "continuation_denied" | "claim_conflict" | "integrity_uncertain";
      readonly reason: string;
    }>;

export type RefinementOperation = Readonly<{
  readonly refinement: Refinement;
  readonly enabled: boolean;
}>;

export type PendingRun = Readonly<{
  readonly objective: string;
  readonly constraints: readonly string[];
}>;

export type ActiveRun = {
  readonly controller: AbortController;
  readonly operationControllers: Map<string, AbortController>;
  calls: number;
  maxCalls: number;
  maxConcurrency: number;
};

export type HostContext = {
  readonly store: FileRunStore;
  readonly project: ProjectTrustRef;
  readonly cwd: string;
  readonly evaluator: RuntimeEvaluator;
  readonly executor: SpecialistExecutor;
  readonly capacity: HostCapacity;
  readonly runtimeLimits: WorkflowLimitsInput;
  readonly policyDigest: string;
  readonly promptProfile: string;
  readonly toolProfile: string;
  readonly securityProfile: string;
  readonly approvalPolicy: string;
  readonly sandboxPolicy: string;
  readonly codexCapabilityDigest: string;
  readonly telemetry: TelemetrySink | undefined;
  readonly refinementsEnabled: boolean;
  readonly pending: Map<string, PendingRun>;
  readonly active: Map<string, ActiveRun>;
  readonly journalSequences: Map<string, number>;
  readonly reservations: Map<string, number>;
  reservedCost: number;
};

export type JournalInput =
  | Readonly<{ event: "state-changed"; from: RunStatus; to: RunStatus; reason: string }>
  | Readonly<{ event: "operation"; lifecycle: OperationLifecycle; outcome?: SpecialistOutcome }>
  | Readonly<{ event: "checkpoint"; checkpoint: Checkpoint }>
  | Readonly<{ event: "continuation-claimed"; claim: ContinuationClaim }>
  | Readonly<{ event: "refinement"; refinement: Refinement }>;

export type CheckpointValues = Readonly<{
  readonly verifiedEvidence: readonly string[];
  readonly decisions: readonly string[];
  readonly phases: readonly string[];
  readonly activeWork: readonly string[];
  readonly unresolvedWork: readonly string[];
  readonly blockers: readonly string[];
  readonly verification: readonly string[];
  readonly retainedSummaries: readonly string[];
  readonly nextActions: readonly string[];
  readonly usageCompleteness: "complete" | "partial" | "unknown";
  readonly recoverableErrors: readonly string[];
}>;
