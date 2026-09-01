// SPDX-License-Identifier: Apache-2.0

import type {
  DelegationMode,
  JsonObject,
  JsonValue,
  PlanDefinition,
  RouteKey,
  ServiceTier,
  SpecialistOutcomeV2,
} from "@holycodex/core";
import type {
  AgentExecution,
  AssignmentExecutionService,
  CodexError,
  ProjectTrustIdentity,
} from "@holycodex/codex";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type {
  CompileOptions,
  ExecutionPlan,
  EvaluateWorkflowInput,
  WorkflowApprovalRequest,
  WorkflowCheckpoint,
  WorkflowFailure,
  WorkflowHostServices as RuntimeWorkflowHostServices,
  WorkflowVerificationRequest,
  WorkflowLimitsInput,
  WorkflowResult,
  NativeWorkflow,
  Wait,
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
  RetainedSessionRef,
  RunDefinition,
  RunId,
  RunStatus,
  Telemetry,
  WorkflowRuntimeEvent,
} from "./schemas.ts";
import type { FileRunStore } from "./store.ts";
import type { PlanFirstExecutionGate } from "@holycodex/core";

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

export type SpecialistExecutor = (assignment: SpecialistAssignment) => unknown;

export type WorkflowDefinition = Wait<JsonValue, JsonValue> | NativeWorkflow;
export type WorkflowExecutionMode = "native" | "compatibility";
export type WorkflowHostServices = RuntimeWorkflowHostServices;
export type HostApprovalDecision = "approved" | "denied";
export type HostApprovalHandler = (
  request: WorkflowApprovalRequest,
) => Effect.Effect<HostApprovalDecision, WorkflowFailure>;
export type HostVerificationHandler = (
  request: WorkflowVerificationRequest,
) => Effect.Effect<void, WorkflowFailure>;
export type HostCheckpointHandler = (
  checkpoint: WorkflowCheckpoint,
) => Effect.Effect<void, WorkflowFailure>;

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
  /** Explicitly named compatibility evaluator for the isolated string route. */
  readonly compatibilityEvaluator?: RuntimeEvaluator;
  /** Compatibility adapter for the isolated string evaluator. */
  readonly executeSpecialist?: SpecialistExecutor;
  /** Compatibility alias for executeSpecialist. */
  readonly specialistExecutor?: SpecialistExecutor;
  /** Effect-native workflow services supplied by the host composition root. */
  readonly services?: WorkflowHostServices;
  /** Codex AgentExecution service used by the production assignment bridge. */
  readonly codex?: AssignmentExecutionService;
  /** Compatibility alias for the Codex AgentExecution service. */
  readonly agentExecution?: AssignmentExecutionService;
  readonly codexLayer?: Layer.Layer<AgentExecution, CodexError>;
  readonly compileOptions?: CompileOptions;
  readonly approval?: HostApprovalHandler;
  readonly verification?: HostVerificationHandler;
  readonly checkpoint?: HostCheckpointHandler;
  readonly capacity?: HostCapacity;
  readonly runtimeLimits?: WorkflowLimitsInput;
  readonly policyDigest?: string;
  readonly promptProfile?: string;
  readonly toolProfile?: string;
  readonly securityProfile?: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
  readonly codexCapabilityDigest?: string;
  /** Platform identity used to select exact conditional tool instructions. */
  readonly platform?: "win32" | "posix";
  readonly telemetry?: TelemetrySink;
  readonly refinementsEnabled?: boolean;
  /** Shared conversational gate; planning is read-only until explicit continuation. */
  readonly planFirstGate?: PlanFirstExecutionGate;
}>;

export type CreateRunInput = Readonly<{
  readonly source: string;
  readonly args: unknown;
  readonly objective: string;
  readonly sourcePath?: string;
  readonly constraints?: readonly string[];
  readonly plan?: unknown;
  readonly route?: RouteKey;
  readonly serviceTier?: ServiceTier;
  readonly objectiveLineage?: string;
  readonly parentRunId?: string | null;
  readonly estimatedCost?: number;
  readonly expectedCalls?: number;
  /** Optional exact proof digest for an explicit compatibility cardinality declaration. */
  readonly expectedCallsProofDigest?: string;
  readonly expectedConcurrency?: number;
  readonly expectedRetries?: number;
  readonly expectedFanOut?: number;
  /** Effect-native immutable workflow terminal. Source remains the CLI compatibility input. */
  readonly workflow?: WorkflowDefinition;
  readonly compileOptions?: CompileOptions;
  readonly executionMode?: WorkflowExecutionMode;
  readonly delegationMode?: DelegationMode;
}>;

