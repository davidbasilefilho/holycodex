// SPDX-License-Identifier: Apache-2.0

import { lstat, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  isManagedRuntimeConfigState,
  deleteTomlPath,
  LEGACY_ROOT_CONFIG_KEY_PATHS,
  mergeManagedRuntimeConfig,
  isCanonicalHolyCodexMarketplaceGitSource,
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
  DEFAULT_CAPABILITY_SELECTIONS,
  NATIVE_AGENT_TYPES,
  STATE_SCHEMA_EPOCH,
  canonicalBaseVersion,
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
  nativeAgentConfigPath,
  nativeAgentGenerationId,
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
  PersistedInstallOptionsMigrationSchema,
  PersistedInstallOptionsSchema,
  InstallRequestSchema,
  InstallTransactionSchema,
  InstallTransactionMigrationSchema,
  ConflictDecisionSchema,
  JsonObjectSchema,
} from "./schema.ts";
import { optionalJsonFile, optionalTextFile, writeAtomicJson, writeAtomicText } from "./storage.ts";
import { parseToml, stringifyToml } from "./toml.ts";
import { createInstallerRuntime, ensureContext7, removeOwnedContext7 } from "./tooling.ts";
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

/** Public CLI value for holycodex marketplace. */
export const HOLYCODEX_MARKETPLACE = "davidbasilefilho/holycodex";
/** Public CLI value for holycodex plugin. */
export const HOLYCODEX_PLUGIN = "holycodex@holycodex";
/** Codex Desktop owns Browser Use provisioning and lifecycle. */
export const CODEX_DESKTOP_BROWSER_PLUGIN_ID = "browser@openai-bundled";
// Records through the boundary release used Astra for every Root profile.
const ROOT_ROUTE_MIGRATION_BOUNDARY = "0.16.8" as const;
const migratedActiveDigests = new WeakMap<InstallRecord, string>();

/** Public data contract for install request used by CLI operations. */
export interface InstallRequest {
  /** The profile in install request. */
  readonly profile?: ProfileName | undefined;
  /** The tier in install request. */
  readonly tier?: ServiceTier | undefined;
  /** The optional in install request. */
  readonly optional?: ExplicitOptionalSelections | undefined;
  /** The official plugins in install request. */
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
  const options = parsed as InstallOptions;
  rejectCodexDesktopBrowserRequest(options);
  return options;
}

