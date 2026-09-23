// SPDX-License-Identifier: Apache-2.0

import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  deleteTomlPath,
  LEGACY_ROOT_CONFIG_KEY_PATHS,
  mergeManagedRuntimeConfig,
  readTomlPath,
  resolveAgentConfigPath,
  resolveOfficialPluginEntry,
  summarizeManagedConfigValue,
  writeTomlPath,
  TomlDocumentSchema,
  type ManagedConfigKeyPath,
  type ManagedConfigWriteValue,
  type ManagedRuntimeConfigState,
  type TomlDocument,
  type TomlTable,
  type TomlValue,
} from "@holycodex/codex";
import {
  CAPABILITY_REGISTRY,
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
  NATIVE_AGENT_TYPES,
  STATE_SCHEMA_EPOCH,
  canonicalJson,
  canonicalJsonUtf8,
  canonicalOfficialPluginId,
  compareReleaseVersions,
  domainSeparatedSha256,
  lookupProfile,
  migrateProfileName,
  type LegacyProfileName,
  pluginIdsForOptionalCapabilities,
  resolveOptionalCapabilitySelections,
  ServiceTierSchema,
  type JsonObject,
  type OptionalCapabilityName,
  type OptionalCapabilitySelections,
  type ProfileName,
  type ReleaseVersion,
  type ServiceTier,
} from "@holycodex/core";

