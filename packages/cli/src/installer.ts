// SPDX-License-Identifier: Apache-2.0

import { lstat, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  cleanupManagedRuntimeConfigEffect,
  compareManagedConfigKeyEffect,
  createManagedRuntimeConfigState,
  isManagedRuntimeConfigState,
  deleteTomlPath,
  LEGACY_ROOT_CONFIG_KEY_PATHS,
  mergeManagedRuntimeConfigEffect,
  isCanonicalHolyCodexMarketplaceGitSource,
  readTomlPath,
  resolveAgentConfigPath,
  resolveOfficialPluginEntry,
  summarizeManagedConfigValueEffect,
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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { asJsonValue } from "./json.ts";
import { readInstallationVersionEffect } from "./manifest.ts";
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
  ensureOwnedDirectoryEffect,
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
import {
  optionalStateFile,
  migrateValidatedState,
  optionalTextFile,
  writeAtomicState,
  writeAtomicText,
} from "./storage.ts";
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

const ROOT_ROUTE_MIGRATION_BOUNDARY = "0.16.8" as const;

const ROOT_HIGH_EFFORT_LEGACY_BOUNDARY = "0.16.9" as const;

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
export function readInstallOptions(
  paths: ResolvedInstallerPaths,
): Promise<PersistedInstallOptions | undefined> {
  return Effect.runPromise(readInstallOptionsEffect(paths));
}

function readInstallOptionsEffect(
  paths: ResolvedInstallerPaths,
): Effect.Effect<PersistedInstallOptions | undefined, unknown> {
  return Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () => optionalTextFile(paths.installOptions),
      catch: (error) => error,
    });
    return decodeInstallOptionsText(source, paths.installOptions);
  });
}

