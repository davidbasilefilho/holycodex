// SPDX-License-Identifier: Apache-2.0

import type { ManagedRuntimeConfigState } from "@holycodex/codex";
import type { LiveOfficialPluginListEnvelope } from "@holycodex/codex";
import { STATE_SCHEMA_EPOCH } from "@holycodex/core";
import type {
  ReleaseVersion,
  CliEnvelope,
  JsonObject,
  OptionalCapabilityName,
  ProfileName,
  ServiceTier,
} from "@holycodex/core";

import type { InstallRequest } from "./installer.ts";

/** Public CLI type describing optional selections. */
export type OptionalSelections = Readonly<{
  readonly browser_use: boolean;
  readonly computer_use: boolean;
  readonly sites: boolean;
  readonly coding: true;
}>;

/** Public CLI type describing explicit optional selections. */
export type ExplicitOptionalSelections = Readonly<
  Partial<{
    readonly browser_use: boolean | undefined;
    readonly computer_use: boolean | undefined;
    readonly sites: boolean | undefined;
  }>
>;

/** Public data contract for installer paths used by CLI operations. */
export interface InstallerPaths {
  /** The codex home in installer paths. */
  readonly codexHome: string;
}

/** Public CLI type describing official plugin status. */
export type OfficialPluginStatus =
  | "installed"
  | "available"
  | "missing"
  | "disabled"
  | "uncertain"
  | "unknown";

/** Public data contract for official plugin manager used by CLI operations. */
export interface OfficialPluginManager {
  /** Reads the current official-plugin list from Codex. */
  readonly list?: () => Promise<LiveOfficialPluginListEnvelope>;
  /** Populate Codex-owned reserved marketplaces through supported runtime startup. */
  readonly ensureOfficialMarketplace?: (selectedPluginIds: readonly string[]) => Promise<void>;
  /** The add marketplace in official plugin manager. */
  readonly addMarketplace?: (source: string) => Promise<void>;
  /** Installs an official plugin by its Codex identifier. */
  readonly add?: (pluginId: string) => Promise<void>;
  /** Removes an official plugin by its Codex identifier. */
  readonly remove?: (pluginId: string) => Promise<void>;
  /** Returns the observed status of each requested plugin. */
  readonly status?: (
    selected: readonly string[],
  ) => Promise<Readonly<Record<string, OfficialPluginStatus>>>;
  /** The get observed identities in official plugin manager. */
  readonly getObservedIdentities?: () => Readonly<Record<string, string>>;
}

/** Public data contract for managed artifact used by CLI operations. */
export interface ManagedArtifact {
  /** The path in managed artifact. */
  readonly path: string;
  /** Digest of the package contents associated with the record. */
  readonly digest: string;
}

/** Public data contract for install record used by CLI operations. */
export interface InstallRecord {
  /** Marks this record as owned by HolyCodex. */
  readonly owner: "holycodex";
  /** The schema epoch in install record. */
  readonly schema_epoch: typeof STATE_SCHEMA_EPOCH;
  /** The install id in install record. */
  readonly install_id: string;
  /** HolyCodex version that created or last updated the record. */
  readonly version: ReleaseVersion;
  /** Digest of the package contents associated with the record. */
  readonly digest: string;
  /** Profile whose generated roles and defaults were installed. */
  readonly profile: ProfileName;
  /** Model service tier selected for generated agent configuration. */
  readonly tier: ServiceTier;
  /** The optional selections in install record. */
  readonly optional_selections: OptionalSelections;
  /** The explicit optional selections in install record. */
  readonly explicit_optional_selections: ExplicitOptionalSelections;
  /** The official plugins in install record. */
  readonly official_plugins?: readonly string[] | undefined;
  /** The capability state in install record. */
  readonly capability_state?: CapabilityStateRecord | undefined;
  /** The managed artifacts in install record. */
  readonly managed_artifacts: readonly ManagedArtifact[];
  /** The installed at in install record. */
  readonly installed_at: string;
  /** Present on current records; omitted only for legacy-state compatibility. */
  readonly status?: "active" | undefined;
  /** Transaction step that was active when this record was persisted. */
  readonly step?: "active" | undefined;
  /** The managed config in install record. */
  readonly managed_config?: ManagedRuntimeConfigState | undefined;
  /** The plugin snapshot in install record. */
  readonly plugin_snapshot?: readonly PluginSnapshot[] | undefined;
  /** The plugin config in install record. */
  readonly plugin_config?: PluginConfigSnapshot | undefined;
  /** The provider config in install record. */
  readonly provider_config?: readonly ProviderPluginConfigSnapshot[] | undefined;
  /** The owned plugins in install record. */
  readonly owned_plugins?: readonly string[] | undefined;
  /** Optional external tooling managed or inspected by the installer. */
  readonly tooling?: InstallerToolingState | undefined;
}

