// SPDX-License-Identifier: Apache-2.0

import type { ManagedRuntimeConfigState } from "@holycodex/codex";
import type { LiveOfficialPluginListEnvelope } from "@holycodex/codex";
import { STATE_SCHEMA_EPOCH } from "@holycodex/core";
import type { CliEnvelope, JsonObject, ProfileName, ServiceTier } from "@holycodex/core";

import type { InstallRequest } from "./installer.ts";

export type OptionalSelections = Readonly<{
  readonly computer_use: boolean;
  readonly frontend: boolean;
  readonly security: boolean;
  readonly coding: true;
}>;

export type ExplicitOptionalSelections = Readonly<
  Partial<{
    readonly computer_use: boolean | undefined;
    readonly frontend: boolean | undefined;
    readonly security: boolean | undefined;
  }>
>;

export interface InstallerPaths {
  readonly codexHome: string;
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
  /** Populate Codex-owned reserved marketplaces through supported runtime startup. */
  readonly ensureOfficialMarketplace?: (selectedPluginIds: readonly string[]) => Promise<void>;
  readonly addMarketplace?: (source: string) => Promise<void>;
  readonly add?: (pluginId: string) => Promise<void>;
  readonly remove?: (pluginId: string) => Promise<void>;
  readonly status?: (
    selected: readonly string[],
  ) => Promise<Readonly<Record<string, OfficialPluginStatus>>>;
  readonly getObservedIdentities?: () => Readonly<Record<string, string>>;
}

export interface ManagedArtifact {
  readonly path: string;
  readonly digest: string;
}

export interface InstallRecord {
  readonly owner: "holycodex";
  readonly schema_epoch: typeof STATE_SCHEMA_EPOCH;
  readonly install_id: string;
  readonly version: string;
  readonly digest: string;
  readonly profile: ProfileName;
  readonly tier: ServiceTier;
  readonly optional_selections: OptionalSelections;
  readonly explicit_optional_selections: ExplicitOptionalSelections;
  readonly official_plugins?: readonly string[] | undefined;
  readonly capability_state?: CapabilityStateRecord | undefined;
  readonly managed_artifacts: readonly ManagedArtifact[];
  readonly installed_at: string;
  /** Present on current records; omitted only for legacy-state compatibility. */
  readonly status?: "active" | undefined;
  readonly step?: "active" | undefined;
  readonly managed_config?: ManagedRuntimeConfigState | undefined;
  readonly plugin_snapshot?: readonly PluginSnapshot[] | undefined;
  readonly plugin_config?: PluginConfigSnapshot | undefined;
  readonly provider_config?: readonly ProviderPluginConfigSnapshot[] | undefined;
  readonly owned_plugins?: readonly string[] | undefined;
  readonly tooling?: InstallerToolingState | undefined;
}

export interface PluginSnapshot {
  readonly plugin_id: string;
  readonly status: OfficialPluginStatus;
}

export type PluginConfigSafeValue =
  | Readonly<{ readonly kind: "boolean"; readonly value: boolean }>
  | Readonly<{
      readonly kind: "marketplace";
      readonly source_type: "git";
      readonly source: "https://github.com/davidbasilefilho/holycodex.git";
    }>;

export interface PluginConfigEntrySnapshot {
  readonly presence: "absent" | "present";
  readonly digest: string;
  readonly safe_value?: PluginConfigSafeValue | undefined;
}

export interface PluginConfigSnapshot {
  readonly plugin_id: "holycodex@holycodex";
  readonly before: Readonly<{
    readonly preference: PluginConfigEntrySnapshot;
    readonly marketplace: PluginConfigEntrySnapshot;
  }>;
  readonly after: Readonly<{
    readonly preference: PluginConfigEntrySnapshot;
    readonly marketplace: PluginConfigEntrySnapshot;
  }>;
}

export interface ProviderPluginConfigEntrySnapshot {
  readonly presence: "absent" | "present";
  readonly digest: string;
  readonly safe_value?: Readonly<{ readonly kind: "boolean"; readonly value: boolean }> | undefined;
}

export interface ProviderPluginConfigSnapshot {
  readonly plugin_id: string;
  readonly before: ProviderPluginConfigEntrySnapshot;
  readonly after: ProviderPluginConfigEntrySnapshot;
}