function decodeInstallOptionsText(
  source: string | undefined,
  path: string,
): PersistedInstallOptions | undefined {
  if (source === undefined) return undefined;
  const document = Effect.runSync(
    Effect.try({
      try: () => parseToml(source),
      catch: (error) =>
        new InstallerError(
          "state_corrupt",
          "The HolyCodex install options are not valid TOML.",
          error,
          { path },
        ),
    }),
  );
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
export function writeInstallOptions(
  paths: ResolvedInstallerPaths,
  value: PersistedInstallOptions,
): Promise<void> {
  return Effect.runPromise(writeInstallOptionsEffect(paths, value));
}

function writeInstallOptionsEffect(
  paths: ResolvedInstallerPaths,
  value: PersistedInstallOptions,
): Effect.Effect<void, unknown> {
  if (decodeSchema(PersistedInstallOptionsSchema, value) === undefined) {
    return Effect.fail(
      new InstallerError("state_corrupt", "The HolyCodex install options are invalid."),
    );
  }
  return Effect.tryPromise({
    try: () =>
      writeAtomicText(paths.installOptions, stringifyToml(value as unknown as TomlDocument)),
    catch: (error) => error,
  });
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
export function readEffectiveInstallRequestEffect(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<InstallRequest, unknown> {
  return Effect.gen(function* () {
    const paths = resolveInstallerPaths(options, environment);
    const persisted = yield* readInstallOptionsEffect(paths);
    if (persisted !== undefined) return installRequestFromPersistedOptions(persisted);
    const previous = yield* readActiveInstallRecordEffect(paths);
    if (previous === undefined) return {};
    return {
      profile: previous.profile,
      tier: previous.tier,
      optional: previous.optional_selections,
      officialPlugins: additionalPluginsFromPrevious(previous),
    };
  });
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
export function installHolyCodexEffect(
  request: InstallRequest = {},
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<InstallResult, unknown> {
  return Effect.gen(function* () {
    const validatedRequest = decodeSchema(InstallRequestSchema, request);
    if (validatedRequest === undefined) {
      return yield* Effect.fail(
        new InstallerError("install_failed", "The installation options are invalid."),
      );
    }
    rejectCodexDesktopBrowserRequest(validatedRequest as InstallRequest);
    const paths = resolveInstallerPaths(options, environment);
    const installOptionsBefore = yield* Effect.tryPromise({
      try: () => optionalTextFile(paths.installOptions),
      catch: (error) => error,
    });
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
    const previous = yield* readActiveInstallRecordEffect(paths);
    const activeRecordBefore = yield* Effect.tryPromise({
      try: () => optionalTextFile(paths.activeRecord),
      catch: (error) => error,
    });
    if (previous !== undefined && !(yield* recordDigestMatchesRawEffect(previous))) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The existing HolyCodex configuration has changed and cannot be replaced.",
          undefined,
          { path: paths.activeRecord },
        ),
      );
    }
    const preparing = yield* readInstallTransactionEffect(paths.preparingRecord, previous);
    const conflicted = yield* readInstallTransactionEffect(paths.conflictedRecord, previous);
    assertInstallTransactionState(previous, preparing, conflicted);
    const interrupted = [conflicted, preparing].find(
      (transaction) =>
        transaction !== undefined &&
        (previous === undefined || isTransactionBoundToActive(transaction, previous)),
    );
    if (interrupted !== undefined) {
      const { removeHolyCodex } = yield* Effect.tryPromise({
        try: () => import("./maintenance.ts"),
        catch: (error) => error,
      });
      const recovery = yield* Effect.tryPromise({
        try: () => removeHolyCodex(options, environment),
        catch: (error) => error,
      });
      if (recovery.preserved.length > 0 || recovery.reasons.length > 0) {
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            "The interrupted HolyCodex installation could not be reconciled safely.",
            undefined,
            {
              preserved: recovery.preserved.join(","),
              reasons: recovery.reasons.join(","),
            },
          ),
        );
      }
      return yield* installHolyCodexEffect(
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
    const context7PreflightReady = yield* Effect.tryPromise({
      try: () => ensureContext7(runtime, false, previous?.tooling?.context7),
      catch: (error) => error,
    }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
    let context7: Context7ToolState | undefined;
    let context7Warning: string | undefined;
    const providerPlugins = [
      ...new Set(
        pluginIdsForOptionalCapabilities(toCoreSelections(optional), additionalPlugins).map(
          (pluginId) => canonicalOfficialPluginId(pluginId) ?? pluginId,
        ),
      ),
    ];
    const manager =
      options.officialPluginManager ??
      (yield* Effect.tryPromise({
        try: () =>
          CodexOfficialPluginManager.discover({
            ...environment,
            CODEX_HOME: paths.codexHome,
          }),
        catch: (error) =>
          new InstallerError(
            "capability_denied",
            "Native Codex plugin installation is unavailable.",
            error,
            { recovery: "Install or expose Codex, then retry." },
          ),
      }));
    if (!manager.addMarketplace || !manager.add || !manager.list) {
      return yield* Effect.fail(
        new InstallerError(
          "install_failed",
          "Native Codex plugin installation and verification are unavailable.",
        ),
      );
    }
    const installId = previous?.install_id ?? crypto.randomUUID().replaceAll("-", "");
    const version = yield* readInstallationVersionEffect();
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
      return yield* Effect.fail(
        new InstallerError(
          "install_failed",
          "Native Codex cannot remove previously managed plugins omitted from the new selection.",
          undefined,
          { plugins: omittedOwnedPlugins.join(",") },
        ),
      );
    }
    const installedAt = (options.now?.() ?? new Date()).toISOString();
    const desiredConfig = desiredRootConfig(profile, tier, {
      browserUse: optional.browser_use,
      computerUse: optional.computer_use,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
      security: DEFAULT_CAPABILITY_SELECTIONS.security,
    });
    const configBefore = yield* Effect.tryPromise({
      try: () => optionalTextFile(paths.configFile),
      catch: (error) => error,
    });
    const parsedConfigResult = Effect.runSync(
      Effect.try({
        try: () => parseConfig(configBefore, paths.configFile),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (document) => ({ document }),
        }),
      ),
    );
    if ("error" in parsedConfigResult) {
      const error = parsedConfigResult.error;
      if (error instanceof InstallerError && error.code === "state_corrupt") {
        yield* showUnrepairableConfigConflict(options, error, paths.configFile);
      }
      return yield* Effect.fail(error);
    }
    const parsedConfigDocument = parsedConfigResult.document;
    const preflightManagedConfigState =
      previous?.managed_config ??
      createManagedRuntimeConfigState({ schema: STATE_SCHEMA_EPOCH, installId });
    const preflightContext = yield* migrateLegacyRootConfigSettings(
      parsedConfigDocument,
      preflightManagedConfigState,
    );
    const preflightInvalidConfig = yield* resolveInvalidConfigTables(
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
      const currentConfig = yield* Effect.tryPromise({
        try: () => optionalTextFile(paths.configFile),
        catch: (error) => error,
      });
      if (currentConfig !== configBefore) {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            "Codex configuration changed after the invalid-table review; review the latest configuration and retry.",
            undefined,
            { path: paths.configFile },
          ),
        );
      }
      temporaryPreflightConfig = serializeConfig(reviewedInvalidConfigDocument);
      yield* Effect.tryPromise({
        try: () => writeAtomicText(paths.configFile, temporaryPreflightConfig!),
        catch: (error) => error,
      });
    }
    let preflightLive: Awaited<ReturnType<NonNullable<OfficialPluginManager["list"]>>>;
    let marketplaceRepairedDuringPreflight = false;
    let preflightMarketplaceConflict: ManagedConflict | undefined;
    let preflightMarketplaceDecisions: ReadonlyMap<string, ConflictDecision> = new Map();
    const preflightList = yield* Effect.tryPromise({
      try: () => manager.list!(),
      catch: (error) => error,
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (live) => ({ live }),
      }),
    );
    if ("live" in preflightList) {
      preflightLive = preflightList.live;
    } else {
      const error = preflightList.error;
      if (temporaryPreflightConfig !== undefined) {
        yield* restoreTemporaryPreflightConfig(
          paths.configFile,
          configBefore,
          temporaryPreflightConfig,
        );
        temporaryPreflightConfig = undefined;
      }
      if (!isIncompleteHolyCodexMarketplaceError(error)) {
        return yield* Effect.fail(
          new InstallerError(
            "capability_denied",
            "Native Codex plugin state could not be read safely.",
            error,
          ),
        );
      }
      if (
        (yield* Effect.tryPromise({
          try: () => optionalTextFile(paths.configFile),
          catch: (error) => error,
        })) !== configBefore
      ) {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            "Codex configuration changed before the required marketplace repair; review the current marketplace source and retry.",
            error,
            { path: paths.configFile, key: "marketplaces.holycodex" },
          ),
        );
      }
      const configuredMarketplace = readTomlPath(configInputDocument, "marketplaces.holycodex");
      const reviewedMarketplaceContainerRemoval = preflightInvalidConfigConflicts.some(
        (conflict) =>
          conflict.key === "marketplaces" &&
          preflightInvalidConfigDecisions.get(conflict.identity!) === "remove",
      );
      if (configuredMarketplace === undefined && !reviewedMarketplaceContainerRemoval) {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            "Codex reported an incomplete marketplace named holycodex, but config.toml does not contain a reviewable marketplace source. Review the source before retrying; no automatic replacement was attempted.",
            error,
            { path: paths.configFile, key: "marketplaces.holycodex" },
          ),
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
        const resolution = yield* resolveOwnedConflictInventory(
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
        if (
          (yield* Effect.tryPromise({
            try: () => optionalTextFile(paths.configFile),
            catch: (error) => error,
          })) !== configBefore
        ) {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              "Codex configuration changed before marketplace repair; review the current source and retry.",
              error,
              { path: paths.configFile, key: "marketplaces.holycodex" },
            ),
          );
        }
        const replacementDocument = writePluginConfigEntry(
          configInputDocument,
          "marketplaces",
          HOLYCODEX_MARKETPLACE_CONFIG_KEY,
          { source_type: "git", source: HOLYCODEX_MARKETPLACE_URL },
        );
        temporaryPreflightConfig = serializeConfig(replacementDocument);
        yield* Effect.tryPromise({
          try: () => writeAtomicText(paths.configFile, temporaryPreflightConfig!),
          catch: (error) => error,
        });
      }
      if (manager.addMarketplace === undefined) {
        return yield* Effect.fail(
          new InstallerError(
            "capability_denied",
            "Native Codex plugin state could not be read safely.",
            error,
          ),
        );
      }
      const repairResult = yield* Effect.tryPromise({
        try: () => manager.addMarketplace!(HOLYCODEX_MARKETPLACE),
        catch: (repairError) => repairError,
      })
        .pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({ try: () => manager.list!(), catch: (repairError) => repairError }),
          ),
        )
        .pipe(
          Effect.match({
            onFailure: (repairError) => ({ error: repairError }),
            onSuccess: (live) => ({ live }),
          }),
        );
      if ("error" in repairResult) {
        const repairError = repairResult.error;
        if (temporaryPreflightConfig !== undefined) {
          const temporaryConfig = temporaryPreflightConfig;
          const restoreResult = yield* restoreTemporaryPreflightConfig(
            paths.configFile,
            configBefore,
            temporaryConfig,
          ).pipe(
            Effect.match({
              onFailure: (restoreError) => ({ error: restoreError }),
              onSuccess: () => ({ restored: true }),
            }),
          );
          if ("error" in restoreResult) {
            const restoreError = restoreResult.error;
            return yield* Effect.fail(
              new InstallerError(
                "confirmation_required",
                "The marketplace repair failed and the reviewed temporary Codex configuration could not be restored safely; review config.toml before retrying.",
                restoreError,
                { path: paths.configFile, key: "marketplaces.holycodex" },
              ),
            );
          }
          temporaryPreflightConfig = undefined;
        }
        return yield* Effect.fail(
          new InstallerError(
            "capability_denied",
            "The required HolyCodex marketplace could not be repaired before plugin validation.",
            repairError,
          ),
        );
      }
      preflightLive = repairResult.live;
      marketplaceRepairedDuringPreflight = true;
    }
    if (temporaryPreflightConfig !== undefined) {
      yield* restoreTemporaryPreflightConfig(
        paths.configFile,
        configBefore,
        temporaryPreflightConfig,
      );
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
    const currentHolyCodexPluginConfig =
      yield* snapshotHolyCodexPluginConfigEffect(configInputDocument);
    const initialPluginConfigBefore =
      previous?.plugin_config?.before ?? currentHolyCodexPluginConfig;
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
    const currentProviderConfig = yield* snapshotProviderPluginConfig(
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
            ? {
                validDecisions: ["replace", "cancel"] as const,
                defaultDecision: "replace" as const,
              }
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
    const migratedRuntime = yield* migrateKnownLegacyRoleRegistrations(
      configInputDocument,
      unmanagedConfigState,
      previous,
    );
    const migratedContext = yield* migrateLegacyRootConfigSettings(
      migratedRuntime.document,
      migratedRuntime.state,
    );
    const migratedAutoCompact = yield* migrateLegacyAutoCompactConfig(
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
      } else if (
        previous.profile === "high" &&
        compareReleaseVersions(previousBaseVersion, ROOT_HIGH_EFFORT_LEGACY_BOUNDARY) <= 0
      ) {
        // The prior high profile used Sol high; recognize it as managed rather than a user override.
        previousDesiredConfig.model_reasoning_effort = "high";
      }
      // Developer instructions contain host-boundary policy that must follow the
      // current runtime, even when an older record treated its value as managed.
      delete previousDesiredConfig.developer_instructions;
    }
    const desiredConfigWithPersistedManagedValues = yield* preserveManagedConfigDecisions(
      configDocument,
      currentManagedConfig,
      desiredConfig,
      previousDesiredConfig,
    );
    const mergedResult = yield* mergeManagedRuntimeConfigEffect(
      configDocument,
      currentManagedConfig,
      desiredConfigWithPersistedManagedValues,
      { schema: STATE_SCHEMA_EPOCH, installId },
    )
      .pipe(
        Effect.mapError((error) =>
          error instanceof InstallerError
            ? error
            : new InstallerError(
                "state_corrupt",
                "The existing Codex configuration has an incompatible shape for HolyCodex settings.",
                error,
                { recovery: "Converge the conflicting Codex setting, then retry." },
              ),
        ),
      )
      .pipe(Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }));
    if ("error" in mergedResult) return yield* Effect.fail(mergedResult.error);
    let mergedConfig = mergedResult.value;
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
    const nativeConflicts = yield* Effect.tryPromise({
      try: () =>
        inspectNativeAgentConflicts(paths.codexHome, profile, previous?.managed_artifacts, tier, {
          browserUse: optional.browser_use,
          computerUse: optional.computer_use,
        }),
      catch: (error) => new InstallerError("install_failed", safeMessage(error), error),
    });
    if (useBatchConflictResolution)
      pendingConflicts.push(...nativeConflicts.map(structureConflict));
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
      ...(preflightMarketplaceConflict === undefined
        ? []
        : [preflightMarketplaceConflict.identity!]),
    ]);
    const initialReviewConflicts = (
      useBatchConflictResolution ? pendingConflicts : allConflicts
    ).filter((conflict) => !preResolvedIdentities.has(conflict.identity!));
    const initialResolution = yield* resolveOwnedConflictInventory(
      options,
      initialReviewConflicts,
      true,
    );
    let resolvedConflicts: Effect.Success<ReturnType<typeof resolveOwnedConflictInventory>> = {
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
    const applyResolvedConflictDecisions = () =>
      Effect.gen(function* () {
        reviewedNativeConflicts = nativeConflicts.map((conflict) => {
          const projected = structureConflict(conflict);
          const decision = resolvedConflicts.decisions.get(projected.identity!);
          return decision === undefined ? projected : { ...projected, decision };
        });
        const acceptedPluginConfig = yield* applyPluginConfigConflictDecisions(
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
        const effectiveDesiredConfig: Partial<
          Record<ManagedConfigKeyPath, ManagedConfigWriteValue>
        > = {
          ...desiredConfigWithPersistedManagedValues,
        };
        for (const conflict of [...initialUserConfigConflicts, ...managedConfigConflicts]) {
          const key = conflict.key;
          if (key === undefined) continue;
          const configKey = key as ManagedConfigKeyPath;
          const decision = resolvedConflicts.decisions.get(conflict.identity!);
          if (decision !== "keep" && decision !== "replace") {
            return yield* Effect.fail(
              new InstallerError(
                "confirmation_required",
                "Managed conflict resolution is incomplete.",
                undefined,
                { key },
              ),
            );
          }
          const existing = acceptedManaged[configKey];
          const desiredValue = desiredConfig[configKey];
          if (desiredValue === undefined) {
            return yield* Effect.fail(
              new InstallerError(
                "state_corrupt",
                "The managed conflict cannot be verified.",
                undefined,
                { path: paths.configFile, key },
              ),
            );
          }
          const live = readTomlPath(configDocument, configKey);
          if (decision === "replace") {
            acceptedDocument = writeTomlPath(acceptedDocument, configKey, desiredValue);
            if (existing !== undefined) {
              acceptedManaged[configKey] = {
                ...existing,
                lastManagedValue: yield* summarizeManagedConfigValueEffect(configKey, desiredValue),
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
              lastManagedValue: yield* summarizeManagedConfigValueEffect(configKey, live),
            };
            const candidateState = {
              ...currentManagedConfig,
              managed: { ...acceptedManaged, [configKey]: keptEntry },
            };
            if (isManagedRuntimeConfigState(candidateState)) acceptedManaged[configKey] = keptEntry;
            else delete acceptedManaged[configKey];
          }
        }
        mergedConfig = yield* mergeManagedRuntimeConfigEffect(
          acceptedDocument,
          { ...currentManagedConfig, managed: acceptedManaged },
          effectiveDesiredConfig,
          { schema: STATE_SCHEMA_EPOCH, installId },
        );
        if (mergedConfig.driftedKeys.length > 0) {
          return yield* Effect.fail(
            new InstallerError("state_corrupt", "The accepted managed conflicts did not converge."),
          );
        }
        resolvedDesiredConfig = effectiveDesiredConfig;
        const stabilityManaged = { ...currentManagedConfig.managed };
        for (const conflict of [...initialUserConfigConflicts, ...managedConfigConflicts]) {
          const key = conflict.key as ManagedConfigKeyPath | undefined;
          if (key === undefined) continue;
          delete stabilityManaged[key];
        }
        resolvedManagedConfig = stabilityManaged;
      });
    yield* applyResolvedConflictDecisions();
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
        const review = yield* options.reviewInstall({
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
          return yield* Effect.fail(
            new InstallerError("confirmation_required", "Install review was cancelled."),
          );
        }
        if (review.action === "resolve") {
          if (allConflicts.length === 0) {
            return yield* Effect.fail(
              new InstallerError(
                "confirmation_required",
                "There are no managed conflicts to resolve.",
              ),
            );
          }
          resolvedConflicts = yield* resolveOwnedConflictInventory(options, allConflicts, true);
          yield* applyResolvedConflictDecisions();
          reviewConflicts = projectReviewConflicts();
          reviewConflictCounts = projectReviewConflictCounts(reviewConflicts);
          continue;
        }
        if (review.action === "change") {
          if (review.request === undefined) {
            return yield* Effect.fail(
              new InstallerError(
                "confirmation_required",
                "Changing install options requires a revised request.",
              ),
            );
          }
          return yield* installHolyCodexEffect(review.request, options, environment);
        }
        if (review.action === "apply") break;
        return yield* Effect.fail(
          new InstallerError("confirmation_required", "Unknown install review action."),
        );
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
    yield* ensureOwnedDirectoryEffect(paths.stateRoot);
    yield* writeTransaction(paths.preparingRecord, preMutationTransaction);
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
    const transactionEffect = Effect.gen(function* () {
      if (preflightInvalidConfigConflicts.length > 0) {
        const configAtMutation = yield* Effect.tryPromise({
          try: () => optionalTextFile(paths.configFile),
          catch: (error) => error,
        });
        reviewedInvalidConfigDocument = applyInvalidConfigConflictDecisions(
          parseConfig(configAtMutation, paths.configFile),
          preflightInvalidConfigConflicts,
          preflightInvalidConfigDecisions,
        );
        if (
          (yield* Effect.tryPromise({
            try: () => optionalTextFile(paths.configFile),
            catch: (error) => error,
          })) !== configAtMutation
        ) {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              "Codex configuration changed during conflict resolution; review the latest configuration and retry.",
              undefined,
              { path: paths.configFile },
            ),
          );
        }
        yield* Effect.tryPromise({
          try: () =>
            writeAtomicText(paths.configFile, serializeConfig(reviewedInvalidConfigDocument)),
          catch: (error) => error,
        });
        invalidConfigApplied = true;
      }
      const context7Result = yield* Effect.tryPromise({
        try: () => ensureContext7(runtime, true, previous?.tooling?.context7),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (value) => ({ value }),
        }),
      );
      if ("error" in context7Result) {
        context7Warning = `Optional ctx7 is unavailable: ${safeMessage(context7Result.error)}`;
      } else {
        context7 = context7Result.value;
      }
      const recordedContext7 = context7 ?? previous?.tooling?.context7;
      const tooling = recordedContext7 === undefined ? undefined : { context7: recordedContext7 };
      let transaction: PreparingTransaction = {
        ...preMutationTransaction,
        ...(tooling === undefined ? {} : { tooling }),
      };
      transactionForRecovery = transaction;
      yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
      if (
        manager.ensureOfficialMarketplace !== undefined &&
        unresolvedOfficialProviderPlugins.length > 0
      ) {
        yield* Effect.tryPromise({
          try: () => manager.ensureOfficialMarketplace!(unresolvedOfficialProviderPlugins),
          catch: (error) =>
            new InstallerError(
              "capability_denied",
              `The selected official Codex provider marketplace is unavailable: ${safeMessage(error)}`,
              error,
              { recovery: "Check Codex network and marketplace policy, then retry." },
            ),
        });
      }
      pluginSnapshot = yield* snapshotPlugins({ list: () => manager.list!() }, [
        ...new Set([HOLYCODEX_PLUGIN, ...providerPlugins, ...previousOwnedPlugins]),
      ]).pipe(
        Effect.mapError(
          (error) =>
            new InstallerError(
              "capability_denied",
              "Native Codex plugin state could not be read safely.",
              error,
            ),
        ),
      );
      transaction = { ...transaction, plugin_snapshot: pluginSnapshot };
      transactionForRecovery = transaction;
      yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
      let configTextBeforePluginSetup = yield* Effect.tryPromise({
        try: () => optionalTextFile(paths.configFile),
        catch: (error) => error,
      });
      const parsedLiveConfigBeforeMutation = parseConfig(
        configTextBeforePluginSetup,
        paths.configFile,
      );
      const liveConfigBeforeMutation = applyInvalidConfigConflictDecisions(
        parsedLiveConfigBeforeMutation,
        preflightInvalidConfigConflicts,
        resolvedConflicts.decisions,
      );
      yield* assertPreflightPluginConfigStable(
        liveConfigBeforeMutation,
        currentHolyCodexPluginConfig,
        currentProviderConfig,
      );
      const configBeforeMutationRuntime = yield* migrateKnownLegacyRoleRegistrations(
        liveConfigBeforeMutation,
        preflightManagedConfigState,
        previous,
      );
      const configBeforeMutationContext = yield* migrateLegacyRootConfigSettings(
        configBeforeMutationRuntime.document,
        configBeforeMutationRuntime.state,
      );
      const configBeforeMutationAutoCompact = yield* migrateLegacyAutoCompactConfig(
        configBeforeMutationContext.document,
        configBeforeMutationContext.state,
      );
      configBeforeMutationDocument = configBeforeMutationAutoCompact.document;
      yield* assertPostPluginConfigStable(
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
      yield* ensureOwnedDirectoryEffect(paths.roleRoot);
      native = yield* Effect.tryPromise({
        try: () =>
          installNativeAgents(
            paths.codexHome,
            profile,
            previous?.managed_artifacts,
            tier,
            nativeConflicts.length === 0 ? options.resolveConflict : undefined,
            reviewedNativeConflicts,
            { browserUse: optional.browser_use, computerUse: optional.computer_use },
          ),
        catch: (error) => error,
      });
      transactionForRecovery = {
        ...transaction,
        step: "roles_prepared",
        managed_artifacts: native.managed_artifacts,
      };
      yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
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
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            "The pre-mutation configuration baseline is missing.",
          ),
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
      const pluginRecoveryConfigAfter = yield* snapshotHolyCodexPluginConfigEffect(
        pluginRecoveryTargetDocument,
      );
      const providerRecoveryConfigAfter = yield* snapshotProviderPluginConfig(
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
      yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
      if (configBefore === undefined) {
        initialConfigIdentity = yield* Effect.gen(function* () {
          const identity = yield* createEmptyCodexConfigEffect(paths.configFile);
          const configNow = yield* Effect.tryPromise({
            try: () => optionalTextFile(paths.configFile),
            catch: (error) => error,
          });
          if (identity === undefined || configNow !== "") {
            return yield* Effect.fail(
              new InstallerError(
                "confirmation_required",
                "Codex config.toml appeared during installation; review the latest configuration and retry.",
                undefined,
                { operation: "initialize Codex configuration", path: paths.configFile },
              ),
            );
          }
          return identity;
        }).pipe(
          Effect.mapError((error) =>
            error instanceof InstallerError
              ? error
              : new InstallerError(
                  "permission_denied",
                  "Codex config.toml could not be initialized before plugin setup.",
                  error,
                  {
                    operation: "initialize Codex configuration",
                    path: paths.configFile,
                    recovery: "Check CODEX_HOME permissions, then retry.",
                  },
                ),
          ),
        );
        configTextBeforePluginSetup = "";
      }
      if (
        (yield* Effect.tryPromise({
          try: () => optionalTextFile(paths.configFile),
          catch: (error) => error,
        })) !== configTextBeforePluginSetup
      ) {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            "Codex configuration changed during plugin setup; review the latest configuration and retry.",
            undefined,
            { path: paths.configFile },
          ),
        );
      }
      yield* Effect.tryPromise({
        try: () => writeAtomicText(paths.configFile, serializeConfig(pluginRecoveryTargetDocument)),
        catch: (error) => error,
      });
      configPublished = true;
      if (!marketplaceRepairedDuringPreflight) {
        yield* Effect.tryPromise({
          try: () => manager.addMarketplace!(HOLYCODEX_MARKETPLACE),
          catch: (error) => error,
        });
      }
      const nativeManager = {
        list: () => manager.list!(),
        add: (id: string) => manager.add!(id),
      };
      yield* installAndVerifyEffect(
        nativeManager,
        [HOLYCODEX_PLUGIN, ...providerPlugins],
        refreshPluginIds,
        (id, mutation) =>
          Effect.gen(function* () {
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
            yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
          }),
      );
      transactionForRecovery = { ...transactionForRecovery, step: "plugins_installed" };
      yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
      reportProgress(options, {
        stage: "plugins",
        status: "completed",
        message: "Selected capabilities installed",
      });
      const configAfterPlugins = yield* Effect.tryPromise({
        try: () => optionalTextFile(paths.configFile),
        catch: (error) => error,
      });
      const parsedPostPluginDocument = parseConfig(configAfterPlugins, paths.configFile);
      const postPluginDocument = applyInvalidConfigConflictDecisions(
        parsedPostPluginDocument,
        preflightInvalidConfigConflicts,
        resolvedConflicts.decisions,
      );
      const postPluginRuntime = yield* migrateKnownLegacyRoleRegistrations(
        postPluginDocument,
        preflightManagedConfigState,
        previous,
      );
      const postPluginContext = yield* migrateLegacyRootConfigSettings(
        postPluginRuntime.document,
        postPluginRuntime.state,
      );
      const postPluginAutoCompact = yield* migrateLegacyAutoCompactConfig(
        postPluginContext.document,
        postPluginContext.state,
      );
      if (configBeforeMutationDocument === undefined) {
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            "The pre-mutation configuration baseline is missing.",
          ),
        );
      }
      const postPluginResolution = yield* applyPluginConfigConflictDecisions(
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
      const pluginConfigAfter =
        yield* snapshotHolyCodexPluginConfigEffect(stablePostPluginDocument);
      const currentProviderConfigAfter = yield* snapshotProviderPluginConfig(
        stablePostPluginDocument,
        providerConfigPluginIds,
      );
      const providerConfig = currentProviderConfigAfter.map((entry) => ({
        plugin_id: entry.plugin_id,
        before:
          providerConfigBefore.find((candidate) => candidate.plugin_id === entry.plugin_id)
            ?.before ?? entry.before,
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
      const postPluginBaselineManaged: Record<
        string,
        ManagedRuntimeConfigState["managed"][string]
      > = { ...resolvedManagedConfig };
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
            : {
                lastManagedValue: yield* summarizeManagedConfigValueEffect(keyPath, value),
              }),
        };
      }
      const postPluginBaseline: ManagedRuntimeConfigState = {
        ...mergedConfig.state,
        managed: postPluginBaselineManaged,
      };
      yield* assertPostPluginConfigStable(
        stablePostPluginDocument,
        configBeforeMutationDocument,
        { ...postPluginBaseline, managed: resolvedManagedConfig },
        resolvedDesiredConfig,
      );
      for (const conflict of [...initialUserConfigConflicts, ...managedConfigConflicts]) {
        const key = conflict.key as ManagedConfigKeyPath | undefined;
        if (key === undefined) continue;
        const decision = resolvedConflicts.decisions.get(conflict.identity!);
        const value =
          decision === "replace" ? desiredConfig[key] : readTomlPath(configDocument, key);
        if (value !== undefined)
          stablePostPluginDocument = writeTomlPath(stablePostPluginDocument, key, value);
      }
      const postPluginConfig = yield* mergeManagedRuntimeConfigEffect(
        stablePostPluginDocument,
        postPluginBaseline,
        resolvedDesiredConfig,
        { schema: STATE_SCHEMA_EPOCH, installId },
      );
      if (postPluginConfig.driftedKeys.length > 0) {
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            "HolyCodex-owned Codex settings changed during native plugin setup.",
            undefined,
            { keys: postPluginConfig.driftedKeys.join(",") },
          ),
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
      if (
        (yield* Effect.tryPromise({
          try: () => optionalTextFile(paths.configFile),
          catch: (error) => error,
        })) !== configAfterPlugins
      ) {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            "Codex configuration changed during plugin setup; review the latest configuration and retry.",
            undefined,
            { path: paths.configFile },
          ),
        );
      }
      const initializedPermissionProfile =
        previous === undefined ||
        (previous.managed_config?.managed["permissions.holycodex.extends"] === undefined &&
          readTomlPath(postPluginConfig.document, "default_permissions") === undefined);
      const installedConfigDocument = initializedPermissionProfile
        ? writeTomlPath(postPluginConfig.document, "default_permissions", "holycodex")
        : postPluginConfig.document;
      yield* Effect.tryPromise({
        try: () => writeAtomicText(paths.configFile, serializeConfig(installedConfigDocument)),
        catch: (error) => error,
      });
      configPublished = true;
      transactionForRecovery = { ...transactionForRecovery, step: "config_published" };
      yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
      if (omittedOwnedPlugins.length > 0) {
        const removalManager = {
          list: () => manager.list!(),
          remove: (id: string) => manager.remove!(id),
        };
        yield* removeAndVerifyEffect(removalManager, omittedOwnedPlugins, (id, mutation) =>
          Effect.gen(function* () {
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
            yield* writeTransaction(paths.preparingRecord, transactionForRecovery);
          }),
        );
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
      yield* verifyEffectiveInstallEffect(
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
      const digest = yield* installRecordDigestEffect({
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
        return yield* Effect.fail(
          new InstallerError("state_corrupt", "The HolyCodex configuration is invalid."),
        );
      }
      activeRecordWriteStarted = true;
      yield* Effect.tryPromise({
        try: () => writeAtomicState(paths.activeRecord, asJsonValue(record)),
        catch: (error) => error,
      });
      installOptionsWriteStarted = true;
      yield* writeInstallOptionsEffect(
        paths,
        persistedOptionsForInstall(profile, tier, optional, additionalPlugins),
      );
      yield* removeTransaction(paths.preparingRecord);
      yield* removeTransaction(paths.conflictedRecord);
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
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause);
          const rollbackFailures: string[] = [];
          let rollbackConfigIdentity: Readonly<{ dev: number; ino: number }> | undefined;
          if (activeRecordWriteStarted) {
            const result = yield* attemptEffect(
              activeRecordBefore === undefined
                ? removeFileIfPresent(paths.activeRecord)
                : Effect.tryPromise({
                    try: () => writeAtomicText(paths.activeRecord, activeRecordBefore),
                    catch: (error) => error,
                  }),
            );
            if (!result.ok) {
              rollbackFailures.push("active_record");
            }
          }
          if (installOptionsWriteStarted) {
            const result = yield* attemptEffect(
              installOptionsBefore === undefined
                ? removeFileIfPresent(paths.installOptions)
                : Effect.tryPromise({
                    try: () => writeAtomicText(paths.installOptions, installOptionsBefore),
                    catch: (error) => error,
                  }),
            );
            if (!result.ok) {
              rollbackFailures.push("install_options");
            }
          }
          if (pluginEffectsStarted || configPublished) {
            const configBaseline = configBeforeMutationDocument;
            const result = yield* attemptEffect(
              configBaseline === undefined
                ? Effect.succeed(undefined)
                : rollbackConfigTransaction(
                    paths.configFile,
                    transactionForRecovery,
                    configBaseline,
                    rollbackOwnedPlugins,
                  ),
            );
            if (result.ok) {
              rollbackConfigIdentity = result.value;
            } else {
              rollbackFailures.push("config");
            }
          }
          if (invalidConfigApplied) {
            const result = yield* attemptEffect(
              restoreReviewedInvalidConfig(paths.configFile, preflightInvalidConfigConflicts),
            );
            if (!result.ok) {
              rollbackFailures.push("invalid_config");
            }
          }
          if (native !== undefined) {
            const nativeRollback = native.rollback;
            const result = yield* attemptEffect(
              Effect.tryPromise({
                try: () => rollbackNativeAgentInstall(nativeRollback),
                catch: (error) => error,
              }),
            );
            if (!result.ok || result.value.preserved.length > 0) {
              rollbackFailures.push("roles");
            }
          }
          if (uncertainPluginMutations.size > 0) {
            rollbackFailures.push(...[...uncertainPluginMutations].map((id) => `plugin:${id}`));
          }
          for (const pluginId of addedPlugins) {
            const result = yield* attemptEffect(
              manager.remove === undefined
                ? Effect.succeed(undefined)
                : Effect.tryPromise({
                    try: () => manager.remove!(pluginId),
                    catch: (error) => error,
                  }),
            );
            if (!result.ok) {
              rollbackFailures.push(`plugin:${pluginId}`);
            }
          }
          for (const pluginId of new Set([...removedPlugins, ...uncertainPluginRemovals])) {
            const result = yield* attemptEffect(
              Effect.gen(function* () {
                yield* restoreRemovedPluginEffect(
                  {
                    list: () => manager.list!(),
                    add: (id: string) => manager.add!(id),
                  },
                  pluginId,
                  pluginSnapshot.find((snapshot) => snapshot.plugin_id === pluginId)?.status,
                );
                yield* writeTransaction(paths.preparingRecord, {
                  ...transactionForRecovery,
                  owned_plugins: [...ownedPlugins, pluginId],
                });
              }),
            );
            if (result.ok) {
              removedPlugins.delete(pluginId);
              uncertainPluginRemovals.delete(pluginId);
              ownedPlugins.add(pluginId);
              transactionForRecovery = {
                ...transactionForRecovery,
                owned_plugins: [...ownedPlugins],
              };
            } else {
              // Keep ownership in the recovery journal when restoring a removed
              // plugin cannot be proven complete.
              ownedPlugins.add(pluginId);
              uncertainPluginRemovals.add(pluginId);
              transactionForRecovery = {
                ...transactionForRecovery,
                owned_plugins: [...ownedPlugins],
              };
              yield* Effect.ignore(writeTransaction(paths.preparingRecord, transactionForRecovery));
              rollbackFailures.push(`plugin:${pluginId}`);
            }
          }
          if (
            context7?.ownership === "holycodex" &&
            previous?.tooling?.context7?.ownership !== "holycodex"
          ) {
            const result = yield* attemptEffect(
              Effect.tryPromise({
                try: () => removeOwnedContext7(runtime, context7),
                catch: (error) => error,
              }),
            );
            if (!result.ok || !result.value) {
              rollbackFailures.push("context7");
            }
          }
          if (rollbackFailures.length === 0 && configBefore === undefined) {
            const result = yield* attemptEffect(
              Effect.gen(function* () {
                const current = yield* Effect.tryPromise({
                  try: () => optionalTextFile(paths.configFile),
                  catch: (error) => error,
                });
                if (
                  current?.trim().length === 0 &&
                  (yield* sameFileIdentity(
                    paths.configFile,
                    rollbackConfigIdentity ?? initialConfigIdentity,
                  ))
                ) {
                  yield* Effect.tryPromise({
                    try: () => rm(paths.configFile, { force: false }),
                    catch: (error) => error,
                  });
                }
              }),
            );
            if (!result.ok) {
              rollbackFailures.push("config_initialization");
            }
          }
          if (rollbackFailures.length > 0) {
            const normalization = yield* attemptEffect(
              Effect.gen(function* () {
                const recoveryDocument = parseConfig(
                  yield* Effect.tryPromise({
                    try: () => optionalTextFile(paths.configFile),
                    catch: (error) => error,
                  }),
                  paths.configFile,
                );
                const recoveryPluginConfig = transactionForRecovery.plugin_config;
                const recoveryCurrentPluginConfig =
                  yield* snapshotHolyCodexPluginConfigEffect(recoveryDocument);
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
                const recoveryCurrentProviderConfig = yield* snapshotProviderPluginConfig(
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
              }),
            );
            // Keep the transaction's expected post-mutation snapshots when the live state cannot be read.
            void normalization;
            let conflictPublished = false;
            const conflictResult = yield* attemptEffect(
              writeTransaction(paths.conflictedRecord, {
                ...transactionForRecovery,
                step: "conflicted",
                status: "conflicted",
              }),
            );
            conflictPublished = conflictResult.ok;
            // Keep the preparing journal when conflict publication fails so recovery can retry it.
            if (conflictPublished) {
              yield* Effect.ignore(removeTransaction(paths.preparingRecord));
            }
          } else {
            yield* Effect.ignore(removeTransaction(paths.preparingRecord));
          }
          if (error instanceof PathBoundaryError) return yield* Effect.fail(error);
          if (error instanceof InstallerError) return yield* Effect.fail(error);
          return yield* Effect.fail(
            new InstallerError(
              error instanceof OfficialPluginManagerError ||
                error instanceof PluginVerificationError
                ? "capability_denied"
                : "install_failed",
              safeMessage(error),
              error,
              rollbackFailures.length > 0
                ? { recovery: "Resolve conflicted state before retrying." }
                : {},
            ),
          );
        }).pipe(Effect.uninterruptible),
      ),
    );
    return yield* transactionEffect;
  });
}