/** Public data contract for plugin snapshot used by CLI operations. */
export interface PluginSnapshot {
  /** The plugin id in plugin snapshot. */
  readonly plugin_id: string;
  /** Returns the observed status of each requested plugin. */
  readonly status: OfficialPluginStatus;
}

/** Public CLI type describing plugin config safe value. */
export type PluginConfigSafeValue =
  | Readonly<{ readonly kind: "boolean"; readonly value: boolean }>
  | Readonly<{
      readonly kind: "marketplace";
      readonly source_type: "git";
      readonly source: "https://github.com/davidbasilefilho/holycodex.git";
    }>;

/** Public data contract for plugin config entry snapshot used by CLI operations. */
export interface PluginConfigEntrySnapshot {
  /** Records whether the setting existed before or after the transaction. */
  readonly presence: "absent" | "present";
  /** Digest of the package contents associated with the record. */
  readonly digest: string;
  /** The safe value in plugin config entry snapshot. */
  readonly safe_value?: PluginConfigSafeValue | undefined;
}

/** Public data contract for plugin config snapshot used by CLI operations. */
export interface PluginConfigSnapshot {
  /** The plugin id in plugin config snapshot. */
  readonly plugin_id: "holycodex@holycodex";
  /** Observed setting state before the transaction. */
  readonly before: Readonly<{
    readonly preference: PluginConfigEntrySnapshot;
    readonly marketplace: PluginConfigEntrySnapshot;
  }>;
  /** Expected setting state after the transaction. */
  readonly after: Readonly<{
    readonly preference: PluginConfigEntrySnapshot;
    readonly marketplace: PluginConfigEntrySnapshot;
  }>;
}

/** Public data contract for provider plugin config entry snapshot used by CLI operations. */
export interface ProviderPluginConfigEntrySnapshot {
  /** Records whether the setting existed before or after the transaction. */
  readonly presence: "absent" | "present";
  /** Digest of the package contents associated with the record. */
  readonly digest: string;
  /** The safe value in provider plugin config entry snapshot. */
  readonly safe_value?: Readonly<{ readonly kind: "boolean"; readonly value: boolean }> | undefined;
}

/** Public data contract for provider plugin config snapshot used by CLI operations. */
export interface ProviderPluginConfigSnapshot {
  /** The plugin id in provider plugin config snapshot. */
  readonly plugin_id: string;
  /** Observed setting state before the transaction. */
  readonly before: ProviderPluginConfigEntrySnapshot;
  /** Expected setting state after the transaction. */
  readonly after: ProviderPluginConfigEntrySnapshot;
}

/** Public CLI type describing install transaction status. */
export type InstallTransactionStatus = "preparing" | "conflicted";
/** Public CLI type describing install transaction step. */
export type InstallTransactionStep =
  | "validated"
  | "plugins_snapshotted"
  | "roles_prepared"
  | "plugins_installed"
  | "config_published"
  | "verified"
  | "conflicted";

/** Public CLI type describing capability state status. */
export type CapabilityStateStatus =
  | "disabled"
  | "pending"
  | "healthy"
  | "missing"
  | "provider_disabled"
  | "uncertain"
  | "unavailable";

/** Public data contract for capability install state used by CLI operations. */
export interface CapabilityInstallState {
  /** Whether this capability is enabled for the installation. */
  readonly selected: boolean;
  /** Returns the observed status of each requested plugin. */
  readonly status: CapabilityStateStatus;
  /** The plugin ids in capability install state. */
  readonly plugin_ids: readonly string[];
  /** The reason in capability install state. */
  readonly reason?: string | undefined;
}

/** Public CLI type describing capability state record. */
export type CapabilityStateRecord = Readonly<{
  readonly browser_use: CapabilityInstallState;
  readonly computer_use: CapabilityInstallState;
  readonly frontend: CapabilityInstallState;
  readonly security: CapabilityInstallState;
  readonly sites: CapabilityInstallState;
}>;