import { asJsonValue } from "./json.ts";
import { readInstallationVersion } from "./manifest.ts";
import {
  installNativeAgents,
  inspectNativeAgentConflicts,
  isKnownLegacyRootRoleContent,
  projectNativeAgents,
  projectRootAgent,
  nativeAgentSandboxConfigurationMatches,
  removeManagedNativeAgents,
  rollbackNativeAgentInstall,
  rootDeveloperInstructions,
  type NativeAgentInstallResult,
} from "./native-agents.ts";
import { CodexOfficialPluginManager, OfficialPluginManagerError } from "./official-manager.ts";
import {
  ensureOwnedDirectory,
  isFsCode,
  resolveInstallerPaths,
  PathBoundaryError,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import {
  decodeSchema,
  InstallRecordMigrationSchema,
  InstallRecordSchema,
  InstallOptionsSchema,
  PersistedInstallOptionsSchema,
  InstallRequestSchema,
  InstallTransactionSchema,
  JsonObjectSchema,
} from "./schema.ts";
import { optionalJsonFile, optionalTextFile, writeAtomicJson, writeAtomicText } from "./storage.ts";
import { parseToml, stringifyToml } from "./toml.ts";
import {
  createInstallerRuntime,
  ensureContext7,
  ensureGitBash,
  preflightContext7,
  removeOwnedContext7,
  ToolingError,
  WINDOWS_GIT_BASH,
} from "./tooling.ts";
import type {
  CapabilityInstallState,
  CapabilityStateRecord,
  ExplicitOptionalSelections,
  InstallRecord,
  InstallResult,
  InstallerOptions,
  OptionalSelections,
  OfficialPluginManager,
  PluginSnapshot,
  PluginConfigEntrySnapshot,
  PluginConfigSafeValue,
  PluginConfigSnapshot,
  ProviderPluginConfigSnapshot,
  InstallTransactionStep,
  InstallProgressEvent,
  GitBashState,
  Context7ToolState,
  ConflictDecision,
  ManagedConflict,
  InstallReview,
} from "./types.ts";

export {
  CapabilityInstallStateSchema,
  CapabilityStateRecordSchema,
  InstallRequestSchema,
  InstallRecordSchema,
  InstallOptionsSchema,
  PersistedInstallOptionsSchema,
  InstallTransactionSchema,
} from "./schema.ts";

export const HOLYCODEX_MARKETPLACE = "davidbasilefilho/holycodex";
export const HOLYCODEX_PLUGIN = "holycodex@holycodex";

export interface InstallRequest {
  readonly profile?: ProfileName | undefined;
  readonly tier?: ServiceTier | undefined;
  readonly optional?: ExplicitOptionalSelections | undefined;
  readonly officialPlugins?: readonly string[] | undefined;
}

/** Alias for the validated install selections domain used by every CLI surface. */
export type InstallOptions = InstallRequest;

/** Validate install selections before handing them to the installation effect. */
export function validateInstallOptions(input: unknown): InstallOptions {
  const parsed = decodeSchema(InstallOptionsSchema, input);
  if (parsed === undefined) {
    throw new InstallerError("install_failed", "The installation options are invalid.");
  }
  return parsed as InstallOptions;
}

/** The only values written to the user-facing install options file. */
export type PersistedInstallOptions = Readonly<{
  readonly schema_version: 1;
  readonly profile: ProfileName;
  readonly tier: ServiceTier;
  readonly capabilities: readonly OptionalCapabilityName[];
  readonly additional_plugins: readonly string[];
}>;

/** Read and validate the optional user-facing install options file. */
export async function readInstallOptions(
  paths: ResolvedInstallerPaths,
): Promise<PersistedInstallOptions | undefined> {
  const source = await optionalTextFile(paths.installOptions);
  return decodeInstallOptionsText(source, paths.installOptions);
}

function decodeInstallOptionsText(
  source: string | undefined,
  path: string,
): PersistedInstallOptions | undefined {
  if (source === undefined) return undefined;
  let document: TomlDocument;
  try {
    document = parseToml(source);
  } catch (error: unknown) {
    throw new InstallerError(
      "state_corrupt",
      "The HolyCodex install options are not valid TOML.",
      error,
      { path },
    );
  }
  const parsed = decodeSchema(PersistedInstallOptionsSchema, document);
  if (parsed === undefined) {
    throw new InstallerError(
      "state_corrupt",
      "The HolyCodex install options are invalid.",
      undefined,
      { path },
    );
  }
  return parsed as PersistedInstallOptions;
}

/** Serialize and atomically persist the validated install options. */
export async function writeInstallOptions(
  paths: ResolvedInstallerPaths,
  value: PersistedInstallOptions,
): Promise<void> {
  if (decodeSchema(PersistedInstallOptionsSchema, value) === undefined) {
    throw new InstallerError("state_corrupt", "The HolyCodex install options are invalid.");
  }
  await writeAtomicText(paths.installOptions, stringifyToml(value as unknown as TomlDocument));
}

/** Convert persisted selections into the install request used by the wizard and installer. */
export function installRequestFromPersistedOptions(value: PersistedInstallOptions): InstallRequest {
  return {
    profile: value.profile,
    tier: value.tier,
    optional: {
      computer_use: value.capabilities.includes("computer_use"),
      frontend: value.capabilities.includes("frontend"),
      security: value.capabilities.includes("security"),
    },
    officialPlugins: [...value.additional_plugins],
  };
}

/** Read effective prior selections for an interactive reinstall. */
export async function readEffectiveInstallRequest(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallRequest> {
  const paths = resolveInstallerPaths(options, environment);
  const persisted = await readInstallOptions(paths);
  if (persisted !== undefined) return installRequestFromPersistedOptions(persisted);
  const previous = await readActiveInstallRecord(paths);
  if (previous === undefined) return {};
  return {
    profile: previous.profile,
    tier: previous.tier,
    optional: previous.optional_selections,
    officialPlugins: additionalPluginsFromPrevious(previous),
  };
}

/** Build the persisted representation from the fully resolved install selections. */
export function persistedOptionsForInstall(
  profile: ProfileName,
  tier: ServiceTier,
  optional: OptionalSelections,
  additionalPlugins: readonly string[],
): PersistedInstallOptions {
  const capabilities = (["computer_use", "frontend", "security"] as const).filter(
    (name) => optional[name],
  );
  return {
    schema_version: 1,
    profile,
    tier,
    capabilities,
    additional_plugins: [...new Set(additionalPlugins)],
  };
}

type PreparingTransaction = Omit<InstallRecord, "status" | "step"> & {
  readonly status: "preparing";
  readonly step: InstallTransactionStep;
  readonly managed_config: ManagedRuntimeConfigState;
  readonly plugin_snapshot: readonly PluginSnapshot[];
  readonly owned_plugins: readonly string[];
};

/**
 * Return whether a persisted transaction belongs to the active installation baseline it is allowed
 * to reconcile.
 *
 * Transactions deliberately carry the active record's installation identity and digest while
 * effects are being applied. This relation lets recovery distinguish a transaction bound to the
 * active record from one that must be inspected before any destructive work.
 */
export function isTransactionBoundToActive(
  transaction: Readonly<Pick<InstallRecord, "install_id" | "digest">>,
  active: Readonly<Pick<InstallRecord, "install_id" | "digest">>,
): boolean {
  return transaction.install_id === active.install_id && transaction.digest === active.digest;
}

/** Describe how persisted transaction journals relate to the active ownership record. */
export type InstallTransactionDiagnosis = Readonly<{
  readonly status: "preparing" | "conflicted";
  readonly relation: "bound" | "orphaned" | "stale" | "incompatible";
  readonly install_id: string;
  readonly digest: string;
  readonly recovery: "reconcile" | "inspect";
  readonly active_install_id?: string | undefined;
  readonly active_digest?: string | undefined;
}>;

type InstallTransactionIdentity = Readonly<Pick<InstallRecord, "install_id" | "digest">>;

/**
 * Diagnose all transaction journals before an installer or maintenance operation mutates state. A
 * journal with no active record is recoverable orphaned state; a journal that disagrees with an
 * active record is stale and cannot authorize destructive work.
 */
export function diagnoseInstallTransactions(
  active: InstallTransactionIdentity | undefined,
  preparing: InstallTransactionIdentity | undefined,
  conflicted: InstallTransactionIdentity | undefined,
): readonly InstallTransactionDiagnosis[] {
  const transactions = [
    { status: "conflicted" as const, record: conflicted },
    { status: "preparing" as const, record: preparing },
  ].filter(
    (entry): entry is { status: "conflicted" | "preparing"; record: InstallTransactionIdentity } =>
      entry.record !== undefined,
  );
  const multiple = transactions.length > 1;
  const matchingJournals =
    multiple &&
    transactions.every(({ record }) => isTransactionBoundToActive(record, transactions[0]!.record));
  return transactions.map(({ status, record }) => {
    const relation =
      active === undefined
        ? multiple && !matchingJournals
          ? "incompatible"
          : "orphaned"
        : isTransactionBoundToActive(record, active)
          ? multiple && !matchingJournals
            ? "incompatible"
            : "bound"
          : "stale";
    return {
      status,
      relation,
      install_id: record.install_id,
      digest: record.digest,
      recovery: relation === "stale" || relation === "incompatible" ? "inspect" : "reconcile",
      ...(active === undefined
        ? {}
        : { active_install_id: active.install_id, active_digest: active.digest }),
    };
  });
}

/** Reject stale or mutually incompatible journals before destructive recovery can begin. */
export function assertInstallTransactionState(
  active: InstallTransactionIdentity | undefined,
  preparing: InstallTransactionIdentity | undefined,
  conflicted: InstallTransactionIdentity | undefined,
): readonly InstallTransactionDiagnosis[] {
  const diagnoses = diagnoseInstallTransactions(active, preparing, conflicted);
  const incompatible = diagnoses.filter(
    (diagnosis) => diagnosis.relation === "stale" || diagnosis.relation === "incompatible",
  );
  if (incompatible.length > 0) {
    throw new InstallerError(
      "state_corrupt",
      "HolyCodex has stale or incompatible transaction state and cannot recover safely.",
      undefined,
      transactionDiagnosisDetails(diagnoses),
    );
  }
  return diagnoses;
}

/**
 * Reject only ambiguous transaction journals before removal can begin.
 *
 * Removal is authorized by a valid active install record when one exists, so stale journals are
 * ignored and bound journals remain available for recovery. With no active record, multiple
 * journals cannot establish ownership safely.
 */
export function assertRemovalTransactionState(
  active: InstallTransactionIdentity | undefined,
  preparing: InstallTransactionIdentity | undefined,
  conflicted: InstallTransactionIdentity | undefined,
): readonly InstallTransactionDiagnosis[] {
  const diagnoses = diagnoseInstallTransactions(active, preparing, conflicted);
  if (
    active === undefined &&
    diagnoses.some((diagnosis) => diagnosis.relation === "incompatible")
  ) {
    throw new InstallerError(
      "state_corrupt",
      "HolyCodex has ambiguous transaction state and cannot recover safely.",
      undefined,
      transactionDiagnosisDetails(diagnoses),
    );
  }
  return diagnoses;
}

function transactionDiagnosisDetails(
  diagnoses: readonly InstallTransactionDiagnosis[],
): JsonObject {
  return {
    recovery: diagnoses.map((diagnosis) => diagnosis.recovery).join(","),
    transactions: diagnoses
      .map(
        (diagnosis) =>
          `${diagnosis.status}:${diagnosis.relation}:${diagnosis.install_id}:${diagnosis.digest}`,
      )
      .join(","),
    active:
      diagnoses[0]?.active_install_id === undefined
        ? "absent"
        : `${diagnoses[0].active_install_id}:${diagnoses[0].active_digest}`,
  };
}

const HOLYCODEX_MARKETPLACE_URL = "https://github.com/davidbasilefilho/holycodex.git" as const;
const HOLYCODEX_PLUGIN_CONFIG_KEY = "holycodex@holycodex";
const HOLYCODEX_MARKETPLACE_CONFIG_KEY = "holycodex";
const LEGACY_WORK_PLUGIN_NAMES = new Set([
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "template-creator",
]);
const LEGACY_AUTO_COMPACT_KEY = LEGACY_ROOT_CONFIG_KEY_PATHS[0]!;

/** Install or reconcile HolyCodex state, plugins, native agents, and managed configuration. */
export async function installHolyCodex(
  request: InstallRequest = {},
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallResult> {
  if (decodeSchema(InstallRequestSchema, request) === undefined) {
    throw new InstallerError("install_failed", "The installation options are invalid.");
  }
  const paths = resolveInstallerPaths(options, environment);
  const installOptionsBefore = await optionalTextFile(paths.installOptions);
  const activeRecordBefore = await optionalTextFile(paths.activeRecord);
  const persistedOptions = decodeInstallOptionsText(installOptionsBefore, paths.installOptions);
  const persistedRequest =
    persistedOptions === undefined
      ? undefined
      : installRequestFromPersistedOptions(persistedOptions);
  reportProgress(options, {
    stage: "validation",
    status: "started",
    message: "Validating Codex target",
  });
  const previous = await readActiveInstallRecord(paths);
  if (previous !== undefined && !(await recordDigestMatches(previous))) {
    throw new InstallerError(
      "state_corrupt",
      "The existing HolyCodex configuration has changed and cannot be replaced.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  const preparing = await optionalJsonFile(paths.preparingRecord, InstallTransactionSchema);
  const conflicted = await optionalJsonFile(paths.conflictedRecord, InstallTransactionSchema);
  assertInstallTransactionState(previous, preparing, conflicted);
  const interrupted = [conflicted, preparing].find(
    (transaction) =>
      transaction !== undefined &&
      (previous === undefined || isTransactionBoundToActive(transaction, previous)),
  );
  if (interrupted !== undefined) {
    const { removeHolyCodex } = await import("./maintenance.ts");
    const recovery = await removeHolyCodex(options, environment);
    if (recovery.preserved.length > 0 || recovery.reasons.length > 0) {
      throw new InstallerError(
        "state_corrupt",
        "The interrupted HolyCodex installation could not be reconciled safely.",
        undefined,
        {
          preserved: recovery.preserved.join(","),
          reasons: recovery.reasons.join(","),
        },
      );
    }
    return await installHolyCodex(
      {
        profile: request.profile ?? persistedRequest?.profile ?? interrupted.profile,
        tier: request.tier ?? persistedRequest?.tier ?? interrupted.tier,
        optional: {
          computer_use:
            request.optional?.computer_use ??
            persistedRequest?.optional?.computer_use ??
            interrupted.optional_selections.computer_use,
          frontend:
            request.optional?.frontend ??
            persistedRequest?.optional?.frontend ??
            interrupted.optional_selections.frontend,
          security:
            request.optional?.security ??
            persistedRequest?.optional?.security ??
            interrupted.optional_selections.security,
        },
        officialPlugins:
          request.officialPlugins ??
          persistedRequest?.officialPlugins ??
          additionalPluginsFromPrevious(interrupted),
      },
      options,
      environment,
    );
  }
  const profile = chooseProfile(request.profile ?? persistedRequest?.profile, previous?.profile);
  const tier = chooseTier(request.tier ?? persistedRequest?.tier, previous?.tier);
  const persistedOptional = persistedRequest?.optional;
  const requestedOptional = mergeExplicitOptionalSelections(persistedOptional, request.optional);
  const optional = chooseOptional(requestedOptional, previous?.optional_selections);
  const explicitOptional = mergeExplicitOptionalSelections(
    mergeExplicitOptionalSelections(previous?.explicit_optional_selections, persistedOptional),
    request.optional,
  );
  const additionalPlugins =
    request.officialPlugins ??
    persistedRequest?.officialPlugins ??
    additionalPluginsFromPrevious(previous);
  const runtime = options.runtime ?? createInstallerRuntime(environment);
  const discoveredGitBash = await ensureGitBash(runtime, false);
  const debugInstaller = async (message: string): Promise<void> => {
    if (environment["HOLYCODEX_DEBUG_INSTALLER"] !== "1") return;
    await appendFile(join(paths.codexHome, ".holycodex-debug.log"), `${message}\n`, "utf8");
  };
  let context7PreflightReady = false;
  try {
    await preflightContext7(runtime);
    context7PreflightReady = true;
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      "Context7 tooling cannot be inspected before managed installation changes.",
      error,
    );
  }
  let gitBash: GitBashState = discoveredGitBash;
  let context7: Context7ToolState | undefined;
  const providerPlugins = [
    ...new Set(
      pluginIdsForOptionalCapabilities(toCoreSelections(optional), additionalPlugins).map(
        (pluginId) => canonicalOfficialPluginId(pluginId) ?? pluginId,
      ),
    ),
  ];
  let manager: OfficialPluginManager;
  try {
    manager =
      options.officialPluginManager ??
      (await CodexOfficialPluginManager.discover({
        ...environment,
        CODEX_HOME: paths.codexHome,
      }));
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      "Native Codex plugin installation is unavailable.",
      error,
      { recovery: "Install or expose Codex, then retry." },
    );
  }
  if (!manager.addMarketplace || !manager.add || !manager.list) {
    throw new InstallerError(
      "install_failed",
      "Native Codex plugin installation and verification are unavailable.",
    );
  }
  let preflightLive: Awaited<ReturnType<NonNullable<OfficialPluginManager["list"]>>>;
  try {
    preflightLive = await manager.list();
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      "Native Codex plugin state could not be read safely.",
      error,
    );
  }
  const unresolvedOfficialProviderPlugins = providerPlugins.filter((pluginId) => {
    if (canonicalOfficialPluginId(pluginId) !== pluginId) return false;
    const entry = findPlugin(preflightLive, pluginId);
    return !(entry?.installed && entry.enabled);
  });
  reportProgress(options, {
    stage: "validation",
    status: "completed",
    message: "Codex target validated",
  });

  const installId = previous?.install_id ?? crypto.randomUUID().replaceAll("-", "");
  const version = await readInstallationVersion();
  const refreshPluginIds =
    previous !== undefined &&
    previous.version !== version &&
    previous.owned_plugins?.includes(HOLYCODEX_PLUGIN) === true
      ? new Set([HOLYCODEX_PLUGIN])
      : new Set<string>();
  const previousOwnedPlugins = new Set(previous?.owned_plugins ?? []);
  const desiredOwnedPlugins = new Set([HOLYCODEX_PLUGIN, ...providerPlugins]);
  const omittedOwnedPlugins = [...previousOwnedPlugins].filter(
    (pluginId) => !desiredOwnedPlugins.has(pluginId),
  );
  if (omittedOwnedPlugins.length > 0 && manager.remove === undefined) {
    throw new InstallerError(
      "install_failed",
      "Native Codex cannot remove previously managed plugins omitted from the new selection.",
      undefined,
      { plugins: omittedOwnedPlugins.join(",") },
    );
  }
  const installedAt = (options.now?.() ?? new Date()).toISOString();
  const configBefore = await optionalTextFile(paths.configFile);
  const configInputDocument = parseConfig(configBefore);
  const currentHolyCodexPluginConfig = await snapshotHolyCodexPluginConfig(configInputDocument);
  const initialPluginConfigBefore = previous?.plugin_config?.before ?? currentHolyCodexPluginConfig;
  let pluginConfigBefore = initialPluginConfigBefore;
  const useBatchConflictResolution = options.resolveConflicts !== undefined;
  const pendingConflicts: ManagedConflict[] = [];
  let pluginConfigConflicts: readonly ManagedConflict[] = [];
  let providerConfigConflicts: readonly ManagedConflict[] = [];
  if (previous?.plugin_config !== undefined) {
    const conflicts = (["preference", "marketplace"] as const).filter((name) => {
      const current = currentHolyCodexPluginConfig[name].digest;
      return (
        current !== previous.plugin_config?.after[name].digest &&
        current !== previous.plugin_config?.before[name].digest
      );
    });
    pluginConfigConflicts = conflicts.map((name) => {
      const key =
        name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex";
      const current = currentHolyCodexPluginConfig[name];
      const desired =
        name === "preference"
          ? { kind: "boolean" as const, value: true }
          : {
              kind: "marketplace" as const,
              source_type: "git" as const,
              source: HOLYCODEX_MARKETPLACE_URL,
            };
      const conflict = structureConflict({
        path: paths.configFile,
        key,
        action: "replace" as const,
        category: "config-key",
        target: key,
        existing: current.safe_value ?? { presence: current.presence },
        desired,
        explanation: `The managed ${key} entry changed outside the previous HolyCodex transaction.`,
      });
      return conflict;
    });
    if (useBatchConflictResolution) pendingConflicts.push(...pluginConfigConflicts);
  }
  const providerConfigPluginIds = [
    ...new Set([
      ...providerPlugins,
      ...(previous?.provider_config ?? []).map((entry) => entry.plugin_id),
      ...(previous?.owned_plugins ?? []),
    ]),
  ].filter((pluginId) => pluginId !== HOLYCODEX_PLUGIN);
  const currentProviderConfig = await snapshotProviderPluginConfig(
    configInputDocument,
    providerConfigPluginIds,
  );
  if (previous?.provider_config !== undefined) {
    const previousOwned = new Set(previous.owned_plugins ?? []);
    const conflicts = currentProviderConfig.filter((current) => {
      if (!previousOwned.has(current.plugin_id)) return false;
      const prior = previous.provider_config?.find(
        (candidate) => candidate.plugin_id === current.plugin_id,
      );
      return (
        prior !== undefined &&
        current.before.digest !== prior.after.digest &&
        current.before.digest !== prior.before.digest
      );
    });
    providerConfigConflicts = conflicts.map((entry) => {
      const key = `plugins."${entry.plugin_id}"`;
      const conflict = structureConflict({
        path: paths.configFile,
        key,
        action: "replace" as const,
        category: "config-key",
        target: key,
        existing: entry.before.safe_value ?? { presence: entry.before.presence },
        desired: { kind: "boolean", value: true },
        explanation: `The managed provider plugin entry ${entry.plugin_id} changed outside the previous transaction.`,
      });
      return conflict;
    });
    if (useBatchConflictResolution) pendingConflicts.push(...providerConfigConflicts);
  }
  const initialProviderConfigBefore = currentProviderConfig.map((entry) => {
    const previousEntry = previous?.provider_config?.find(
      (candidate) => candidate.plugin_id === entry.plugin_id,
    );
    return previousEntry === undefined
      ? entry
      : { plugin_id: entry.plugin_id, before: previousEntry.before, after: previousEntry.before };
  });
  let providerConfigBefore: readonly ProviderPluginConfigSnapshot[] = initialProviderConfigBefore;
  const unmanagedConfigState =
    previous?.managed_config ??
    createManagedRuntimeConfigState({ schema: STATE_SCHEMA_EPOCH, installId });
  const migratedRuntime = await migrateKnownLegacyRoleRegistrations(
    configInputDocument,
    unmanagedConfigState,
    previous,
  );
  const migratedContext = await migrateLegacyContextManagement(
    migratedRuntime.document,
    migratedRuntime.state,
  );
  const migratedAutoCompact = await migrateLegacyAutoCompactConfig(
    migratedContext.document,
    migratedContext.state,
  );
  const configDocument = migratedAutoCompact.document;
  const currentManagedConfig = migratedAutoCompact.state;
  rejectPreExistingDeveloperInstructions(configDocument, currentManagedConfig);
  const desiredConfig = desiredRootConfig(profile, tier, {
    computerUse: optional.computer_use,
    frontend: optional.frontend,
    security: optional.security,
    ...(runtime.platform === "win32"
      ? {
          windowsGitBashExecutable:
            discoveredGitBash.status === "healthy" ? discoveredGitBash.path : WINDOWS_GIT_BASH,
        }
      : {}),
  });
  await debugInstaller(
    `desired platform=${runtime.platform} gitBash=${discoveredGitBash.status} desiredShell=${String(typeof desiredConfig.developer_instructions === "string" && desiredConfig.developer_instructions.includes("On Windows, use Git for Windows Bash"))} desiredTail=${JSON.stringify(typeof desiredConfig.developer_instructions === "string" ? desiredConfig.developer_instructions.slice(-500) : desiredConfig.developer_instructions)} previous=${previous?.version ?? "none"}`,
  );
  let previousDesiredConfig:
    | Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>
    | undefined;
  if (previous !== undefined) {
    previousDesiredConfig = desiredRootConfig(previous.profile, previous.tier, {
      computerUse: previous.optional_selections.computer_use,
      frontend: previous.optional_selections.frontend,
      security: previous.optional_selections.security,
    });
    if (compareReleaseVersions(previous.version, version) < 0) {
      // Before this release every profile used Astra for Root. Compare against that
      // persisted release contract so its canonical route upgrades, while a
      // recorded user override remains distinguishable and is preserved.
      previousDesiredConfig.model = "gpt-6-astra";
      previousDesiredConfig.model_reasoning_effort =
        previous.profile === "low" ? "low" : previous.profile === "default" ? "medium" : "high";
    }
    // Developer instructions contain host-boundary policy that must follow the
    // current runtime, even when an older record treated its value as managed.
    delete previousDesiredConfig.developer_instructions;
  }
  const desiredConfigWithPersistedManagedValues = await preserveManagedConfigDecisions(
    configDocument,
    currentManagedConfig,
    desiredConfig,
    previousDesiredConfig,
  );
  let mergedConfig: Awaited<ReturnType<typeof mergeManagedRuntimeConfig>>;
  try {
    mergedConfig = await mergeManagedRuntimeConfig(
      configDocument,
      currentManagedConfig,
      desiredConfigWithPersistedManagedValues,
      { schema: STATE_SCHEMA_EPOCH, installId },
    );
  } catch (error: unknown) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "state_corrupt",
      "The existing Codex configuration has an incompatible shape for HolyCodex settings.",
      error,
      { recovery: "Converge the conflicting Codex setting, then retry." },
    );
  }
  let managedConfigConflicts: readonly ManagedConflict[] = [];
  if (mergedConfig.driftedKeys.length > 0) {
    managedConfigConflicts = mergedConfig.driftedKeys.map((key) => {
      const existing = currentManagedConfig.managed[key];
      const currentValue = readTomlPath(configDocument, key);
      const desiredValue = desiredConfig[key];
      return structureConflict({
        path: paths.configFile,
        key,
        action: "replace",
        category: "config-key",
        target: key,
        existing: currentValue ?? existing?.lastManagedValue,
        desired: desiredValue,
        explanation: `The managed Codex setting ${key} changed outside the previous transaction.`,
      });
    });
  }
  if (useBatchConflictResolution) pendingConflicts.push(...managedConfigConflicts);
  let nativeConflicts: readonly ManagedConflict[];
  try {
    nativeConflicts = await inspectNativeAgentConflicts(
      paths.codexHome,
      profile,
      previous?.managed_artifacts,
      tier,
      runtime.platform === "win32"
        ? discoveredGitBash.status === "healthy"
          ? discoveredGitBash.path
          : WINDOWS_GIT_BASH
        : undefined,
    );
  } catch (error: unknown) {
    throw new InstallerError("install_failed", safeMessage(error), error);
  }
  if (useBatchConflictResolution) pendingConflicts.push(...nativeConflicts.map(structureConflict));
  const allConflicts = [
    ...pluginConfigConflicts,
    ...providerConfigConflicts,
    ...managedConfigConflicts,
    ...nativeConflicts.map(structureConflict),
  ];
  let resolvedConflicts = await resolveOwnedConflictInventory(
    options,
    useBatchConflictResolution ? pendingConflicts : allConflicts,
    true,
  );
  let reviewedNativeConflicts: readonly ManagedConflict[] = [];
  let resolvedDesiredConfig: Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>> = {
    ...desiredConfigWithPersistedManagedValues,
  };
  let resolvedManagedConfig = currentManagedConfig.managed;
  const applyResolvedConflictDecisions = async (): Promise<void> => {
    reviewedNativeConflicts = nativeConflicts.map((conflict) => {
      const projected = structureConflict(conflict);
      const decision = resolvedConflicts.decisions.get(projected.identity!);
      return decision === undefined ? projected : { ...projected, decision };
    });
    const acceptedPluginConfig = await applyPluginConfigConflictDecisions(
      configDocument,
      configDocument,
      initialPluginConfigBefore,
      initialProviderConfigBefore,
      currentHolyCodexPluginConfig,
      currentProviderConfig,
      pluginConfigConflicts,
      providerConfigConflicts,
      resolvedConflicts.decisions,
      providerPlugins,
    );
    let acceptedDocument = acceptedPluginConfig.document;
    pluginConfigBefore = acceptedPluginConfig.pluginConfigBefore;
    providerConfigBefore = acceptedPluginConfig.providerConfigBefore;
    const acceptedManaged = { ...currentManagedConfig.managed };
    const effectiveDesiredConfig: Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>> = {
      ...desiredConfigWithPersistedManagedValues,
    };
    for (const conflict of managedConfigConflicts) {
      const key = conflict.key;
      if (key === undefined) continue;
      const configKey = key as ManagedConfigKeyPath;
      const decision = resolvedConflicts.decisions.get(conflict.identity!);
      if (decision !== "keep" && decision !== "replace") {
        throw new InstallerError(
          "confirmation_required",
          "Managed conflict resolution is incomplete.",
          undefined,
          { key },
        );
      }
      const existing = acceptedManaged[configKey];
      const desiredValue = desiredConfig[configKey];
      if (existing === undefined || desiredValue === undefined) {
        throw new InstallerError(
          "state_corrupt",
          "The managed conflict cannot be verified.",
          undefined,
          { path: paths.configFile, key },
        );
      }
      const live = readTomlPath(configDocument, configKey);
      if (decision === "replace") {
        acceptedDocument = writeTomlPath(acceptedDocument, configKey, desiredValue);
        acceptedManaged[configKey] = {
          ...existing,
          lastManagedValue: await summarizeManagedConfigValue(configKey, desiredValue),
        };
      } else if (live === undefined) {
        delete effectiveDesiredConfig[configKey];
        delete acceptedManaged[configKey];
      } else {
        delete effectiveDesiredConfig[configKey];
        acceptedManaged[configKey] = {
          ...existing,
          lastManagedValue: await summarizeManagedConfigValue(configKey, live),
        };
      }
    }
    mergedConfig = await mergeManagedRuntimeConfig(
      acceptedDocument,
      { ...currentManagedConfig, managed: acceptedManaged },
      effectiveDesiredConfig,
      { schema: STATE_SCHEMA_EPOCH, installId },
    );
    if (mergedConfig.driftedKeys.length > 0) {
      throw new InstallerError("state_corrupt", "The accepted managed conflicts did not converge.");
    }
    resolvedDesiredConfig = effectiveDesiredConfig;
    await debugInstaller(
      `resolvedShell=${String(typeof resolvedDesiredConfig.developer_instructions === "string" && resolvedDesiredConfig.developer_instructions.includes("On Windows, use Git for Windows Bash"))} resolvedTail=${JSON.stringify(typeof resolvedDesiredConfig.developer_instructions === "string" ? resolvedDesiredConfig.developer_instructions.slice(-500) : resolvedDesiredConfig.developer_instructions)}`,
    );
    const stabilityManaged = { ...currentManagedConfig.managed };
    for (const conflict of managedConfigConflicts) {
      const key = conflict.key as ManagedConfigKeyPath | undefined;
      if (key === undefined) continue;
      const live = readTomlPath(configDocument, key);
      const existing = stabilityManaged[key];
      if (existing !== undefined && live === undefined) {
        delete stabilityManaged[key];
      } else if (existing !== undefined && live !== undefined) {
        stabilityManaged[key] = {
          ...existing,
          lastManagedValue: await summarizeManagedConfigValue(key, live),
        };
      }
    }
    resolvedManagedConfig = stabilityManaged;
  };
  await applyResolvedConflictDecisions();
  const projectReviewConflicts = (): readonly ManagedConflict[] =>
    allConflicts.map((conflict) => {
      const projected = structureConflict(conflict);
      const decision = resolvedConflicts.decisions.get(projected.identity!);
      return decision === undefined ? projected : { ...projected, decision };
    });
  const projectReviewConflictCounts = (
    conflicts: readonly ManagedConflict[],
  ): Readonly<Record<string, number>> =>
    Object.fromEntries(
      ["config-key", "native-plugin", "role-asset"].flatMap((category) => {
        const count = conflicts.filter((conflict) => conflict.category === category).length;
        return count === 0 ? [] : [[category, count] as const];
      }),
    );
  let reviewConflicts = projectReviewConflicts();
  let reviewConflictCounts = projectReviewConflictCounts(reviewConflicts);
  const reviewTools = installReviewTools(
    discoveredGitBash,
    context7PreflightReady,
    preflightLive,
    providerPlugins,
  );
  if (options.reviewInstall !== undefined) {
    while (true) {
      const review = await options.reviewInstall({
        operation: previous === undefined ? "install" : "upgrade",
        ...(previous === undefined ? {} : { fromVersion: previous.version }),
        toVersion: version,
        profile,
        tier,
        capabilities: {
          computer_use: optional.computer_use,
          frontend: optional.frontend,
          security: optional.security,
        },
        additionalPlugins: [...additionalPlugins],
        conflicts: reviewConflicts,
        conflictCounts: reviewConflictCounts,
        tools: reviewTools,
      });
      if (review.action === "cancel") {
        throw new InstallerError("confirmation_required", "Install review was cancelled.");
      }
      if (review.action === "resolve") {
        if (allConflicts.length === 0) {
          throw new InstallerError(
            "confirmation_required",
            "There are no managed conflicts to resolve.",
          );
        }
        resolvedConflicts = await resolveOwnedConflictInventory(
          options,
          useBatchConflictResolution ? pendingConflicts : allConflicts,
          true,
        );
        await applyResolvedConflictDecisions();
        reviewConflicts = projectReviewConflicts();
        reviewConflictCounts = projectReviewConflictCounts(reviewConflicts);
        continue;
      }
      if (review.action === "change") {
        if (review.request === undefined) {
          throw new InstallerError(
            "confirmation_required",
            "Changing install options requires a revised request.",
          );
        }
        return await installHolyCodex(review.request, options, environment);
      }
      if (review.action === "apply") break;
      throw new InstallerError("confirmation_required", "Unknown install review action.");
    }
  }
  const preMutationTransaction: PreparingTransaction = {
    owner: "holycodex",
    schema_epoch: STATE_SCHEMA_EPOCH,
    install_id: installId,
    version,
    digest: previous?.digest ?? "0".repeat(64),
    profile,
    tier,
    optional_selections: optional,
    explicit_optional_selections: explicitOptional,
    official_plugins: providerPlugins,
    capability_state: capabilityStateFor(optional),
    managed_artifacts: previous?.managed_artifacts ?? [],
    installed_at: installedAt,
    status: "preparing",
    step: "validated",
    // Until config publication, recovery must use the ownership record already
    // committed for the live configuration. Conflict decisions are projections
    // and must not make user-kept values look HolyCodex-owned in this journal.
    managed_config: unmanagedConfigState,
    plugin_snapshot: [],
    plugin_config: {
      plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
      before: pluginConfigBefore,
      after: pluginConfigBefore,
    },
    provider_config: providerConfigBefore,
    owned_plugins: [...previousOwnedPlugins],
    ...(previous?.tooling === undefined ? {} : { tooling: previous.tooling }),
  };
  await ensureOwnedDirectory(paths.stateRoot);
  await writeTransaction(paths.preparingRecord, preMutationTransaction);

  let pluginSnapshot: readonly PluginSnapshot[] = [];

  let native: NativeAgentInstallResult | undefined;
  let configPublished = false;
  const addedPlugins = new Set<string>();
  const removedPlugins = new Set<string>();
  const uncertainPluginRemovals = new Set<string>();
  const ownedPlugins = new Set(previousOwnedPlugins);
  const rollbackOwnedPlugins = new Set(previousOwnedPlugins);
  const uncertainPluginMutations = new Set<string>();
  let transactionForRecovery: PreparingTransaction = preMutationTransaction;
  let pluginEffectsStarted = false;
  let configBeforeMutationDocument: TomlDocument | undefined;
  let publishedConfigState = mergedConfig.state;
  let activeRecordWriteStarted = false;
  let installOptionsWriteStarted = false;
  try {
    try {
      gitBash = await ensureGitBash(runtime, true);
      context7 = await ensureContext7(runtime, true, previous?.tooling?.context7);
      if (context7 === undefined) {
        throw new InstallerError("capability_denied", "Context7 installation was not verified.");
      }
    } catch (error: unknown) {
      if (error instanceof ToolingError) {
        throw new InstallerError("capability_denied", error.message, error, error.details);
      }
      throw error;
    }
    const tooling = { git_bash: gitBash, context7 } as const;
    let transaction: PreparingTransaction = { ...preMutationTransaction, tooling };
    transactionForRecovery = transaction;
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    if (
      manager.ensureOfficialMarketplace !== undefined &&
      unresolvedOfficialProviderPlugins.length > 0
    ) {
      try {
        await manager.ensureOfficialMarketplace(unresolvedOfficialProviderPlugins);
      } catch (error: unknown) {
        throw new InstallerError(
          "capability_denied",
          `The selected official Codex provider marketplace is unavailable: ${safeMessage(error)}`,
          error,
          { recovery: "Check Codex network and marketplace policy, then retry." },
        );
      }
    }
    try {
      pluginSnapshot = await snapshotPlugins({ list: () => manager.list!() }, [
        ...new Set([HOLYCODEX_PLUGIN, ...providerPlugins, ...previousOwnedPlugins]),
      ]);
    } catch (error: unknown) {
      throw new InstallerError(
        "capability_denied",
        "Native Codex plugin state could not be read safely.",
        error,
      );
    }
    transaction = { ...transaction, plugin_snapshot: pluginSnapshot };
    transactionForRecovery = transaction;
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    const liveConfigBeforeMutation = parseConfig(await optionalTextFile(paths.configFile));
    await assertPreflightPluginConfigStable(
      liveConfigBeforeMutation,
      currentHolyCodexPluginConfig,
      currentProviderConfig,
    );
    const configBeforeMutationRuntime = await migrateKnownLegacyRoleRegistrations(
      liveConfigBeforeMutation,
      unmanagedConfigState,
      previous,
    );
    const configBeforeMutationContext = await migrateLegacyContextManagement(
      configBeforeMutationRuntime.document,
      configBeforeMutationRuntime.state,
    );
    const configBeforeMutationAutoCompact = await migrateLegacyAutoCompactConfig(
      configBeforeMutationContext.document,
      configBeforeMutationContext.state,
    );
    configBeforeMutationDocument = configBeforeMutationAutoCompact.document;
    await assertPostPluginConfigStable(
      configBeforeMutationDocument,
      configDocument,
      { ...currentManagedConfig, managed: resolvedManagedConfig },
      resolvedDesiredConfig,
    );
    reportProgress(options, {
      stage: "roles",
      status: "started",
      message: "Installing subagent roles",
    });
    await ensureOwnedDirectory(paths.roleRoot);
    native = await installNativeAgents(
      paths.codexHome,
      profile,
      previous?.managed_artifacts,
      tier,
      gitBash.status === "healthy" ? gitBash.path : undefined,
      nativeConflicts.length === 0 ? options.resolveConflict : undefined,
      reviewedNativeConflicts,
    );
    transactionForRecovery = {
      ...transaction,
      step: "roles_prepared",
      managed_artifacts: native.managed_artifacts,
    };
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    reportProgress(options, {
      stage: "roles",
      status: "completed",
      message: "Subagent roles installed",
    });
    reportProgress(options, {
      stage: "plugins",
      status: "started",
      message: "Installing selected capabilities",
    });
    pluginEffectsStarted = true;
    let pluginRecoveryTargetDocument = configBeforeMutationDocument;
    if (pluginRecoveryTargetDocument === undefined) {
      throw new InstallerError(
        "state_corrupt",
        "The pre-mutation configuration baseline is missing.",
      );
    }
    pluginRecoveryTargetDocument = writePluginConfigEntry(
      pluginRecoveryTargetDocument,
      "plugins",
      HOLYCODEX_PLUGIN_CONFIG_KEY,
      { enabled: true },
    );
    pluginRecoveryTargetDocument = writePluginConfigEntry(
      pluginRecoveryTargetDocument,
      "marketplaces",
      HOLYCODEX_MARKETPLACE_CONFIG_KEY,
      { source_type: "git", source: HOLYCODEX_MARKETPLACE_URL },
    );
    for (const pluginId of providerPlugins) {
      pluginRecoveryTargetDocument = writePluginConfigEntry(
        pluginRecoveryTargetDocument,
        "plugins",
        pluginId,
        { enabled: true },
      );
    }
    const pluginRecoveryConfigAfter = await snapshotHolyCodexPluginConfig(
      pluginRecoveryTargetDocument,
    );
    const providerRecoveryConfigAfter = await snapshotProviderPluginConfig(
      pluginRecoveryTargetDocument,
      providerConfigPluginIds,
    );
    const providerRecoveryConfig = providerRecoveryConfigAfter.map((entry) => ({
      plugin_id: entry.plugin_id,
      before:
        providerConfigBefore.find((candidate) => candidate.plugin_id === entry.plugin_id)?.before ??
        entry.before,
      after: entry.before,
    }));
    transactionForRecovery = {
      ...transactionForRecovery,
      plugin_config: {
        plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
        before: pluginConfigBefore,
        after: pluginRecoveryConfigAfter,
      },
      provider_config: providerRecoveryConfig,
    };
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    if (omittedOwnedPlugins.length > 0) {
      const removalManager = {
        list: () => manager.list!(),
        remove: (id: string) => manager.remove!(id),
      };
      await removeAndVerify(removalManager, omittedOwnedPlugins, async (id, mutation) => {
        if (mutation === "removed") {
          removedPlugins.add(id);
          ownedPlugins.delete(id);
        } else if (mutation === "absent") {
          ownedPlugins.delete(id);
        } else {
          // A failed remove whose post-state cannot be proven remains owned
          // so conflicted recovery can retry it safely.
          uncertainPluginRemovals.add(id);
        }
        transactionForRecovery = {
          ...transactionForRecovery,
          owned_plugins: [...ownedPlugins],
        };
        await writeTransaction(paths.preparingRecord, transactionForRecovery);
      });
    }
    await manager.addMarketplace!(HOLYCODEX_MARKETPLACE);
    const nativeManager = {
      list: () => manager.list!(),
      add: (id: string) => manager.add!(id),
    };
    await installAndVerify(
      nativeManager,
      [HOLYCODEX_PLUGIN, ...providerPlugins],
      refreshPluginIds,
      async (id, mutation) => {
        if (mutation === "new") {
          addedPlugins.add(id);
          ownedPlugins.add(id);
          rollbackOwnedPlugins.add(id);
          transactionForRecovery = {
            ...transactionForRecovery,
            owned_plugins: [...ownedPlugins],
          };
        } else {
          // An add attempt that cannot be classified safely may still have
          // installed the plugin. Record ownership for conflicted recovery;
          // the next remove/retry must reconcile that effect explicitly.
          uncertainPluginMutations.add(id);
          ownedPlugins.add(id);
          rollbackOwnedPlugins.add(id);
          transactionForRecovery = {
            ...transactionForRecovery,
            owned_plugins: [...ownedPlugins],
          };
        }
        await writeTransaction(paths.preparingRecord, transactionForRecovery);
      },
    );
    transactionForRecovery = { ...transactionForRecovery, step: "plugins_installed" };
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    reportProgress(options, {
      stage: "plugins",
      status: "completed",
      message: "Selected capabilities installed",
    });
    const configAfterPlugins = await optionalTextFile(paths.configFile);
    const postPluginDocument = parseConfig(configAfterPlugins);
    const postPluginRuntime = await migrateKnownLegacyRoleRegistrations(
      postPluginDocument,
      unmanagedConfigState,
      previous,
    );
    const postPluginContext = await migrateLegacyContextManagement(
      postPluginRuntime.document,
      postPluginRuntime.state,
    );
    const postPluginAutoCompact = await migrateLegacyAutoCompactConfig(
      postPluginContext.document,
      postPluginContext.state,
    );
    if (configBeforeMutationDocument === undefined) {
      throw new InstallerError(
        "state_corrupt",
        "The pre-mutation configuration baseline is missing.",
      );
    }
    const postPluginResolution = await applyPluginConfigConflictDecisions(
      postPluginAutoCompact.document,
      configBeforeMutationDocument,
      initialPluginConfigBefore,
      initialProviderConfigBefore,
      currentHolyCodexPluginConfig,
      currentProviderConfig,
      pluginConfigConflicts,
      providerConfigConflicts,
      resolvedConflicts.decisions,
      providerPlugins,
    );
    let stablePostPluginDocument = postPluginResolution.document;
    for (const rawKeyPath of Object.keys(resolvedManagedConfig)) {
      const keyPath = rawKeyPath as ManagedConfigKeyPath;
      const acceptedValue = readTomlPath(configBeforeMutationDocument, keyPath);
      stablePostPluginDocument =
        acceptedValue === undefined
          ? deleteTomlPath(stablePostPluginDocument, keyPath)
          : writeTomlPath(stablePostPluginDocument, keyPath, acceptedValue);
    }
    pluginConfigBefore = postPluginResolution.pluginConfigBefore;
    providerConfigBefore = postPluginResolution.providerConfigBefore;
    const pluginConfigAfter = await snapshotHolyCodexPluginConfig(stablePostPluginDocument);
    const currentProviderConfigAfter = await snapshotProviderPluginConfig(
      stablePostPluginDocument,
      providerConfigPluginIds,
    );
    const providerConfig = currentProviderConfigAfter.map((entry) => ({
      plugin_id: entry.plugin_id,
      before:
        providerConfigBefore.find((candidate) => candidate.plugin_id === entry.plugin_id)?.before ??
        entry.before,
      after: entry.before,
    }));
    transactionForRecovery = {
      ...transactionForRecovery,
      plugin_config: {
        plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
        before: pluginConfigBefore,
        after: pluginConfigAfter,
      },
      provider_config: providerConfig,
    };
    const postPluginBaselineManaged: Record<string, ManagedRuntimeConfigState["managed"][string]> =
      {};
    for (const [rawKeyPath, entry] of Object.entries(resolvedManagedConfig)) {
      const keyPath = rawKeyPath as ManagedConfigKeyPath;
      const value = readTomlPath(configBeforeMutationDocument, keyPath);
      postPluginBaselineManaged[keyPath] = {
        ...entry,
        ...(value === undefined
          ? {}
          : { lastManagedValue: await summarizeManagedConfigValue(keyPath, value) }),
      };
    }
    const postPluginBaseline: ManagedRuntimeConfigState = {
      ...currentManagedConfig,
      managed: postPluginBaselineManaged,
    };
    await assertPostPluginConfigStable(
      stablePostPluginDocument,
      configBeforeMutationDocument,
      postPluginBaseline,
      resolvedDesiredConfig,
    );
    const postPluginConfig = await mergeManagedRuntimeConfig(
      stablePostPluginDocument,
      postPluginBaseline,
      resolvedDesiredConfig,
      { schema: STATE_SCHEMA_EPOCH, installId },
    );
    if (postPluginConfig.driftedKeys.length > 0) {
      throw new InstallerError(
        "state_corrupt",
        "HolyCodex-owned Codex settings changed during native plugin setup.",
        undefined,
        { keys: postPluginConfig.driftedKeys.join(",") },
      );
    }
    const publishedDeveloperInstructions = readTomlPath(
      postPluginConfig.document,
      "developer_instructions",
    );
    await debugInstaller(
      `publishedCandidate shell=${String(typeof publishedDeveloperInstructions === "string" && publishedDeveloperInstructions.includes("On Windows, use Git for Windows Bash"))} publishedTail=${JSON.stringify(typeof publishedDeveloperInstructions === "string" ? publishedDeveloperInstructions.slice(-500) : publishedDeveloperInstructions)} resolvedShell=${String(typeof resolvedDesiredConfig.developer_instructions === "string" && resolvedDesiredConfig.developer_instructions.includes("On Windows, use Git for Windows Bash"))}`,
    );
    reportProgress(options, {
      stage: "config",
      status: "started",
      message: "Configuring Root",
    });
    publishedConfigState = postPluginConfig.state;
    transactionForRecovery = {
      ...transactionForRecovery,
      managed_config: publishedConfigState,
      plugin_config: {
        plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
        before: pluginConfigBefore,
        after: pluginConfigAfter,
      },
      provider_config: providerConfig,
    };
    if ((await optionalTextFile(paths.configFile)) !== configAfterPlugins) {
      throw new InstallerError(
        "confirmation_required",
        "Codex configuration changed during plugin setup; review the latest configuration and retry.",
        undefined,
        { path: paths.configFile },
      );
    }
    await writeAtomicText(paths.configFile, serializeConfig(postPluginConfig.document));
    configPublished = true;
    const publishedConfigText = await optionalTextFile(paths.configFile);
    await debugInstaller(
      `afterWrite shell=${String(publishedConfigText?.includes("On Windows, use Git for Windows Bash"))} textTail=${JSON.stringify(publishedConfigText?.slice(-500) ?? "")}`,
    );
    transactionForRecovery = { ...transactionForRecovery, step: "config_published" };
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    reportProgress(options, {
      stage: "config",
      status: "completed",
      message: "Root configuration published",
    });
    reportProgress(options, {
      stage: "verification",
      status: "started",
      message: "Verifying installation",
    });
    await verifyEffectiveInstall(
      paths,
      profile,
      tier,
      {
        computerUse: optional.computer_use,
        frontend: optional.frontend,
        security: optional.security,
        ...(gitBash.status === "healthy" ? { windowsGitBashExecutable: gitBash.path } : {}),
      },
      publishedConfigState,
      native.preserved,
      resolvedDesiredConfig,
    );
    reportProgress(options, {
      stage: "verification",
      status: "completed",
      message: "Installation verified",
    });
    const capabilityState = capabilityStateFor(optional);
    const digest = await installRecordDigest({
      owner: "holycodex",
      install_id: installId,
      version,
      profile,
      tier,
      optional_selections: optional,
      explicit_optional_selections: explicitOptional,
      official_plugins: providerPlugins,
      capability_state: capabilityState,
      managed_artifacts: native.managed_artifacts,
      managed_config: publishedConfigState,
      plugin_config: {
        plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
        before: pluginConfigBefore,
        after: pluginConfigAfter,
      },
      provider_config: providerConfig,
      plugin_snapshot: pluginSnapshot,
      owned_plugins: [...ownedPlugins],
      tooling,
    });
    const record: InstallRecord = {
      owner: "holycodex",
      schema_epoch: STATE_SCHEMA_EPOCH,
      install_id: installId,
      version,
      digest,
      profile,
      tier,
      optional_selections: optional,
      explicit_optional_selections: explicitOptional,
      official_plugins: providerPlugins,
      capability_state: capabilityState,
      managed_artifacts: native.managed_artifacts,
      installed_at: installedAt,
      status: "active",
      step: "active",
      managed_config: publishedConfigState,
      plugin_snapshot: pluginSnapshot,
      plugin_config: {
        plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
        before: pluginConfigBefore,
        after: pluginConfigAfter,
      },
      provider_config: providerConfig,
      owned_plugins: [...ownedPlugins],
      tooling,
    };
    if (decodeSchema(InstallRecordSchema, record) === undefined) {
      throw new InstallerError("state_corrupt", "The HolyCodex configuration is invalid.");
    }
    activeRecordWriteStarted = true;
    await writeAtomicJson(paths.activeRecord, asJsonValue(record));
    installOptionsWriteStarted = true;
    await writeInstallOptions(
      paths,
      persistedOptionsForInstall(profile, tier, optional, additionalPlugins),
    );
    await removeTransaction(paths.preparingRecord);
    await removeTransaction(paths.conflictedRecord);
    reportProgress(options, {
      stage: "complete",
      status: "completed",
      message: "HolyCodex installation complete",
    });
    return {
      record,
      optional_plugins: providerPlugins,
      preserved: native.preserved,
      warnings: native.preserved.length === 0 ? [] : ["modified managed files were preserved"],
    };
  } catch (error: unknown) {
    const rollbackFailures: string[] = [];
    if (activeRecordWriteStarted) {
      try {
        if (activeRecordBefore === undefined) {
          await rm(paths.activeRecord, { force: false }).catch((restoreError: unknown) => {
            if (!isFsCode(restoreError, "ENOENT")) throw restoreError;
          });
        } else {
          await writeAtomicText(paths.activeRecord, activeRecordBefore);
        }
      } catch {
        rollbackFailures.push("active_record");
      }
    }
    if (installOptionsWriteStarted) {
      try {
        if (installOptionsBefore === undefined) {
          await rm(paths.installOptions, { force: false }).catch((restoreError: unknown) => {
            if (!isFsCode(restoreError, "ENOENT")) throw restoreError;
          });
        } else {
          await writeAtomicText(paths.installOptions, installOptionsBefore);
        }
      } catch {
        rollbackFailures.push("install_options");
      }
    }
    if (pluginEffectsStarted || configPublished) {
      try {
        if (configBeforeMutationDocument !== undefined) {
          await rollbackConfigTransaction(
            paths.configFile,
            transactionForRecovery,
            configBeforeMutationDocument,
            rollbackOwnedPlugins,
          );
        }
      } catch {
        rollbackFailures.push("config");
      }
    }
    if (native !== undefined) {
      try {
        const rollback = await rollbackNativeAgentInstall(native.rollback);
        if (rollback.preserved.length > 0) {
          rollbackFailures.push("roles");
        }
      } catch {
        rollbackFailures.push("roles");
      }
    }
    if (uncertainPluginMutations.size > 0) {
      rollbackFailures.push(...[...uncertainPluginMutations].map((id) => `plugin:${id}`));
    }
    for (const pluginId of addedPlugins) {
      try {
        await manager.remove?.(pluginId);
      } catch {
        rollbackFailures.push(`plugin:${pluginId}`);
      }
    }
    for (const pluginId of new Set([...removedPlugins, ...uncertainPluginRemovals])) {
      try {
        await restoreRemovedPlugin(
          {
            list: () => manager.list!(),
            add: (id: string) => manager.add!(id),
          },
          pluginId,
          pluginSnapshot.find((snapshot) => snapshot.plugin_id === pluginId)?.status,
        );
        removedPlugins.delete(pluginId);
        uncertainPluginRemovals.delete(pluginId);
        ownedPlugins.add(pluginId);
        transactionForRecovery = {
          ...transactionForRecovery,
          owned_plugins: [...ownedPlugins],
        };
        await writeTransaction(paths.preparingRecord, transactionForRecovery);
      } catch {
        // Keep ownership in the recovery journal when restoring a removed
        // plugin cannot be proven complete.
        ownedPlugins.add(pluginId);
        uncertainPluginRemovals.add(pluginId);
        transactionForRecovery = {
          ...transactionForRecovery,
          owned_plugins: [...ownedPlugins],
        };
        await writeTransaction(paths.preparingRecord, transactionForRecovery).catch(
          () => undefined,
        );
        rollbackFailures.push(`plugin:${pluginId}`);
      }
    }
    if (
      context7?.ownership === "holycodex" &&
      previous?.tooling?.context7?.ownership !== "holycodex"
    ) {
      try {
        if (!(await removeOwnedContext7(runtime, context7))) {
          rollbackFailures.push("context7");
        }
      } catch {
        rollbackFailures.push("context7");
      }
    }
    if (rollbackFailures.length > 0) {
      try {
        const recoveryDocument = parseConfig(await optionalTextFile(paths.configFile));
        const recoveryPluginConfig = transactionForRecovery.plugin_config;
        const recoveryCurrentPluginConfig = await snapshotHolyCodexPluginConfig(recoveryDocument);
        const normalizedPluginConfig =
          recoveryPluginConfig === undefined
            ? undefined
            : {
                ...recoveryPluginConfig,
                after: {
                  preference:
                    recoveryCurrentPluginConfig.preference.digest ===
                    recoveryPluginConfig.before.preference.digest
                      ? recoveryPluginConfig.before.preference
                      : recoveryPluginConfig.after.preference,
                  marketplace:
                    recoveryCurrentPluginConfig.marketplace.digest ===
                    recoveryPluginConfig.before.marketplace.digest
                      ? recoveryPluginConfig.before.marketplace
                      : recoveryPluginConfig.after.marketplace,
                },
              };
        const recoveryProviderConfig = transactionForRecovery.provider_config;
        const recoveryCurrentProviderConfig = await snapshotProviderPluginConfig(
          recoveryDocument,
          recoveryProviderConfig?.map((entry) => entry.plugin_id) ?? [],
        );
        const normalizedProviderConfig = recoveryProviderConfig?.map((entry) => {
          const current = recoveryCurrentProviderConfig.find(
            (candidate) => candidate.plugin_id === entry.plugin_id,
          );
          return current !== undefined && current.before.digest === entry.before.digest
            ? { ...entry, after: entry.before }
            : entry;
        });
        transactionForRecovery = {
          ...transactionForRecovery,
          ...(normalizedPluginConfig === undefined
            ? {}
            : { plugin_config: normalizedPluginConfig }),
          ...(normalizedProviderConfig === undefined
            ? {}
            : { provider_config: normalizedProviderConfig }),
        };
      } catch {
        // Keep the transaction's expected post-mutation snapshots when the live state cannot be read.
      }
      let conflictPublished = false;
      try {
        await writeTransaction(paths.conflictedRecord, {
          ...transactionForRecovery,
          step: "conflicted",
          status: "conflicted",
        });
        conflictPublished = true;
      } catch {
        // Keep the preparing journal when conflict publication fails so recovery can retry it.
      }
      if (conflictPublished) {
        await removeTransaction(paths.preparingRecord).catch(() => undefined);
      }
    } else {
      await removeTransaction(paths.preparingRecord).catch(() => undefined);
    }
    if (error instanceof PathBoundaryError) throw error;
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      error instanceof OfficialPluginManagerError || error instanceof PluginVerificationError
        ? "capability_denied"
        : "install_failed",
      safeMessage(error),
      error,
      rollbackFailures.length > 0 ? { recovery: "Resolve conflicted state before retrying." } : {},
    );
  }
}