/** Read and, when needed, migrate the active install record after validating its digest. */
export function readActiveInstallRecordEffect(
  paths: ResolvedInstallerPaths,
): Effect.Effect<InstallRecord | undefined, unknown> {
  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => optionalStateFile(paths.activeRecord, JsonObjectSchema),
      catch: (error) => error,
    });
    if (raw === undefined) return undefined;
    const current = decodeSchema(InstallRecordSchema, raw);
    if (current !== undefined) {
      if (!(yield* recordDigestMatchesRawEffect(current)))
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            "The existing HolyCodex configuration has an invalid digest.",
          ),
        );
      yield* Effect.tryPromise({
        try: () => migrateValidatedState(paths.activeRecord, raw),
        catch: (error) => error,
      });
      return current;
    }
    const legacy = decodeSchema(InstallRecordMigrationSchema, raw);
    if (legacy === undefined) {
      return yield* Effect.fail(
        new InstallerError("state_corrupt", "The HolyCodex configuration is invalid."),
      );
    }
    if (!(yield* recordDigestMatchesRawEffect(legacy))) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The existing HolyCodex configuration has an invalid digest.",
          undefined,
          { path: paths.activeRecord },
        ),
      );
    }
    const persistedProfile =
      "profile" in legacy && legacy.profile !== undefined
        ? legacy.profile
        : "plan" in legacy
          ? legacy.plan
          : undefined;
    if (persistedProfile === undefined) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The persisted installation has neither profile nor legacy plan state.",
          undefined,
          { path: paths.activeRecord },
        ),
      );
    }
    const migratedProfile = Effect.runSync(
      Effect.try({
        try: () => migrateProfileName(persistedProfile),
        catch: (error) =>
          new InstallerError(
            "state_corrupt",
            `The persisted profile ${persistedProfile} was removed and requires an explicit replacement.`,
            error,
            { path: paths.activeRecord, profile: persistedProfile },
          ),
      }),
    );
    const legacyWithoutPlan =
      "plan" in legacy
        ? (Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "plan")) as Omit<
            typeof legacy,
            "plan"
          >)
        : legacy;
    const priorSelections = legacy.optional_selections;
    const priorExplicit = legacy.explicit_optional_selections;
    const optionalSelections: OptionalSelections = {
      browser_use:
        ("browser_use" in priorSelections ? priorSelections.browser_use : undefined) ??
        DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
      computer_use: priorSelections.computer_use,
      sites:
        ("sites" in priorSelections ? priorSelections.sites : undefined) ??
        DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.sites,
      coding: true,
    };
    const explicitOptionalSelections: ExplicitOptionalSelections = {
      ...(priorExplicit.computer_use === undefined
        ? {}
        : { computer_use: priorExplicit.computer_use }),
      ...(!("browser_use" in priorExplicit) || priorExplicit.browser_use === undefined
        ? {}
        : { browser_use: priorExplicit.browser_use }),
      ...(!("sites" in priorExplicit) || priorExplicit.sites === undefined
        ? {}
        : { sites: priorExplicit.sites }),
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
      digest: yield* installRecordDigestEffect({
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
    yield* Effect.tryPromise({
      try: () => migrateValidatedState(paths.activeRecord, raw),
      catch: (error) => error,
    });
    return migrated;
  });
}

