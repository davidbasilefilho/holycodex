// SPDX-License-Identifier: Apache-2.0

import { STATE_SCHEMA_EPOCH } from "@holycodex/core";
import type { CliEnvelope, JsonObject, JsonValue, PlanName, ServiceTier } from "@holycodex/core";
import type { OfficialPluginManifest, OfficialPluginVerification } from "@holycodex/codex";
import type {
  InspectionProjection,
  Refinement,
  RunDefinition,
  RunExecution,
  WorkflowHostError,
} from "@holycodex/workflow-host";

export type OptionalSelectionName = "computer_use" | "work" | "web" | "security" | "coding";

export type OptionalSelections = Readonly<{
  readonly computer_use: boolean;
  readonly work: boolean;
  readonly web: boolean;
  readonly security: boolean;
  readonly coding: true;
}>;

export type ExplicitOptionalSelections = Readonly<
  Partial<{
    readonly computer_use: boolean;
    readonly work: boolean;
    readonly web: boolean;
    readonly security: boolean;
  }>
>;

export interface InstallerPaths {
  readonly codexHome: string;
  readonly marketplaceRoot: string;
}

export interface OfficialPluginManager {
  readonly list?: () => Promise<readonly OfficialPluginManifest[]>;
  readonly add?: (plugin: OfficialPluginVerification) => Promise<void>;
  readonly status?: (
    selected: readonly string[],
  ) => Promise<Readonly<Record<string, "installed" | "available" | "missing" | "unknown">>>;
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
  readonly official_plugins?: readonly string[];
  readonly installed_at: string;
}

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

export type CleanupScope = "run" | "workspace" | "expired";

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
    readonly plan?: PlanName;
    readonly serviceTier?: ServiceTier;
  }) => Promise<RunDefinition>;
  readonly run?: (input: {
    readonly runId: string;
    readonly source: string;
    readonly args: JsonValue;
  }) => Promise<RunExecution>;
  readonly resume?: (input: {
    readonly runId: string;
    readonly source: string;
    readonly args: JsonValue;
  }) => Promise<RunExecution>;
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
  ) => Promise<JsonValue>;
  readonly refinements?: {
    readonly list?: () => Promise<readonly Refinement[]>;
    readonly show?: (id: string) => Promise<Refinement>;
    readonly enable?: (id: string) => Promise<Refinement>;
    readonly disable?: (id: string) => Promise<Refinement>;
  };
}

export interface CliIo {
  readonly stdin?: AsyncIterable<string>;
  readonly stdoutIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

export interface CliContext {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly io?: CliIo;
  readonly installer?: InstallerOptions;
  readonly workflowService?: WorkflowService;
  readonly trustGate?: (path: string) => Promise<boolean>;
  readonly readStdin?: () => Promise<string>;
  readonly now?: () => Date;
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
