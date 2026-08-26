// SPDX-License-Identifier: Apache-2.0

export const packageName = "holycodex" as const;

export { runCli, executeCommand, renderHuman } from "./commands.ts";
export { runBinary } from "./binary.ts";
export type { BinaryIo } from "./binary.ts";
export { helpText, helpRequested, helpTopic } from "./help.ts";
export { parseArgv, ArgumentError } from "./args.ts";
export {
  installHolyCodex,
  readActiveInstallRecord,
  verifyActivation,
  CapabilityStateRecordSchema,
  CapabilityInstallStateSchema,
  InstallRecordSchema,
  InstallerError,
} from "./installer.ts";
export { doctorHolyCodex, cleanupHolyCodex, CleanupError } from "./maintenance.ts";
export {
  publicManifestPath,
  readCanonicalBaseVersion,
  readCanonicalVersion,
  updateCanonicalVersion,
} from "./manifest.ts";
export {
  resolveInstallerPaths,
  assertRootText,
  pathWithin,
  PathBoundaryError,
  STATE_SCHEMA,
} from "./paths.ts";
export {
  managedMarketplaceEntry,
  managedEntryMatches,
  readMarketplace,
  writeMarketplace,
  MarketplaceError,
} from "./marketplace.ts";
export { acquireInstallLock, LockError } from "./lock.ts";
export { CodexOfficialPluginManager, OfficialPluginManagerError } from "./official-manager.ts";
export type { OfficialPluginCommandRunner } from "./official-manager.ts";
export {
  executeWorkflowCommand,
  createDefaultWorkflowService,
  invokeWorkflowCapability,
  loadNativeWorkflow,
  readWorkflowSource,
  optionalArgs,
  WorkflowCommandError,
} from "./workflow.ts";
export {
  LEGACY_SCHEMA_EPOCH,
  MIGRATED_STATE_NAME,
  MIGRATION_RECORD_NAME,
  inspectLegacyState,
  migrateLegacyState,
  readMigratedInstallerSelections,
} from "./migration.ts";
export { WorkflowStoreError } from "./workflow-store.ts";
export {
  assertSafeSessionId,
  assertSafeWorkflowName,
  GeneratedWorkflowStore,
  GeneratedWorkflowStoreError,
  shortWorkflowHash,
  GENERATED_WORKFLOW_DEFAULT_TTL_MS,
  GENERATED_WORKFLOW_MAX_NAME_BYTES,
  GENERATED_WORKFLOW_MAX_SESSION_ID_BYTES,
  GENERATED_WORKFLOW_MAX_SOURCE_BYTES,
  GENERATED_WORKFLOW_NAMING_VERSION,
  GENERATED_WORKFLOW_SCHEMA_EPOCH,
} from "./generated-workflow-store.ts";
export type {
  GeneratedWorkflowCleanupResult,
  GeneratedWorkflowMetadata,
  GeneratedWorkflowStoreOptions,
  NativeWorkflowStoredIdentity,
  SafeWorkflowFilesystemBoundary,
  SafeWorkflowDirectoryEntry,
  StoredGeneratedWorkflow,
} from "./generated-workflow-store.ts";
export { RefinementStoreError } from "./refinement-store.ts";
export type {
  CapabilityInstallState,
  CapabilityStateRecord,
  CapabilityStateStatus,
  CliContext,
  CliIo,
  CleanupResult,
  CleanupScope,
  CommandResult,
  DoctorCheck,
  DoctorResult,
  ExplicitOptionalSelections,
  InstallRecord,
  InstallResult,
  InstallerOptions,
  InstallerPaths,
  OfficialPluginManager,
  OfficialPluginStatus,
  OptionalSelections,
  ParsedCommand,
  WorkflowService,
  WorkflowCapabilities,
  WorkflowCapabilityPort,
  WorkflowCapabilityRequest,
  WorkflowCapabilityResult,
  AppServerAssignmentPort,
  Autonomy,
} from "./types.ts";
export type { InstallRequest } from "./installer.ts";

if (import.meta.main) {
  if (Bun.argv[2] === "--__holycodex-workflow-child") {
    const { runWorkflowChild } = await import("@holycodex/workflow-runtime");
    await runWorkflowChild();
  } else {
    const { runBinary } = await import("./binary.ts");
    process.exitCode = await runBinary();
  }
}