/** Read a transaction journal and migrate prior-schema selections before recovery examines it. */
export function readInstallTransactionEffect(
  path: string,
  active?: InstallRecord,
): Effect.Effect<
  | (Omit<InstallRecord, "status" | "step"> & {
      readonly status: "preparing" | "conflicted";
      readonly step: InstallTransactionStep;
    })
  | undefined,
  unknown
> {
  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => optionalStateFile(path, JsonObjectSchema),
      catch: (error) => error,
    });
    if (raw === undefined) return undefined;
    const current = decodeSchema(InstallTransactionSchema, raw) as
      | (Omit<InstallRecord, "status" | "step"> & {
          readonly status: "preparing" | "conflicted";
          readonly step: InstallTransactionStep;
        })
      | undefined;
    if (current !== undefined) {
      yield* Effect.tryPromise({
        try: () => migrateValidatedState(path, raw),
        catch: (error) => error,
      });
      return current;
    }
    const legacy = decodeSchema(InstallTransactionMigrationSchema, raw);
    if (legacy === undefined) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The HolyCodex transaction state is invalid.",
          undefined,
          {
            path,
          },
        ),
      );
    }
    const profileValue =
      ("profile" in legacy ? legacy.profile : undefined) ??
      ("plan" in legacy ? legacy.plan : undefined);
    if (profileValue === undefined) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The HolyCodex transaction has no profile.",
          undefined,
          {
            path,
          },
        ),
      );
    }
    const profile = Effect.runSync(
      Effect.try({
        try: () => migrateProfileName(profileValue),
        catch: (error) =>
          new InstallerError(
            "state_corrupt",
            "The persisted transaction profile requires an explicit replacement.",
            error,
            { path, profile: profileValue },
          ),
      }),
    );
    const selections = legacy.optional_selections;
    const explicit = legacy.explicit_optional_selections;
    const optionalSelections: OptionalSelections = {
      browser_use:
        ("browser_use" in selections ? selections.browser_use : undefined) ??
        DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
      computer_use: selections.computer_use ?? false,
      sites:
        ("sites" in selections ? selections.sites : undefined) ??
        DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.sites,
      coding: true,
    };
    const explicitOptionalSelections: ExplicitOptionalSelections = {
      ...(!("browser_use" in explicit) || explicit.browser_use === undefined
        ? {}
        : { browser_use: explicit.browser_use }),
      ...(explicit.computer_use === undefined ? {} : { computer_use: explicit.computer_use }),
      ...(!("sites" in explicit) || explicit.sites === undefined ? {} : { sites: explicit.sites }),
    };
    const priorCapabilityState = legacy.capability_state;
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
    const base =
      "profile" in legacy
        ? (({ profile: _profile, ...rest }) => rest)(legacy)
        : "plan" in legacy
          ? (({ plan: _plan, ...rest }) => rest)(legacy)
          : legacy;
    const priorDigest = base.digest;
    const boundLegacyDigest = active === undefined ? undefined : migratedActiveDigests.get(active);
    const digest =
      active !== undefined &&
      base.install_id === active.install_id &&
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
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The migrated transaction state is invalid.",
          undefined,
          {
            path,
          },
        ),
      );
    }
    yield* Effect.tryPromise({
      try: () => migrateValidatedState(path, raw),
      catch: (error) => error,
    });
    return transaction;
  });
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
  return Effect.runSync(
    Effect.try({
      try: () => {
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
      },
      catch: (error: unknown) => {
        if (error instanceof InstallerError) return error;
        const parserMessage = safeMessage(error);
        const location = locateTomlParseFailure(text, parserMessage);
        const detail =
          location === undefined
            ? `${path} contains invalid TOML: ${parserMessage}. Fix the TOML syntax and retry; HolyCodex cannot safely rewrite malformed TOML.`
            : `${path} contains invalid TOML at line ${location.line}, column ${location.column} (offset ${location.offset}): ${parserMessage}. Fix the syntax at that location and retry; HolyCodex cannot safely rewrite malformed TOML.`;
        return new InstallerError("state_corrupt", detail, error, {
          path,
          parser_message: parserMessage,
          ...(location === undefined ? {} : location),
          reason: "invalid_toml_syntax",
        });
      },
    }),
  );
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

