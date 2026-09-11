// SPDX-License-Identifier: Apache-2.0

import { runBinary } from "./binary.ts";

export const packageName = "holycodex" as const;

export { runCli, executeCommand, renderHuman, renderProgress } from "./commands.ts";
export { runBinary } from "./binary.ts";
export type { BinaryIo } from "./binary.ts";
export { helpText, helpRequested, helpTopic, renderHelp } from "./help.ts";
export { parseArgv, ArgumentError } from "./args.ts";
export {
  installHolyCodex,
  installRecordDigest,
  readActiveInstallRecord,
  CapabilityStateRecordSchema,
  CapabilityInstallStateSchema,
  InstallRequestSchema,
  InstallOptionsSchema,
  InstallRecordSchema,
  InstallerError,
  validateInstallOptions,
} from "./installer.ts";
export {
  renderInstallWizardReview,
  applyWizardConfigurationKey,
  parsePluginInput,
  runOpenTuiInstallWizard,
  stateFromRequest,
  toInstallOptions,
} from "./installer-wizard.ts";
export type { WizardConfigurationTransition, WizardKey, WizardState } from "./installer-wizard.ts";
export { doctorHolyCodex, removeHolyCodex, upgradeHolyCodex } from "./maintenance.ts";
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
export { CodexOfficialPluginManager, OfficialPluginManagerError } from "./official-manager.ts";
export {
  CONTEXT7_SPEC,
  WINDOWS_GIT_BASH,
  ToolingError,
  context7InstallCommand,
  createInstallerRuntime,
  detectContext7Manager,
  ensureContext7,
  ensureGitBash,
  removeOwnedContext7,
} from "./tooling.ts";
export type { OfficialPluginCommandRunner } from "./official-manager.ts";
export {
  projectNativeAgents,
  projectRootAgent,
  installNativeAgents,
  rollbackNativeAgentInstall,
  removeManagedNativeAgents,
  renderNativeAgent,
  rootDeveloperInstructions,
  windowsGitBashShellDirective,
} from "./native-agents.ts";
export type {
  NativeAgentInstallResult,
  NativeAgentRemovalResult,
  NativeAgentRollbackEntry,
  NativeAgentInstructionOptions,
  RootDeveloperInstructionOptions,
} from "./native-agents.ts";
export type {
  CapabilityInstallState,
  CapabilityStateRecord,
  CapabilityStateStatus,
  CliContext,
  CliIo,
  HumanRenderOptions,
  CommandResult,
  DoctorCheck,
  DoctorResult,
  ExplicitOptionalSelections,
  InstallRecord,
  InstallResult,
  InstallerOptions,
  InstallProgressEvent,
  InstallerPaths,
  InstallerRuntime,
  InstallerProcessRunner,
  InstallerProcessResult,
  InstallerPlatform,
  InstallerToolingState,
  GitBashState,
  Context7Manager,
  Context7ToolState,
  ManagedConflict,
  ConflictResolution,
  ConflictResolver,
  ManagedArtifact,
  OfficialPluginManager,
  OfficialPluginStatus,
  OptionalSelections,
  PluginSnapshot,
  PluginConfigSafeValue,
  PluginConfigEntrySnapshot,
  PluginConfigSnapshot,
  ProviderPluginConfigEntrySnapshot,
  ProviderPluginConfigSnapshot,
  InstallTransactionStatus,
  InstallTransactionStep,
  InstallProgressStage,
  ParsedCommand,
  RemoveResult,
  UpgradeRequest,
  UpgradeResult,
  InstallWizardResult,
  ConfirmationResult,
} from "./types.ts";
export type { InstallOptions, InstallRequest } from "./installer.ts";

if (import.meta.main) process.exitCode = await runBinary();
