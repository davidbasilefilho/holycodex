// SPDX-License-Identifier: Apache-2.0

export const packageName = "holycodex" as const;

export { runCli, executeCommand, renderHuman } from "./commands.ts";
export { runBinary } from "./binary.ts";
export { parseArgv, ArgumentError } from "./args.ts";
export {
  installHolyCodex,
  readActiveInstallRecord,
  verifyActivation,
  InstallRecordSchema,
  InstallerError,
} from "./installer.ts";
export { doctorHolyCodex, cleanupHolyCodex, CleanupError } from "./maintenance.ts";
export { readCanonicalVersion, updateCanonicalVersion, publicManifestPath } from "./manifest.ts";
export { resolveInstallerPaths, assertRootText, PathBoundaryError, STATE_SCHEMA } from "./paths.ts";
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
  readWorkflowSource,
  optionalArgs,
  WorkflowCommandError,
} from "./workflow.ts";
export type {
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
  OptionalSelections,
  ParsedCommand,
  WorkflowService,
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