function resolveInvalidConfigTables(
  options: InstallerOptions,
  path: string,
  document: TomlDocument,
  keyPaths: readonly string[],
): Effect.Effect<
  {
    readonly document: TomlDocument;
    readonly conflicts: readonly ManagedConflict[];
    readonly decisions: ReadonlyMap<string, ConflictDecision>;
  },
  unknown
> {
  return Effect.gen(function* () {
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
    const resolution = yield* resolveOwnedConflictInventory(options, conflicts, true);
    return {
      document: applyInvalidConfigConflictDecisions(document, conflicts, resolution.decisions),
      conflicts,
      decisions: resolution.decisions,
    };
  });
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

function restoreTemporaryPreflightConfig(
  path: string,
  originalText: string | undefined,
  temporaryText: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (
      (yield* Effect.tryPromise({ try: () => optionalTextFile(path), catch: (error) => error })) !==
      temporaryText
    ) {
      return yield* Effect.fail(
        new InstallerError(
          "confirmation_required",
          "Codex configuration changed during preflight validation; review the latest configuration and retry.",
          undefined,
          { path },
        ),
      );
    }
    if (originalText === undefined) {
      yield* removeFileIfPresent(path);
      return;
    }
    yield* Effect.tryPromise({
      try: () => writeAtomicText(path, originalText),
      catch: (error) => error,
    });
  });
}

function restoreReviewedInvalidConfig(
  path: string,
  conflicts: readonly ManagedConflict[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const liveText = yield* Effect.tryPromise({
      try: () => optionalTextFile(path),
      catch: (error) => error,
    });
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
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `Codex configuration at ${conflict.key} changed during rollback; preserve it and review the current value.`,
              undefined,
              { path, key: conflict.key },
            ),
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
    if (
      (yield* Effect.tryPromise({ try: () => optionalTextFile(path), catch: (error) => error })) !==
      liveText
    ) {
      return yield* Effect.fail(
        new InstallerError(
          "confirmation_required",
          "Codex configuration changed during rollback; preserve it and review the current value.",
          undefined,
          { path },
        ),
      );
    }
    yield* Effect.tryPromise({
      try: () => writeAtomicText(path, serializeConfig(restoredDocument)),
      catch: (error) => error,
    });
  });
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

function showUnrepairableConfigConflict(
  options: InstallerOptions,
  error: InstallerError,
  path: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
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
    yield* Effect.ignore(resolveOwnedConflictInventory(options, [conflict], true));
  });
}

/** Serialize a validated TOML document for writing to Codex configuration. */
export function serializeConfig(document: TomlDocument): string {
  return Effect.runSync(
    Effect.try({
      try: () => {
        const bun = (
          globalThis as { Bun?: { TOML?: { stringify: (value: TomlDocument) => string } } }
        ).Bun;
        const rendered = bun?.TOML?.stringify
          ? bun.TOML.stringify(document)
          : stringifyToml(document);
        return `${rendered.trimEnd()}\n`;
      },
      catch: (error: unknown) =>
        new InstallerError(
          "install_failed",
          "The merged Codex configuration is not writable.",
          error,
        ),
    }),
  );
}

type PluginConfigEntryName = "preference" | "marketplace";

/** Capture the pre-install configuration entries owned by the HolyCodex plugin. */
export function snapshotHolyCodexPluginConfigEffect(
  document: TomlDocument,
): Effect.Effect<PluginConfigSnapshot["before"], unknown> {
  return Effect.gen(function* () {
    return {
      preference: yield* snapshotPluginConfigEntry(
        document,
        "plugins",
        HOLYCODEX_PLUGIN_CONFIG_KEY,
      ),
      marketplace: yield* snapshotPluginConfigEntry(
        document,
        "marketplaces",
        HOLYCODEX_MARKETPLACE_CONFIG_KEY,
      ),
    };
  });
}

