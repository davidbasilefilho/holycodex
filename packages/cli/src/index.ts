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
  runOpenTuiInstallWizard,
  toInstallOptions,
} from "./installer-wizard.ts";
export { doctorHolyCodex, removeHolyCodex } from "./maintenance.ts";
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
export type { OfficialPluginCommandRunner } from "./official-manager.ts";
export {
  projectNativeAgents,
  projectRootAgent,
  installNativeAgents,
  rollbackNativeAgentInstall,
  removeManagedNativeAgents,
  renderNativeAgent,
  rootDeveloperInstructions,
} from "./native-agents.ts";
export type {
  NativeAgentInstallResult,
  NativeAgentRemovalResult,
  NativeAgentRollbackEntry,
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
  InstallerPaths,
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
  ParsedCommand,
  RemoveResult,
  InstallWizardResult,
} from "./types.ts";
export type { InstallOptions, InstallRequest } from "./installer.ts";

if (import.meta.main) process.exitCode = await runBinary();