/** Public CLI type describing installer platform. */
export type InstallerPlatform = NodeJS.Platform;

/** Public data contract for installer process result used by CLI operations. */
export interface InstallerProcessResult {
  /** The exit code in installer process result. */
  readonly exitCode: number;
  /** Captured standard output from the child process. */
  readonly stdout: string;
  /** Captured standard error from the child process. */
  readonly stderr: string;
}

/** Public CLI type describing installer process runner. */
export type InstallerProcessRunner = (
  executable: string,
  args: readonly string[],
) => Promise<InstallerProcessResult>;

/** Public data contract for installer file system used by CLI operations. */
export interface InstallerFileSystem {
  /** Checks whether a required path can be accessed. */
  readonly access: (path: string) => Promise<void>;
  /** The read text in installer file system. */
  readonly readText: (path: string) => Promise<string>;
  /** Returns the canonical path used for identity checks. */
  readonly realpath: (path: string) => Promise<string>;
}

/** Public data contract for installer runtime used by CLI operations. */
export interface InstallerRuntime {
  /** Operating-system identifier used to select platform-specific behavior. */
  readonly platform: InstallerPlatform;
  /** Environment variables passed to installer-owned child processes. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The process path in installer runtime. */
  readonly processPath: string;
  /** Runs an installer command and captures its result. */
  readonly run: InstallerProcessRunner;
  /** Injectable filesystem boundary for package and executable verification. */
  readonly files?: InstallerFileSystem;
}

/** Public CLI type describing context7 manager. */
export type Context7Manager = Readonly<{
  readonly launcher: "bunx" | "npx" | "pnpm dlx";
  readonly family: "bun" | "npm" | "pnpm";
  readonly executable: "bun" | "npm" | "pnpm";
}>;

/** Legacy Git Bash discovery state accepted while reading earlier install records. */
export type GitBashState =
  | Readonly<{ readonly status: "not_applicable" }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{
      readonly status: "healthy";
      readonly path: string;
      readonly installed: boolean;
    }>;

/** Public CLI type describing context7 tool state. */
export type Context7ToolState = Readonly<{
  readonly manager: Context7Manager["family"];
  readonly launcher: Context7Manager["launcher"];
  readonly version: string;
  readonly executable: string;
  readonly ownership: "user" | "holycodex";
  /** Digest of the verified manager, package, and executable provenance. */
  readonly identity?: string | undefined;
}>;

/** Public CLI type describing installer tooling state. */
export type InstallerToolingState = Readonly<{
  /** Legacy state accepted while reading earlier install records. */
  readonly git_bash?: GitBashState | undefined;
  readonly context7?: Context7ToolState | undefined;
}>;

/** Public CLI type describing managed conflict. */
export type ManagedConflict = Readonly<{
  /** Stable identity used to retain a decision while the view is redrawn. */
  readonly identity?: string | undefined;
  /** Managed conflict family, such as config-key, role-asset, or native-plugin. */
  readonly category?: string | undefined;
  /** Human-facing managed target. */
  readonly target?: string | undefined;
  readonly existing?: unknown;
  readonly desired?: unknown;
  /** Decision selected during preflight conflict resolution, when one was made. */
  readonly decision?: ConflictDecision | undefined;
  readonly defaultDecision?: ConflictDecision | undefined;
  readonly validDecisions?: readonly ConflictDecision[] | undefined;
  readonly explanation?: string | undefined;
  readonly path: string;
  readonly key?: string | undefined;
  readonly action: "replace" | "remove";
}>;

/** Public CLI type describing conflict resolution. */
export type ConflictResolution = "accept" | "decline" | "cancel";
/** A user-selected action available for one managed conflict. */
export type ConflictDecision = "keep" | "remove" | "replace" | "cancel";
/** Public CLI type describing conflict resolver. */
export type ConflictResolver = (conflict: ManagedConflict) => Promise<ConflictResolution>;
/** Resolve the complete conflict inventory in one user interaction. */
export type ConflictBatchResolver = (
  conflicts: readonly ManagedConflict[],
) => Promise<Readonly<Record<string, ConflictDecision>>>;