export type RunInput = Readonly<{
  readonly runId: string;
  readonly source?: string;
  readonly args?: unknown;
  readonly sourcePath?: string;
  readonly signal?: AbortSignal;
  readonly workflow?: WorkflowDefinition;
  readonly compileOptions?: CompileOptions;
  readonly executionMode?: WorkflowExecutionMode;
  readonly delegationMode?: DelegationMode;
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
      readonly outcome: SpecialistOutcomeV2;
    }>
  | Readonly<{
      readonly kind: "denied";
      readonly code:
        | "identity_mismatch"
        | "operation_input_mismatch"
        | "no_progress"
        | "integrity_uncertain"
        | "new_context_required";
      readonly reason: string;
    }>;

export type RetainedReuseInput = Readonly<{
  readonly project: ProjectTrustInput;
  readonly route: RouteKey;
  readonly role: "Explorer" | "Librarian" | "Worker" | "Reviewer";
  readonly task?: string;
  readonly objectiveLineage?: string;
  readonly authorityScopeDigest?: string;
  readonly policyDigest: string;
  readonly toolProfile: string;
  readonly securityProfile: string;
  readonly promptProfile: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
  readonly codexCapabilityDigest?: string;
  readonly skillProfileDigest: string;
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
  readonly workflow?: WorkflowDefinition;
  readonly compileOptions?: CompileOptions;
  readonly compiledPlan?: ExecutionPlan<unknown>;
}>;

export type ActiveRun = {
  readonly controller: AbortController;
  readonly operationControllers: Map<string, AbortController>;
  calls: number;
  maxCalls: number;
  maxConcurrency: number;
  maxCost: number;
  inFlight: number;
  costUnits: number;
};

export type HostContext = {
  readonly store: FileRunStore;
  readonly project: ProjectTrustRef;
  readonly cwd: string;
  readonly evaluator: RuntimeEvaluator;
  readonly compatibilityEvaluator: RuntimeEvaluator | undefined;
  readonly compatibilityEnabled: boolean;
  readonly executor: SpecialistExecutor;
  readonly services: WorkflowHostServices;
  readonly codex: AssignmentExecutionService | undefined;
  readonly codexLayer: Layer.Layer<AgentExecution, CodexError> | undefined;
  readonly compileOptions: CompileOptions;
  readonly approval: HostApprovalHandler | undefined;
  readonly verification: HostVerificationHandler | undefined;
  readonly checkpoint: HostCheckpointHandler | undefined;
  readonly sharedCapacity: import("@holycodex/workflow-runtime").CapacityService;
  readonly capacity: HostCapacity;
  readonly runtimeLimits: WorkflowLimitsInput;
  readonly policyDigest: string;
  readonly promptProfile: string;
  readonly toolProfile: string;
  readonly securityProfile: string;
  readonly approvalPolicy: string;
  readonly sandboxPolicy: string;
  readonly codexCapabilityDigest: string;
  readonly platform: "win32" | "posix";
  readonly telemetry: TelemetrySink | undefined;
  readonly refinementsEnabled: boolean;
  readonly planFirstGate: PlanFirstExecutionGate;
  readonly pending: Map<string, PendingRun>;
  readonly active: Map<string, ActiveRun>;
  readonly executionLocks: Map<string, Promise<void>>;
  readonly journalSequences: Map<string, number>;
  readonly reservations: Map<string, import("@holycodex/workflow-runtime").CapacityRunReservation>;
  readonly approvalLocks: Map<string, Promise<void>>;
  readonly lifecycleLocks: Map<string, Promise<void>>;
};

export type JournalInput =
  | Readonly<{ event: "state-changed"; from: RunStatus; to: RunStatus; reason: string }>
  | Readonly<{
      event: "operation";
      lifecycle: OperationLifecycle;
      outcome?: SpecialistOutcomeV2;
      session?: RetainedSessionRef;
    }>
  | Omit<WorkflowRuntimeEvent, "schema_epoch" | "run_id" | "sequence" | "at">
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
