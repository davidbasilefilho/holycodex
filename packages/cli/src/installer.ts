// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  deleteTomlPath,
  mergeManagedRuntimeConfig,
  readTomlPath,
  resolveAgentConfigPath,
  resolveOfficialPluginEntry,
  summarizeManagedConfigValue,
  writeTomlPath,
  TomlDocumentSchema,
  type ManagedConfigKeyPath,
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
  canonicalJsonUtf8,
  canonicalOfficialPluginId,
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
  type ServiceTier,
} from "@holycodex/core";

import { asJsonValue } from "./json.ts";
import { readCanonicalBaseVersion } from "./manifest.ts";
import {
  installNativeAgents,
  inspectNativeAgentConflicts,
  isKnownLegacyRootRoleContent,
  projectNativeAgents,
  projectRootAgent,
  nativeAgentSandboxMode,
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
  ManagedConflict,
} from "./types.ts";

export {
  CapabilityInstallStateSchema,
  CapabilityStateRecordSchema,
  InstallRequestSchema,
  InstallRecordSchema,
  InstallOptionsSchema,
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
 * effects are being applied. This relation lets recovery ignore a stale transaction left after a
 * newer active record was published; it does not attempt to authenticate same-user filesystem
 * state.
 */
export function isTransactionBoundToActive(
  transaction: Readonly<Pick<InstallRecord, "install_id" | "digest">>,
  active: Readonly<Pick<InstallRecord, "install_id" | "digest">>,
): boolean {
  return transaction.install_id === active.install_id && transaction.digest === active.digest;
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
        profile: request.profile ?? interrupted.profile,
        tier: request.tier ?? interrupted.tier,
        optional: {
          computer_use:
            request.optional?.computer_use ?? interrupted.optional_selections.computer_use,
          frontend: request.optional?.frontend ?? interrupted.optional_selections.frontend,
          security: request.optional?.security ?? interrupted.optional_selections.security,
        },
        officialPlugins: request.officialPlugins ?? additionalPluginsFromPrevious(interrupted),
      },
      options,
      environment,
    );
  }
  const profile = chooseProfile(request.profile, previous?.profile);
  const tier = chooseTier(request.tier, previous?.tier);
  const optional = chooseOptional(request.optional, previous?.optional_selections);
  const explicitOptional = mergeExplicitOptionalSelections(
    previous?.explicit_optional_selections,
    request.optional,
  );
  const additionalPlugins = request.officialPlugins ?? additionalPluginsFromPrevious(previous);
  const runtime = options.runtime ?? createInstallerRuntime(environment);
  const discoveredGitBash = await ensureGitBash(runtime, false);
  let gitBash: GitBashState = discoveredGitBash;
  let context7: Context7ToolState;
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
  const version = await readCanonicalBaseVersion();
  const refreshPluginIds =
    previous !== undefined &&
    previous.version !== version &&
    previous.owned_plugins?.includes(HOLYCODEX_PLUGIN) === true
      ? new Set([HOLYCODEX_PLUGIN])
      : new Set<string>();
  const installedAt = (options.now?.() ?? new Date()).toISOString();
  const configBefore = await optionalTextFile(paths.configFile);
  const configInputDocument = parseConfig(configBefore);
  const currentHolyCodexPluginConfig = await snapshotHolyCodexPluginConfig(configInputDocument);
  const pluginConfigBefore = previous?.plugin_config?.before ?? currentHolyCodexPluginConfig;
  if (previous?.plugin_config !== undefined) {
    const conflicts = (["preference", "marketplace"] as const).filter((name) => {
      const current = currentHolyCodexPluginConfig[name].digest;
      return (
        current !== previous.plugin_config?.after[name].digest &&
        current !== previous.plugin_config?.before[name].digest
      );
    });
    await resolveOwnedConflicts(
      options,
      conflicts.map((name) => ({
        path: paths.configFile,
        key: name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex",
        action: "replace" as const,
      })),
    );
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
    await resolveOwnedConflicts(
      options,
      conflicts.map((entry) => ({
        path: paths.configFile,
        key: `plugins."${entry.plugin_id}"`,
        action: "replace" as const,
      })),
    );
  }
  const providerConfigBefore = currentProviderConfig.map((entry) => {
    const previousEntry = previous?.provider_config?.find(
      (candidate) => candidate.plugin_id === entry.plugin_id,
    );
    return previousEntry === undefined
      ? entry
      : { plugin_id: entry.plugin_id, before: previousEntry.before, after: previousEntry.before };
  });
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
  const configDocument = migratedContext.document;
  const currentManagedConfig = migratedContext.state;
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
  let mergedConfig: Awaited<ReturnType<typeof mergeManagedRuntimeConfig>>;
  try {
    mergedConfig = await mergeManagedRuntimeConfig(
      configDocument,
      currentManagedConfig,
      desiredConfig,
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
  if (mergedConfig.driftedKeys.length > 0) {
    await resolveOwnedConflicts(
      options,
      mergedConfig.driftedKeys.map((key) => ({ path: paths.configFile, key, action: "replace" })),
    );
    let acceptedDocument = configDocument;
    const acceptedManaged = { ...currentManagedConfig.managed };
    for (const key of mergedConfig.driftedKeys) {
      const existing = acceptedManaged[key];
      const desiredValue = desiredConfig[key];
      if (existing === undefined || desiredValue === undefined) {
        throw new InstallerError(
          "state_corrupt",
          "The managed conflict cannot be verified.",
          undefined,
          {
            path: paths.configFile,
            key,
          },
        );
      }
      let live = readTomlPath(acceptedDocument, key);
      if (live === undefined) {
        acceptedDocument = writeTomlPath(acceptedDocument, key, desiredValue);
        live = desiredValue;
      }
      acceptedManaged[key] = {
        ...existing,
        lastManagedValue: await summarizeManagedConfigValue(key, live),
      };
    }
    mergedConfig = await mergeManagedRuntimeConfig(
      acceptedDocument,
      { ...currentManagedConfig, managed: acceptedManaged },
      desiredConfig,
      { schema: STATE_SCHEMA_EPOCH, installId },
    );
    if (mergedConfig.driftedKeys.length > 0) {
      throw new InstallerError("state_corrupt", "The accepted managed conflicts did not converge.");
    }
  }
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
  const acceptedNativeConflicts = await resolveOwnedConflicts(options, nativeConflicts, true);
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
    managed_config: mergedConfig.state,
    plugin_snapshot: [],
    plugin_config: {
      plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
      before: pluginConfigBefore,
      after: pluginConfigBefore,
    },
    provider_config: providerConfigBefore,
    owned_plugins: [...new Set(previous?.owned_plugins ?? [])],
    ...(previous?.tooling === undefined ? {} : { tooling: previous.tooling }),
  };
  await ensureOwnedDirectory(paths.stateRoot);
  await writeTransaction(paths.preparingRecord, preMutationTransaction);
  try {
    gitBash = await ensureGitBash(runtime, true);
    context7 = await ensureContext7(runtime, true, previous?.tooling?.context7);
  } catch (error: unknown) {
    if (error instanceof ToolingError) {
      throw new InstallerError("capability_denied", error.message, error, error.details);
    }
    throw error;
  }
  const tooling = { git_bash: gitBash, context7 } as const;
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

  let pluginSnapshot: readonly PluginSnapshot[];
  try {
    pluginSnapshot = await snapshotPlugins({ list: () => manager.list!() }, [
      ...new Set([HOLYCODEX_PLUGIN, ...providerPlugins, ...(previous?.owned_plugins ?? [])]),
    ]);
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      "Native Codex plugin state could not be read safely.",
      error,
    );
  }
  const transaction: PreparingTransaction = {
    ...preMutationTransaction,
    plugin_snapshot: pluginSnapshot,
    tooling,
  };
  await writeTransaction(paths.preparingRecord, transaction);

  let native: NativeAgentInstallResult | undefined;
  let configPublished = false;
  const addedPlugins = new Set<string>();
  const ownedPlugins = new Set(previous?.owned_plugins ?? []);
  const uncertainPluginMutations = new Set<string>();
  let transactionForRecovery: PreparingTransaction = transaction;
  let pluginEffectsStarted = false;
  let pluginConfigBaselineValidated = false;
  let configRollbackBaseline = configBefore;
  let publishedConfigState = mergedConfig.state;
  try {
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
      acceptedNativeConflicts,
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
    await manager.addMarketplace!(HOLYCODEX_MARKETPLACE);
    const nativeManager = {
      list: () => manager.list!(),
      add: (id: string) => manager.add!(id),
    };
    await installAndVerify(
      nativeManager,
      [HOLYCODEX_PLUGIN, ...providerPlugins],
      refreshPluginIds,
      (id, mutation) => {
        if (mutation === "new") {
          addedPlugins.add(id);
          ownedPlugins.add(id);
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
          transactionForRecovery = {
            ...transactionForRecovery,
            owned_plugins: [...ownedPlugins],
          };
        }
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
    configRollbackBaseline = configAfterPlugins;
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
    const stablePostPluginDocument = postPluginContext.document;
    const stableManagedConfig = postPluginContext.state;
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
    await assertPostPluginConfigStable(
      stablePostPluginDocument,
      configDocument,
      stableManagedConfig,
      desiredConfig,
    );
    const postPluginConfig = await mergeManagedRuntimeConfig(
      stablePostPluginDocument,
      stableManagedConfig,
      desiredConfig,
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
    pluginConfigBaselineValidated = true;
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
    await writeAtomicText(paths.configFile, serializeConfig(postPluginConfig.document));
    configPublished = true;
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
    await writeAtomicJson(paths.activeRecord, asJsonValue(record));
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
    if (configPublished) {
      try {
        await restoreConfig(paths.configFile, configRollbackBaseline);
      } catch {
        rollbackFailures.push("config");
      }
    }
    if (pluginEffectsStarted && !pluginConfigBaselineValidated) {
      const currentConfig = await optionalTextFile(paths.configFile).catch(() => undefined);
      if (currentConfig !== configRollbackBaseline) rollbackFailures.push("config");
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
    if (rollbackFailures.length > 0) {
      await writeTransaction(paths.conflictedRecord, {
        ...transactionForRecovery,
        step: "conflicted",
        status: "conflicted",
      }).catch(() => undefined);
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
  value: TomlTable,
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
): Partial<Record<ManagedConfigKeyPath, string | boolean>> {
  const root = projectRootAgent(profile, tier);
  const desired: Partial<Record<ManagedConfigKeyPath, string | boolean>> = {
    model: root.model,
    model_reasoning_effort: root.effort,
    service_tier: root.serviceTier,
    model_verbosity: "low",
    developer_instructions: rootDeveloperInstructions(capabilities),
    suppress_unstable_features_warning: true,
    "features.default_mode_request_user_input": true,
    "features.multi_agent": true,
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
  desired: Readonly<Partial<Record<ManagedConfigKeyPath, string | boolean>>>,
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
    if (before !== after) drifted.push(keyPath);
  }
  if (drifted.length > 0) {
    throw new InstallerError(
      "state_corrupt",
      "Codex settings changed during native plugin setup.",
      undefined,
      { keys: drifted.join(",") },
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

async function restoreConfig(path: string, before: string | undefined): Promise<void> {
  if (before === undefined) {
    await rm(path, { force: false }).catch((error: unknown) => {
      if (!isFsCode(error, "ENOENT")) throw error;
    });
    return;
  }
  await writeAtomicText(path, before);
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
): Promise<void> {
  const text = await optionalTextFile(paths.configFile);
  const document = parseConfig(text);
  const expected = desiredRootConfig(profile, tier, capabilities);
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
      roleDoc["sandbox_mode"] !== nativeAgentSandboxMode(agent) ||
      roleDoc["approval_policy"] !== "never" ||
      roleDoc["web_search"] !== (agent.permissions.network ? "live" : "disabled") ||
      roleDoc["tool_output_token_limit"] !== undefined ||
      readTomlPath(roleDoc, "agents.enabled") !== false ||
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
  onMutation?: (id: string, mutation: "new" | "uncertain") => void,
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
          if (refresh || !samePluginState(before, afterFailure)) onMutation?.(id, "uncertain");
        } catch {
          onMutation?.(id, "uncertain");
        }
        throw wrapPluginManagerError("add", error, id);
      }
    }
    let after;
    try {
      after = findPlugin(await manager.list(), id);
    } catch (error: unknown) {
      if (addAttempted) onMutation?.(id, "uncertain");
      throw wrapPluginManagerError("list", error, id);
    }
    if (!after?.installed) {
      if (addAttempted && (refresh || !samePluginState(before, after))) {
        onMutation?.(id, "uncertain");
      }
      throw new PluginVerificationError("missing", `${id} is not installed after add`);
    }
    if (addAttempted && after.enabled) onMutation?.(id, refresh ? "uncertain" : "new");
    if (!after.enabled) {
      if (addAttempted) onMutation?.(id, refresh ? "uncertain" : "new");
      throw new PluginVerificationError("uncertain", `${id} is disabled after add`);
    }
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
  operation: "list" | "add",
  error: unknown,
  pluginId: string,
): OfficialPluginManagerError {
  if (error instanceof OfficialPluginManagerError) return error;
  return new OfficialPluginManagerError(
    operation === "list" ? "list_failed" : "add_failed",
    operation === "list"
      ? `Codex could not read the status of ${pluginId}.`
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
  readonly version: string;
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

export async function recordDigestMatches(record: InstallRecord): Promise<boolean> {
  return await recordDigestMatchesRaw(record);
}

async function recordDigestMatchesRaw(record: {
  readonly owner: "holycodex";
  readonly install_id: string;
  readonly version: string;
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

async function resolveOwnedConflicts(
  options: InstallerOptions,
  conflicts: readonly {
    readonly path: string;
    readonly key?: string | undefined;
    readonly action: "replace" | "remove";
  }[],
  preserveDeclined = false,
): Promise<readonly ManagedConflict[]> {
  const accepted: ManagedConflict[] = [];
  for (const conflict of conflicts) {
    const resolution = await options.resolveConflict?.(conflict);
    if (resolution === "accept") {
      accepted.push(conflict);
      continue;
    }
    if (resolution === "decline" && preserveDeclined) continue;
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
  return accepted;
}

function reportProgress(options: InstallerOptions, event: InstallProgressEvent): void {
  try {
    options.onProgress?.(event);
  } catch {
    // Progress rendering is observational and must never change install semantics.
  }
}

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