/** A single prerequisite shown in the final install or upgrade review. */
export type InstallReviewTool = Readonly<{
  readonly name: string;
  readonly status: string;
  readonly detail?: string | undefined;
}>;

/** The complete, read-only plan presented immediately before a managed transaction. */
export type InstallReview = Readonly<{
  readonly operation: "install" | "upgrade";
  readonly fromVersion?: ReleaseVersion | undefined;
  readonly toVersion: ReleaseVersion;
  readonly profile: ProfileName;
  readonly tier: ServiceTier;
  readonly capabilities: Readonly<Record<OptionalCapabilityName, boolean>>;
  readonly additionalPlugins: readonly string[];
  readonly conflicts: readonly ManagedConflict[];
  readonly conflictCounts: Readonly<Record<string, number>>;
  readonly tools: readonly InstallReviewTool[];
}>;

/** The action selected on the final install or upgrade review screen. */
export type InstallReviewAction = "apply" | "change" | "resolve" | "cancel";

/** Result returned by the final install or upgrade review surface. */
export type InstallReviewResult =
  | Readonly<{ readonly action: "apply" }>
  | Readonly<{ readonly action: "change"; readonly request?: InstallRequest | undefined }>
  | Readonly<{ readonly action: "resolve" }>
  | Readonly<{ readonly action: "cancel" }>;

/** Resolve the final plan in one interaction before any managed mutation begins. */
export type InstallReviewResolver = (review: InstallReview) => Promise<InstallReviewResult>;

/** Public data contract for installer options used by CLI operations. */
export interface InstallerOptions {
  /** The paths in installer options. */
  readonly paths?: Partial<InstallerPaths>;
  /** The source root in installer options. */
  readonly sourceRoot?: string;
  /** The official plugin manager in installer options. */
  readonly officialPluginManager?: OfficialPluginManager;
  /** Injectable clock used for deterministic timestamps. */
  readonly now?: () => Date;
  /** Injectable platform/process boundary for optional tooling inspection and repair. */
  readonly runtime?: InstallerRuntime;
  /** Resolve modifications to state whose HolyCodex ownership is proven by persisted metadata. */
  readonly resolveConflict?: ConflictResolver;
  /** Resolve all install conflicts through one review surface. */
  readonly resolveConflicts?: ConflictBatchResolver;
  /** Review the complete preflight plan before any managed mutation begins. */
  readonly reviewInstall?: InstallReviewResolver;
  /** Receives lifecycle progress only when an installer stage actually starts or completes. */
  readonly onProgress?: (event: InstallProgressEvent) => void;
}

/** Public data contract for install result used by CLI operations. */
export interface InstallResult {
  /** Committed installation state returned to the caller. */
  readonly record: InstallRecord;
  /** The optional plugins in install result. */
  readonly optional_plugins: readonly string[];
  /** The preserved in install result. */
  readonly preserved: readonly string[];
  /** The warnings in install result. */
  readonly warnings: readonly string[];
}

/** Public data contract for upgrade request used by CLI operations. */
export interface UpgradeRequest {
  /** The dry run in upgrade request. */
  readonly dryRun?: boolean | undefined;
  /** Explicit install selections used when the user chooses Change options. */
  readonly options?: InstallRequest | undefined;
}

/** Public data contract for upgrade result used by CLI operations. */
export interface UpgradeResult {
  /** Returns the observed status of each requested plugin. */
  readonly status: "upgraded" | "current" | "dry_run";
  /** The from version in upgrade result. */
  readonly from_version: ReleaseVersion;
  /** The to version in upgrade result. */
  readonly to_version: ReleaseVersion;
  /** Human-readable summary of upgrade changes. */
  readonly changes: readonly string[];
  /** Committed installation state returned to the caller. */
  readonly record?: InstallRecord | undefined;
  /** The preserved in upgrade result. */
  readonly preserved: readonly string[];
  /** The warnings in upgrade result. */
  readonly warnings: readonly string[];
  /** The conflicts in upgrade result. */
  readonly conflicts?: readonly ManagedConflict[] | undefined;
}

/** Public data contract for doctor check used by CLI operations. */
export interface DoctorCheck {
  /** Returns the observed status of each requested plugin. */
  readonly status: "healthy" | "warning" | "failed" | "unsupported";
  /** Concrete explanations for warnings or failed checks. */
  readonly reasons: readonly string[];
  /** Structured data supporting the check result. */
  readonly details: JsonObject;
}