function snapshotProviderPluginConfig(
  document: TomlDocument,
  pluginIds: readonly string[],
): Effect.Effect<readonly ProviderPluginConfigSnapshot[], unknown> {
  return Effect.all(
    pluginIds.map((pluginId) =>
      snapshotPluginConfigEntry(document, "plugins", pluginId).pipe(
        Effect.map((entry) => {
          const snapshot = {
            presence: entry.presence,
            digest: entry.digest,
            ...(entry.safe_value?.kind === "boolean" ? { safe_value: entry.safe_value } : {}),
          };
          return { plugin_id: pluginId, before: snapshot, after: snapshot };
        }),
      ),
    ),
    { concurrency: "unbounded" },
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
export function cleanupHolyCodexPluginConfigEffect(
  document: TomlDocument,
  snapshot: PluginConfigSnapshot,
  options: Readonly<{ readonly allowBeforeState?: boolean }> = {},
): Effect.Effect<PluginConfigCleanupResult, unknown> {
  return Effect.gen(function* () {
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
      const current = yield* snapshotPluginConfigEntry(document, parent, key);
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
      output = writePluginConfigEntry(
        output,
        parent,
        key,
        pluginSafeValueToToml(before.safe_value),
      );
      restored.push(name);
    }
    return { document: output, restored, removed, preserved };
  });
}

/** Restore or remove provider plugin entries when their values are unchanged. */
export function cleanupProviderPluginConfigEffect(
  document: TomlDocument,
  snapshots: readonly ProviderPluginConfigSnapshot[],
  ownedPlugins: ReadonlySet<string>,
  options: Readonly<{ readonly allowBeforeState?: boolean }> = {},
): Effect.Effect<ProviderPluginConfigCleanupResult, unknown> {
  return Effect.gen(function* () {
    let output = document;
    const restored: string[] = [];
    const removed: string[] = [];
    const preserved: string[] = [];
    for (const snapshot of snapshots) {
      if (!ownedPlugins.has(snapshot.plugin_id)) continue;
      const before = snapshot.before;
      const after = snapshot.after;
      const current = yield* snapshotPluginConfigEntry(document, "plugins", snapshot.plugin_id);
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
  });
}

function restoreUnsupportedPluginConfigEntry(
  document: TomlDocument,
  baseline: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
  before: PluginConfigEntrySnapshot | ProviderPluginConfigSnapshot["before"],
  after: PluginConfigEntrySnapshot | ProviderPluginConfigSnapshot["after"],
): Effect.Effect<{ readonly document: TomlDocument; readonly restored: boolean }, unknown> {
  return Effect.gen(function* () {
    if (before.presence !== "present" || before.safe_value !== undefined) {
      return { document, restored: false };
    }
    const current = yield* snapshotPluginConfigEntry(document, parent, key);
    if (current.digest === before.digest || current.digest !== after.digest) {
      return { document, restored: false };
    }
    const value = readPluginConfigEntry(baseline, parent, key);
    if (value === undefined) return { document, restored: false };
    return {
      document: writePluginConfigEntry(document, parent, key, value),
      restored: true,
    };
  });
}

function snapshotPluginConfigEntry(
  document: TomlDocument,
  parent: "plugins" | "marketplaces",
  key: string,
): Effect.Effect<PluginConfigEntrySnapshot, unknown> {
  return Effect.gen(function* () {
    const value = readPluginConfigEntry(document, parent, key);
    const digest = yield* Effect.tryPromise({
      try: () =>
        domainSeparatedSha256("holycodex-plugin-config", [
          canonicalJsonUtf8(
            asJsonValue({
              key: `${parent}.${key}`,
              value: value === undefined ? { presence: "absent" } : value,
            }),
          ),
        ]),
      catch: (error) => error,
    });
    const safeValue = pluginConfigSafeValue(parent, value);
    return {
      presence: value === undefined ? "absent" : "present",
      digest,
      ...(safeValue === undefined ? {} : { safe_value: safeValue }),
    };
  });
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

function assertPreflightPluginConfigStable(
  document: TomlDocument,
  expectedHolyCodex: PluginConfigSnapshot["before"],
  expectedProviders: readonly ProviderPluginConfigSnapshot[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const entries = [
      {
        parent: "plugins",
        key: HOLYCODEX_PLUGIN_CONFIG_KEY,
        expected: expectedHolyCodex.preference,
      },
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
      const current = yield* snapshotPluginConfigEntry(document, parent, key);
      if (current.digest !== expected.digest) {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            "Plugin configuration changed after preflight; review the latest configuration and retry.",
            undefined,
            { key: `${parent}.${key}` },
          ),
        );
      }
    }
  });
}

function applyPluginConfigConflictDecisions(
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
): Effect.Effect<PluginConfigConflictResolution, unknown> {
  return Effect.gen(function* () {
    let output = document;
    let effectivePluginConfigBefore = pluginConfigBefore;
    let effectiveProviderConfigBefore = providerConfigBefore;
    for (const conflict of pluginConflicts) {
      const identity = conflict.identity;
      if (identity === undefined) {
        return yield* Effect.fail(
          new InstallerError("state_corrupt", "A plugin configuration conflict has no identity."),
        );
      }
      const decision = decisions.get(identity);
      if (decision !== "keep" && decision !== "replace") {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            `Plugin configuration conflict resolution is incomplete for ${conflict.key ?? identity}.`,
          ),
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
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              "Keeping disabled HolyCodex config would disable the selected plugin.",
            ),
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
        return yield* Effect.fail(
          new InstallerError("state_corrupt", "A provider configuration conflict has no identity."),
        );
      }
      const pluginId =
        key.startsWith('plugins."') && key.endsWith('"')
          ? key.slice('plugins."'.length, -1)
          : undefined;
      if (pluginId === undefined) {
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            `The provider configuration conflict key ${key} is invalid.`,
          ),
        );
      }
      const decision = decisions.get(identity);
      if (decision !== "keep" && decision !== "replace") {
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            `Provider configuration conflict resolution is incomplete for ${key}.`,
          ),
        );
      }
      const current = currentProviderConfig.find((entry) => entry.plugin_id === pluginId);
      if (current === undefined) {
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            `The provider configuration entry ${pluginId} is missing.`,
          ),
        );
      }
      if (decision === "keep") {
        const preserved = readPluginConfigEntry(preservationDocument, "plugins", pluginId);
        if (
          selectedProviderPlugins.includes(pluginId) &&
          isTomlTable(preserved) &&
          preserved["enabled"] === false
        ) {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `Keeping disabled config would disable selected plugin ${pluginId}.`,
            ),
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
  });
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

function preserveManagedConfigDecisions(
  document: TomlDocument,
  current: ManagedRuntimeConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
  previousDesired:
    | Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>
    | undefined,
): Effect.Effect<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>, unknown> {
  return Effect.gen(function* () {
    const effective = { ...desired };
    if (previousDesired === undefined) return effective;
    for (const rawKeyPath of Object.keys(desired)) {
      const keyPath = rawKeyPath as ManagedConfigKeyPath;
      const existing = current.managed[keyPath];
      const previousValue = previousDesired[keyPath];
      if (existing === undefined || previousValue === undefined) continue;
      const previousSummary = yield* summarizeManagedConfigValueEffect(keyPath, previousValue);
      if (JSON.stringify(previousSummary) === JSON.stringify(existing.lastManagedValue)) continue;
      const live = readTomlPath(document, keyPath);
      if (typeof live !== "string" && typeof live !== "number" && typeof live !== "boolean") {
        continue;
      }
      const liveSummary = yield* summarizeManagedConfigValueEffect(keyPath, live);
      if (JSON.stringify(liveSummary) === JSON.stringify(existing.lastManagedValue)) {
        delete effective[keyPath];
      }
    }
    return effective;
  });
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
    approval_policy: "on-request",
    approvals_reviewer: "auto_review",
    "permissions.holycodex.extends": ":workspace",
    "permissions.holycodex.network.enabled": true,
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

function assertPostPluginConfigStable(
  live: TomlDocument,
  preflight: TomlDocument,
  current: ManagedRuntimeConfigState,
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, ManagedConfigWriteValue>>>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const drifted: ManagedConfigKeyPath[] = [];
    for (const rawKeyPath of Object.keys(desired)) {
      const keyPath = rawKeyPath as ManagedConfigKeyPath;
      const existing = current.managed[keyPath];
      if (existing !== undefined) {
        const comparison = yield* compareManagedConfigKeyEffect(live, current, keyPath);
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
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "Codex settings changed during native plugin setup.",
          undefined,
          {
            keys: drifted.join(","),
          },
        ),
      );
    }
  });
}

function migrateKnownLegacyRoleRegistrations(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
  previous: InstallRecord | undefined,
): Effect.Effect<Readonly<{ document: TomlDocument; state: ManagedRuntimeConfigState }>, unknown> {
  return Effect.gen(function* () {
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
      const cleanup = yield* cleanupManagedRuntimeConfigEffect(
        document,
        { ...state, managed: legacyManaged },
        { schema: state.schema, installId: state.installId },
      );
      if (cleanup.preservedKeys.length > 0 || cleanup.unresolvedKeys.length > 0) {
        return yield* Effect.fail(
          new InstallerError(
            "state_corrupt",
            "Legacy HolyCodex agent registrations changed and cannot be migrated safely.",
            undefined,
            { keys: [...new Set([...cleanup.preservedKeys, ...cleanup.unresolvedKeys])].join(",") },
          ),
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
  });
}

function migrateLegacyAutoCompactConfig(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
): Effect.Effect<Readonly<{ document: TomlDocument; state: ManagedRuntimeConfigState }>, unknown> {
  return Effect.gen(function* () {
    const entry = state.managed[LEGACY_AUTO_COMPACT_KEY];
    if (entry === undefined) return { document, state };
    const cleanup = yield* cleanupManagedRuntimeConfigEffect(
      document,
      { ...state, managed: { [LEGACY_AUTO_COMPACT_KEY]: entry } },
      { schema: state.schema, installId: state.installId },
    );
    const managed = Object.fromEntries(
      Object.entries(state.managed).filter(([keyPath]) => keyPath !== LEGACY_AUTO_COMPACT_KEY),
    );
    return { document: cleanup.document, state: { ...state, managed } };
  });
}

function migrateLegacyRootConfigSettings(
  document: TomlDocument,
  state: ManagedRuntimeConfigState,
): Effect.Effect<Readonly<{ document: TomlDocument; state: ManagedRuntimeConfigState }>, unknown> {
  return Effect.gen(function* () {
    const legacy = Object.fromEntries(
      Object.entries(state.managed).filter(([key]) =>
        (LEGACY_ROOT_CONFIG_KEY_PATHS as readonly string[]).includes(key),
      ),
    );
    if (Object.keys(legacy).length === 0) return { document, state };
    const cleanup = yield* cleanupManagedRuntimeConfigEffect(
      document,
      { ...state, managed: legacy },
      { schema: state.schema, installId: state.installId },
    );
    const managed = Object.fromEntries(
      Object.entries(state.managed).filter(([key]) => !(key in legacy)),
    );
    return { document: cleanup.document, state: { ...state, managed } };
  });
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

function snapshotPlugins(
  manager: Required<Pick<OfficialPluginManager, "list">>,
  selected: readonly string[],
): Effect.Effect<readonly PluginSnapshot[], unknown> {
  return Effect.gen(function* () {
    const live = yield* Effect.tryPromise({
      try: () => manager.list(),
      catch: (error) => wrapPluginManagerError("list", error, "selected plugins"),
    });
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
  });
}

function writeTransaction(path: string, value: unknown): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const transaction = decodeSchema(InstallTransactionSchema, value);
    if (transaction === undefined) {
      return yield* Effect.fail(
        new InstallerError("state_corrupt", "The HolyCodex transaction state is invalid."),
      );
    }
    yield* Effect.tryPromise({
      try: () => writeAtomicState(path, asJsonValue(transaction)),
      catch: (error) => error,
    });
  });
}