function rejectCodexDesktopBrowserRequest(request: InstallRequest): void {
  if (request.officialPlugins?.includes(CODEX_DESKTOP_BROWSER_PLUGIN_ID) !== true) return;
  throw new InstallerError(
    "install_failed",
    "Browser Use is provided by Codex Desktop/runtime and cannot be installed by the HolyCodex CLI. Select the Browser Use capability instead; it is available only on supporting Codex surfaces.",
    undefined,
    { plugin_id: CODEX_DESKTOP_BROWSER_PLUGIN_ID },
  );
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
  if (parsed !== undefined) return parsed as PersistedInstallOptions;
  const legacy = decodeSchema(PersistedInstallOptionsMigrationSchema, document);
  if (legacy !== undefined) {
    return {
      schema_version: 1,
      profile: legacy.profile,
      tier: legacy.tier,
      capabilities: legacy.capabilities
        .filter(
          (name): name is OptionalCapabilityName =>
            name === "browser_use" || name === "computer_use" || name === "sites",
        )
        .concat(
          ...(["browser_use", "sites"] as const).filter(
            (name) => !legacy.capabilities.includes(name),
          ),
        ),
      additional_plugins: legacy.additional_plugins,
    };
  }
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
      browser_use: value.capabilities.includes("browser_use"),
      computer_use: value.capabilities.includes("computer_use"),
      sites: value.capabilities.includes("sites"),
    },
    officialPlugins: value.additional_plugins.filter(
      (pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID,
    ),
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
  const capabilities = (["browser_use", "computer_use", "sites"] as const).filter(
    (name) => optional[name],
  );
  return {
    schema_version: 1,
    profile,
    tier,
    capabilities,
    additional_plugins: [...new Set(additionalPlugins)].filter(
      (pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID,
    ),
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
  const validatedRequest = decodeSchema(InstallRequestSchema, request);
  if (validatedRequest === undefined) {
    throw new InstallerError("install_failed", "The installation options are invalid.");
  }
  rejectCodexDesktopBrowserRequest(validatedRequest as InstallRequest);
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
  const preparing = await readInstallTransaction(paths.preparingRecord, previous);
  const conflicted = await readInstallTransaction(paths.conflictedRecord, previous);
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
          browser_use:
            request.optional?.browser_use ??
            persistedRequest?.optional?.browser_use ??
            interrupted.optional_selections.browser_use,
          computer_use:
            request.optional?.computer_use ??
            persistedRequest?.optional?.computer_use ??
            interrupted.optional_selections.computer_use,
          sites:
            request.optional?.sites ??
            persistedRequest?.optional?.sites ??
            interrupted.optional_selections.sites,
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
  const context7PreflightReady = await ensureContext7(
    runtime,
    false,
    previous?.tooling?.context7,
  ).then(
    () => true,
    () => false,
  );
  let context7: Context7ToolState | undefined;
  let context7Warning: string | undefined;
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
  const installId = previous?.install_id ?? crypto.randomUUID().replaceAll("-", "");
  const version = await readInstallationVersion();
  const refreshPluginIds =
    previous !== undefined &&
    previous.version !== version &&
    previous.owned_plugins?.includes(HOLYCODEX_PLUGIN) === true
      ? new Set([HOLYCODEX_PLUGIN])
      : new Set<string>();
  const previousOwnedPlugins = new Set(
    (previous?.owned_plugins ?? []).filter(
      (pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID,
    ),
  );
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
  const desiredConfig = desiredRootConfig(profile, tier, {
    browserUse: optional.browser_use,
    computerUse: optional.computer_use,
    frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
    security: DEFAULT_CAPABILITY_SELECTIONS.security,
  });
  const configBefore = await optionalTextFile(paths.configFile);
  let parsedConfigDocument: TomlDocument;
  try {
    parsedConfigDocument = parseConfig(configBefore, paths.configFile);
  } catch (error: unknown) {
    if (error instanceof InstallerError && error.code === "state_corrupt") {
      await showUnrepairableConfigConflict(options, error, paths.configFile);
    }
    throw error;
  }
  const preflightManagedConfigState =
    previous?.managed_config ??
    createManagedRuntimeConfigState({ schema: STATE_SCHEMA_EPOCH, installId });
  const preflightContext = await migrateLegacyContextManagement(
    parsedConfigDocument,
    preflightManagedConfigState,
  );
  const preflightInvalidConfig = await resolveInvalidConfigTables(
    options,
    paths.configFile,
    preflightContext.document,
    ['plugins."holycodex@holycodex"', "marketplaces.holycodex", ...Object.keys(desiredConfig)],
  );
  let configInputDocument = preflightInvalidConfig.document;
  const preflightInvalidConfigConflicts = preflightInvalidConfig.conflicts;
  const preflightInvalidConfigDecisions = preflightInvalidConfig.decisions;
  let reviewedInvalidConfigDocument =
    preflightInvalidConfigConflicts.length === 0
      ? parsedConfigDocument
      : applyInvalidConfigConflictDecisions(
          parsedConfigDocument,
          preflightInvalidConfigConflicts,
          preflightInvalidConfigDecisions,
        );
  let temporaryPreflightConfig: string | undefined;
  if (preflightInvalidConfigConflicts.length > 0) {
    const currentConfig = await optionalTextFile(paths.configFile);
    if (currentConfig !== configBefore) {
      throw new InstallerError(
        "confirmation_required",
        "Codex configuration changed after the invalid-table review; review the latest configuration and retry.",
        undefined,
        { path: paths.configFile },
      );
    }
    temporaryPreflightConfig = serializeConfig(reviewedInvalidConfigDocument);
    await writeAtomicText(paths.configFile, temporaryPreflightConfig);
  }

  let preflightLive: Awaited<ReturnType<NonNullable<OfficialPluginManager["list"]>>>;
  let marketplaceRepairedDuringPreflight = false;
  let preflightMarketplaceConflict: ManagedConflict | undefined;
  let preflightMarketplaceDecisions: ReadonlyMap<string, ConflictDecision> = new Map();
  try {
    preflightLive = await manager.list();
  } catch (error: unknown) {
    if (temporaryPreflightConfig !== undefined) {
      await restoreTemporaryPreflightConfig(
        paths.configFile,
        configBefore,
        temporaryPreflightConfig,
      );
      temporaryPreflightConfig = undefined;
    }
    if (!isIncompleteHolyCodexMarketplaceError(error)) {
      throw new InstallerError(
        "capability_denied",
        "Native Codex plugin state could not be read safely.",
        error,
      );
    }
    if ((await optionalTextFile(paths.configFile)) !== configBefore) {
      throw new InstallerError(
        "confirmation_required",
        "Codex configuration changed before the required marketplace repair; review the current marketplace source and retry.",
        error,
        { path: paths.configFile, key: "marketplaces.holycodex" },
      );
    }
    const configuredMarketplace = readTomlPath(configInputDocument, "marketplaces.holycodex");
    const reviewedMarketplaceContainerRemoval = preflightInvalidConfigConflicts.some(
      (conflict) =>
        conflict.key === "marketplaces" &&
        preflightInvalidConfigDecisions.get(conflict.identity!) === "remove",
    );
    if (configuredMarketplace === undefined && !reviewedMarketplaceContainerRemoval) {
      throw new InstallerError(
        "confirmation_required",
        "Codex reported an incomplete marketplace named holycodex, but config.toml does not contain a reviewable marketplace source. Review the source before retrying; no automatic replacement was attempted.",
        error,
        { path: paths.configFile, key: "marketplaces.holycodex" },
      );
    }
    if (
      configuredMarketplace !== undefined &&
      !hasCanonicalHolyCodexMarketplaceSource(configuredMarketplace)
    ) {
      preflightMarketplaceConflict = structureConflict({
        path: paths.configFile,
        key: "marketplaces.holycodex",
        action: "replace",
        category: "config-key",
        target: "marketplaces.holycodex",
        existing: configuredMarketplace,
        desired: { source_type: "git", source: HOLYCODEX_MARKETPLACE_URL },
        explanation:
          "The existing HolyCodex marketplace source must be reviewed before rebuilding its incomplete cache from the required canonical source.",
        defaultDecision: "replace",
        validDecisions: ["replace", "cancel"],
      });
      const resolution = await resolveOwnedConflictInventory(
        options,
        [preflightMarketplaceConflict],
        true,
      );
      preflightMarketplaceDecisions = resolution.decisions;
    }
    const configuredMarketplaceIsCanonicalUrl =
      isTomlTable(configuredMarketplace) &&
      Object.keys(configuredMarketplace).length === 2 &&
      configuredMarketplace["source_type"] === "git" &&
      configuredMarketplace["source"] === HOLYCODEX_MARKETPLACE_URL;
    if (!configuredMarketplaceIsCanonicalUrl) {
      if ((await optionalTextFile(paths.configFile)) !== configBefore) {
        throw new InstallerError(
          "confirmation_required",
          "Codex configuration changed before marketplace repair; review the current source and retry.",
          error,
          { path: paths.configFile, key: "marketplaces.holycodex" },
        );
      }
      const replacementDocument = writePluginConfigEntry(
        configInputDocument,
        "marketplaces",
        HOLYCODEX_MARKETPLACE_CONFIG_KEY,
        { source_type: "git", source: HOLYCODEX_MARKETPLACE_URL },
      );
      temporaryPreflightConfig = serializeConfig(replacementDocument);
      await writeAtomicText(paths.configFile, temporaryPreflightConfig);
    }
    if (manager.addMarketplace === undefined) {
      throw new InstallerError(
        "capability_denied",
        "Native Codex plugin state could not be read safely.",
        error,
      );
    }
    try {
      await manager.addMarketplace(HOLYCODEX_MARKETPLACE);
      preflightLive = await manager.list();
      marketplaceRepairedDuringPreflight = true;
    } catch (repairError: unknown) {
      if (temporaryPreflightConfig !== undefined) {
        try {
          await restoreTemporaryPreflightConfig(
            paths.configFile,
            configBefore,
            temporaryPreflightConfig,
          );
          temporaryPreflightConfig = undefined;
        } catch (restoreError: unknown) {
          throw new InstallerError(
            "confirmation_required",
            "The marketplace repair failed and the reviewed temporary Codex configuration could not be restored safely; review config.toml before retrying.",
            restoreError,
            { path: paths.configFile, key: "marketplaces.holycodex" },
          );
        }
      }
      throw new InstallerError(
        "capability_denied",
        "The required HolyCodex marketplace could not be repaired before plugin validation.",
        repairError,
      );
    }
  }
  if (temporaryPreflightConfig !== undefined) {
    await restoreTemporaryPreflightConfig(paths.configFile, configBefore, temporaryPreflightConfig);
    temporaryPreflightConfig = undefined;
  }
  const unresolvedOfficialProviderPlugins = providerPlugins.filter((pluginId) => {
    if (!pluginId.endsWith("@openai-curated")) return false;
    const entry = findPlugin(preflightLive, pluginId);
    return !(entry?.installed && entry.enabled);
  });
  reportProgress(options, {
    stage: "validation",
    status: "completed",
    message: "Codex target validated",
  });

  const currentHolyCodexPluginConfig = await snapshotHolyCodexPluginConfig(configInputDocument);
  const initialPluginConfigBefore = previous?.plugin_config?.before ?? currentHolyCodexPluginConfig;
  let pluginConfigBefore = initialPluginConfigBefore;
  const useBatchConflictResolution = options.resolveConflicts !== undefined;
  const pendingConflicts: ManagedConflict[] = [];
  let pluginConfigConflicts: readonly ManagedConflict[] = [];
  let providerConfigConflicts: readonly ManagedConflict[] = [];
  {
    const conflicts = (["preference", "marketplace"] as const).filter((name) => {
      const current = currentHolyCodexPluginConfig[name].digest;
      const snapshot = currentHolyCodexPluginConfig[name];
      const expected =
        name === "preference"
          ? { kind: "boolean" as const, value: true }
          : {
              kind: "marketplace" as const,
              source_type: "git" as const,
              source: HOLYCODEX_MARKETPLACE_URL,
            };
      const preexistingMismatch =
        snapshot.presence === "present" &&
        JSON.stringify(snapshot.safe_value) !== JSON.stringify(expected);
      const changedSincePrevious =
        previous?.plugin_config !== undefined &&
        current !== previous.plugin_config.after[name].digest &&
        current !== previous.plugin_config.before[name].digest;
      return preexistingMismatch || changedSincePrevious;
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
        explanation: `The existing ${key} entry does not match the HolyCodex plugin configuration.`,
        validDecisions: ["replace", "cancel"] as const,
        defaultDecision: "replace" as const,
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
  ].filter(
    (pluginId) => pluginId !== HOLYCODEX_PLUGIN && pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID,
  );
  const currentProviderConfig = await snapshotProviderPluginConfig(
    configInputDocument,
    providerConfigPluginIds,
  );
  {
    const previousOwned = new Set(previous?.owned_plugins ?? []);
    const conflicts = currentProviderConfig.filter((current) => {
      const prior = previous?.provider_config?.find(
        (candidate) => candidate.plugin_id === current.plugin_id,
      );
      const changedSincePrevious =
        previousOwned.has(current.plugin_id) &&
        prior !== undefined &&
        current.before.digest !== prior.after.digest &&
        current.before.digest !== prior.before.digest;
      const selectedMismatch =
        providerPlugins.includes(current.plugin_id) &&
        current.before.presence === "present" &&
        current.before.safe_value?.value !== true;
      return changedSincePrevious || selectedMismatch;
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
        explanation: `The existing provider plugin entry ${entry.plugin_id} does not match the selected plugin configuration.`,
        ...(providerPlugins.includes(entry.plugin_id)
          ? { validDecisions: ["replace", "cancel"] as const, defaultDecision: "replace" as const }
          : {}),
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
  const unmanagedConfigState = preflightContext.state;
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
  let previousDesiredConfig:
    | Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>
    | undefined;
  if (previous !== undefined) {
    previousDesiredConfig = desiredRootConfig(previous.profile, previous.tier, {
      browserUse: previous.optional_selections.browser_use,
      computerUse: previous.optional_selections.computer_use,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
      security: DEFAULT_CAPABILITY_SELECTIONS.security,
    });
    const previousBaseVersion = canonicalBaseVersion(previous.version.split("-", 1)[0]!);
    for (const agentType of NATIVE_AGENT_TYPES) {
      const previousArtifact = previous.managed_artifacts.find(({ path }) =>
        path.endsWith(`/${agentType}.toml`),
      );
      previousDesiredConfig[`agents."${agentType}".config_file`] =
        previousArtifact?.path ?? `holycodex/agents/${agentType}.toml`;
    }
    if (compareReleaseVersions(previousBaseVersion, ROOT_ROUTE_MIGRATION_BOUNDARY) <= 0) {
      // Interpret the prior managed values using the route contract active at installation.
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
  const initialUserConfigConflicts: readonly ManagedConflict[] = Object.entries(
    desiredConfig,
  ).flatMap(([rawKey, desiredValue]) => {
    const key = rawKey as ManagedConfigKeyPath;
    if (currentManagedConfig.managed[key] !== undefined) return [];
    const existing = readTomlPath(configDocument, key);
    if (existing === undefined || JSON.stringify(existing) === JSON.stringify(desiredValue)) {
      return [];
    }
    return [
      structureConflict({
        path: paths.configFile,
        key,
        action: "replace",
        category: "config-key",
        target: key,
        existing,
        desired: desiredValue,
        explanation: `The existing Codex setting ${key} is user-owned and differs from the HolyCodex install value.`,
        defaultDecision: "replace",
        validDecisions: ["keep", "replace", "cancel"],
      }),
    ];
  });
  if (useBatchConflictResolution) pendingConflicts.push(...initialUserConfigConflicts);
  if (useBatchConflictResolution) pendingConflicts.push(...managedConfigConflicts);
  let nativeConflicts: readonly ManagedConflict[];
  try {
    nativeConflicts = await inspectNativeAgentConflicts(
      paths.codexHome,
      profile,
      previous?.managed_artifacts,
      tier,
      { browserUse: optional.browser_use, computerUse: optional.computer_use },
    );
  } catch (error: unknown) {
    throw new InstallerError("install_failed", safeMessage(error), error);
  }
  if (useBatchConflictResolution) pendingConflicts.push(...nativeConflicts.map(structureConflict));
  const allConflicts = [
    ...preflightInvalidConfigConflicts,
    ...pluginConfigConflicts,
    ...providerConfigConflicts,
    ...initialUserConfigConflicts,
    ...managedConfigConflicts,
    ...nativeConflicts.map(structureConflict),
  ];
  const initiallyMergedManaged = { ...mergedConfig.state.managed };
  const preResolvedIdentities = new Set([
    ...preflightInvalidConfigConflicts.map((conflict) => conflict.identity!),
    ...(preflightMarketplaceConflict === undefined ? [] : [preflightMarketplaceConflict.identity!]),
  ]);
  const initialReviewConflicts = (
    useBatchConflictResolution ? pendingConflicts : allConflicts
  ).filter((conflict) => !preResolvedIdentities.has(conflict.identity!));
  const initialResolution = await resolveOwnedConflictInventory(
    options,
    initialReviewConflicts,
    true,
  );
  let resolvedConflicts: Awaited<ReturnType<typeof resolveOwnedConflictInventory>> = {
    ...initialResolution,
    decisions: new Map([
      ...preflightInvalidConfigDecisions,
      ...preflightMarketplaceDecisions,
      ...initialResolution.decisions,
    ]),
  };
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
    let acceptedDocument = applyInvalidConfigConflictDecisions(
      acceptedPluginConfig.document,
      preflightInvalidConfigConflicts,
      resolvedConflicts.decisions,
    );
    pluginConfigBefore = acceptedPluginConfig.pluginConfigBefore;
    providerConfigBefore = acceptedPluginConfig.providerConfigBefore;
    const acceptedManaged = { ...currentManagedConfig.managed };
    const effectiveDesiredConfig: Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>> = {
      ...desiredConfigWithPersistedManagedValues,
    };
    for (const conflict of [...initialUserConfigConflicts, ...managedConfigConflicts]) {
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
      if (desiredValue === undefined) {
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
        if (existing !== undefined) {
          acceptedManaged[configKey] = {
            ...existing,
            lastManagedValue: await summarizeManagedConfigValue(configKey, desiredValue),
          };
        } else {
          const preflightEntry = initiallyMergedManaged[configKey];
          if (preflightEntry !== undefined) acceptedManaged[configKey] = preflightEntry;
        }
      } else {
        delete effectiveDesiredConfig[configKey];
        if (existing === undefined) continue;
        if (live === undefined) {
          delete acceptedManaged[configKey];
          continue;
        }
        const keptEntry = {
          ...existing,
          lastManagedValue: await summarizeManagedConfigValue(configKey, live),
        };
        const candidateState = {
          ...currentManagedConfig,
          managed: { ...acceptedManaged, [configKey]: keptEntry },
        };
        if (isManagedRuntimeConfigState(candidateState)) acceptedManaged[configKey] = keptEntry;
        else delete acceptedManaged[configKey];
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
    const stabilityManaged = { ...currentManagedConfig.managed };
    for (const conflict of [...initialUserConfigConflicts, ...managedConfigConflicts]) {
      const key = conflict.key as ManagedConfigKeyPath | undefined;
      if (key === undefined) continue;
      delete stabilityManaged[key];
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
      ["config-key", "invalid-config", "native-plugin", "role-asset"].flatMap((category) => {
        const count = conflicts.filter((conflict) => conflict.category === category).length;
        return count === 0 ? [] : [[category, count] as const];
      }),
    );
  let reviewConflicts = projectReviewConflicts();
  let reviewConflictCounts = projectReviewConflictCounts(reviewConflicts);
  const reviewTools = installReviewTools(context7PreflightReady, preflightLive, providerPlugins);
  if (options.reviewInstall !== undefined) {
    while (true) {
      const review = await options.reviewInstall({
        operation: previous === undefined ? "install" : "upgrade",
        ...(previous === undefined ? {} : { fromVersion: previous.version }),
        toVersion: version,
        profile,
        tier,
        capabilities: {
          browser_use: optional.browser_use,
          computer_use: optional.computer_use,
          sites: optional.sites,
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
        resolvedConflicts = await resolveOwnedConflictInventory(options, allConflicts, true);
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
    ...(previous?.tooling?.context7 === undefined
      ? {}
      : { tooling: { context7: previous.tooling.context7 } }),
  };
  await ensureOwnedDirectory(paths.stateRoot);
  await writeTransaction(paths.preparingRecord, preMutationTransaction);

  let pluginSnapshot: readonly PluginSnapshot[] = [];

  let native: NativeAgentInstallResult | undefined;
  let configPublished = false;
  let invalidConfigApplied = false;
  const addedPlugins = new Set<string>();
  const removedPlugins = new Set<string>();
  const uncertainPluginRemovals = new Set<string>();
  const ownedPlugins = new Set(previousOwnedPlugins);
  const rollbackOwnedPlugins = new Set([...previousOwnedPlugins, ...providerPlugins]);
  const uncertainPluginMutations = new Set<string>();
  let transactionForRecovery: PreparingTransaction = preMutationTransaction;
  let pluginEffectsStarted = false;
  let configBeforeMutationDocument: TomlDocument | undefined;
  let initialConfigIdentity: Readonly<{ dev: number; ino: number }> | undefined;
  let publishedConfigState = mergedConfig.state;
  let activeRecordWriteStarted = false;
  let installOptionsWriteStarted = false;
  try {
    if (preflightInvalidConfigConflicts.length > 0) {
      const configAtMutation = await optionalTextFile(paths.configFile);
      reviewedInvalidConfigDocument = applyInvalidConfigConflictDecisions(
        parseConfig(configAtMutation, paths.configFile),
        preflightInvalidConfigConflicts,
        preflightInvalidConfigDecisions,
      );
      if ((await optionalTextFile(paths.configFile)) !== configAtMutation) {
        throw new InstallerError(
          "confirmation_required",
          "Codex configuration changed during conflict resolution; review the latest configuration and retry.",
          undefined,
          { path: paths.configFile },
        );
      }
      await writeAtomicText(paths.configFile, serializeConfig(reviewedInvalidConfigDocument));
      invalidConfigApplied = true;
    }
    try {
      context7 = await ensureContext7(runtime, true, previous?.tooling?.context7);
    } catch (error: unknown) {
      context7Warning = `Optional ctx7 is unavailable: ${safeMessage(error)}`;
    }
    const recordedContext7 = context7 ?? previous?.tooling?.context7;
    const tooling = recordedContext7 === undefined ? undefined : { context7: recordedContext7 };
    let transaction: PreparingTransaction = {
      ...preMutationTransaction,
      ...(tooling === undefined ? {} : { tooling }),
    };
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
    let configTextBeforePluginSetup = await optionalTextFile(paths.configFile);
    const parsedLiveConfigBeforeMutation = parseConfig(
      configTextBeforePluginSetup,
      paths.configFile,
    );
    const liveConfigBeforeMutation = applyInvalidConfigConflictDecisions(
      parsedLiveConfigBeforeMutation,
      preflightInvalidConfigConflicts,
      resolvedConflicts.decisions,
    );
    await assertPreflightPluginConfigStable(
      liveConfigBeforeMutation,
      currentHolyCodexPluginConfig,
      currentProviderConfig,
    );
    const configBeforeMutationRuntime = await migrateKnownLegacyRoleRegistrations(
      liveConfigBeforeMutation,
      preflightManagedConfigState,
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
      nativeConflicts.length === 0 ? options.resolveConflict : undefined,
      reviewedNativeConflicts,
      { browserUse: optional.browser_use, computerUse: optional.computer_use },
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
        currentProviderConfig.find((candidate) => candidate.plugin_id === entry.plugin_id)
          ?.before ?? entry.before,
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
    if (configBefore === undefined) {
      try {
        initialConfigIdentity = await createEmptyCodexConfig(paths.configFile);
        const configNow = await optionalTextFile(paths.configFile);
        if (initialConfigIdentity === undefined || configNow !== "") {
          throw new InstallerError(
            "confirmation_required",
            "Codex config.toml appeared during installation; review the latest configuration and retry.",
            undefined,
            { operation: "initialize Codex configuration", path: paths.configFile },
          );
        }
        configTextBeforePluginSetup = "";
      } catch (error: unknown) {
        if (error instanceof InstallerError) throw error;
        throw new InstallerError(
          "permission_denied",
          "Codex config.toml could not be initialized before plugin setup.",
          error,
          {
            operation: "initialize Codex configuration",
            path: paths.configFile,
            recovery: "Check CODEX_HOME permissions, then retry.",
          },
        );
      }
    }
    if ((await optionalTextFile(paths.configFile)) !== configTextBeforePluginSetup) {
      throw new InstallerError(
        "confirmation_required",
        "Codex configuration changed during plugin setup; review the latest configuration and retry.",
        undefined,
        { path: paths.configFile },
      );
    }
    await writeAtomicText(paths.configFile, serializeConfig(pluginRecoveryTargetDocument));
    configPublished = true;
    if (!marketplaceRepairedDuringPreflight) {
      await manager.addMarketplace!(HOLYCODEX_MARKETPLACE);
    }
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
    const parsedPostPluginDocument = parseConfig(configAfterPlugins, paths.configFile);
    const postPluginDocument = applyInvalidConfigConflictDecisions(
      parsedPostPluginDocument,
      preflightInvalidConfigConflicts,
      resolvedConflicts.decisions,
    );
    const postPluginRuntime = await migrateKnownLegacyRoleRegistrations(
      postPluginDocument,
      preflightManagedConfigState,
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
    const providerRollbackConfig = currentProviderConfigAfter.map((entry) => ({
      plugin_id: entry.plugin_id,
      before:
        currentProviderConfig.find((candidate) => candidate.plugin_id === entry.plugin_id)
          ?.before ?? entry.before,
      after: entry.before,
    }));
    transactionForRecovery = {
      ...transactionForRecovery,
      plugin_config: {
        plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
        before: pluginConfigBefore,
        after: pluginConfigAfter,
      },
      provider_config: providerRollbackConfig,
    };
    const configConflictKeys = new Set(
      [...initialUserConfigConflicts, ...managedConfigConflicts].flatMap((conflict) =>
        conflict.key === undefined ? [] : [conflict.key],
      ),
    );
    const postPluginBaselineManaged: Record<string, ManagedRuntimeConfigState["managed"][string]> =
      { ...resolvedManagedConfig };
    for (const conflict of [...initialUserConfigConflicts, ...managedConfigConflicts]) {
      const key = conflict.key;
      if (key === undefined) continue;
      const entry = mergedConfig.state.managed[key as ManagedConfigKeyPath];
      if (entry !== undefined) postPluginBaselineManaged[key] = entry;
    }
    for (const [rawKeyPath, entry] of Object.entries(postPluginBaselineManaged)) {
      if (configConflictKeys.has(rawKeyPath)) continue;
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
      ...mergedConfig.state,
      managed: postPluginBaselineManaged,
    };
    await assertPostPluginConfigStable(
      stablePostPluginDocument,
      configBeforeMutationDocument,
      { ...postPluginBaseline, managed: resolvedManagedConfig },
      resolvedDesiredConfig,
    );
    for (const conflict of [...initialUserConfigConflicts, ...managedConfigConflicts]) {
      const key = conflict.key as ManagedConfigKeyPath | undefined;
      if (key === undefined) continue;
      const decision = resolvedConflicts.decisions.get(conflict.identity!);
      const value = decision === "replace" ? desiredConfig[key] : readTomlPath(configDocument, key);
      if (value !== undefined)
        stablePostPluginDocument = writeTomlPath(stablePostPluginDocument, key, value);
    }
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
      provider_config: providerRollbackConfig,
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
    transactionForRecovery = { ...transactionForRecovery, step: "config_published" };
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
        browserUse: optional.browser_use,
        computerUse: optional.computer_use,
        frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
        security: DEFAULT_CAPABILITY_SELECTIONS.security,
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
      ...(tooling === undefined ? {} : { tooling }),
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
      ...(tooling === undefined ? {} : { tooling }),
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
      warnings: [
        ...(native.preserved.length === 0 ? [] : ["modified managed files were preserved"]),
        ...(context7Warning === undefined ? [] : [context7Warning]),
      ],
    };
  } catch (error: unknown) {
    const rollbackFailures: string[] = [];
    let rollbackConfigIdentity: Readonly<{ dev: number; ino: number }> | undefined;
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
          rollbackConfigIdentity = await rollbackConfigTransaction(
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
    if (invalidConfigApplied) {
      try {
        await restoreReviewedInvalidConfig(paths.configFile, preflightInvalidConfigConflicts);
      } catch {
        rollbackFailures.push("invalid_config");
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
    if (rollbackFailures.length === 0 && configBefore === undefined) {
      try {
        const current = await optionalTextFile(paths.configFile);
        if (
          current?.trim().length === 0 &&
          (await sameFileIdentity(
            paths.configFile,
            rollbackConfigIdentity ?? initialConfigIdentity,
          ))
        ) {
          await rm(paths.configFile, { force: false });
        }
      } catch {
        rollbackFailures.push("config_initialization");
      }
    }
    if (rollbackFailures.length > 0) {
      try {
        const recoveryDocument = parseConfig(
          await optionalTextFile(paths.configFile),
          paths.configFile,
        );
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
  const priorSelections = legacy.optional_selections as Readonly<{
    browser_use?: boolean;
    computer_use: boolean;
    sites?: boolean;
  }>;
  const priorExplicit = legacy.explicit_optional_selections as Readonly<{
    browser_use?: boolean;
    computer_use?: boolean;
    sites?: boolean;
  }>;
  const optionalSelections: OptionalSelections = {
    browser_use: priorSelections.browser_use ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
    computer_use: priorSelections.computer_use,
    sites: priorSelections.sites ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.sites,
    coding: true,
  };
  const explicitOptionalSelections: ExplicitOptionalSelections = {
    ...(priorExplicit.computer_use === undefined
      ? {}
      : { computer_use: priorExplicit.computer_use }),
    ...(priorExplicit.browser_use === undefined ? {} : { browser_use: priorExplicit.browser_use }),
    ...(priorExplicit.sites === undefined ? {} : { sites: priorExplicit.sites }),
  };
  const capabilityState =
    legacy.capability_state === undefined
      ? undefined
      : capabilityStateFor(
          optionalSelections,
          new Map<OptionalCapabilityName, "missing" | "uncertain">([
            ["browser_use", "missing"],
            ["sites", "missing"],
          ]),
        );
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
  migratedActiveDigests.set(migrated, legacy.digest);
  return migrated;
}

/** Read a transaction journal and migrate prior-schema selections before recovery examines it. */
export async function readInstallTransaction(
  path: string,
  active?: InstallRecord,
): Promise<
  | (Omit<InstallRecord, "status" | "step"> & {
      readonly status: "preparing" | "conflicted";
      readonly step: InstallTransactionStep;
    })
  | undefined
> {
  const raw = await optionalJsonFile(path, JsonObjectSchema);
  if (raw === undefined) return undefined;
  const current = decodeSchema(InstallTransactionSchema, raw) as
    | (Omit<InstallRecord, "status" | "step"> & {
        readonly status: "preparing" | "conflicted";
        readonly step: InstallTransactionStep;
      })
    | undefined;
  if (current !== undefined) return current;
  const legacy = decodeSchema(InstallTransactionMigrationSchema, raw);
  if (legacy === undefined) {
    throw new InstallerError(
      "state_corrupt",
      "The HolyCodex transaction state is invalid.",
      undefined,
      {
        path,
      },
    );
  }

  const value = legacy as unknown as Record<string, unknown>;
  const profileValue = value["profile"] ?? value["plan"];
  if (typeof profileValue !== "string") {
    throw new InstallerError(
      "state_corrupt",
      "The HolyCodex transaction has no profile.",
      undefined,
      {
        path,
      },
    );
  }
  let profile: ProfileName;
  try {
    profile = migrateProfileName(profileValue as LegacyProfileName);
  } catch (error: unknown) {
    throw new InstallerError(
      "state_corrupt",
      "The persisted transaction profile requires an explicit replacement.",
      error,
      { path, profile: profileValue },
    );
  }

  const selections = value["optional_selections"] as Readonly<Record<string, boolean | undefined>>;
  const explicit = value["explicit_optional_selections"] as Readonly<
    Record<string, boolean | undefined>
  >;
  const optionalSelections: OptionalSelections = {
    browser_use: selections["browser_use"] ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
    computer_use: selections["computer_use"] ?? false,
    sites: selections["sites"] ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.sites,
    coding: true,
  };
  const explicitOptionalSelections: ExplicitOptionalSelections = {
    ...(explicit["browser_use"] === undefined ? {} : { browser_use: explicit["browser_use"] }),
    ...(explicit["computer_use"] === undefined ? {} : { computer_use: explicit["computer_use"] }),
    ...(explicit["sites"] === undefined ? {} : { sites: explicit["sites"] }),
  };
  const priorCapabilityState = value["capability_state"];
  const capabilityState =
    priorCapabilityState === undefined
      ? undefined
      : capabilityStateFor(
          optionalSelections,
          new Map<OptionalCapabilityName, "missing" | "uncertain">([
            ["browser_use", "missing"],
            ["sites", "missing"],
          ]),
        );
  const {
    plan: _plan,
    profile: _profile,
    optional_selections: _selections,
    explicit_optional_selections: _explicit,
    capability_state: _capabilityState,
    ...base
  } = value;
  const priorDigest = typeof base["digest"] === "string" ? base["digest"] : undefined;
  const boundLegacyDigest = active === undefined ? undefined : migratedActiveDigests.get(active);
  const digest =
    active !== undefined &&
    base["install_id"] === active.install_id &&
    (priorDigest === active.digest ||
      (boundLegacyDigest !== undefined && priorDigest === boundLegacyDigest))
      ? active.digest
      : priorDigest;
  const migrated = {
    ...base,
    profile,
    optional_selections: optionalSelections,
    explicit_optional_selections: explicitOptionalSelections,
    ...(capabilityState === undefined ? {} : { capability_state: capabilityState }),
    ...(digest === undefined ? {} : { digest }),
  };
  const transaction = decodeSchema(InstallTransactionSchema, migrated) as
    | (Omit<InstallRecord, "status" | "step"> & {
        readonly status: "preparing" | "conflicted";
        readonly step: InstallTransactionStep;
      })
    | undefined;
  if (transaction === undefined) {
    throw new InstallerError(
      "state_corrupt",
      "The migrated transaction state is invalid.",
      undefined,
      {
        path,
      },
    );
  }
  return transaction;
}

export { removeManagedNativeAgents };

function toCoreSelections(value: OptionalSelections): OptionalCapabilitySelections {
  return {
    browser_use: value.browser_use,
    computer_use: value.computer_use,
    sites: value.sites,
  };
}

/** Parse Codex configuration text through the validated TOML document boundary. */
export function parseConfig(text: string | undefined, path = "config.toml"): TomlDocument {
  if (text === undefined || text.trim().length === 0) return {};
  try {
    const bun = (globalThis as { Bun?: { TOML?: { parse: (value: string) => unknown } } }).Bun;
    const parsed = bun?.TOML?.parse ? bun.TOML.parse(text) : parseToml(text);
    const document = decodeSchema(TomlDocumentSchema, parsed);
    if (document === undefined) {
      const key = findUnsupportedTomlPath(parsed);
      const target = key === undefined ? "an unsupported TOML value" : `the TOML value ${key}`;
      throw new InstallerError(
        "state_corrupt",
        `${path} contains ${target} that HolyCodex cannot preserve. Convert it to a string, number, boolean, table, or array, then retry.`,
        undefined,
        { path, ...(key === undefined ? {} : { key }), reason: "unsupported_toml_value" },
      );
    }
    return document;
  } catch (error: unknown) {
    if (error instanceof InstallerError) throw error;
    const parserMessage = safeMessage(error);
    const location = locateTomlParseFailure(text, parserMessage);
    const detail =
      location === undefined
        ? `${path} contains invalid TOML: ${parserMessage}. Fix the TOML syntax and retry; HolyCodex cannot safely rewrite malformed TOML.`
        : `${path} contains invalid TOML at line ${location.line}, column ${location.column} (offset ${location.offset}): ${parserMessage}. Fix the syntax at that location and retry; HolyCodex cannot safely rewrite malformed TOML.`;
    throw new InstallerError("state_corrupt", detail, error, {
      path,
      parser_message: parserMessage,
      ...(location === undefined ? {} : location),
      reason: "invalid_toml_syntax",
    });
  }
}

function findUnsupportedTomlPath(value: unknown, path: readonly string[] = []): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : formatTomlPath(path);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const unsupported = findUnsupportedTomlPath(entry, [...path, "[" + index + "]"]);
      if (unsupported !== undefined) return unsupported;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return formatTomlPath(path);
    for (const [key, entry] of Object.entries(value)) {
      const unsupported = findUnsupportedTomlPath(entry, [...path, key]);
      if (unsupported !== undefined) return unsupported;
    }
    return undefined;
  }
  return formatTomlPath(path);
}

function formatTomlPath(parts: readonly string[]): string {
  return parts.length === 0 ? "<root>" : parts.join(".");
}

function findInvalidConfigTables(
  document: TomlDocument,
  keyPaths: readonly string[],
): readonly Readonly<{ key: string; value: TomlValue }>[] {
  const issues = new Map<string, TomlValue>();
  for (const keyPath of keyPaths) {
    for (const parentPath of configPathParents(keyPath)) {
      const value = readTomlPath(document, parentPath);
      if (value !== undefined && !isTomlTable(value)) issues.set(parentPath, value);
    }
  }
  return [...issues].map(([key, value]) => ({ key, value }));
}

function configPathParents(keyPath: string): readonly string[] {
  const parents: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < keyPath.length; index += 1) {
    const character = keyPath[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ".") parents.push(keyPath.slice(0, index));
  }
  return parents;
}

function invalidConfigTableError(
  path: string,
  issue: Readonly<{ key: string; value: TomlValue }>,
): InstallerError {
  const existing = JSON.stringify(issue.value);
  return new InstallerError(
    "state_corrupt",
    `${path} has the non-table value ${existing} at ${issue.key}, but the HolyCodex installer needs that path to be a table. Remove it after review or convert it to a table and retry; replacing it automatically could discard user configuration.`,
    undefined,
    {
      path,
      key: issue.key,
      existing,
      reason: "expected_table",
    },
  );
}

async function resolveInvalidConfigTables(
  options: InstallerOptions,
  path: string,
  document: TomlDocument,
  keyPaths: readonly string[],
): Promise<{
  readonly document: TomlDocument;
  readonly conflicts: readonly ManagedConflict[];
  readonly decisions: ReadonlyMap<string, ConflictDecision>;
}> {
  const conflicts = findInvalidConfigTables(document, keyPaths).map((issue) => {
    const error = invalidConfigTableError(path, issue);
    return structureConflict({
      identity: `invalid-config:${path}:${issue.key}`,
      category: "invalid-config",
      target: issue.key,
      existing: issue.value,
      desired: `Remove the conflicting value at ${issue.key} so HolyCodex can create the required table.`,
      explanation: `${error.message} Choose remove to continue or cancel to repair it manually.`,
      path,
      key: issue.key,
      action: "remove",
      defaultDecision: "remove",
      validDecisions: ["remove", "cancel"],
    });
  });
  if (conflicts.length === 0) return { document, conflicts, decisions: new Map() };
  const resolution = await resolveOwnedConflictInventory(options, conflicts, true);
  return {
    document: applyInvalidConfigConflictDecisions(document, conflicts, resolution.decisions),
    conflicts,
    decisions: resolution.decisions,
  };
}

function applyInvalidConfigConflictDecisions(
  document: TomlDocument,
  conflicts: readonly ManagedConflict[],
  decisions: ReadonlyMap<string, ConflictDecision>,
): TomlDocument {
  let output = document;
  for (const conflict of conflicts) {
    const decision = decisions.get(conflict.identity!);
    if (decision !== "remove" || conflict.key === undefined) {
      throw new InstallerError(
        "confirmation_required",
        `Invalid configuration at ${conflict.target} can only be removed after review or cancelled.`,
        undefined,
        {
          path: conflict.path,
          ...(conflict.key === undefined ? {} : { key: conflict.key }),
          existing: JSON.stringify(conflict.existing),
          valid_decisions: conflict.validDecisions ?? ["remove", "cancel"],
        },
      );
    }
    const live = readTomlPath(output, conflict.key);
    if (live === undefined) continue;
    if (JSON.stringify(live) !== JSON.stringify(conflict.existing)) {
      throw new InstallerError(
        "confirmation_required",
        `Invalid configuration at ${conflict.key} changed after review; review the current value and retry.`,
        undefined,
        {
          path: conflict.path,
          key: conflict.key,
          reviewed: JSON.stringify(conflict.existing),
          current: JSON.stringify(live),
        },
      );
    }
    output = deleteTomlPath(output, conflict.key);
  }
  return output;
}

async function restoreTemporaryPreflightConfig(
  path: string,
  originalText: string | undefined,
  temporaryText: string,
): Promise<void> {
  if ((await optionalTextFile(path)) !== temporaryText) {
    throw new InstallerError(
      "confirmation_required",
      "Codex configuration changed during preflight validation; review the latest configuration and retry.",
      undefined,
      { path },
    );
  }
  if (originalText === undefined) {
    await rm(path, { force: false }).catch((error: unknown) => {
      if (!isFsCode(error, "ENOENT")) throw error;
    });
    return;
  }
  await writeAtomicText(path, originalText);
}

async function restoreReviewedInvalidConfig(
  path: string,
  conflicts: readonly ManagedConflict[],
): Promise<void> {
  const liveText = await optionalTextFile(path);
  const liveDocument = parseConfig(liveText, path);
  let restoredDocument = liveDocument;
  for (const conflict of conflicts) {
    if (conflict.key === undefined || conflict.existing === undefined) continue;
    const liveValue = readTomlPath(restoredDocument, conflict.key);
    if (liveValue !== undefined) {
      if (JSON.stringify(liveValue) === JSON.stringify(conflict.existing)) continue;
      const isEmptyTable =
        typeof liveValue === "object" &&
        liveValue !== null &&
        !Array.isArray(liveValue) &&
        Object.keys(liveValue).length === 0;
      if (!isEmptyTable) {
        throw new InstallerError(
          "confirmation_required",
          `Codex configuration at ${conflict.key} changed during rollback; preserve it and review the current value.`,
          undefined,
          { path, key: conflict.key },
        );
      }
      restoredDocument = deleteTomlPath(restoredDocument, conflict.key);
    }
    restoredDocument = writeTomlPath(
      restoredDocument,
      conflict.key,
      conflict.existing as TomlValue,
    );
  }
  if (restoredDocument === liveDocument) return;
  if ((await optionalTextFile(path)) !== liveText) {
    throw new InstallerError(
      "confirmation_required",
      "Codex configuration changed during rollback; preserve it and review the current value.",
      undefined,
      { path },
    );
  }
  await writeAtomicText(path, serializeConfig(restoredDocument));
}

function locateTomlParseFailure(
  source: string,
  message: string,
): Readonly<{ offset: number; line: number; column: number }> | undefined {
  let offset: number | undefined;
  const foundHex = /found \(0x([0-9a-f]{2})\)/iu.exec(message);
  const foundToken = /found '((?:\\.|[^'])*)'/u.exec(message);
  const foundCharacter =
    foundHex === null
      ? foundToken?.[1]?.replaceAll("\\'", "'").replaceAll('\\"', '"')
      : String.fromCharCode(Number.parseInt(foundHex[1]!, 16));
  if (foundCharacter !== undefined) {
    offset = findTomlTokenOutsideValue(source, foundCharacter);
  } else if (/end of file|unterminated/iu.test(message)) {
    offset = source.length;
  } else if (/missing value after/iu.test(message)) {
    const equals = source.lastIndexOf("=");
    const newline = equals < 0 ? -1 : source.indexOf("\n", equals + 1);
    offset = newline < 0 ? source.length : newline;
  }
  if (offset === undefined) return undefined;
  const line = source.slice(0, offset).split("\n").length;
  const previousNewline = source.lastIndexOf("\n", Math.max(0, offset - 1));
  return { offset, line, column: offset - previousNewline };
}

function findTomlTokenOutsideValue(source: string, token: string): number | undefined {
  let quote: string | undefined;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (source.startsWith(token, index)) return index;
    if (character === '"' || character === "'") quote = character;
  }
  return undefined;
}

async function showUnrepairableConfigConflict(
  options: InstallerOptions,
  error: InstallerError,
  path: string,
): Promise<void> {
  const key = typeof error.details["key"] === "string" ? error.details["key"] : undefined;
  const offset =
    typeof error.details["offset"] === "number" ? String(error.details["offset"]) : undefined;
  const conflict = structureConflict({
    identity: "invalid-config:" + path + ":" + (offset ?? key ?? "unsupported"),
    category: "invalid-config",
    target: key === undefined ? path + " syntax" : path + " value " + key,
    existing: error.details,
    desired: "Repair the TOML value before installing HolyCodex.",
    explanation: error.message,
    path,
    ...(key === undefined ? {} : { key }),
    action: "replace",
    defaultDecision: "cancel",
    validDecisions: ["cancel"],
  });
  try {
    await resolveOwnedConflictInventory(options, [conflict], true);
  } catch {
    // Invalid TOML has no safe automated repair; preserve the actionable parser failure.
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

/** Public data contract for plugin config cleanup result used by CLI operations. */
export interface PluginConfigCleanupResult {
  /** The document in plugin config cleanup result. */
  readonly document: TomlDocument;
  /** The restored in plugin config cleanup result. */
  readonly restored: readonly PluginConfigEntryName[];
  /** The removed in plugin config cleanup result. */
  readonly removed: readonly PluginConfigEntryName[];
  /** The preserved in plugin config cleanup result. */
  readonly preserved: readonly PluginConfigEntryName[];
}

/** Public data contract for provider plugin config cleanup result used by CLI operations. */
export interface ProviderPluginConfigCleanupResult {
  /** The document in provider plugin config cleanup result. */
  readonly document: TomlDocument;
  /** The restored in provider plugin config cleanup result. */
  readonly restored: readonly string[];
  /** The removed in provider plugin config cleanup result. */
  readonly removed: readonly string[];
  /** The preserved in provider plugin config cleanup result. */
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
  if (!isTomlTable(table) || !Object.hasOwn(table, key)) return undefined;
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
        browserUse?: boolean;
        computerUse?: boolean;
        frontend?: boolean;
        security?: boolean;
      }> = false,
): Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>> {
  const root = projectRootAgent(profile, tier);
  const rootOptions = typeof capabilities === "boolean" ? {} : capabilities;
  const nativeOptions = {
    browserUse: rootOptions.browserUse ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
    computerUse:
      typeof capabilities === "boolean"
        ? capabilities
        : (rootOptions.computerUse ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.computer_use),
  };
  const generationId = nativeAgentGenerationId(profile, tier, nativeOptions);
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
    "features.multi_agent": true,
    "features.default_mode_request_user_input": true,
    "features.multi_agent_v2": false,
    "features.agent_message_board": false,
    "features.context_management.experimental_mode": true,
  };
  for (const agentType of NATIVE_AGENT_TYPES) {
    desired[`agents."${agentType}".config_file`] = nativeAgentConfigPath(agentType, generationId);
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

/** Remove obsolete managed Codex settings while preserving user-edited values. */
async function migrateLegacyContextManagement(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
): Promise<Readonly<{ document: TomlDocument; state: ManagedRuntimeConfigState }>> {
  const legacy = Object.fromEntries(
    Object.entries(state.managed).filter(([key]) =>
      (LEGACY_ROOT_CONFIG_KEY_PATHS as readonly string[]).includes(key),
    ),
  );
  if (Object.keys(legacy).length === 0) return { document, state };
  const cleanup = await cleanupManagedRuntimeConfig(
    document,
    { ...state, managed: legacy },
    { schema: state.schema, installId: state.installId },
  );
  const managed = Object.fromEntries(
    Object.entries(state.managed).filter(([key]) => !(key in legacy)),
  );
  return { document: cleanup.document, state: { ...state, managed } };
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
): Promise<Readonly<{ dev: number; ino: number }> | undefined> {
  const currentText = await optionalTextFile(path);
  if (currentText === undefined) return;
  let document = parseConfig(currentText, path);
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
  if (!changed) return undefined;
  await writeAtomicText(path, serializeConfig(document));
  const restored = await lstat(path);
  return restored.isFile() && !restored.isSymbolicLink()
    ? { dev: restored.dev, ino: restored.ino }
    : undefined;
}

/** Verify effective Root configuration and every canonical native specialist profile. */
export async function verifyEffectiveInstall(
  paths: ResolvedInstallerPaths,
  profile: ProfileName,
  tier: ServiceTier,
  capabilities: Readonly<{
    browserUse?: boolean;
    computerUse: boolean;
    frontend: boolean;
    security: boolean;
  }>,
  state: ManagedRuntimeConfigState,
  preservedArtifacts: readonly string[] = [],
  expectedConfig: Readonly<
    Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>
  > = desiredRootConfig(profile, tier, capabilities),
): Promise<void> {
  const text = await optionalTextFile(paths.configFile);
  const document = parseConfig(text, paths.configFile);
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
  const nativeOptions = {
    browserUse: capabilities.browserUse ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
    computerUse: capabilities.computerUse,
  };
  const generationId = nativeAgentGenerationId(profile, tier, nativeOptions);
  const projected = projectNativeAgents(profile, tier);
  for (const agent of projected) {
    const keyPath = `agents."${agent.name}".config_file` as const;
    const ref = readTomlPath(document, keyPath);
    if (typeof ref !== "string") {
      throw new InstallerError("install_failed", `The ${agent.name} registration is missing.`);
    }
    const expectedReference = nativeAgentConfigPath(agent.name, generationId);
    const rolePath = resolveAgentConfigPath(paths.configFile, expectedReference);
    const expectedPath = rolePath.replaceAll("\\", "/");
    const resolved = resolveAgentConfigPath(paths.configFile, ref).replaceAll("\\", "/");
    if (resolved !== expectedPath) {
      throw new InstallerError(
        "install_failed",
        `The ${agent.name} registration is stale (expected ${expectedReference}; received ${ref}).`,
      );
    }
    const roleText = await optionalTextFile(rolePath);
    if (roleText === undefined)
      throw new InstallerError("install_failed", `The ${agent.name} role file is missing.`);
    if (
      preservedArtifacts.some(
        (preservedPath) => preservedPath.replaceAll("\\", "/") === expectedPath,
      )
    ) {
      throw new InstallerError(
        "install_failed",
        `The ${agent.name} role file was kept after a conflict and cannot be activated.`,
      );
    }
    const roleDoc = parseConfig(roleText, rolePath);
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
      readTomlPath(roleDoc, "features.multi_agent") !== false ||
      readTomlPath(roleDoc, "features.multi_agent_v2") !== false ||
      readTomlPath(roleDoc, "features.agent_message_board") !== false ||
      readTomlPath(roleDoc, "features.context_management.experimental_mode") !== true ||
      Object.keys((roleDoc["features"] as Record<string, unknown> | undefined) ?? {}).some(
        (key) =>
          !["multi_agent", "multi_agent_v2", "agent_message_board", "context_management"].includes(
            key,
          ),
      )
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
  for (const name of ["browser_use", "computer_use", "sites"] as const) {
    const value = requested?.[name] ?? previous?.[name];
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

function optionalCapabilityForPlugin(pluginId: string): OptionalCapabilityName | undefined {
  return (["browser_use", "computer_use", "sites"] as const).find((name) =>
    CAPABILITY_REGISTRY[name].pluginIds.includes(pluginId),
  );
}

function additionalPluginsFromPrevious(
  previous: Pick<InstallRecord, "official_plugins" | "optional_selections"> | undefined,
): readonly string[] {
  return (previous?.official_plugins ?? []).filter((pluginId) => {
    if (pluginId === CODEX_DESKTOP_BROWSER_PLUGIN_ID) return false;
    if (isLegacyWorkPlugin(pluginId)) return false;
    const capability = optionalCapabilityForPlugin(pluginId);
    return capability === undefined || previous?.optional_selections[capability] !== true;
  });
}

async function createEmptyCodexConfig(
  path: string,
): Promise<Readonly<{ dev: number; ino: number }> | undefined> {
  await ensureOwnedDirectory(dirname(path));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error: unknown) {
    if (isFsCode(error, "EEXIST")) return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    await handle.sync();
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

async function sameFileIdentity(
  path: string,
  identity: Readonly<{ dev: number; ino: number }> | undefined,
): Promise<boolean> {
  if (identity === undefined) return false;
  try {
    const stat = await lstat(path);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return false;
    throw error;
  }
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
    browser_use: selected.browser_use,
    computer_use: selected.computer_use,
    sites: selected.sites,
    coding: true,
  };
}

function capabilityStateFor(
  selections: OptionalSelections,
  failures: ReadonlyMap<OptionalCapabilityName, "missing" | "uncertain"> = new Map(),
): CapabilityStateRecord {
  const names = ["browser_use", "computer_use", "frontend", "security", "sites"] as const;
  return Object.fromEntries(
    names.map((name) => {
      const selected = name === "frontend" || name === "security" ? true : selections[name];
      const failure = name === "frontend" || name === "security" ? undefined : failures.get(name);
      const value: CapabilityInstallState = {
        selected,
        status: selected ? (failure ?? "healthy") : "disabled",
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
  readonly optional_selections: Readonly<Record<string, boolean | undefined>> &
    Readonly<{ readonly coding: true; readonly work?: boolean | undefined }>;
  readonly explicit_optional_selections: Readonly<Record<string, boolean | undefined>>;
  readonly official_plugins: readonly string[];
  readonly capability_state:
    | (Readonly<Record<string, CapabilityInstallState | undefined>> &
        Readonly<{ readonly work?: CapabilityInstallState | undefined }>)
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
  const payload = Object.fromEntries(
    Object.entries(plan === undefined ? { ...rest, profile } : { ...rest, plan }).filter(
      ([, entry]) => entry !== undefined,
    ),
  );
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
  readonly optional_selections: Readonly<Record<string, boolean | undefined>> &
    Readonly<{ readonly coding: true; readonly work?: boolean | undefined }>;
  readonly explicit_optional_selections: Readonly<Record<string, boolean | undefined>>;
  readonly official_plugins?: readonly string[] | undefined;
  readonly capability_state?:
    | (Readonly<Record<string, CapabilityInstallState | undefined>> &
        Readonly<{ readonly work?: CapabilityInstallState | undefined }>)
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

function isIncompleteHolyCodexMarketplaceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const invalidMarketplace =
    /(?:^|[\n:])\s*-\s*`([^`]+)`\s+at\s+[^\r\n]*:\s*marketplace root does not contain a supported manifest/iu.exec(
      error.message,
    );
  return invalidMarketplace?.[1] === "holycodex";
}

function hasCanonicalHolyCodexMarketplaceSource(value: TomlValue | undefined): boolean {
  return (
    isTomlTable(value) &&
    Object.keys(value).length === 2 &&
    value["source_type"] === "git" &&
    typeof value["source"] === "string" &&
    isCanonicalHolyCodexMarketplaceGitSource(value["source"])
  );
}

function installReviewTools(
  context7Ready: boolean,
  live: Awaited<ReturnType<NonNullable<OfficialPluginManager["list"]>>>,
  providerPlugins: readonly string[],
): InstallReview["tools"] {
  const tools: InstallReview["tools"][number][] = [
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
  const defaultDecisions =
    conflict.action === "remove"
      ? (["keep", "remove", "cancel"] as const)
      : (["keep", "replace", "cancel"] as const);
  const validDecisions =
    conflict.action === "remove" &&
    conflict.validDecisions?.includes("replace") === true &&
    conflict.validDecisions.includes("remove") === false
      ? defaultDecisions
      : (conflict.validDecisions ?? defaultDecisions);
  const defaultDecision =
    conflict.defaultDecision !== undefined && validDecisions.includes(conflict.defaultDecision)
      ? conflict.defaultDecision
      : validDecisions.includes(conflict.action)
        ? conflict.action
        : (validDecisions[0] ?? conflict.action);
  return {
    ...conflict,
    identity,
    category,
    target,
    defaultDecision,
    validDecisions,
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
    let selected: Readonly<Record<string, ConflictDecision>>;
    try {
      selected = await options.resolveConflicts(structured);
    } catch (error: unknown) {
      if (!(error instanceof InstallerError) || error.code !== "confirmation_required") throw error;
      const summary = structured
        .map((conflict) => {
          const observed =
            conflict.category === "invalid-config" &&
            conflict.key !== undefined &&
            conflict.existing !== undefined
              ? ` = ${JSON.stringify(conflict.existing)}`
              : "";
          return `${conflict.target} at ${conflict.path}${observed}`;
        })
        .join("; ");
      throw new InstallerError(
        "confirmation_required",
        `${error.message} Conflicts: ${summary}.`,
        error,
        { conflicts: summary },
      );
    }
    for (const conflict of structured) {
      const identity = conflict.identity!;
      const decision = decodeSchema(ConflictDecisionSchema, selected[identity]);
      if (decision === undefined || conflict.validDecisions?.includes(decision) === false) {
        const choices = conflict.validDecisions?.join(", ") ?? "keep, replace, cancel";
        throw new InstallerError(
          "confirmation_required",
          `The conflict at ${conflict.target} requires one of these decisions: ${choices}.`,
          undefined,
          {
            identity,
            path: conflict.path,
            ...(conflict.key === undefined ? {} : { key: conflict.key }),
          },
        );
      }
      if (decision === "cancel") {
        throw new InstallerError(
          "confirmation_required",
          `Conflict resolution was cancelled for ${conflict.target} at ${conflict.path}.`,
          undefined,
          {
            identity,
            path: conflict.path,
            ...(conflict.key === undefined ? {} : { key: conflict.key }),
          },
        );
      }
      decisions.set(identity, decision);
    }
    return {
      accepted: structured.filter(
        (conflict) =>
          decisions.get(conflict.identity!) ===
          (conflict.action === "remove" ? "remove" : "replace"),
      ),
      decisions,
    };
  }
  const accepted: ManagedConflict[] = [];
  for (const conflict of structured) {
    const resolution = await options.resolveConflict?.(conflict);
    if (resolution === "accept") {
      const decision = conflict.action === "remove" ? "remove" : "replace";
      if (conflict.validDecisions?.includes(decision) === false) {
        throw new InstallerError(
          "confirmation_required",
          `The conflict at ${conflict.target} cannot be ${decision}d; choose ${conflict.validDecisions?.join(", ")}.`,
          undefined,
          {
            identity: conflict.identity!,
            path: conflict.path,
            ...(conflict.key === undefined ? {} : { key: conflict.key }),
          },
        );
      }
      accepted.push(conflict);
      decisions.set(conflict.identity!, decision);
      continue;
    }
    if (resolution === "decline" && preserveDeclined) {
      if (conflict.validDecisions?.includes("keep") === false) {
        throw new InstallerError(
          "confirmation_required",
          `The conflict at ${conflict.target} cannot be kept; choose ${conflict.validDecisions?.join(", ")}.`,
          undefined,
          {
            identity: conflict.identity!,
            path: conflict.path,
            ...(conflict.key === undefined ? {} : { key: conflict.key }),
          },
        );
      }
      decisions.set(conflict.identity!, "keep");
      continue;
    }
    throw new InstallerError(
      "confirmation_required",
      resolution === "cancel"
        ? `Conflict resolution was cancelled for ${conflict.target} at ${conflict.path}.`
        : `Conflict resolution is required for ${conflict.target} at ${conflict.path}: ${conflict.explanation}.`,
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
  /** The code in install record digest input. */
  readonly code:
    | "install_failed"
    | "capability_denied"
    | "permission_denied"
    | "state_corrupt"
    | "confirmation_required"
    | "not_installed"
    | "upgrade_failed"
    | "upgrade_downgrade";
  /** The cause value in install record digest input. */
  readonly causeValue: unknown;
  /** The details in install record digest input. */
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
