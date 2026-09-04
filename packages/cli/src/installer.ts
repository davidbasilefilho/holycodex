// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";

import {
  compareManagedConfigKey,
  createManagedRuntimeConfigState,
  deleteTomlPath,
  mergeManagedRuntimeConfig,
  readTomlPath,
  resolveAgentConfigPath,
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
  STATE_SCHEMA_EPOCH,
  canonicalJsonUtf8,
  domainSeparatedSha256,
  lookupPlan,
  migratePlanName,
  pluginIdsForOptionalCapabilities,
  resolveOptionalCapabilitySelections,
  ServiceTierSchema,
  type JsonObject,
  type OptionalCapabilityName,
  type OptionalCapabilitySelections,
  type PlanName,
  type ServiceTier,
} from "@holycodex/core";

import { asJsonValue } from "./json.ts";
import { readCanonicalBaseVersion } from "./manifest.ts";
import {
  installNativeAgents,
  removeManagedNativeAgents,
  projectRootAgent,
  rootDeveloperInstructions,
  isKnownLegacyRootRoleContent,
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
  InstallRequestSchema,
  InstallTransactionSchema,
  JsonObjectSchema,
} from "./schema.ts";
import { optionalJsonFile, optionalTextFile, writeAtomicJson, writeAtomicText } from "./storage.ts";
import { parseToml, stringifyToml } from "./toml.ts";
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
} from "./types.ts";

export {
  CapabilityInstallStateSchema,
  CapabilityStateRecordSchema,
  InstallRequestSchema,
  InstallRecordSchema,
  InstallTransactionSchema,
} from "./schema.ts";

export const HOLYCODEX_MARKETPLACE = "davidbasilefilho/holycodex";
export const HOLYCODEX_PLUGIN = "holycodex@holycodex";

export interface InstallRequest {
  readonly plan?: PlanName | undefined;
  readonly tier?: ServiceTier | undefined;
  readonly optional?: ExplicitOptionalSelections | undefined;
  readonly officialPlugins?: readonly string[] | undefined;
}

type PreparingTransaction = Omit<InstallRecord, "status" | "step"> & {
  readonly status: "preparing";
  readonly step: InstallTransactionStep;
  readonly managed_config: ManagedRuntimeConfigState;
  readonly plugin_snapshot: readonly PluginSnapshot[];
  readonly owned_plugins: readonly string[];
};

const HOLYCODEX_MARKETPLACE_URL = "https://github.com/davidbasilefilho/holycodex.git" as const;
const HOLYCODEX_PLUGIN_CONFIG_KEY = "holycodex@holycodex";
const HOLYCODEX_MARKETPLACE_CONFIG_KEY = "holycodex";