/** Public data contract for doctor result used by CLI operations. */
export interface DoctorResult {
  /** True when all required checks pass. */
  readonly healthy: boolean;
  /** Health results indexed by prerequisite or capability. */
  readonly checks: Readonly<Record<string, DoctorCheck>>;
  /** Concrete explanations for warnings or failed checks. */
  readonly reasons: readonly string[];
}

/** Public data contract for remove result used by CLI operations. */
export interface RemoveResult {
  /** The removed in remove result. */
  readonly removed: readonly string[];
  /** The preserved in remove result. */
  readonly preserved: readonly string[];
  /** Concrete explanations for warnings or failed checks. */
  readonly reasons: readonly string[];
}

/** Public data contract for cli io used by CLI operations. */
export interface CliIo {
  /** Interactive input stream consumed by the command. */
  readonly stdin?: AsyncIterable<string>;
  /** The stdout is tty in cli io. */
  readonly stdoutIsTTY?: boolean;
  /** The stderr is tty in cli io. */
  readonly stderrIsTTY?: boolean;
  /** Requests a yes/no confirmation and reports cancellation when unavailable. */
  readonly confirm?: (message: string) => Promise<boolean | ConfirmationResult>;
  /** Injectable interactive installer boundary used by tests and embedders. */
  readonly installWizard?: (initial: InstallRequest) => Promise<InstallWizardResult>;
  /** Injectable final install or upgrade review boundary used by tests and embedders. */
  readonly installReview?: InstallReviewResolver;
  /** The write stdout in cli io. */
  readonly writeStdout?: (text: string) => void;
  /** The write stderr in cli io. */
  readonly writeStderr?: (text: string) => void;
}

/** Result of the public interactive install wizard. */
export type InstallWizardResult =
  | Readonly<{ readonly action: "install"; readonly request: InstallRequest }>
  | Readonly<{ readonly action: "cancel" }>;

/** Result returned by confirmation operations. */
export type ConfirmationResult = "confirmed" | "cancelled" | "unavailable";

/** Controls the human renderer without affecting the machine JSON envelope. */
export interface HumanRenderOptions {
  /** The stdout is tty in human render options. */
  readonly stdoutIsTTY?: boolean | undefined;
  /** The stderr is tty in human render options. */
  readonly stderrIsTTY?: boolean | undefined;
  /** Environment used to decide terminal colors and output behavior. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Selects which terminal stream controls rendering behavior. */
  readonly stream?: "stdout" | "stderr" | undefined;
}

/** Public data contract for cli context used by CLI operations. */
export interface CliContext {
  /** Environment used to decide terminal colors and output behavior. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Working directory used to resolve relative command paths. */
  readonly cwd?: string;
  /** The io in cli context. */
  readonly io?: CliIo;
  /** Installer dependencies and conflict/review callbacks for the command. */
  readonly installer?: InstallerOptions;
  /** Injectable clock used for deterministic timestamps. */
  readonly now?: () => Date;
  /** Observe lifecycle boundaries after the corresponding operation begins or completes. */
  readonly onProgress?: (event: InstallProgressEvent) => void;
}

/** Public CLI type describing install progress stage. */
export type InstallProgressStage =
  | "validation"
  | "roles"
  | "plugins"
  | "config"
  | "verification"
  | "complete"
  | "removal";

/** Public data contract for install progress event used by CLI operations. */
export interface InstallProgressEvent {
  /** Lifecycle phase whose progress is being reported. */
  readonly stage: InstallProgressStage;
  /** Returns the observed status of each requested plugin. */
  readonly status: "started" | "completed";
  /** Progress text suitable for terminal or machine-readable output. */
  readonly message: string;
}

/** Public data contract for command result used by CLI operations. */
export interface CommandResult {
  /** Typed result payload emitted by the CLI command. */
  readonly envelope: CliEnvelope;
  /** The exit code in command result. */
  readonly exitCode: number;
}

/** Public data contract for parsed command used by CLI operations. */
export interface ParsedCommand {
  /** The command in parsed command. */
  readonly command: string;
  /** Arguments that are not associated with a named option. */
  readonly positionals: readonly string[];
  /** Values parsed from named CLI options. */
  readonly options: Readonly<Record<string, string | boolean | readonly string[]>>;
}