/** Read and, when needed, migrate the active install record after validating its digest. */
export async function readActiveInstallRecord(
  paths: ResolvedInstallerPaths,
): Promise<InstallRecord | undefined> {
  const raw = await optionalJsonFile(paths.activeRecord, JsonObjectSchema);
  if (raw === undefined) return undefined;
  const rawSelections = raw["optional_selections"];
  const hasLegacyWork =
    typeof rawSelections === "object" &&
    rawSelections !== null &&
    !Array.isArray(rawSelections) &&
    Object.prototype.hasOwnProperty.call(rawSelections, "work");
  const current = hasLegacyWork ? undefined : decodeSchema(InstallRecordSchema, raw);
  if (current !== undefined) return current;
  const legacy = decodeSchema(InstallRecordMigrationSchema, raw);
  if (legacy === undefined) {
    throw new InstallerError("state_corrupt", "The HolyCodex configuration is invalid.");
  }
  if (!(await recordDigestMatchesRaw(legacy))) {
    throw new InstallerError(
      "state_corrupt",
      "The existing HolyCodex configuration has an invalid digest.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  const persistedProfile =
    "profile" in legacy && legacy.profile !== undefined
      ? legacy.profile
      : "plan" in legacy
        ? legacy.plan
        : undefined;
  if (persistedProfile === undefined) {
    throw new InstallerError(
      "state_corrupt",
      "The persisted installation has neither profile nor legacy plan state.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  let migratedProfile: ProfileName;
  try {
    migratedProfile = migrateProfileName(persistedProfile);
  } catch (error: unknown) {
    throw new InstallerError(
      "state_corrupt",
      `The persisted profile ${persistedProfile} was removed and requires an explicit replacement.`,
      error,
      { path: paths.activeRecord, profile: persistedProfile },
    );
  }
  const legacyWithoutPlan =
    "plan" in legacy
      ? (Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "plan")) as Omit<
          typeof legacy,
          "plan"
        >)
      : legacy;
  const optionalSelections: OptionalSelections = {
    computer_use: legacy.optional_selections.computer_use,
    frontend: legacy.optional_selections.frontend,
    security: legacy.optional_selections.security,
    coding: true,
  };
  const explicitOptionalSelections: ExplicitOptionalSelections = {
    ...(legacy.explicit_optional_selections.computer_use === undefined
      ? {}
      : { computer_use: legacy.explicit_optional_selections.computer_use }),
    ...(legacy.explicit_optional_selections.frontend === undefined
      ? {}
      : { frontend: legacy.explicit_optional_selections.frontend }),
    ...(legacy.explicit_optional_selections.security === undefined
      ? {}
      : { security: legacy.explicit_optional_selections.security }),
  };
  const capabilityState =
    legacy.capability_state === undefined ? undefined : capabilityStateFor(optionalSelections);
  const officialPlugins = (legacy.official_plugins ?? []).filter((id) => !isLegacyWorkPlugin(id));
  const ownedPlugins = legacy.owned_plugins?.filter((id) => !isLegacyWorkPlugin(id));
  const providerConfig = legacy.provider_config?.filter(
    (entry) => !isLegacyWorkPlugin(entry.plugin_id),
  );
  const pluginSnapshot = legacy.plugin_snapshot?.filter(
    (entry) => !isLegacyWorkPlugin(entry.plugin_id),
  );
  const {
    optional_selections: _legacyOptional,
    explicit_optional_selections: _legacyExplicit,
    capability_state: _legacyCapabilityState,
    official_plugins: _legacyOfficialPlugins,
    owned_plugins: _legacyOwnedPlugins,
    provider_config: _legacyProviderConfig,
    plugin_snapshot: _legacyPluginSnapshot,
    ...legacyBase
  } = legacyWithoutPlan;
  const migrated = {
    ...legacyBase,
    profile: migratedProfile,
    optional_selections: optionalSelections,
    explicit_optional_selections: explicitOptionalSelections,
    official_plugins: officialPlugins,
    ...(capabilityState === undefined ? {} : { capability_state: capabilityState }),
    ...(ownedPlugins === undefined ? {} : { owned_plugins: ownedPlugins }),
    ...(providerConfig === undefined ? {} : { provider_config: providerConfig }),
    ...(pluginSnapshot === undefined ? {} : { plugin_snapshot: pluginSnapshot }),
    digest: await installRecordDigest({
      owner: legacy.owner,
      install_id: legacy.install_id,
      version: legacy.version,
      profile: migratedProfile,
      tier: legacy.tier,
      optional_selections: optionalSelections,
      explicit_optional_selections: explicitOptionalSelections,
      official_plugins: officialPlugins,
      capability_state: capabilityState ?? null,
      managed_artifacts: legacy.managed_artifacts,
      ...(legacy.managed_config === undefined ? {} : { managed_config: legacy.managed_config }),
      ...(legacy.plugin_config === undefined ? {} : { plugin_config: legacy.plugin_config }),
      ...(providerConfig === undefined ? {} : { provider_config: providerConfig }),
      ...(pluginSnapshot === undefined ? {} : { plugin_snapshot: pluginSnapshot }),
      ...(ownedPlugins === undefined ? {} : { owned_plugins: ownedPlugins }),
      ...(legacy.tooling === undefined ? {} : { tooling: legacy.tooling }),
    }),
  } as InstallRecord;
  return migrated;
}

export { removeManagedNativeAgents };

function toCoreSelections(value: OptionalSelections): OptionalCapabilitySelections {
  return {
    computer_use: value.computer_use,
    frontend: value.frontend,
    security: value.security,
  };
}

/** Parse Codex configuration text through the validated TOML document boundary. */
export function parseConfig(text: string | undefined): TomlDocument {
  if (text === undefined || text.trim().length === 0) return {};
  try {
    const bun = (globalThis as { Bun?: { TOML?: { parse: (value: string) => unknown } } }).Bun;
    const parsed = bun?.TOML?.parse ? bun.TOML.parse(text) : parseToml(text);
    const document = decodeSchema(TomlDocumentSchema, parsed);
    if (document === undefined) throw new Error("TOML document contains unsupported values.");
    return document;
  } catch (error: unknown) {
    throw new InstallerError("state_corrupt", "The Codex config.toml is not valid TOML.", error);
  }
}

/** Serialize a validated TOML document for writing to Codex configuration. */
export function serializeConfig(document: TomlDocument): string {
  try {
    const bun = (globalThis as { Bun?: { TOML?: { stringify: (value: TomlDocument) => string } } })
      .Bun;
    const rendered = bun?.TOML?.stringify ? bun.TOML.stringify(document) : stringifyToml(document);
    return `${rendered.trimEnd()}\n`;
  } catch (error: unknown) {
    throw new InstallerError(
      "install_failed",
      "The merged Codex configuration is not writable.",
      error,
    );
  }
}

type PluginConfigEntryName = "preference" | "marketplace";

/** Capture the pre-install configuration entries owned by the HolyCodex plugin. */
export async function snapshotHolyCodexPluginConfig(
  document: TomlDocument,
): Promise<PluginConfigSnapshot["before"]> {
  return {
    preference: await snapshotPluginConfigEntry(document, "plugins", HOLYCODEX_PLUGIN_CONFIG_KEY),
    marketplace: await snapshotPluginConfigEntry(
      document,
      "marketplaces",
      HOLYCODEX_MARKETPLACE_CONFIG_KEY,
    ),
  };
}

async function snapshotProviderPluginConfig(
  document: TomlDocument,
  pluginIds: readonly string[],
): Promise<readonly ProviderPluginConfigSnapshot[]> {
  return await Promise.all(
    pluginIds.map(async (pluginId) => {
      const entry = await snapshotPluginConfigEntry(document, "plugins", pluginId);
      const snapshot = {
        presence: entry.presence,
        digest: entry.digest,
        ...(entry.safe_value?.kind === "boolean" ? { safe_value: entry.safe_value } : {}),
      };
      return { plugin_id: pluginId, before: snapshot, after: snapshot };
    }),
  );
}

export interface PluginConfigCleanupResult {
  readonly document: TomlDocument;
  readonly restored: readonly PluginConfigEntryName[];
  readonly removed: readonly PluginConfigEntryName[];
  readonly preserved: readonly PluginConfigEntryName[];
}

export interface ProviderPluginConfigCleanupResult {
  readonly document: TomlDocument;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
}

/** Restore or remove HolyCodex configuration entries when their values are unchanged. */
export async function cleanupHolyCodexPluginConfig(
  document: TomlDocument,
  snapshot: PluginConfigSnapshot,
  options: Readonly<{ readonly allowBeforeState?: boolean }> = {},
): Promise<PluginConfigCleanupResult> {
  let output = document;
  const restored: PluginConfigEntryName[] = [];
  const removed: PluginConfigEntryName[] = [];
  const preserved: PluginConfigEntryName[] = [];
  for (const [name, parent, key] of [
    ["preference", "plugins", HOLYCODEX_PLUGIN_CONFIG_KEY],
    ["marketplace", "marketplaces", HOLYCODEX_MARKETPLACE_CONFIG_KEY],
  ] as const) {
    const before = snapshot.before[name];
    const after = snapshot.after[name];
    const current = await snapshotPluginConfigEntry(document, parent, key);
    if (options.allowBeforeState === true && current.digest === before.digest) continue;
    if (current.digest !== after.digest) {
      preserved.push(name);
      continue;
    }
    if (before.presence === "absent") {
      if (current.presence === "present") {
        output = deletePluginConfigEntry(output, parent, key);
        removed.push(name);
      }
      continue;
    }
    if (before.safe_value === undefined) {
      preserved.push(name);
      continue;
    }
    output = writePluginConfigEntry(output, parent, key, pluginSafeValueToToml(before.safe_value));
    restored.push(name);
  }
  return { document: output, restored, removed, preserved };
}

/** Restore or remove provider plugin entries when their values are unchanged. */
export async function cleanupProviderPluginConfig(
  document: TomlDocument,
  snapshots: readonly ProviderPluginConfigSnapshot[],
  ownedPlugins: ReadonlySet<string>,
  options: Readonly<{ readonly allowBeforeState?: boolean }> = {},
): Promise<ProviderPluginConfigCleanupResult> {
  let output = document;
  const restored: string[] = [];
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const snapshot of snapshots) {
    if (!ownedPlugins.has(snapshot.plugin_id)) continue;
    const before = snapshot.before;
    const after = snapshot.after;
    const current = await snapshotPluginConfigEntry(document, "plugins", snapshot.plugin_id);
    if (options.allowBeforeState === true && current.digest === before.digest) continue;
    if (current.digest !== after.digest) {
      preserved.push(snapshot.plugin_id);
      continue;
    }
    if (before.presence === "absent") {
      if (current.presence === "present") {
        output = deletePluginConfigEntry(output, "plugins", snapshot.plugin_id);
        removed.push(snapshot.plugin_id);
      }
      continue;
    }
    if (before.safe_value === undefined) {
      preserved.push(snapshot.plugin_id);
      continue;
    }
    output = writePluginConfigEntry(output, "plugins", snapshot.plugin_id, {
      enabled: before.safe_value.value,
    });
    restored.push(snapshot.plugin_id);
  }
  return { document: output, restored, removed, preserved };
}

async function restoreUnsupportedPluginConfigEntry(
  document: TomlDocument,
  baseline: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
  before: PluginConfigEntrySnapshot | ProviderPluginConfigSnapshot["before"],
  after: PluginConfigEntrySnapshot | ProviderPluginConfigSnapshot["after"],
): Promise<{ readonly document: TomlDocument; readonly restored: boolean }> {
  if (before.presence !== "present" || before.safe_value !== undefined) {
    return { document, restored: false };
  }
  const current = await snapshotPluginConfigEntry(document, parent, key);
  if (current.digest === before.digest || current.digest !== after.digest) {
    return { document, restored: false };
  }
  const value = readPluginConfigEntry(baseline, parent, key);
  if (value === undefined) return { document, restored: false };
  return {
    document: writePluginConfigEntry(document, parent, key, value),
    restored: true,
  };
}

async function snapshotPluginConfigEntry(
  document: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
): Promise<PluginConfigEntrySnapshot> {
  const value = readPluginConfigEntry(document, parent, key);
  const digest = await domainSeparatedSha256("holycodex-plugin-config", [
    canonicalJsonUtf8(
      asJsonValue({
        key: `${parent}.${key}`,
        value: value === undefined ? { presence: "absent" } : value,
      }),
    ),
  ]);
  const safeValue = pluginConfigSafeValue(parent, value);
  return {
    presence: value === undefined ? "absent" : "present",
    digest,
    ...(safeValue === undefined ? {} : { safe_value: safeValue }),
  };
}

function readPluginConfigEntry(
  document: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
): TomlValue | undefined {
  const table = document[parent];
  if (!isTomlTable(table)) return undefined;
  return table[key];
}

function pluginConfigSafeValue(
  parent: "plugins" | "marketplaces",
  value: TomlValue | undefined,
): PluginConfigSafeValue | undefined {
  if (!isTomlTable(value)) return undefined;
  const keys = Object.keys(value);
  if (parent === "plugins") {
    if (keys.length !== 1 || keys[0] !== "enabled" || typeof value["enabled"] !== "boolean") {
      return undefined;
    }
    return { kind: "boolean", value: value["enabled"] };
  }
  if (
    keys.length !== 2 ||
    !keys.includes("source_type") ||
    !keys.includes("source") ||
    value["source_type"] !== "git" ||
    value["source"] !== HOLYCODEX_MARKETPLACE_URL
  ) {
    return undefined;
  }
  return {
    kind: "marketplace",
    source_type: "git",
    source: HOLYCODEX_MARKETPLACE_URL,
  };
}

function pluginSafeValueToToml(value: PluginConfigSafeValue): TomlTable {
  if (value.kind === "boolean") return { enabled: value.value };
  return { source_type: value.source_type, source: value.source };
}

function writePluginConfigEntry(
  document: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
  value: TomlValue,
): TomlDocument {
  const output: Record<string, TomlValue> = { ...document };
  const parentValue = output[parent];
  if (parentValue !== undefined && !isTomlTable(parentValue)) {
    throw new InstallerError("state_corrupt", `The ${parent} Codex config table is invalid.`);
  }
  output[parent] = { ...(parentValue as TomlTable | undefined), [key]: value };
  return output;
}

function deletePluginConfigEntry(
  document: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
): TomlDocument {
  const parentValue = document[parent];
  if (!isTomlTable(parentValue) || !Object.prototype.hasOwnProperty.call(parentValue, key)) {
    return document;
  }
  const output: Record<string, TomlValue> = { ...document };
  const next: Record<string, TomlValue> = { ...parentValue };
  delete next[key];
  if (Object.keys(next).length === 0) delete output[parent];
  else output[parent] = next;
  return output;
}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PluginConfigConflictResolution = Readonly<{
  readonly document: TomlDocument;
  readonly pluginConfigBefore: PluginConfigSnapshot["before"];
  readonly providerConfigBefore: readonly ProviderPluginConfigSnapshot[];
}>;

async function assertPreflightPluginConfigStable(
  document: TomlDocument,
  expectedHolyCodex: PluginConfigSnapshot["before"],
  expectedProviders: readonly ProviderPluginConfigSnapshot[],
): Promise<void> {
  const entries = [
    { parent: "plugins", key: HOLYCODEX_PLUGIN_CONFIG_KEY, expected: expectedHolyCodex.preference },
    {
      parent: "marketplaces",
      key: HOLYCODEX_MARKETPLACE_CONFIG_KEY,
      expected: expectedHolyCodex.marketplace,
    },
    ...expectedProviders.map(({ plugin_id, before }) => ({
      parent: "plugins" as const,
      key: plugin_id,
      expected: before,
    })),
  ] as const;
  for (const { parent, key, expected } of entries) {
    const current = await snapshotPluginConfigEntry(document, parent, key);
    if (current.digest !== expected.digest) {
      throw new InstallerError(
        "confirmation_required",
        "Plugin configuration changed after preflight; review the latest configuration and retry.",
        undefined,
        { key: `${parent}.${key}` },
      );
    }
  }
}

async function applyPluginConfigConflictDecisions(
  document: TomlDocument,
  preservationDocument: TomlDocument,
  pluginConfigBefore: PluginConfigSnapshot["before"],
  providerConfigBefore: readonly ProviderPluginConfigSnapshot[],
  currentPluginConfig: PluginConfigSnapshot["before"],
  currentProviderConfig: readonly ProviderPluginConfigSnapshot[],
  pluginConflicts: readonly ManagedConflict[],
  providerConflicts: readonly ManagedConflict[],
  decisions: ReadonlyMap<string, ConflictDecision>,
  selectedProviderPlugins: readonly string[],
): Promise<PluginConfigConflictResolution> {
  let output = document;
  let effectivePluginConfigBefore = pluginConfigBefore;
  let effectiveProviderConfigBefore = providerConfigBefore;
  for (const conflict of pluginConflicts) {
    const identity = conflict.identity;
    if (identity === undefined) {
      throw new InstallerError("state_corrupt", "A plugin configuration conflict has no identity.");
    }
    const decision = decisions.get(identity);
    if (decision !== "keep" && decision !== "replace") {
      throw new InstallerError(
        "confirmation_required",
        `Plugin configuration conflict resolution is incomplete for ${conflict.key ?? identity}.`,
      );
    }
    const name: PluginConfigEntryName =
      conflict.key === 'plugins."holycodex@holycodex"' ? "preference" : "marketplace";
    const current = currentPluginConfig[name];
    if (decision === "keep") {
      const preserved = readPluginConfigEntry(
        preservationDocument,
        "plugins",
        HOLYCODEX_PLUGIN_CONFIG_KEY,
      );
      if (name === "preference" && isTomlTable(preserved) && preserved["enabled"] === false) {
        throw new InstallerError(
          "confirmation_required",
          "Keeping disabled HolyCodex config would disable the selected plugin.",
        );
      }
      output = preserveConfigConflictEntry(output, preservationDocument, conflict.key);
      effectivePluginConfigBefore = {
        ...effectivePluginConfigBefore,
        [name]: current,
      };
      continue;
    }
    output = writePluginConfigEntry(
      output,
      name === "preference" ? "plugins" : "marketplaces",
      name === "preference" ? HOLYCODEX_PLUGIN_CONFIG_KEY : HOLYCODEX_MARKETPLACE_CONFIG_KEY,
      name === "preference"
        ? { enabled: true }
        : { source_type: "git", source: HOLYCODEX_MARKETPLACE_URL },
    );
  }
  for (const conflict of providerConflicts) {
    const identity = conflict.identity;
    const key = conflict.key;
    if (identity === undefined || key === undefined) {
      throw new InstallerError(
        "state_corrupt",
        "A provider configuration conflict has no identity.",
      );
    }
    const pluginId =
      key.startsWith('plugins."') && key.endsWith('"')
        ? key.slice('plugins."'.length, -1)
        : undefined;
    if (pluginId === undefined) {
      throw new InstallerError(
        "state_corrupt",
        `The provider configuration conflict key ${key} is invalid.`,
      );
    }
    const decision = decisions.get(identity);
    if (decision !== "keep" && decision !== "replace") {
      throw new InstallerError(
        "confirmation_required",
        `Provider configuration conflict resolution is incomplete for ${key}.`,
      );
    }
    const current = currentProviderConfig.find((entry) => entry.plugin_id === pluginId);
    if (current === undefined) {
      throw new InstallerError(
        "state_corrupt",
        `The provider configuration entry ${pluginId} is missing.`,
      );
    }
    if (decision === "keep") {
      const preserved = readPluginConfigEntry(preservationDocument, "plugins", pluginId);
      if (
        selectedProviderPlugins.includes(pluginId) &&
        isTomlTable(preserved) &&
        preserved["enabled"] === false
      ) {
        throw new InstallerError(
          "confirmation_required",
          `Keeping disabled config would disable selected plugin ${pluginId}.`,
        );
      }
      output = preserveConfigConflictEntry(output, preservationDocument, key);
      effectiveProviderConfigBefore = effectiveProviderConfigBefore.map((entry) =>
        entry.plugin_id === pluginId
          ? { plugin_id: pluginId, before: current.before, after: current.before }
          : entry,
      );
      continue;
    }
    output = writePluginConfigEntry(output, "plugins", pluginId, { enabled: true });
  }
  return {
    document: output,
    pluginConfigBefore: effectivePluginConfigBefore,
    providerConfigBefore: effectiveProviderConfigBefore,
  };
}

function preserveConfigConflictEntry(
  document: TomlDocument,
  preservationDocument: TomlDocument,
  key: string | undefined,
): TomlDocument {
  if (key === undefined) {
    throw new InstallerError("state_corrupt", "A configuration conflict has no key.");
  }
  if (key.startsWith('plugins."') && key.endsWith('"')) {
    const pluginId = key.slice('plugins."'.length, -1);
    const value = readPluginConfigEntry(preservationDocument, "plugins", pluginId);
    return value === undefined
      ? deletePluginConfigEntry(document, "plugins", pluginId)
      : writePluginConfigEntry(document, "plugins", pluginId, value);
  }
  const value = readTomlPath(preservationDocument, key);
  return value === undefined ? deleteTomlPath(document, key) : writeTomlPath(document, key, value);
}

async function preserveManagedConfigDecisions(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
  previousDesired:
    | Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>
    | undefined,
): Promise<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>> {
  const effective = { ...desired };
  if (previousDesired === undefined) return effective;
  for (const rawKeyPath of Object.keys(desired)) {
    const keyPath = rawKeyPath as ManagedConfigKeyPath;
    const existing = current.managed[keyPath];
    const previousValue = previousDesired[keyPath];
    if (existing === undefined || previousValue === undefined) continue;
    const previousSummary = await summarizeManagedConfigValue(keyPath, previousValue);
    if (JSON.stringify(previousSummary) === JSON.stringify(existing.lastManagedValue)) continue;
    const live = readTomlPath(document, keyPath);
    if (typeof live !== "string" && typeof live !== "number" && typeof live !== "boolean") {
      continue;
    }
    const liveSummary = await summarizeManagedConfigValue(keyPath, live);
    if (JSON.stringify(liveSummary) === JSON.stringify(existing.lastManagedValue)) {
      delete effective[keyPath];
    }
  }
  return effective;
}

/** Build the complete managed Root and canonical-agent runtime projection. */
export function desiredRootConfig(
  profile: ProfileName,
  tier: ServiceTier,
  capabilities:
    | boolean
    | Readonly<{
        computerUse?: boolean;
        frontend?: boolean;
        security?: boolean;
        windowsGitBashExecutable?: string;
      }> = false,
): Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>> {
  const root = projectRootAgent(profile, tier);
  const desired: Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>> = {
    model: root.model,
    model_reasoning_effort: root.effort,
    service_tier: root.serviceTier,
    "agents.max_concurrent_threads_per_session": 21,
    web_search: "live",
    "sandbox_workspace_write.network_access": true,
    model_verbosity: "low",
    developer_instructions: rootDeveloperInstructions({
      ...(typeof capabilities === "boolean" ? { computerUse: capabilities } : capabilities),
      rootModel: root.model,
    }),
    suppress_unstable_features_warning: true,
    "features.default_mode_request_user_input": true,
    "features.multi_agent": true,
    "features.agent_message_board": false,
    "features.multi_agent_v2": false,
    "features.context_management": true,
  };
  for (const agentType of NATIVE_AGENT_TYPES) {
    desired[`agents."${agentType}".config_file`] = `holycodex/agents/${agentType}.toml`;
  }
  return desired;
}

async function assertPostPluginConfigStable(
  live: TomlDocument,
  preflight: TomlDocument,
  current: ManagedRuntimeConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
): Promise<void> {
  const drifted: ManagedConfigKeyPath[] = [];
  for (const rawKeyPath of Object.keys(desired)) {
    const keyPath = rawKeyPath as ManagedConfigKeyPath;
    const existing = current.managed[keyPath];
    if (existing !== undefined) {
      const comparison = await compareManagedConfigKey(live, current, keyPath);
      if (comparison.status === "drifted") drifted.push(keyPath);
      continue;
    }
    const before = readTomlPath(preflight, keyPath);
    const after = readTomlPath(live, keyPath);
    const beforeJson = asJsonValue(before === undefined ? null : before);
    const afterJson = asJsonValue(after === undefined ? null : after);
    if (canonicalJson(beforeJson) !== canonicalJson(afterJson)) drifted.push(keyPath);
  }
  if (drifted.length > 0) {
    throw new InstallerError(
      "state_corrupt",
      "Codex settings changed during native plugin setup.",
      undefined,
      {
        keys: drifted.join(","),
      },
    );
  }
}

async function migrateKnownLegacyRoleRegistrations(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
  previous: InstallRecord | undefined,
): Promise<Readonly<{ document: TomlDocument; state: ManagedRuntimeConfigState }>> {
  const legacyKeys = [
    "agents.explorer.config_file",
    "agents.librarian.config_file",
    "agents.worker.config_file",
    "agents.reviewer.config_file",
  ] as const;
  const legacyManaged = Object.fromEntries(
    legacyKeys.flatMap((keyPath) => {
      const entry = state.managed[keyPath];
      return entry === undefined ? [] : [[keyPath, entry] as const];
    }),
  );
  let output = document;
  let migratedState = state;
  if (Object.keys(legacyManaged).length > 0) {
    const cleanup = await cleanupManagedRuntimeConfig(
      document,
      { ...state, managed: legacyManaged },
      { schema: state.schema, installId: state.installId },
    );
    if (cleanup.preservedKeys.length > 0 || cleanup.unresolvedKeys.length > 0) {
      throw new InstallerError(
        "state_corrupt",
        "Legacy HolyCodex agent registrations changed and cannot be migrated safely.",
        undefined,
        { keys: [...new Set([...cleanup.preservedKeys, ...cleanup.unresolvedKeys])].join(",") },
      );
    }
    output = cleanup.document;
    migratedState = {
      ...state,
      managed: Object.fromEntries(
        Object.entries(state.managed).filter(
          ([keyPath]) => !legacyKeys.includes(keyPath as (typeof legacyKeys)[number]),
        ),
      ),
    };
  }
  if (!previous) return { document: output, state: migratedState };
  const legacyArtifacts = previous.managed_artifacts.map((artifact) => artifact.path);
  for (const role of ["explorer", "librarian", "worker", "reviewer"] as const) {
    const hasLegacyRoleArtifact = legacyArtifacts.some(
      (path) =>
        path.startsWith(`agents/${role[0]?.toUpperCase()}${role.slice(1)}.`) ||
        path === `holycodex/agents/${role}.toml`,
    );
    if (!hasLegacyRoleArtifact) continue;
    const keyPath = `agents.${role}.config_file` as const;
    const value = readTomlPath(output, keyPath);
    if (typeof value !== "string") continue;
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (normalized === `agents/${role}.toml` || normalized === `holycodex/agents/${role}.toml`) {
      output = deleteTomlPath(output, keyPath);
    }
  }
  return { document: output, state: migratedState };
}

/** Remove the former auto-compaction override while preserving any user drift. */
async function migrateLegacyAutoCompactConfig(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
): Promise<Readonly<{ document: TomlDocument; state: ManagedRuntimeConfigState }>> {
  const entry = state.managed[LEGACY_AUTO_COMPACT_KEY];
  if (entry === undefined) return { document, state };
  const cleanup = await cleanupManagedRuntimeConfig(
    document,
    { ...state, managed: { [LEGACY_AUTO_COMPACT_KEY]: entry } },
    { schema: state.schema, installId: state.installId },
  );
  const managed = Object.fromEntries(
    Object.entries(state.managed).filter(([keyPath]) => keyPath !== LEGACY_AUTO_COMPACT_KEY),
  );
  return { document: cleanup.document, state: { ...state, managed } };
}

/** Migrate the pre-0.17 nested context-management key when ownership is recorded. */
async function migrateLegacyContextManagement(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
): Promise<Readonly<{ document: TomlDocument; state: ManagedRuntimeConfigState }>> {
  const legacyKey = "features.context_management.experimental_mode" as const;
  const currentKey = "features.context_management" as const;
  const entry = state.managed[legacyKey];
  if (entry === undefined) return { document, state };
  const oldValue = readTomlPath(document, legacyKey);
  const contextContainer = readTomlPath(document, currentKey);
  const currentValue = isTomlTable(contextContainer) ? undefined : contextContainer;
  if (
    isTomlTable(contextContainer) &&
    Object.keys(contextContainer).some((key) => key !== "experimental_mode")
  ) {
    throw new InstallerError(
      "state_corrupt",
      "The legacy context-management table contains unrelated settings and cannot be migrated without changing user configuration.",
      undefined,
      { key: currentKey, recovery: "Move unrelated settings, then retry the upgrade." },
    );
  }
  if (oldValue !== undefined) {
    const liveSummary = await summarizeManagedConfigValue(legacyKey, oldValue);
    if (JSON.stringify(liveSummary) !== JSON.stringify(entry.lastManagedValue)) {
      throw new InstallerError(
        "state_corrupt",
        "The legacy context-management setting changed and cannot be migrated safely.",
        undefined,
        { key: legacyKey },
      );
    }
    if (currentValue !== undefined && JSON.stringify(currentValue) !== JSON.stringify(oldValue)) {
      throw new InstallerError(
        "state_corrupt",
        "Both legacy and canonical context-management settings are present with different values.",
        undefined,
        { keys: `${legacyKey},${currentKey}` },
      );
    }
  }
  if (oldValue === undefined && currentValue !== undefined) {
    const canonicalSummary = await summarizeManagedConfigValue(currentKey, currentValue);
    if (JSON.stringify(canonicalSummary) !== JSON.stringify(entry.lastManagedValue)) {
      throw new InstallerError(
        "state_corrupt",
        "The canonical context-management setting changed and cannot be migrated safely.",
        undefined,
        { key: currentKey },
      );
    }
  }
  if (oldValue === undefined && currentValue === undefined) {
    throw new InstallerError(
      "state_corrupt",
      "The owned legacy context-management setting is missing and cannot be migrated safely.",
      undefined,
      { key: legacyKey },
    );
  }
  let output = document;
  if (oldValue !== undefined) {
    output = deleteTomlPath(output, legacyKey);
    if (currentValue === undefined) output = writeTomlPath(output, currentKey, oldValue);
  }
  const canonicalValue = readTomlPath(output, currentKey);
  if (canonicalValue === undefined)
    throw new InstallerError(
      "state_corrupt",
      "The canonical context-management setting is missing.",
    );
  const managed = { ...state.managed };
  managed[currentKey] = {
    ...entry,
    keyPath: currentKey,
    lastManagedValue: await summarizeManagedConfigValue(currentKey, canonicalValue),
  };
  delete managed[legacyKey];
  return { document: output, state: { ...state, managed } };
}

function rejectPreExistingDeveloperInstructions(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
): void {
  if (
    readTomlPath(document, "developer_instructions") !== undefined &&
    state.managed["developer_instructions"] === undefined
  ) {
    throw new InstallerError(
      "state_corrupt",
      "Existing developer_instructions cannot be displaced safely; remove it or converge managed state first.",
    );
  }
}

async function snapshotPlugins(
  manager: Required<Pick<OfficialPluginManager, "list">>,
  selected: readonly string[],
): Promise<readonly PluginSnapshot[]> {
  const live = await manager.list();
  return selected.map((pluginId) => {
    const entry = findPlugin(live, pluginId);
    const status =
      entry === undefined
        ? "missing"
        : entry.installed && entry.enabled
          ? "installed"
          : entry.installed
            ? "disabled"
            : "available";
    return { plugin_id: pluginId, status } satisfies PluginSnapshot;
  });
}

async function writeTransaction(path: string, value: unknown): Promise<void> {
  if (decodeSchema(InstallTransactionSchema, value) === undefined) {
    throw new InstallerError("state_corrupt", "The HolyCodex transaction state is invalid.");
  }
  await writeAtomicJson(path, asJsonValue(value));
}

async function removeTransaction(path: string): Promise<void> {
  await rm(path, { force: false }).catch((error: unknown) => {
    if (!isFsCode(error, "ENOENT")) throw error;
  });
}

async function rollbackConfigTransaction(
  path: string,
  transaction: PreparingTransaction,
  baseline: TomlDocument,
  ownedPlugins: ReadonlySet<string>,
): Promise<void> {
  const currentText = await optionalTextFile(path);
  if (currentText === undefined) return;
  let document = parseConfig(currentText);
  const managed: Record<string, ManagedRuntimeConfigState["managed"][string]> = {};
  let unsupportedConfigRestored = 0;
  for (const [keyPath, entry] of Object.entries(transaction.managed_config.managed)) {
    const managedKeyPath = keyPath as ManagedConfigKeyPath;
    const before = readTomlPath(baseline, managedKeyPath);
    const beforeSummary =
      before === undefined ? undefined : await summarizeManagedConfigValue(managedKeyPath, before);
    if (JSON.stringify(beforeSummary ?? null) === JSON.stringify(entry.lastManagedValue)) {
      continue;
    }
    if (before !== undefined && beforeSummary?.kind === "digest") {
      const live = readTomlPath(document, managedKeyPath);
      if (
        live !== undefined &&
        JSON.stringify(await summarizeManagedConfigValue(managedKeyPath, live)) ===
          JSON.stringify(entry.lastManagedValue)
      ) {
        document = writeTomlPath(document, managedKeyPath, before);
        unsupportedConfigRestored += 1;
      }
      continue;
    }
    managed[keyPath] = {
      ...entry,
      originalValue: beforeSummary ?? { kind: "absent" },
    };
  }
  const managedCleanup = await cleanupManagedRuntimeConfig(
    document,
    { ...transaction.managed_config, managed },
    { schema: STATE_SCHEMA_EPOCH, installId: transaction.install_id },
  );
  document = managedCleanup.document;
  const pluginCleanup =
    transaction.plugin_config === undefined
      ? undefined
      : await cleanupHolyCodexPluginConfig(document, transaction.plugin_config, {
          allowBeforeState: true,
        });
  if (pluginCleanup !== undefined) document = pluginCleanup.document;
  const providerCleanup =
    transaction.provider_config === undefined
      ? undefined
      : await cleanupProviderPluginConfig(document, transaction.provider_config, ownedPlugins, {
          allowBeforeState: true,
        });
  if (providerCleanup !== undefined) document = providerCleanup.document;
  if (transaction.plugin_config !== undefined) {
    for (const [name, parent, key] of [
      ["preference", "plugins", HOLYCODEX_PLUGIN_CONFIG_KEY],
      ["marketplace", "marketplaces", HOLYCODEX_MARKETPLACE_CONFIG_KEY],
    ] as const) {
      const restoration = await restoreUnsupportedPluginConfigEntry(
        document,
        baseline,
        parent,
        key,
        transaction.plugin_config.before[name],
        transaction.plugin_config.after[name],
      );
      document = restoration.document;
      if (restoration.restored) unsupportedConfigRestored += 1;
    }
  }
  if (transaction.provider_config !== undefined) {
    for (const snapshot of transaction.provider_config) {
      if (!ownedPlugins.has(snapshot.plugin_id)) continue;
      const restoration = await restoreUnsupportedPluginConfigEntry(
        document,
        baseline,
        "plugins",
        snapshot.plugin_id,
        snapshot.before,
        snapshot.after,
      );
      document = restoration.document;
      if (restoration.restored) unsupportedConfigRestored += 1;
    }
  }
  const changed =
    managedCleanup.restoredKeys.length > 0 ||
    (pluginCleanup !== undefined &&
      (pluginCleanup.restored.length > 0 || pluginCleanup.removed.length > 0)) ||
    (providerCleanup !== undefined &&
      (providerCleanup.restored.length > 0 || providerCleanup.removed.length > 0)) ||
    unsupportedConfigRestored > 0;
  if (!changed) return;
  await writeAtomicText(path, serializeConfig(document));
}

/** Verify effective Root configuration and every canonical native specialist profile. */
export async function verifyEffectiveInstall(
  paths: ResolvedInstallerPaths,
  profile: ProfileName,
  tier: ServiceTier,
  capabilities: Readonly<{
    computerUse: boolean;
    frontend: boolean;
    security: boolean;
    windowsGitBashExecutable?: string;
  }>,
  state: ManagedRuntimeConfigState,
  preservedArtifacts: readonly string[] = [],
  expectedConfig: Readonly<
    Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>
  > = desiredRootConfig(profile, tier, capabilities),
): Promise<void> {
  const text = await optionalTextFile(paths.configFile);
  const document = parseConfig(text);
  const expected = expectedConfig;
  for (const [keyPath, expectedValue] of Object.entries(expected)) {
    const actual = readTomlPath(document, keyPath);
    if (keyPath === "developer_instructions") {
      if (
        typeof actual !== "string" ||
        actual !== expectedValue ||
        (await summarizeConfigValue(keyPath, actual)) !==
          state.managed[keyPath]?.lastManagedValue.value
      ) {
        throw new InstallerError(
          "install_failed",
          "The effective Root instructions did not converge.",
        );
      }
    } else if (actual !== expectedValue) {
      throw new InstallerError(
        "install_failed",
        `The effective Codex setting ${keyPath} did not converge.`,
      );
    }
  }
  const projected = projectNativeAgents(profile, tier);
  for (const agent of projected) {
    const keyPath = `agents."${agent.name}".config_file` as const;
    const ref = readTomlPath(document, keyPath);
    if (typeof ref !== "string") {
      throw new InstallerError("install_failed", `The ${agent.name} registration is missing.`);
    }
    const rolePath = join(paths.roleRoot, `${agent.name}.toml`);
    const expectedPath = rolePath.replaceAll("\\", "/");
    const resolved = resolveAgentConfigPath(paths.configFile, ref).replaceAll("\\", "/");
    if (resolved !== expectedPath) {
      throw new InstallerError("install_failed", `The ${agent.name} registration is stale.`);
    }
    const roleText = await optionalTextFile(rolePath);
    if (roleText === undefined)
      throw new InstallerError("install_failed", `The ${agent.name} role file is missing.`);
    if (preservedArtifacts.includes(rolePath)) continue;
    const roleDoc = parseConfig(roleText);
    if (
      roleDoc["name"] !== agent.name ||
      typeof roleDoc["description"] !== "string" ||
      typeof roleDoc["model"] !== "string" ||
      typeof roleDoc["model_reasoning_effort"] !== "string" ||
      typeof roleDoc["service_tier"] !== "string" ||
      typeof roleDoc["developer_instructions"] !== "string" ||
      !nativeAgentSandboxConfigurationMatches(agent, roleDoc) ||
      roleDoc["approval_policy"] !== "never" ||
      roleDoc["web_search"] !== (agent.permissions.network ? "live" : "disabled") ||
      roleDoc["tool_output_token_limit"] !== undefined ||
      readTomlPath(roleDoc, "agents.enabled") !== false ||
      readTomlPath(roleDoc, "features.agent_message_board") !== false ||
      readTomlPath(roleDoc, "features.multi_agent_v2") !== false ||
      readTomlPath(roleDoc, "features.multi_agent") !== false ||
      readTomlPath(roleDoc, "features.context_management") !== true ||
      readTomlPath(roleDoc, "features.computer_use") !== false ||
      readTomlPath(roleDoc, "features.browser_use") !== false ||
      readTomlPath(roleDoc, "features.in_app_browser") !== false
    ) {
      throw new InstallerError("install_failed", `The ${agent.name} role file is malformed.`);
    }
  }
  const legacyRoot = await optionalTextFile(`${paths.codexHome}/agents/root.toml`);
  if (legacyRoot !== undefined && isKnownLegacyRootRoleContent(legacyRoot)) {
    throw new InstallerError("install_failed", "A stale HolyCodex Root role remains installed.");
  }
}

async function summarizeConfigValue(keyPath: string, value: string): Promise<string> {
  return await domainSeparatedSha256("holycodex-managed-config-value", [
    canonicalJsonUtf8({ keyPath, value: value }),
  ]);
}

function mergeExplicitOptionalSelections(
  previous: ExplicitOptionalSelections | undefined,
  requested: ExplicitOptionalSelections | undefined,
): ExplicitOptionalSelections {
  const merged: Record<string, boolean> = {};
  for (const name of ["computer_use", "frontend", "security"] as const) {
    const value = requested?.[name] ?? previous?.[name];
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

function optionalCapabilityForPlugin(pluginId: string): OptionalCapabilityName | undefined {
  return (["computer_use", "frontend", "security"] as const).find((name) =>
    CAPABILITY_REGISTRY[name].pluginIds.includes(pluginId),
  );
}

function additionalPluginsFromPrevious(
  previous: Pick<InstallRecord, "official_plugins" | "optional_selections"> | undefined,
): readonly string[] {
  return (previous?.official_plugins ?? []).filter((pluginId) => {
    if (isLegacyWorkPlugin(pluginId)) return false;
    const capability = optionalCapabilityForPlugin(pluginId);
    return capability === undefined || previous?.optional_selections[capability] !== true;
  });
}

function isLegacyWorkPlugin(pluginId: string): boolean {
  const name = pluginId.slice(0, pluginId.lastIndexOf("@"));
  return LEGACY_WORK_PLUGIN_NAMES.has(name);
}

async function installAndVerify(
  manager: Required<Pick<OfficialPluginManager, "list" | "add">>,
  ids: readonly string[],
  refreshIds: ReadonlySet<string> = new Set(),
  onMutation?: (id: string, mutation: "new" | "uncertain") => void | Promise<void>,
): Promise<void> {
  for (const id of ids) {
    const refresh = refreshIds.has(id);
    let before;
    try {
      before = findPlugin(await manager.list(), id);
    } catch (error: unknown) {
      throw wrapPluginManagerError("list", error, id);
    }
    if (before?.installed && !before.enabled) {
      throw new PluginVerificationError("uncertain", `${id} is disabled`);
    }
    const addAttempted = refresh || !(before?.installed && before.enabled);
    if (addAttempted) {
      try {
        await manager.add(id);
      } catch (error: unknown) {
        try {
          const afterFailure = findPlugin(await manager.list(), id);
          if (refresh || !samePluginState(before, afterFailure))
            await onMutation?.(id, "uncertain");
        } catch {
          await onMutation?.(id, "uncertain");
        }
        throw wrapPluginManagerError("add", error, id);
      }
    }
    let after;
    try {
      after = findPlugin(await manager.list(), id);
    } catch (error: unknown) {
      if (addAttempted) await onMutation?.(id, "uncertain");
      throw wrapPluginManagerError("list", error, id);
    }
    if (!after?.installed) {
      if (addAttempted && (refresh || !samePluginState(before, after))) {
        await onMutation?.(id, "uncertain");
      }
      throw new PluginVerificationError("missing", `${id} is not installed after add`);
    }
    if (addAttempted && after.enabled) await onMutation?.(id, refresh ? "uncertain" : "new");
    if (!after.enabled) {
      if (addAttempted) await onMutation?.(id, refresh ? "uncertain" : "new");
      throw new PluginVerificationError("uncertain", `${id} is disabled after add`);
    }
  }
}

async function removeAndVerify(
  manager: Required<Pick<OfficialPluginManager, "list" | "remove">>,
  ids: readonly string[],
  onMutation?: (id: string, mutation: "absent" | "removed" | "uncertain") => void | Promise<void>,
): Promise<void> {
  for (const id of ids) {
    let before;
    try {
      before = findPlugin(await manager.list(), id);
    } catch (error: unknown) {
      await onMutation?.(id, "uncertain");
      throw wrapPluginManagerError("list", error, id);
    }
    if (!(before?.installed ?? false)) {
      await onMutation?.(id, "absent");
      continue;
    }
    try {
      await manager.remove(id);
    } catch (error: unknown) {
      try {
        const afterFailure = findPlugin(await manager.list(), id);
        if (!(afterFailure?.installed ?? false)) {
          await onMutation?.(id, "removed");
        } else {
          await onMutation?.(id, "uncertain");
        }
      } catch {
        await onMutation?.(id, "uncertain");
      }
      throw wrapPluginManagerError("remove", error, id);
    }
    let after;
    try {
      after = findPlugin(await manager.list(), id);
    } catch (error: unknown) {
      await onMutation?.(id, "uncertain");
      throw wrapPluginManagerError("list", error, id);
    }
    if (after?.installed) {
      await onMutation?.(id, "uncertain");
      throw new PluginVerificationError("uncertain", `${id} is still installed after remove`);
    }
    await onMutation?.(id, "removed");
  }
}

async function restoreRemovedPlugin(
  manager: Required<Pick<OfficialPluginManager, "list" | "add">>,
  id: string,
  priorStatus: PluginSnapshot["status"] | undefined,
): Promise<void> {
  if (priorStatus !== "installed" && priorStatus !== "disabled") {
    throw new PluginVerificationError("uncertain", `${id} has no proven prior installed state`);
  }
  const expectedEnabled = priorStatus === "installed";
  let before;
  try {
    before = findPlugin(await manager.list(), id);
  } catch (error: unknown) {
    throw wrapPluginManagerError("list", error, id);
  }
  if (before?.installed && before.enabled === expectedEnabled) return;
  try {
    await manager.add(id);
  } catch (error: unknown) {
    throw wrapPluginManagerError("add", error, id);
  }
  let after;
  try {
    after = findPlugin(await manager.list(), id);
  } catch (error: unknown) {
    throw wrapPluginManagerError("list", error, id);
  }
  if (!after?.installed) {
    throw new PluginVerificationError("missing", `${id} is not installed after restore`);
  }
  if (after.enabled !== expectedEnabled) {
    throw new PluginVerificationError(
      "uncertain",
      `${id} did not regain its prior ${expectedEnabled ? "enabled" : "disabled"} state`,
    );
  }
}

function samePluginState(
  left: ReturnType<typeof findPlugin>,
  right: ReturnType<typeof findPlugin>,
): boolean {
  return (
    left?.pluginId === right?.pluginId &&
    left?.installed === right?.installed &&
    left?.enabled === right?.enabled &&
    left?.marketplaceName === right?.marketplaceName
  );
}

function wrapPluginManagerError(
  operation: "list" | "add" | "remove",
  error: unknown,
  pluginId: string,
): OfficialPluginManagerError {
  if (error instanceof OfficialPluginManagerError) return error;
  return new OfficialPluginManagerError(
    operation === "list" ? "list_failed" : operation === "remove" ? "remove_failed" : "add_failed",
    operation === "list"
      ? `Codex could not read the status of ${pluginId}.`
      : operation === "remove"
        ? `Codex could not remove ${pluginId}.`
        : `Codex could not add ${pluginId}.`,
    error,
    { plugin_id: pluginId },
  );
}

class PluginVerificationError extends Error {
  readonly status: "missing" | "uncertain";

  constructor(status: "missing" | "uncertain", message: string) {
    super(message);
    this.name = "PluginVerificationError";
    this.status = status;
  }
}

function findPlugin(
  live: Awaited<ReturnType<NonNullable<OfficialPluginManager["list"]>>>,
  id: string,
) {
  const resolved = resolveOfficialPluginEntry(live, id);
  if (resolved !== undefined) return resolved.entry;
  const canonical = canonicalOfficialPluginId(id);
  return [...live.installed, ...live.available].find(
    (entry) => entry.pluginId === id && (canonical === undefined || entry.marketplaceName == null),
  );
}

function chooseProfile(
  requested: ProfileName | undefined,
  previous: ProfileName | undefined,
): ProfileName {
  const value = requested ?? previous ?? "default";
  if (!lookupProfile(value).ok) throw new InstallerError("install_failed", "Unknown profile.");
  return value;
}

function chooseTier(
  requested: ServiceTier | undefined,
  previous: ServiceTier | undefined,
): ServiceTier {
  const value = requested ?? previous ?? "standard";
  if (decodeSchema(ServiceTierSchema, value) === undefined) {
    throw new InstallerError("install_failed", "The tier is not supported.");
  }
  return value;
}

function chooseOptional(
  requested: ExplicitOptionalSelections | undefined,
  previous: OptionalSelections | undefined,
): OptionalSelections {
  const fallback = previous ? toCoreSelections(previous) : DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS;
  const selected = resolveOptionalCapabilitySelections(requested, fallback);
  return {
    computer_use: selected.computer_use,
    frontend: selected.frontend,
    security: selected.security,
    coding: true,
  };
}

function capabilityStateFor(
  selections: OptionalSelections,
  failures: ReadonlyMap<OptionalCapabilityName, "missing" | "uncertain"> = new Map(),
): CapabilityStateRecord {
  const names = ["computer_use", "frontend", "security"] as const;
  return Object.fromEntries(
    names.map((name) => {
      const selected = selections[name];
      const value: CapabilityInstallState = {
        selected,
        status: selected ? (failures.get(name) ?? "healthy") : "disabled",
        plugin_ids: [...CAPABILITY_REGISTRY[name].pluginIds],
      };
      return [name, value];
    }),
  ) as CapabilityStateRecord;
}

type InstallRecordDigestInput = {
  readonly owner: "holycodex";
  readonly install_id: string;
  readonly version: ReleaseVersion;
  readonly profile?: ProfileName | LegacyProfileName;
  /** Legacy persisted product field; never emitted for current records. */
  readonly plan?: ProfileName | LegacyProfileName;
  readonly tier: ServiceTier;
  readonly optional_selections: OptionalSelections &
    Readonly<{ readonly work?: boolean | undefined }>;
  readonly explicit_optional_selections: ExplicitOptionalSelections &
    Readonly<{ readonly work?: boolean | undefined }>;
  readonly official_plugins: readonly string[];
  readonly capability_state:
    | (CapabilityStateRecord & Readonly<{ readonly work?: CapabilityInstallState | undefined }>)
    | null;
  readonly managed_artifacts: readonly { readonly path: string; readonly digest: string }[];
  readonly managed_config?: ManagedRuntimeConfigState | undefined;
  readonly plugin_config?: PluginConfigSnapshot | undefined;
  readonly provider_config?: readonly ProviderPluginConfigSnapshot[] | undefined;
  readonly plugin_snapshot?: readonly PluginSnapshot[] | undefined;
  readonly owned_plugins?: readonly string[] | undefined;
  readonly tooling?: InstallRecord["tooling"] | undefined;
};

/** Compute the domain-separated digest that authenticates an install ownership record. */
export async function installRecordDigest(value: InstallRecordDigestInput): Promise<string> {
  const { profile, plan, ...rest } = value;
  const payload = plan === undefined ? { ...rest, profile } : { ...rest, plan };
  return await domainSeparatedSha256("install-record", [canonicalJsonUtf8(asJsonValue(payload))]);
}

/** Check whether an install record still matches its authenticated digest. */
export async function recordDigestMatches(record: InstallRecord): Promise<boolean> {
  return await recordDigestMatchesRaw(record);
}

async function recordDigestMatchesRaw(record: {
  readonly owner: "holycodex";
  readonly install_id: string;
  readonly version: ReleaseVersion;
  readonly profile?: ProfileName | LegacyProfileName;
  readonly plan?: ProfileName | LegacyProfileName;
  readonly tier: ServiceTier;
  readonly optional_selections: OptionalSelections &
    Readonly<{ readonly work?: boolean | undefined }>;
  readonly explicit_optional_selections: ExplicitOptionalSelections &
    Readonly<{ readonly work?: boolean | undefined }>;
  readonly official_plugins?: readonly string[] | undefined;
  readonly capability_state?:
    | (CapabilityStateRecord & Readonly<{ readonly work?: CapabilityInstallState | undefined }>)
    | undefined;
  readonly managed_artifacts: readonly { readonly path: string; readonly digest: string }[];
  readonly managed_config?: ManagedRuntimeConfigState | undefined;
  readonly plugin_config?: PluginConfigSnapshot | undefined;
  readonly provider_config?: readonly ProviderPluginConfigSnapshot[] | undefined;
  readonly plugin_snapshot?: readonly PluginSnapshot[] | undefined;
  readonly owned_plugins?: readonly string[] | undefined;
  readonly tooling?: InstallRecord["tooling"] | undefined;
  readonly digest: string;
}): Promise<boolean> {
  const digest = await installRecordDigest({
    owner: record.owner,
    install_id: record.install_id,
    version: record.version,
    ...(record.profile === undefined ? {} : { profile: record.profile }),
    ...(record.plan === undefined ? {} : { plan: record.plan }),
    tier: record.tier,
    optional_selections: record.optional_selections,
    explicit_optional_selections: record.explicit_optional_selections,
    official_plugins: record.official_plugins ?? [],
    capability_state: record.capability_state ?? null,
    managed_artifacts: record.managed_artifacts,
    ...(record.managed_config === undefined ? {} : { managed_config: record.managed_config }),
    ...(record.plugin_config === undefined ? {} : { plugin_config: record.plugin_config }),
    ...(record.provider_config === undefined ? {} : { provider_config: record.provider_config }),
    ...(record.plugin_snapshot === undefined ? {} : { plugin_snapshot: record.plugin_snapshot }),
    ...(record.owned_plugins === undefined ? {} : { owned_plugins: record.owned_plugins }),
    ...(record.tooling === undefined ? {} : { tooling: record.tooling }),
  });
  return digest === record.digest;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}

function installReviewTools(
  gitBash: GitBashState,
  context7Ready: boolean,
  live: Awaited<ReturnType<NonNullable<OfficialPluginManager["list"]>>>,
  providerPlugins: readonly string[],
): InstallReview["tools"] {
  const tools: InstallReview["tools"][number][] = [
    {
      name: "git-bash",
      status: gitBash.status,
      ...(gitBash.status === "healthy"
        ? { detail: gitBash.path }
        : gitBash.status === "missing"
          ? { detail: "Git is required for Bash; install with: winget install Git.Git" }
          : {}),
    },
    {
      name: "context7",
      status: context7Ready ? "ready" : "unavailable",
    },
  ];
  for (const pluginId of providerPlugins) {
    const entry = findPlugin(live, pluginId);
    const status =
      entry === undefined
        ? "missing"
        : entry.installed
          ? entry.enabled
            ? "installed"
            : "disabled"
          : "available";
    tools.push({
      name: `official-plugin:${pluginId}`,
      status,
      ...(typeof entry?.version === "string" ? { detail: entry.version } : {}),
    });
  }
  return tools;
}

function structureConflict(conflict: ManagedConflict): ManagedConflict {
  const category = conflict.category ?? (conflict.key === undefined ? "role-asset" : "config-key");
  const target = conflict.target ?? conflict.key ?? conflict.path;
  const identity =
    conflict.identity ?? `${category}:${conflict.path}:${conflict.key ?? ""}:${conflict.action}`;
  return {
    ...conflict,
    identity,
    category,
    target,
    defaultDecision: conflict.defaultDecision ?? "replace",
    validDecisions: conflict.validDecisions ?? ["keep", "replace", "cancel"],
    explanation:
      conflict.explanation ??
      (conflict.action === "remove"
        ? `HolyCodex can remove the managed ${target} after reviewing this change.`
        : `HolyCodex can replace the managed ${target} after reviewing this change.`),
  };
}

async function resolveOwnedConflictInventory(
  options: InstallerOptions,
  conflicts: readonly ManagedConflict[],
  preserveDeclined = false,
): Promise<{
  readonly accepted: readonly ManagedConflict[];
  readonly decisions: ReadonlyMap<string, ConflictDecision>;
}> {
  const structured = conflicts.map(structureConflict);
  const decisions = new Map<string, ConflictDecision>();
  if (structured.length === 0) return { accepted: [], decisions };
  if (options.resolveConflicts !== undefined) {
    const selected = await options.resolveConflicts(structured);
    for (const conflict of structured) {
      const identity = conflict.identity!;
      const decision = selected[identity];
      if (decision !== "keep" && decision !== "replace" && decision !== "cancel") {
        throw new InstallerError(
          "confirmation_required",
          "Every managed conflict must have a valid decision before installation.",
          undefined,
          { identity },
        );
      }
      if (decision === "cancel") {
        throw new InstallerError(
          "confirmation_required",
          "Conflict resolution was cancelled.",
          undefined,
          {
            identity,
          },
        );
      }
      decisions.set(identity, decision);
    }
    return {
      accepted: structured.filter((conflict) => decisions.get(conflict.identity!) === "replace"),
      decisions,
    };
  }
  const accepted: ManagedConflict[] = [];
  for (const conflict of structured) {
    const resolution = await options.resolveConflict?.(conflict);
    if (resolution === "accept") {
      accepted.push(conflict);
      decisions.set(conflict.identity!, "replace");
      continue;
    }
    if (resolution === "decline" && preserveDeclined) {
      decisions.set(conflict.identity!, "keep");
      continue;
    }
    throw new InstallerError(
      "confirmation_required",
      resolution === "cancel"
        ? "Conflict resolution was cancelled."
        : "HolyCodex-owned changes require confirmation before replacement.",
      undefined,
      {
        path: conflict.path,
        ...(conflict.key === undefined ? {} : { key: conflict.key }),
        action: conflict.action,
        resolution: resolution ?? "unavailable",
      },
    );
  }
  return { accepted, decisions };
}

function reportProgress(options: InstallerOptions, event: InstallProgressEvent): void {
  try {
    options.onProgress?.(event);
  } catch {
    // Progress rendering is observational and must never change install semantics.
  }
}

/** Structured failure raised while installing or upgrading HolyCodex. */
export class InstallerError extends Error {
  readonly code:
    | "install_failed"
    | "capability_denied"
    | "permission_denied"
    | "state_corrupt"
    | "confirmation_required"
    | "not_installed"
    | "upgrade_failed"
    | "upgrade_downgrade";
  readonly causeValue: unknown;
  readonly details: JsonObject;

  constructor(
    code: InstallerError["code"],
    message: string,
    causeValue?: unknown,
    details: JsonObject = {},
  ) {
    super(message, causeValue === undefined ? undefined : { cause: causeValue });
    this.name = "InstallerError";
    this.code = code;
    this.causeValue = causeValue;
    this.details = details;
  }
}