export async function installHolyCodex(
  request: InstallRequest = {},
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallResult> {
  if (decodeSchema(InstallRequestSchema, request) === undefined) {
    throw new InstallerError("install_failed", "The installation options are invalid.");
  }
  const paths = resolveInstallerPaths(options, environment);
  await ensureOwnedDirectory(paths.stateRoot);
  const preparing = await optionalJsonFile(paths.preparingRecord, InstallTransactionSchema);
  if (preparing !== undefined) {
    throw new InstallerError(
      "state_corrupt",
      "A previous HolyCodex operation is still preparing and must converge before reinstalling.",
      undefined,
      { path: paths.preparingRecord },
    );
  }
  const conflicted = await optionalJsonFile(paths.conflictedRecord, InstallTransactionSchema);
  if (conflicted !== undefined) {
    throw new InstallerError(
      "state_corrupt",
      "A previous HolyCodex operation is conflicted and must converge before reinstalling.",
      undefined,
      { path: paths.conflictedRecord },
    );
  }
  const previous = await readActiveInstallRecord(paths);
  if (previous !== undefined && !(await recordDigestMatches(previous))) {
    throw new InstallerError(
      "state_corrupt",
      "The existing HolyCodex configuration has changed and cannot be replaced.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  const plan = choosePlan(request.plan, previous?.plan);
  const tier = chooseTier(request.tier, previous?.tier);
  const optional = chooseOptional(request.optional, previous?.optional_selections);
  const explicitOptional = mergeExplicitOptionalSelections(
    previous?.explicit_optional_selections,
    request.optional,
  );
  const additionalPlugins = request.officialPlugins ?? additionalPluginsFromPrevious(previous);
  const providerPlugins = pluginIdsForOptionalCapabilities(
    toCoreSelections(optional),
    additionalPlugins,
  );
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
  if (manager.ensureOfficialMarketplace !== undefined) {
    try {
      await manager.ensureOfficialMarketplace(providerPlugins);
    } catch (error: unknown) {
      throw new InstallerError(
        "capability_denied",
        `The selected official Codex provider marketplace is unavailable: ${safeMessage(error)}`,
        error,
        { recovery: "Check Codex network and marketplace policy, then retry." },
      );
    }
  }

  const installId = previous?.install_id ?? crypto.randomUUID().replaceAll("-", "");
  const version = await readCanonicalBaseVersion();
  const installedAt = (options.now?.() ?? new Date()).toISOString();
  const configBefore = await optionalTextFile(paths.configFile);
  const configInputDocument = parseConfig(configBefore);
  const pluginConfigBefore =
    previous?.plugin_config?.before ?? (await snapshotHolyCodexPluginConfig(configInputDocument));
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
  const providerConfigBefore = currentProviderConfig.map((entry) => {
    const previousEntry = previous?.provider_config?.find(
      (candidate) => candidate.plugin_id === entry.plugin_id,
    );
    return previousEntry === undefined
      ? entry
      : { plugin_id: entry.plugin_id, before: previousEntry.before, after: previousEntry.before };
  });
  const configDocument = migrateKnownLegacyRoleRegistrations(configInputDocument, previous);
  const currentManagedConfig =
    previous?.managed_config ??
    createManagedRuntimeConfigState({ schema: STATE_SCHEMA_EPOCH, installId });
  rejectPreExistingDeveloperInstructions(configDocument, currentManagedConfig);
  const desiredConfig = desiredRootConfig(plan, tier);
  const mergedConfig = await mergeManagedRuntimeConfig(
    configDocument,
    currentManagedConfig,
    desiredConfig,
    { schema: STATE_SCHEMA_EPOCH, installId },
  );
  if (mergedConfig.driftedKeys.length > 0) {
    throw new InstallerError(
      "state_corrupt",
      "HolyCodex-owned Codex settings changed and cannot be replaced safely.",
      undefined,
      { keys: mergedConfig.driftedKeys.join(",") },
    );
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
  const transaction = {
    owner: "holycodex" as const,
    schema_epoch: STATE_SCHEMA_EPOCH,
    install_id: installId,
    version,
    digest: previous?.digest ?? "0".repeat(64),
    plan,
    tier,
    optional_selections: optional,
    explicit_optional_selections: explicitOptional,
    official_plugins: providerPlugins,
    capability_state: capabilityStateFor(optional),
    managed_artifacts: previous?.managed_artifacts ?? [],
    installed_at: installedAt,
    status: "preparing" as const,
    step: "validated" as const,
    managed_config: mergedConfig.state,
    plugin_snapshot: pluginSnapshot,
    plugin_config: {
      plugin_id: HOLYCODEX_PLUGIN as "holycodex@holycodex",
      before: pluginConfigBefore,
      after: pluginConfigBefore,
    },
    provider_config: providerConfigBefore,
    owned_plugins: [...new Set(previous?.owned_plugins ?? [])],
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
    await ensureOwnedDirectory(paths.roleRoot);
    native = await installNativeAgents(paths.codexHome, plan, previous?.managed_artifacts, tier);
    transactionForRecovery = {
      ...transaction,
      step: "roles_prepared",
      managed_artifacts: native.managed_artifacts,
    };
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    pluginEffectsStarted = true;
    await manager.addMarketplace!(HOLYCODEX_MARKETPLACE);
    const nativeManager = {
      list: () => manager.list!(),
      add: (id: string) => manager.add!(id),
    };
    await installAndVerify(
      nativeManager,
      [HOLYCODEX_PLUGIN, ...providerPlugins],
      (id, mutation) => {
        if (mutation === "new") {
          addedPlugins.add(id);
          ownedPlugins.add(id);
          transactionForRecovery = {
            ...transactionForRecovery,
            owned_plugins: [...ownedPlugins],
          };
        } else uncertainPluginMutations.add(id);
      },
    );
    transactionForRecovery = { ...transactionForRecovery, step: "plugins_installed" };
    await writeTransaction(paths.preparingRecord, transactionForRecovery);
    const configAfterPlugins = await optionalTextFile(paths.configFile);
    configRollbackBaseline = configAfterPlugins;
    const postPluginDocument = parseConfig(configAfterPlugins);
    const pluginConfigAfter = await snapshotHolyCodexPluginConfig(postPluginDocument);
    const currentProviderConfigAfter = await snapshotProviderPluginConfig(
      postPluginDocument,
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
      postPluginDocument,
      configDocument,
      currentManagedConfig,
      desiredConfig,
    );
    const postPluginConfig = await mergeManagedRuntimeConfig(
      postPluginDocument,
      currentManagedConfig,
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
    await verifyEffectiveInstall(paths, plan, tier, publishedConfigState, native.preserved);
    const capabilityState = capabilityStateFor(optional);
    const digest = await installRecordDigest({
      owner: "holycodex",
      install_id: installId,
      version,
      plan,
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
    });
    const record: InstallRecord = {
      owner: "holycodex",
      schema_epoch: STATE_SCHEMA_EPOCH,
      install_id: installId,
      version,
      digest,
      plan,
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
    };
    if (decodeSchema(InstallRecordSchema, record) === undefined) {
      throw new InstallerError("state_corrupt", "The HolyCodex configuration is invalid.");
    }
    await writeAtomicJson(paths.activeRecord, asJsonValue(record));
    await removeTransaction(paths.preparingRecord);
    await removeTransaction(paths.conflictedRecord);
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
    if (pluginEffectsStarted && !pluginConfigBaselineValidated) rollbackFailures.push("config");
    if (native !== undefined) {
      const previousPaths = new Set((previous?.managed_artifacts ?? []).map((item) => item.path));
      try {
        await removeManagedNativeAgents(
          paths.codexHome,
          native.managed_artifacts.filter((item) => !previousPaths.has(item.path)),
        );
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

export async function readActiveInstallRecord(
  paths: ResolvedInstallerPaths,
): Promise<InstallRecord | undefined> {
  const raw = await optionalJsonFile(paths.activeRecord, JsonObjectSchema);
  if (raw === undefined) return undefined;
  const current = decodeSchema(InstallRecordSchema, raw);
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
  const migratedPlan = migratePlanName(legacy.plan);
  const migrated = {
    ...legacy,
    plan: migratedPlan,
    digest: await installRecordDigest({
      owner: legacy.owner,
      install_id: legacy.install_id,
      version: legacy.version,
      plan: migratedPlan,
      tier: legacy.tier,
      optional_selections: legacy.optional_selections,
      explicit_optional_selections: legacy.explicit_optional_selections,
      official_plugins: legacy.official_plugins ?? [],
      capability_state: legacy.capability_state ?? null,
      managed_artifacts: legacy.managed_artifacts,
      ...(legacy.managed_config === undefined ? {} : { managed_config: legacy.managed_config }),
      ...(legacy.plugin_config === undefined ? {} : { plugin_config: legacy.plugin_config }),
      ...(legacy.provider_config === undefined ? {} : { provider_config: legacy.provider_config }),
      ...(legacy.plugin_snapshot === undefined ? {} : { plugin_snapshot: legacy.plugin_snapshot }),
      ...(legacy.owned_plugins === undefined ? {} : { owned_plugins: legacy.owned_plugins }),
    }),
  } as InstallRecord;
  return migrated;
}

export { removeManagedNativeAgents };

function toCoreSelections(value: OptionalSelections): OptionalCapabilitySelections {
  return {
    computer_use: value.computer_use,
    work: value.work,
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

export function desiredRootConfig(
  plan: PlanName,
  tier: ServiceTier,
): Partial<Record<ManagedConfigKeyPath, string | boolean>> {
  const root = projectRootAgent(plan, tier);
  return {
    model: root.model,
    model_reasoning_effort: root.effort,
    service_tier: root.serviceTier,
    model_verbosity: "low",
    developer_instructions: rootDeveloperInstructions(),
    suppress_unstable_features_warning: true,
    "features.default_mode_request_user_input": true,
    "features.multi_agent_v2": true,
    "features.context_management.experimental_mode": true,
    "agents.explorer.config_file": "holycodex/agents/explorer.toml",
    "agents.librarian.config_file": "holycodex/agents/librarian.toml",
    "agents.worker.config_file": "holycodex/agents/worker.toml",
    "agents.reviewer.config_file": "holycodex/agents/reviewer.toml",
  };
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

function migrateKnownLegacyRoleRegistrations(
  document: TomlDocument,
  previous: InstallRecord | undefined,
): TomlDocument {
  if (!previous) return document;
  const legacyArtifacts = previous.managed_artifacts.map((artifact) => artifact.path);
  let output = document;
  for (const role of ["explorer", "librarian", "worker", "reviewer"] as const) {
    const hasLegacyRoleArtifact = legacyArtifacts.some((path) =>
      path.startsWith(`agents/${role[0]?.toUpperCase()}${role.slice(1)}.`),
    );
    if (!hasLegacyRoleArtifact) continue;
    const keyPath = `agents.${role}.config_file` as const;
    const value = readTomlPath(output, keyPath);
    if (typeof value !== "string") continue;
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (normalized === `agents/${role}.toml`) output = deleteTomlPath(output, keyPath);
  }
  return output;
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

export async function verifyEffectiveInstall(
  paths: ResolvedInstallerPaths,
  plan: PlanName,
  tier: ServiceTier,
  state: ManagedRuntimeConfigState,
  preservedArtifacts: readonly string[] = [],
): Promise<void> {
  const text = await optionalTextFile(paths.configFile);
  const document = parseConfig(text);
  const expected = desiredRootConfig(plan, tier);
  for (const [keyPath, expectedValue] of Object.entries(expected)) {
    const actual = readTomlPath(document, keyPath);
    if (keyPath === "developer_instructions") {
      if (
        typeof actual !== "string" ||
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
  for (const role of ["explorer", "librarian", "worker", "reviewer"] as const) {
    const keyPath = `agents.${role}.config_file` as const;
    const ref = readTomlPath(document, keyPath);
    if (typeof ref !== "string") {
      throw new InstallerError("install_failed", `The ${role} role registration is missing.`);
    }
    const expectedPath = `${paths.roleRoot}/${role}.toml`.replaceAll("\\", "/");
    const resolved = resolveAgentConfigPath(paths.configFile, ref).replaceAll("\\", "/");
    if (resolved !== expectedPath) {
      throw new InstallerError("install_failed", `The ${role} role registration is stale.`);
    }
    const roleText = await optionalTextFile(`${paths.roleRoot}/${role}.toml`);
    if (roleText === undefined)
      throw new InstallerError("install_failed", `The ${role} role file is missing.`);
    if (preservedArtifacts.includes(`${paths.roleRoot}/${role}.toml`)) continue;
    const roleDoc = parseConfig(roleText);
    if (
      roleDoc["name"] !== role ||
      typeof roleDoc["description"] !== "string" ||
      typeof roleDoc["model"] !== "string" ||
      typeof roleDoc["model_reasoning_effort"] !== "string" ||
      typeof roleDoc["service_tier"] !== "string" ||
      typeof roleDoc["developer_instructions"] !== "string" ||
      readTomlPath(roleDoc, "agents.enabled") !== false ||
      readTomlPath(roleDoc, "features.multi_agent_v2") !== false ||
      readTomlPath(roleDoc, "features.multi_agent") !== false
    ) {
      throw new InstallerError("install_failed", `The ${role} role file is malformed.`);
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
  for (const name of ["computer_use", "work", "frontend", "security"] as const) {
    const value = requested?.[name] ?? previous?.[name];
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

function optionalCapabilityForPlugin(pluginId: string): OptionalCapabilityName | undefined {
  return (["computer_use", "work", "frontend", "security"] as const).find((name) =>
    CAPABILITY_REGISTRY[name].pluginIds.includes(pluginId),
  );
}

function additionalPluginsFromPrevious(previous: InstallRecord | undefined): readonly string[] {
  return (previous?.official_plugins ?? []).filter((pluginId) => {
    const capability = optionalCapabilityForPlugin(pluginId);
    return capability === undefined || previous?.optional_selections[capability] !== true;
  });
}

async function installAndVerify(
  manager: Required<Pick<OfficialPluginManager, "list" | "add">>,
  ids: readonly string[],
  onMutation?: (id: string, mutation: "new" | "uncertain") => void,
): Promise<void> {
  for (const id of ids) {
    let before;
    try {
      before = findPlugin(await manager.list(), id);
    } catch (error: unknown) {
      throw wrapPluginManagerError("list", error, id);
    }
    if (before?.installed && !before.enabled) {
      throw new PluginVerificationError("uncertain", `${id} is disabled`);
    }
    const addAttempted = !(before?.installed && before.enabled);
    if (!(before?.installed && before.enabled)) {
      try {
        await manager.add(id);
      } catch (error: unknown) {
        onMutation?.(id, "uncertain");
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
      if (addAttempted) onMutation?.(id, "uncertain");
      throw new PluginVerificationError("missing", `${id} is not installed after add`);
    }
    if (addAttempted && after.enabled) onMutation?.(id, "new");
    if (!after.enabled) {
      if (addAttempted) onMutation?.(id, "new");
      throw new PluginVerificationError("uncertain", `${id} is disabled after add`);
    }
  }
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
  return [...live.installed, ...live.available].find((entry) => entry.pluginId === id);
}

function choosePlan(requested: PlanName | undefined, previous: PlanName | undefined): PlanName {
  const value = requested ?? previous ?? "plus";
  if (!lookupPlan(value).ok) throw new InstallerError("install_failed", "Unknown plan.");
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
    work: selected.work,
    frontend: selected.frontend,
    security: selected.security,
    coding: true,
  };
}

function capabilityStateFor(
  selections: OptionalSelections,
  failures: ReadonlyMap<OptionalCapabilityName, "missing" | "uncertain"> = new Map(),
): CapabilityStateRecord {
  const names = ["computer_use", "work", "frontend", "security"] as const;
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
  readonly plan: PlanName | "Go";
  readonly tier: ServiceTier;
  readonly optional_selections: OptionalSelections;
  readonly explicit_optional_selections: ExplicitOptionalSelections;
  readonly official_plugins: readonly string[];
  readonly capability_state: CapabilityStateRecord | null;
  readonly managed_artifacts: readonly { readonly path: string; readonly digest: string }[];
  readonly managed_config?: ManagedRuntimeConfigState | undefined;
  readonly plugin_config?: PluginConfigSnapshot | undefined;
  readonly provider_config?: readonly ProviderPluginConfigSnapshot[] | undefined;
  readonly plugin_snapshot?: readonly PluginSnapshot[] | undefined;
  readonly owned_plugins?: readonly string[] | undefined;
};

export async function installRecordDigest(value: InstallRecordDigestInput): Promise<string> {
  return await domainSeparatedSha256("install-record", [canonicalJsonUtf8(asJsonValue(value))]);
}

export async function recordDigestMatches(record: InstallRecord): Promise<boolean> {
  return await recordDigestMatchesRaw(record);
}

async function recordDigestMatchesRaw(record: {
  readonly owner: "holycodex";
  readonly install_id: string;
  readonly version: string;
  readonly plan: PlanName | "Go";
  readonly tier: ServiceTier;
  readonly optional_selections: OptionalSelections;
  readonly explicit_optional_selections: ExplicitOptionalSelections;
  readonly official_plugins?: readonly string[] | undefined;
  readonly capability_state?: CapabilityStateRecord | undefined;
  readonly managed_artifacts: readonly { readonly path: string; readonly digest: string }[];
  readonly managed_config?: ManagedRuntimeConfigState | undefined;
  readonly plugin_config?: PluginConfigSnapshot | undefined;
  readonly provider_config?: readonly ProviderPluginConfigSnapshot[] | undefined;
  readonly plugin_snapshot?: readonly PluginSnapshot[] | undefined;
  readonly owned_plugins?: readonly string[] | undefined;
  readonly digest: string;
}): Promise<boolean> {
  const digest = await installRecordDigest({
    owner: record.owner,
    install_id: record.install_id,
    version: record.version,
    plan: record.plan,
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
  });
  return digest === record.digest;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}

export class InstallerError extends Error {
  readonly code: "install_failed" | "capability_denied" | "permission_denied" | "state_corrupt";
  readonly causeValue: unknown;
  readonly details: JsonObject;

  constructor(
    code: InstallerError["code"],
    message: string,
    causeValue?: unknown,
    details: JsonObject = {},
  ) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    this.causeValue = causeValue;
    this.details = details;
  }
}