export type InstallTransactionStatus = "preparing" | "conflicted";
export type InstallTransactionStep =
  | "validated"
  | "plugins_snapshotted"
  | "roles_prepared"
  | "plugins_installed"
  | "config_published"
  | "verified"
  | "conflicted";

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
  readonly frontend: CapabilityInstallState;
  readonly security: CapabilityInstallState;
}>;

export type InstallerPlatform = NodeJS.Platform;

export interface InstallerProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type InstallerProcessRunner = (
  executable: string,
  args: readonly string[],
) => Promise<InstallerProcessResult>;

export interface InstallerFileSystem {
  readonly access: (path: string) => Promise<void>;
  readonly readText: (path: string) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
}

export interface InstallerRuntime {
  readonly platform: InstallerPlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly processPath: string;
  readonly run: InstallerProcessRunner;
  /** Injectable filesystem boundary for package and executable verification. */
  readonly files?: InstallerFileSystem;
}

export type Context7Manager = Readonly<{
  readonly launcher: "bunx" | "npx" | "pnpm dlx";
  readonly family: "bun" | "npm" | "pnpm";
  readonly executable: "bun" | "npm" | "pnpm";
}>;

export type GitBashState =
  | Readonly<{ readonly status: "not_applicable" }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{
      readonly status: "healthy";
      readonly path: string;
      readonly installed: boolean;
    }>;

export type Context7ToolState = Readonly<{
  readonly manager: Context7Manager["family"];
  readonly launcher: Context7Manager["launcher"];
  readonly version: string;
  readonly executable: string;
  readonly ownership: "user" | "holycodex";
}>;

export type InstallerToolingState = Readonly<{
  readonly git_bash: GitBashState;
  readonly context7: Context7ToolState;
}>;

export type ManagedConflict = Readonly<{
  readonly path: string;
  readonly key?: string | undefined;
  readonly action: "replace" | "remove";
}>;

export type ConflictResolution = "accept" | "decline" | "cancel";
export type ConflictResolver = (conflict: ManagedConflict) => Promise<ConflictResolution>;

export interface InstallerOptions {
  readonly paths?: Partial<InstallerPaths>;
  readonly sourceRoot?: string;
  readonly officialPluginManager?: OfficialPluginManager;
  readonly now?: () => Date;
  /** Injectable platform/process boundary for prerequisite discovery and repair. */
  readonly runtime?: InstallerRuntime;
  /** Resolve modifications to state whose HolyCodex ownership is proven by persisted metadata. */
  readonly resolveConflict?: ConflictResolver;
  /** Receives lifecycle progress only when an installer stage actually starts or completes. */
  readonly onProgress?: (event: InstallProgressEvent) => void;
}

export interface InstallResult {
  readonly record: InstallRecord;
  readonly optional_plugins: readonly string[];
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
}

export interface UpgradeRequest {
  readonly dryRun?: boolean | undefined;
}

export interface UpgradeResult {
  readonly status: "upgraded" | "current" | "dry_run";
  readonly from_version: string;
  readonly to_version: string;
  readonly changes: readonly string[];
  readonly record?: InstallRecord | undefined;
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
  readonly conflicts?: readonly ManagedConflict[] | undefined;
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
}

export interface RemoveResult {
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
  readonly reasons: readonly string[];
}

export interface CliIo {
  readonly stdin?: AsyncIterable<string>;
  readonly stdoutIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly confirm?: (message: string) => Promise<boolean | ConfirmationResult>;
  /** Injectable interactive installer boundary used by tests and embedders. */
  readonly installWizard?: (initial: InstallRequest) => Promise<InstallWizardResult>;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

/** Result of the public interactive install wizard. */
export type InstallWizardResult =
  | Readonly<{ readonly action: "install"; readonly request: InstallRequest }>
  | Readonly<{ readonly action: "cancel" }>;

export type ConfirmationResult = "confirmed" | "cancelled" | "unavailable";

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
  readonly now?: () => Date;
  /** Observe lifecycle boundaries after the corresponding operation begins or completes. */
  readonly onProgress?: (event: InstallProgressEvent) => void;
}

export type InstallProgressStage =
  | "validation"
  | "roles"
  | "plugins"
  | "config"
  | "verification"
  | "complete"
  | "removal";

export interface InstallProgressEvent {
  readonly stage: InstallProgressStage;
  readonly status: "started" | "completed";
  readonly message: string;
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