function removeTransaction(path: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => rm(path, { force: false }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      isFsCode(error, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
}

function removeFileIfPresent(path: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => rm(path, { force: false }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      isFsCode(error, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
}

function attemptEffect<A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<
  | Readonly<{ readonly ok: true; readonly value: A }>
  | Readonly<{ readonly ok: false; readonly error: unknown }>
> {
  return effect.pipe(
    Effect.catchCause((cause) => Effect.fail(Cause.squash(cause))),
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }),
  );
}

function rollbackConfigTransaction(
  path: string,
  transaction: PreparingTransaction,
  baseline: TomlDocument,
  ownedPlugins: ReadonlySet<string>,
): Effect.Effect<Readonly<{ dev: number; ino: number }> | undefined, unknown> {
  return Effect.gen(function* () {
    const currentText = yield* Effect.tryPromise({
      try: () => optionalTextFile(path),
      catch: (error) => error,
    });
    if (currentText === undefined) return;
    let document = parseConfig(currentText, path);
    const managed: Record<string, ManagedRuntimeConfigState["managed"][string]> = {};
    let unsupportedConfigRestored = 0;
    for (const [keyPath, entry] of Object.entries(transaction.managed_config.managed)) {
      const managedKeyPath = keyPath as ManagedConfigKeyPath;
      const before = readTomlPath(baseline, managedKeyPath);
      const beforeSummary =
        before === undefined
          ? undefined
          : yield* summarizeManagedConfigValueEffect(managedKeyPath, before);
      if (JSON.stringify(beforeSummary ?? null) === JSON.stringify(entry.lastManagedValue)) {
        continue;
      }
      if (before !== undefined && beforeSummary?.kind === "digest") {
        const live = readTomlPath(document, managedKeyPath);
        if (
          live !== undefined &&
          JSON.stringify(yield* summarizeManagedConfigValueEffect(managedKeyPath, live)) ===
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
    const managedCleanup = yield* cleanupManagedRuntimeConfigEffect(
      document,
      { ...transaction.managed_config, managed },
      { schema: STATE_SCHEMA_EPOCH, installId: transaction.install_id },
    );
    document = managedCleanup.document;
    const pluginCleanup =
      transaction.plugin_config === undefined
        ? undefined
        : yield* cleanupHolyCodexPluginConfigEffect(document, transaction.plugin_config, {
            allowBeforeState: true,
          });
    if (pluginCleanup !== undefined) document = pluginCleanup.document;
    const providerCleanup =
      transaction.provider_config === undefined
        ? undefined
        : yield* cleanupProviderPluginConfigEffect(
            document,
            transaction.provider_config,
            ownedPlugins,
            {
              allowBeforeState: true,
            },
          );
    if (providerCleanup !== undefined) document = providerCleanup.document;
    if (transaction.plugin_config !== undefined) {
      for (const [name, parent, key] of [
        ["preference", "plugins", HOLYCODEX_PLUGIN_CONFIG_KEY],
        ["marketplace", "marketplaces", HOLYCODEX_MARKETPLACE_CONFIG_KEY],
      ] as const) {
        const restoration = yield* restoreUnsupportedPluginConfigEntry(
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
        const restoration = yield* restoreUnsupportedPluginConfigEntry(
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
    yield* Effect.tryPromise({
      try: () => writeAtomicText(path, serializeConfig(document)),
      catch: (error) => error,
    });
    const restored = yield* Effect.tryPromise({ try: () => lstat(path), catch: (error) => error });
    return restored.isFile() && !restored.isSymbolicLink()
      ? { dev: restored.dev, ino: restored.ino }
      : undefined;
  });
}

/** Verify effective Root configuration and every canonical native specialist profile. */
export function verifyEffectiveInstallEffect(
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
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => optionalTextFile(paths.configFile),
      catch: (error) => error,
    });
    const document = parseConfig(text, paths.configFile);
    const expected = expectedConfig;
    for (const [keyPath, expectedValue] of Object.entries(expected)) {
      const actual = readTomlPath(document, keyPath);
      if (keyPath === "developer_instructions") {
        if (
          typeof actual !== "string" ||
          actual !== expectedValue ||
          (yield* summarizeConfigValue(keyPath, actual)) !==
            state.managed[keyPath]?.lastManagedValue.value
        ) {
          return yield* Effect.fail(
            new InstallerError(
              "install_failed",
              "The effective Root instructions did not converge.",
            ),
          );
        }
      } else if (actual !== expectedValue) {
        return yield* Effect.fail(
          new InstallerError(
            "install_failed",
            `The effective Codex setting ${keyPath} did not converge.`,
          ),
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
        return yield* Effect.fail(
          new InstallerError("install_failed", `The ${agent.name} registration is missing.`),
        );
      }
      const expectedReference = nativeAgentConfigPath(agent.name, generationId);
      const rolePath = resolveAgentConfigPath(paths.configFile, expectedReference);
      const expectedPath = rolePath.replaceAll("\\", "/");
      const resolved = resolveAgentConfigPath(paths.configFile, ref).replaceAll("\\", "/");
      if (resolved !== expectedPath) {
        return yield* Effect.fail(
          new InstallerError(
            "install_failed",
            `The ${agent.name} registration is stale (expected ${expectedReference}; received ${ref}).`,
          ),
        );
      }
      const roleText = yield* Effect.tryPromise({
        try: () => optionalTextFile(rolePath),
        catch: (error) => error,
      });
      if (roleText === undefined)
        return yield* Effect.fail(
          new InstallerError("install_failed", `The ${agent.name} role file is missing.`),
        );
      if (
        preservedArtifacts.some(
          (preservedPath) => preservedPath.replaceAll("\\", "/") === expectedPath,
        )
      ) {
        return yield* Effect.fail(
          new InstallerError(
            "install_failed",
            `The ${agent.name} role file was kept after a conflict and cannot be activated.`,
          ),
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
        roleDoc["tool_output_token_limit"] !== undefined ||
        readTomlPath(roleDoc, "agents.enabled") !== false ||
        readTomlPath(roleDoc, "features.multi_agent") !== false ||
        readTomlPath(roleDoc, "features.multi_agent_v2") !== false ||
        readTomlPath(roleDoc, "features.agent_message_board") !== false ||
        readTomlPath(roleDoc, "features.context_management.experimental_mode") !== true ||
        Object.keys((roleDoc["features"] as Record<string, unknown> | undefined) ?? {}).some(
          (key) =>
            ![
              "multi_agent",
              "multi_agent_v2",
              "agent_message_board",
              "context_management",
            ].includes(key),
        )
      ) {
        return yield* Effect.fail(
          new InstallerError("install_failed", `The ${agent.name} role file is malformed.`),
        );
      }
    }
    const legacyRoot = yield* Effect.tryPromise({
      try: () => optionalTextFile(`${paths.codexHome}/agents/root.toml`),
      catch: (error) => error,
    });
    if (legacyRoot !== undefined && isKnownLegacyRootRoleContent(legacyRoot)) {
      return yield* Effect.fail(
        new InstallerError("install_failed", "A stale HolyCodex Root role remains installed."),
      );
    }
  });
}

function summarizeConfigValue(keyPath: string, value: string): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    return yield* Effect.tryPromise({
      try: () =>
        domainSeparatedSha256("holycodex-managed-config-value", [
          canonicalJsonUtf8({ keyPath, value: value }),
        ]),
      catch: (error) => error,
    });
  });
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

function createEmptyCodexConfigEffect(
  path: string,
): Effect.Effect<Readonly<{ dev: number; ino: number }> | undefined, unknown> {
  return Effect.gen(function* () {
    yield* ensureOwnedDirectoryEffect(dirname(path));
    const openResult = yield* Effect.tryPromise({
      try: () => open(path, "wx", 0o600),
      catch: (error) => error,
    }).pipe(
      Effect.match({ onFailure: (error) => ({ error }), onSuccess: (handle) => ({ handle }) }),
    );
    if ("error" in openResult) {
      if (isFsCode(openResult.error, "EEXIST")) return undefined;
      return yield* Effect.fail(openResult.error);
    }
    const handle = openResult.handle;
    return yield* Effect.acquireUseRelease(
      Effect.succeed(handle),
      (file) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => file.stat(),
            catch: (error) => error,
          });
          yield* Effect.tryPromise({ try: () => file.sync(), catch: (error) => error });
          return { dev: stat.dev, ino: stat.ino };
        }),
      (file) => Effect.tryPromise({ try: () => file.close(), catch: (error) => error }),
    );
  });
}

function sameFileIdentity(
  path: string,
  identity: Readonly<{ dev: number; ino: number }> | undefined,
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    if (identity === undefined) return false;
    const statResult = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: (error) => error,
    }).pipe(Effect.match({ onFailure: (error) => ({ error }), onSuccess: (stat) => ({ stat }) }));
    if ("error" in statResult) {
      if (isFsCode(statResult.error, "ENOENT")) return false;
      return yield* Effect.fail(statResult.error);
    }
    const stat = statResult.stat;
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  });
}

function isLegacyWorkPlugin(pluginId: string): boolean {
  const name = pluginId.slice(0, pluginId.lastIndexOf("@"));
  return LEGACY_WORK_PLUGIN_NAMES.has(name);
}

function installAndVerifyEffect(
  manager: Required<Pick<OfficialPluginManager, "list" | "add">>,
  ids: readonly string[],
  refreshIds: ReadonlySet<string>,
  onMutation:
    | ((id: string, mutation: "new" | "uncertain") => Effect.Effect<void, unknown>)
    | undefined,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const list = (id: string) =>
      Effect.tryPromise({
        try: () => manager.list(),
        catch: (error) => wrapPluginManagerError("list", error, id),
      });
    const add = (id: string) =>
      Effect.tryPromise({
        try: () => manager.add(id),
        catch: (error) => wrapPluginManagerError("add", error, id),
      });
    const recordMutation = (id: string, mutation: "new" | "uncertain") =>
      onMutation?.(id, mutation) ?? Effect.void;

    for (const id of ids) {
      const refresh = refreshIds.has(id);
      const beforeResult = yield* list(id).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (plugins) => ({ before: findPlugin(plugins, id) }),
        }),
      );
      if ("error" in beforeResult) return yield* Effect.fail(beforeResult.error);
      const before = beforeResult.before;
      if (before?.installed && !before.enabled) {
        return yield* Effect.fail(new PluginVerificationError("uncertain", `${id} is disabled`));
      }
      const addAttempted = refresh || !(before?.installed && before.enabled);
      if (addAttempted) {
        const addResult = yield* add(id).pipe(
          Effect.match({ onFailure: (error) => ({ error }), onSuccess: () => ({ added: true }) }),
        );
        if ("error" in addResult) {
          const afterFailureResult = yield* list(id).pipe(
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: (plugins) => ({ afterFailure: findPlugin(plugins, id) }),
            }),
          );
          if (
            "error" in afterFailureResult ||
            refresh ||
            !samePluginState(before, afterFailureResult.afterFailure)
          ) {
            yield* recordMutation(id, "uncertain");
          }
          return yield* Effect.fail(addResult.error);
        }
      }
      const afterResult = yield* list(id).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (plugins) => ({ after: findPlugin(plugins, id) }),
        }),
      );
      if ("error" in afterResult) {
        if (addAttempted) yield* recordMutation(id, "uncertain");
        return yield* Effect.fail(afterResult.error);
      }
      const after = afterResult.after;
      if (!after?.installed) {
        if (addAttempted && (refresh || !samePluginState(before, after))) {
          yield* recordMutation(id, "uncertain");
        }
        return yield* Effect.fail(
          new PluginVerificationError("missing", `${id} is not installed after add`),
        );
      }
      if (addAttempted && after.enabled) {
        yield* recordMutation(id, refresh ? "uncertain" : "new");
      }
      if (!after.enabled) {
        if (addAttempted) yield* recordMutation(id, refresh ? "uncertain" : "new");
        return yield* Effect.fail(
          new PluginVerificationError("uncertain", `${id} is disabled after add`),
        );
      }
    }
  });
}

