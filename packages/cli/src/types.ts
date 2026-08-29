// SPDX-License-Identifier: Apache-2.0

import { STATE_SCHEMA_EPOCH } from "@holycodex/core";
import type {
  CliEnvelope,
  JsonObject,
  JsonValue,
  OptionalCapabilityName,
  OptionalCapabilitySelections,
  PlanName,
  RouteKey,
  RoleTask,
  ServiceTier,
  CapabilityName,
  CapabilityResultV2,
} from "@holycodex/core";
import type { LiveOfficialPluginListEnvelope } from "@holycodex/codex";
import type { SafeWorkflowFilesystemBoundary } from "./generated-workflow-store.ts";
import type {
  InspectionProjection,
  Refinement,
  RunDefinition,
  RunExecution,
  WorkflowDefinition,
  WorkflowHostError,
} from "@holycodex/workflow-host";

export type OptionalSelectionName = OptionalCapabilityName | "coding";
export type Autonomy = "manual" | "assisted" | "autonomous";
export type WorkflowCapabilityName = CapabilityName;

export type OptionalSelections = OptionalCapabilitySelections &
  Readonly<{
    readonly coding: true;
  }>;

export type ExplicitOptionalSelections = Readonly<
  Partial<{
    readonly computer_use: boolean | undefined;
    readonly work: boolean | undefined;
    readonly web: boolean | undefined;
    readonly security: boolean | undefined;
  }>
>;

export interface InstallerPaths {
  readonly codexHome: string;
  readonly marketplaceRoot: string;
}

export type OfficialPluginStatus =
  | "installed"
  | "available"
  | "missing"
  | "disabled"
  | "uncertain"
  | "unknown";

export interface OfficialPluginManager {
  readonly list?: () => Promise<LiveOfficialPluginListEnvelope>;
  readonly add?: (pluginId: string) => Promise<void>;
  readonly status?: (
    selected: readonly string[],
  ) => Promise<Readonly<Record<string, OfficialPluginStatus>>>;
}

export interface CodexExecutableProbe {
  readonly discover: () => Promise<Readonly<{ path: string; version: string; sha256: string }>>;
}

export interface InstallRecord {
  readonly schema_epoch: typeof STATE_SCHEMA_EPOCH;
  readonly version: string;
  readonly digest: string;
  readonly epoch: string;
  readonly artifact_id: string;
  readonly relative_path: string;
  readonly plan: PlanName;
  readonly tier: ServiceTier;
  readonly optional_selections: OptionalSelections;
  readonly explicit_optional_selections: ExplicitOptionalSelections;
  readonly official_plugins?: readonly string[] | undefined;
  readonly capability_state?: CapabilityStateRecord | undefined;
  readonly autonomy?: Autonomy | undefined;
  readonly max_subagents?: number | undefined;
  readonly installed_at: string;
}

export type CapabilityStateStatus =
  | "disabled"
  | "pending"
  | "healthy"
  | "missing"
  | "provider_disabled"
  | "uncertain"
  | "unavailable";

export interface CapabilityInstallState {
  readonly selected: boolean;
  readonly status: CapabilityStateStatus;
  readonly plugin_ids: readonly string[];
  readonly reason?: string | undefined;
}

export type CapabilityStateRecord = Readonly<{
  readonly computer_use: CapabilityInstallState;
  readonly work: CapabilityInstallState;
  readonly web: CapabilityInstallState;
  readonly security: CapabilityInstallState;
}>;

export interface InstallerOptions {
  readonly paths?: Partial<InstallerPaths>;
  readonly sourceRoot?: string;
  readonly officialPluginManager?: OfficialPluginManager;
  readonly codexExecutable?: CodexExecutableProbe;
  readonly lockTtlMs?: number;
  readonly retentionDays?: number;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly runIdFactory?: () => string;
  /** Supplied by the platform-native helper or an explicit test primitive. */
  readonly generatedWorkflowBoundary?: SafeWorkflowFilesystemBoundary;
}

export interface InstallResult {
  readonly record: InstallRecord;
  readonly artifact_path: string;
  readonly marketplace_path: string;
  readonly recovered_lock: boolean;
  readonly pruned_artifacts: readonly string[];
  readonly optional_plugins: readonly string[];
}

export interface DoctorCheck {
  readonly status: "healthy" | "warning" | "failed" | "unsupported";
  readonly reasons: readonly string[];
  readonly details: JsonObject;
}

export interface DoctorResult {
  readonly healthy: boolean;
  readonly checks: Readonly<Record<string, DoctorCheck>>;
  readonly reasons: readonly string[];
  readonly inactive_artifacts: readonly string[];
}

export type CleanupScope = "run" | "workspace" | "expired" | "workflow-session";

export interface CleanupResult {
  readonly scope: CleanupScope;
  readonly preview: boolean;
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
  readonly reasons: readonly string[];
}