function removeAndVerifyEffect(
  manager: Required<Pick<OfficialPluginManager, "list" | "remove">>,
  ids: readonly string[],
  onMutation:
    | ((id: string, mutation: "absent" | "removed" | "uncertain") => Effect.Effect<void, unknown>)
    | undefined,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const list = (id: string) =>
      Effect.tryPromise({
        try: () => manager.list(),
        catch: (error) => wrapPluginManagerError("list", error, id),
      });
    const remove = (id: string) =>
      Effect.tryPromise({
        try: () => manager.remove(id),
        catch: (error) => wrapPluginManagerError("remove", error, id),
      });
    const recordMutation = (id: string, mutation: "absent" | "removed" | "uncertain") =>
      onMutation?.(id, mutation) ?? Effect.void;

    for (const id of ids) {
      const beforeResult = yield* list(id).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (plugins) => ({ before: findPlugin(plugins, id) }),
        }),
      );
      if ("error" in beforeResult) {
        yield* recordMutation(id, "uncertain");
        return yield* Effect.fail(beforeResult.error);
      }
      const before = beforeResult.before;
      if (!(before?.installed ?? false)) {
        yield* recordMutation(id, "absent");
        continue;
      }
      const removeResult = yield* remove(id).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ removed: true }),
        }),
      );
      if ("error" in removeResult) {
        const afterFailureResult = yield* list(id).pipe(
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: (plugins) => ({ afterFailure: findPlugin(plugins, id) }),
          }),
        );
        yield* recordMutation(
          id,
          "error" in afterFailureResult || afterFailureResult.afterFailure?.installed
            ? "uncertain"
            : "removed",
        );
        return yield* Effect.fail(removeResult.error);
      }
      const afterResult = yield* list(id).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (plugins) => ({ after: findPlugin(plugins, id) }),
        }),
      );
      if ("error" in afterResult) {
        yield* recordMutation(id, "uncertain");
        return yield* Effect.fail(afterResult.error);
      }
      if (afterResult.after?.installed) {
        yield* recordMutation(id, "uncertain");
        return yield* Effect.fail(
          new PluginVerificationError("uncertain", `${id} is still installed after remove`),
        );
      }
      yield* recordMutation(id, "removed");
    }
  });
}

function restoreRemovedPluginEffect(
  manager: Required<Pick<OfficialPluginManager, "list" | "add">>,
  id: string,
  priorStatus: PluginSnapshot["status"] | undefined,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (priorStatus !== "installed" && priorStatus !== "disabled") {
      return yield* Effect.fail(
        new PluginVerificationError("uncertain", `${id} has no proven prior installed state`),
      );
    }
    const expectedEnabled = priorStatus === "installed";
    const beforePlugins = yield* Effect.tryPromise({
      try: () => manager.list(),
      catch: (error) => wrapPluginManagerError("list", error, id),
    });
    const before = findPlugin(beforePlugins, id);
    if (before?.installed && before.enabled === expectedEnabled) return;
    yield* Effect.tryPromise({
      try: () => manager.add(id),
      catch: (error) => wrapPluginManagerError("add", error, id),
    });
    const afterPlugins = yield* Effect.tryPromise({
      try: () => manager.list(),
      catch: (error) => wrapPluginManagerError("list", error, id),
    });
    const after = findPlugin(afterPlugins, id);
    if (!after?.installed) {
      return yield* Effect.fail(
        new PluginVerificationError("missing", `${id} is not installed after restore`),
      );
    }
    if (after.enabled !== expectedEnabled) {
      return yield* Effect.fail(
        new PluginVerificationError(
          "uncertain",
          `${id} did not regain its prior ${expectedEnabled ? "enabled" : "disabled"} state`,
        ),
      );
    }
  });
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
export function installRecordDigest(value: InstallRecordDigestInput): Promise<string> {
  return Effect.runPromise(installRecordDigestEffect(value));
}

function installRecordDigestEffect(
  value: InstallRecordDigestInput,
): Effect.Effect<string, unknown> {
  const { profile, plan, ...rest } = value;
  const payload = Object.fromEntries(
    Object.entries(plan === undefined ? { ...rest, profile } : { ...rest, plan }).filter(
      ([, entry]) => entry !== undefined,
    ),
  );
  return Effect.tryPromise({
    try: () => domainSeparatedSha256("install-record", [canonicalJsonUtf8(asJsonValue(payload))]),
    catch: (error) => error,
  });
}

/** Check whether an install record still matches its authenticated digest. */
export function recordDigestMatches(record: InstallRecord): Promise<boolean> {
  return Effect.runPromise(recordDigestMatchesRawEffect(record));
}

function recordDigestMatchesRawEffect(record: {
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
}): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const digest = yield* installRecordDigestEffect({
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
  });
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

function resolveOwnedConflictInventory(
  options: InstallerOptions,
  conflicts: readonly ManagedConflict[],
  preserveDeclined = false,
): Effect.Effect<
  {
    readonly accepted: readonly ManagedConflict[];
    readonly decisions: ReadonlyMap<string, ConflictDecision>;
  },
  unknown
> {
  return Effect.gen(function* () {
    const structured = conflicts.map(structureConflict);
    const decisions = new Map<string, ConflictDecision>();
    if (structured.length === 0) return { accepted: [], decisions };
    if (options.resolveConflicts !== undefined) {
      const selectionResult = yield* options.resolveConflicts!(structured).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (selected) => ({ selected }),
        }),
      );
      if ("error" in selectionResult) {
        const error = selectionResult.error;
        if (!(error instanceof InstallerError) || error.code !== "confirmation_required") {
          return yield* Effect.fail(error);
        }
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
        return yield* Effect.fail(
          new InstallerError(
            "confirmation_required",
            `${error.message} Conflicts: ${summary}.`,
            error,
            { conflicts: summary },
          ),
        );
      }
      const selected = selectionResult.selected;
      for (const conflict of structured) {
        const identity = conflict.identity!;
        const decision = decodeSchema(ConflictDecisionSchema, selected[identity]);
        if (decision === undefined || conflict.validDecisions?.includes(decision) === false) {
          const choices = conflict.validDecisions?.join(", ") ?? "keep, replace, cancel";
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `The conflict at ${conflict.target} requires one of these decisions: ${choices}.`,
              undefined,
              {
                identity,
                path: conflict.path,
                ...(conflict.key === undefined ? {} : { key: conflict.key }),
              },
            ),
          );
        }
        if (decision === "cancel") {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `Conflict resolution was cancelled for ${conflict.target} at ${conflict.path}.`,
              undefined,
              {
                identity,
                path: conflict.path,
                ...(conflict.key === undefined ? {} : { key: conflict.key }),
              },
            ),
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
      const resolution = yield* options.resolveConflict === undefined
        ? Effect.succeed(undefined)
        : options.resolveConflict(conflict);
      if (resolution === "accept") {
        const decision = conflict.action === "remove" ? "remove" : "replace";
        if (conflict.validDecisions?.includes(decision) === false) {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `The conflict at ${conflict.target} cannot be ${decision}d; choose ${conflict.validDecisions?.join(", ")}.`,
              undefined,
              {
                identity: conflict.identity!,
                path: conflict.path,
                ...(conflict.key === undefined ? {} : { key: conflict.key }),
              },
            ),
          );
        }
        accepted.push(conflict);
        decisions.set(conflict.identity!, decision);
        continue;
      }
      if (resolution === "decline" && preserveDeclined) {
        if (conflict.validDecisions?.includes("keep") === false) {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `The conflict at ${conflict.target} cannot be kept; choose ${conflict.validDecisions?.join(", ")}.`,
              undefined,
              {
                identity: conflict.identity!,
                path: conflict.path,
                ...(conflict.key === undefined ? {} : { key: conflict.key }),
              },
            ),
          );
        }
        decisions.set(conflict.identity!, "keep");
        continue;
      }
      return yield* Effect.fail(
        new InstallerError(
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
        ),
      );
    }
    return { accepted, decisions };
  });
}

function reportProgress(options: InstallerOptions, event: InstallProgressEvent): void {
  Effect.runSync(
    Effect.ignore(Effect.try({ try: () => options.onProgress?.(event), catch: (error) => error })),
  );
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
/** Promise adapter for external callers of readEffectiveInstallRequest. */
export function readEffectiveInstallRequest(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallRequest> {
  return Effect.runPromise(readEffectiveInstallRequestEffect(options, environment));
}

/** Promise adapter for external callers of installHolyCodex. */
export function installHolyCodex(
  request: InstallRequest = {},
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallResult> {
  return Effect.runPromise(installHolyCodexEffect(request, options, environment));
}

/** Promise adapter for external callers of readActiveInstallRecord. */
export function readActiveInstallRecord(
  paths: ResolvedInstallerPaths,
): Promise<InstallRecord | undefined> {
  return Effect.runPromise(readActiveInstallRecordEffect(paths));
}

/** Promise adapter for external callers of readInstallTransaction. */
export function readInstallTransaction(
  path: string,
  active?: InstallRecord,
): Promise<
  | (Omit<InstallRecord, "status" | "step"> & {
      readonly status: "preparing" | "conflicted";
      readonly step: InstallTransactionStep;
    })
  | undefined
> {
  return Effect.runPromise(readInstallTransactionEffect(path, active));
}

/** Promise adapter for external callers of snapshotHolyCodexPluginConfig. */
export function snapshotHolyCodexPluginConfig(
  document: TomlDocument,
): Promise<PluginConfigSnapshot["before"]> {
  return Effect.runPromise(snapshotHolyCodexPluginConfigEffect(document));
}

/** Promise adapter for external callers of cleanupHolyCodexPluginConfig. */
export function cleanupHolyCodexPluginConfig(
  document: TomlDocument,
  snapshot: PluginConfigSnapshot,
  options: Readonly<{ readonly allowBeforeState?: boolean }> = {},
): Promise<PluginConfigCleanupResult> {
  return Effect.runPromise(cleanupHolyCodexPluginConfigEffect(document, snapshot, options));
}

/** Promise adapter for external callers of cleanupProviderPluginConfig. */
export function cleanupProviderPluginConfig(
  document: TomlDocument,
  snapshots: readonly ProviderPluginConfigSnapshot[],
  ownedPlugins: ReadonlySet<string>,
  options: Readonly<{ readonly allowBeforeState?: boolean }> = {},
): Promise<ProviderPluginConfigCleanupResult> {
  return Effect.runPromise(
    cleanupProviderPluginConfigEffect(document, snapshots, ownedPlugins, options),
  );
}

/** Promise adapter for external callers of verifyEffectiveInstall. */
export function verifyEffectiveInstall(
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
  return Effect.runPromise(
    verifyEffectiveInstallEffect(
      paths,
      profile,
      tier,
      capabilities,
      state,
      preservedArtifacts,
      expectedConfig,
    ),
  );
}