export interface WorkflowService {
  readonly create?: (input: {
    readonly source: string;
    readonly args: JsonValue;
    readonly objective: string;
    readonly sourcePath?: string;
    readonly plan?: PlanName;
    readonly serviceTier?: ServiceTier;
    readonly autonomy?: Autonomy;
    readonly maxSubagents?: number;
    readonly workflow?: WorkflowDefinition;
  }) => Promise<RunDefinition>;
  readonly run?: (input: {
    readonly runId: string;
    readonly source: string;
    readonly args: JsonValue;
    readonly sourcePath?: string;
    readonly workflow?: WorkflowDefinition;
    readonly compatibility?: boolean;
  }) => Promise<RunExecution>;
  readonly resume?: (input: {
    readonly runId: string;
    readonly source: string;
    readonly args: JsonValue;
    readonly sourcePath?: string;
    readonly workflow?: WorkflowDefinition;
    readonly compatibility?: boolean;
  }) => Promise<RunExecution>;
  readonly continuation?: (input: {
    readonly runId: string;
    readonly source: string;
    readonly args: JsonValue;
    readonly compatibility?: boolean;
  }) => Promise<JsonValue>;
  readonly list?: () => Promise<readonly InspectionProjection[]>;
  readonly show?: (runId: string) => Promise<InspectionProjection>;
  readonly inspect?: (runId: string, follow: boolean) => Promise<InspectionProjection>;
  readonly goal?: (runId: string, summary: string) => Promise<InspectionProjection>;
  readonly pause?: (runId: string) => Promise<InspectionProjection>;
  readonly restart?: (runId: string) => Promise<InspectionProjection>;
  readonly reopen?: (runId: string) => Promise<InspectionProjection>;
  readonly stop?: (runId: string) => Promise<InspectionProjection>;
  readonly stopAgent?: (runId: string, callId: string) => Promise<InspectionProjection>;
  readonly save?: (scope: "user" | "project", name: string, source: string) => Promise<JsonValue>;
  readonly invoke?: (
    scope: "user" | "project",
    name: string,
    args: JsonValue,
    compatibility?: boolean,
  ) => Promise<JsonValue>;
  readonly refinements?: {
    readonly list?: () => Promise<readonly Refinement[]>;
    readonly show?: (id: string) => Promise<Refinement>;
    readonly enable?: (id: string) => Promise<Refinement>;
    readonly disable?: (id: string) => Promise<Refinement>;
  };
}

export interface WorkflowCapabilityRequest {
  readonly capability: WorkflowCapabilityName;
  readonly input: JsonObject;
  readonly objective: string;
  readonly role_task: RoleTask | null;
  readonly authority: string;
  readonly scope: readonly string[];
  readonly constraints: readonly string[];
  readonly required_evidence: readonly string[];
  readonly completion: readonly string[];
  readonly tools: Readonly<{
    readonly allowed: readonly string[];
    readonly specialist_spawn: false;
    readonly workflow: false;
  }>;
  readonly security: Readonly<{
    readonly network: boolean;
    readonly specialist_spawn: false;
    readonly workflow: false;
  }>;
  readonly route: RouteKey | null;
  readonly signal: AbortSignal;
  readonly rootAuthority: boolean;
}

export type WorkflowCapabilityResult = CapabilityResultV2;

export interface WorkflowCapabilityPort {
  readonly invoke: (request: WorkflowCapabilityRequest) => Promise<unknown>;
  readonly available?: () => Promise<boolean>;
}

export type WorkflowCapabilities = Readonly<
  Partial<Record<WorkflowCapabilityName, WorkflowCapabilityPort>>
>;

export interface CliIo {
  readonly stdin?: AsyncIterable<string>;
  readonly stdoutIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

/** Controls the human renderer without affecting the machine JSON envelope. */
export interface HumanRenderOptions {
  readonly stdoutIsTTY?: boolean | undefined;
  readonly stderrIsTTY?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stream?: "stdout" | "stderr" | undefined;
}

export interface CliContext {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly io?: CliIo;
  readonly installer?: InstallerOptions;
  /** Explicit test seam for a validated App Server assignment adapter. */
  readonly appServerAssignment?: AppServerAssignmentPort;
  readonly workflowService?: WorkflowService;
  readonly capabilities?: WorkflowCapabilities;
  readonly rootAuthority?: boolean;
  /** Caller-owned session identity used for generated workflow storage. */
  readonly workflowSessionId?: string;
  /** Optional strict generated workflow filename stem supplied by the caller. */
  readonly workflowName?: string;
  readonly generatedWorkflowBoundary?: SafeWorkflowFilesystemBoundary;
  readonly trustGate?: (path: string) => Promise<boolean>;
  readonly readStdin?: () => Promise<string>;
  readonly now?: () => Date;
}

export interface AppServerAssignmentPort {
  readonly execute: (
    packet: unknown,
    options?: Readonly<{ readonly signal?: AbortSignal; readonly timeoutMs?: number }>,
  ) => Promise<unknown>;
}

export interface CommandResult {
  readonly envelope: CliEnvelope;
  readonly exitCode: number;
}

export interface ParsedCommand {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export type CliFailureError = WorkflowHostError | Error;
