// SPDX-License-Identifier: Apache-2.0

import { rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  deleteTomlPath,
  isManagedConfigKeyPath,
  LEGACY_ROOT_CONFIG_KEY_PATHS,
  readTomlPath,
  resolveAgentConfigPath,
  resolveOfficialPluginEntry,
  type ManagedConfigKeyPath,
  type ManagedRuntimeConfigState,
  type TomlDocument,
  type TomlTable,
  type TomlValue,
  type LiveOfficialPluginListEnvelope,
} from "@holycodex/codex";
import {
  canonicalJsonUtf8,
  DEFAULT_CAPABILITY_SELECTIONS,
  compareReleaseVersions,
  domainSeparatedSha256,
  pluginIdsForOptionalCapabilities,
  type ReleaseVersion,
} from "@holycodex/core";

import {
  CODEX_DESKTOP_BROWSER_PLUGIN_ID,
  HOLYCODEX_PLUGIN,
  cleanupHolyCodexPluginConfig,
  cleanupProviderPluginConfig,
  desiredRootConfig,
  parseConfig,
  readActiveInstallRecord,
  readInstallTransaction,
  recordDigestMatches,
  serializeConfig,
  InstallerError,
  assertInstallTransactionState,
  assertRemovalTransactionState,
  diagnoseInstallTransactions,
  installHolyCodex,
  installRequestFromPersistedOptions,
  type InstallRequest,
  isTransactionBoundToActive,
  readInstallOptions,
  validateInstallOptions,
} from "./installer.ts";
import { asJsonValue } from "./json.ts";
import { readInstallationVersion } from "./manifest.ts";
import {
  isKnownLegacyRootRoleContent,
  changedNativeAgentRemovalConflicts,
  inspectNativeAgentConflicts,
  inspectNativeAgentRemovalConflicts,
  nativeAgentConfigPath,
  nativeAgentGenerationId,
  projectNativeAgents,
  renderNativeAgent,
  nativeAgentSandboxConfigurationMatches,
  removeManagedNativeAgents,
} from "./native-agents.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import {
  assertNoSymlinkTree,
  isFsCode,
  resolveInstallerPaths,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import { decodeSchema, InstallTransactionSchema } from "./schema.ts";
import { optionalTextFile, writeAtomicJson, writeAtomicText } from "./storage.ts";
import {
  createInstallerRuntime,
  inspectContext7ReadOnly,
  removeOwnedContext7,
  sameInstallerFile,
} from "./tooling.ts";
import type {
  DoctorCheck,
  DoctorResult,
  InstallerOptions,
  InstallRecord,
  RemoveResult,
  InstallProgressEvent,
  UpgradeRequest,
  UpgradeResult,
  ManagedConflict,
} from "./types.ts";

const LEGACY_WORK_PLUGIN_NAMES = new Set([
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "template-creator",
]);

/** Inspect HolyCodex paths, records, runtime configuration, plugins, and tooling health. */
export async function doctorHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DoctorResult> {
  const paths = resolveInstallerPaths(options, environment);
  const checks: Record<string, DoctorCheck> = {};
  try {
    await assertNoSymlinkTree(paths.codexHome);
    await assertNoSymlinkTree(paths.stateRoot);
    checks["paths"] = healthyCheck({ state_root: paths.stateRoot });
  } catch (error: unknown) {
    checks["paths"] = failedCheck(["path_symlink"], { error: safeMessage(error) });
  }

  const active = await readActiveInstallRecord(paths).catch((error: unknown) => {
    checks["configuration"] = failedCheck(["state_corrupt"], { error: safeMessage(error) });
    return undefined;
  });
  const [preparing, conflicted] = await Promise.all([
    readInstallTransaction(paths.preparingRecord, active).catch((error: unknown) => {
      checks["transaction"] = failedCheck(["state_corrupt"], {
        path: paths.preparingRecord,
        error: safeMessage(error),
      });
      return undefined;
    }),
    readInstallTransaction(paths.conflictedRecord, active).catch((error: unknown) => {
      checks["transaction"] = failedCheck(["state_corrupt"], {
        path: paths.conflictedRecord,
        error: safeMessage(error),
      });
      return undefined;
    }),
  ]);
  if (
    checks["transaction"]?.status !== "failed" &&
    (preparing !== undefined || conflicted !== undefined)
  ) {
    const diagnoses = diagnoseInstallTransactions(active, preparing, conflicted);
    const reasons = [
      ...new Set(
        diagnoses.map((diagnosis) => {
          if (diagnosis.relation === "stale") return "stale_transaction_state";
          if (diagnosis.relation === "incompatible") return "incompatible_transaction_state";
          return diagnosis.status === "preparing" ? "incomplete_install_state" : "conflicted_state";
        }),
      ),
    ];
    checks["transaction"] = failedCheck(reasons, {
      recovery: diagnoses.map((diagnosis) => diagnosis.recovery).join(","),
      transactions: diagnoses
        .map(
          (diagnosis) =>
            `${diagnosis.status}:${diagnosis.relation}:${diagnosis.install_id}:${diagnosis.digest}`,
        )
        .join(","),
      active: active === undefined ? "absent" : `${active.install_id}:${active.digest}`,
    });
  }

  if (!checks["configuration"]) {
    if (!active) {
      checks["configuration"] = failedCheck(["configuration_missing"]);
    } else if (await recordDigestMatches(active)) {
      checks["configuration"] = healthyCheck({
        profile: active.profile,
        tier: active.tier,
        install_id: active.install_id,
      });
    } else {
      checks["configuration"] = failedCheck(["configuration_changed"], {
        path: paths.activeRecord,
      });
    }
  }

  if (active) {
    checks["runtime_config"] = await doctorRuntimeConfig(paths, active);
    checks["native_roles"] = await doctorNativeRoles(paths, active.profile, active.tier, {
      browserUse:
        active.capability_state?.browser_use.status === "healthy" &&
        active.capability_state.browser_use.selected,
      computerUse:
        active.capability_state?.computer_use.status === "healthy" &&
        active.capability_state.computer_use.selected,
    });
    const failedCapability = Object.entries(active.capability_state ?? {}).find(
      ([name, value]) => name !== "browser_use" && value.selected && value.status !== "healthy",
    );
    if (failedCapability) {
      checks["capabilities"] = failedCheck(["selected_capability_not_healthy"], {
        capability: failedCapability[0]!,
        status: failedCapability[1].status,
      });
    }
    if (active.optional_selections.browser_use) {
      checks["browser_use"] = {
        status: "unsupported",
        reasons: ["surface_managed_by_codex_desktop"],
        details: {
          selected: true,
          owner: "Codex Desktop/runtime",
          availability: "Available only on Codex surfaces that provide Browser Use.",
          cli_provisioning: "HolyCodex CLI does not install, configure, or verify Browser.",
        },
      };
    }
  }

  const runtime = options.runtime ?? createInstallerRuntime(environment);
  try {
    const context7 = await inspectContext7ReadOnly(runtime, active?.tooling?.context7);
    checks["context7"] = healthyCheck({
      manager: context7.manager,
      version: context7.version,
      executable: context7.executable,
      ownership: context7.ownership,
    });
  } catch (error: unknown) {
    checks["context7"] = {
      status: "warning",
      reasons: ["context7_unavailable"],
      details: { error: safeMessage(error) },
    };
  }

  try {
    const legacyRoot = await optionalTextFile(`${paths.codexHome}/agents/root.toml`);
    if (legacyRoot !== undefined && isKnownLegacyRootRoleContent(legacyRoot)) {
      const existing = checks["native_roles"];
      checks["native_roles"] = {
        status: "failed",
        reasons: [...(existing?.reasons ?? []), "stale_legacy_root"],
        details: { ...existing?.details, path: `${paths.codexHome}/agents/root.toml` },
      };
    }
  } catch (error: unknown) {
    checks["native_roles"] = failedCheck(["native_role_invalid"], {
      error: safeMessage(error),
    });
  }

  // Live Codex inventory is required to observe remote provider aliases; the CLI
  // supplies it when available and falls back to installed manifests otherwise.
  const manager = options.officialPluginManager;
  if (active && manager?.status) {
    const selected = [
      ...new Set([
        HOLYCODEX_PLUGIN,
        ...pluginIdsForOptionalCapabilities(
          {
            browser_use: active.optional_selections.browser_use,
            computer_use: active.optional_selections.computer_use,
            sites: active.optional_selections.sites,
          },
          active.official_plugins,
        ),
        ...(active.owned_plugins ?? []).filter(
          (pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID,
        ),
      ]),
    ].filter((pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID);
    try {
      const status = await manager.status(selected);
      const missing = Object.entries(status)
        .filter(([, value]) => value !== "installed")
        .map(([id]) => id);
      const observed = manager.getObservedIdentities?.() ?? {};
      checks["native_plugins"] =
        missing.length === 0
          ? healthyCheck({ status, observed_identities: observed })
          : failedCheck(["native_plugin_disagreement"], {
              missing,
              status,
              observed_identities: observed,
            });
    } catch (error: unknown) {
      checks["native_plugins"] = failedCheck(["native_plugin_status_failed"], {
        error: safeMessage(error),
      });
    }
  } else {
    checks["native_plugins"] = failedCheck(["native_plugin_status_unavailable"], {
      reason: "No read-only live official plugin status source is available.",
    });
  }
  const reasons = Object.values(checks).flatMap((check) => check.reasons);
  return {
    healthy: Object.values(checks).every((check) => check.status !== "failed"),
    checks,
    reasons: [...new Set(reasons)],
  };
}

/** Discover provably owned removal conflicts without mutating installation or provider state. */
export async function inspectRemovalConflicts(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly (ManagedConflict & { readonly action: "remove" })[]> {
  const paths = resolveInstallerPaths(options, environment);
  await assertNoSymlinkTree(paths.codexHome);
  await assertNoSymlinkTree(paths.stateRoot);
  const active = await readActiveInstallRecord(paths);
  if (active !== undefined && !(await recordDigestMatches(active))) {
    throw new InstallerError(
      "state_corrupt",
      "The HolyCodex ownership record has an invalid digest and cannot authorize removal.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  const [preparing, conflicted] = await Promise.all([
    readInstallTransaction(paths.preparingRecord, active),
    readInstallTransaction(paths.conflictedRecord, active),
  ]);
  assertRemovalTransactionState(active, preparing, conflicted);
  const recovery = selectRecoveryState(active, preparing, conflicted);
  if (recovery === undefined) return [];
  const document = parseConfig(await optionalTextFile(paths.configFile));
  const conflicts: (ManagedConflict & { readonly action: "remove" })[] = [];
  if (recovery.managed_config !== undefined) {
    const cleanup = await cleanupManagedRuntimeConfig(document, recovery.managed_config, {
      schema: recovery.managed_config.schema,
      installId: recovery.managed_config.installId,
    });
    for (const key of [...cleanup.preservedKeys, ...cleanup.unresolvedKeys]) {
      conflicts.push(
        await removalConfigConflict(
          paths.configFile,
          key,
          document,
          "config-key",
          "This managed Codex setting changed after installation.",
        ),
      );
    }
  }
  if (recovery.plugin_config !== undefined) {
    const cleanup = await cleanupHolyCodexPluginConfig(document, recovery.plugin_config, {
      allowBeforeState: true,
    });
    for (const name of cleanup.preserved) {
      const key =
        name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex";
      conflicts.push(
        await removalConfigConflict(
          paths.configFile,
          key,
          document,
          "plugin-config",
          "This HolyCodex plugin setting differs from the recorded install state.",
        ),
      );
    }
  }
  if (recovery.provider_config !== undefined) {
    const cleanup = await cleanupProviderPluginConfig(
      document,
      withoutCodexDesktopManagedPlugins(recovery.provider_config),
      new Set(ownedPluginsForRemoval(recovery)),
      { allowBeforeState: true },
    );
    for (const pluginId of cleanup.preserved) {
      const key = `plugins.${JSON.stringify(pluginId)}`;
      conflicts.push(
        await removalConfigConflict(
          paths.configFile,
          key,
          document,
          "plugin-config",
          `The ${pluginId} plugin setting differs from the recorded install state.`,
        ),
      );
    }
  }
  conflicts.push(
    ...(await inspectNativeAgentRemovalConflicts(paths.codexHome, recovery.managed_artifacts)),
  );
  return [...new Map(conflicts.map((conflict) => [conflictIdentity(conflict), conflict])).values()];
}

/** Remove HolyCodex-owned state while preserving unrelated or user-modified data. */
export async function removeHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RemoveResult> {
  const paths = resolveInstallerPaths(options, environment);
  await assertNoSymlinkTree(paths.codexHome);
  await assertNoSymlinkTree(paths.stateRoot);
  const active = await readActiveInstallRecord(paths);
  if (active && !(await recordDigestMatches(active))) {
    throw new InstallerError(
      "state_corrupt",
      "The HolyCodex ownership record has an invalid digest and cannot authorize removal.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  const [preparing, conflicted] = await Promise.all([
    readInstallTransaction(paths.preparingRecord, active),
    readInstallTransaction(paths.conflictedRecord, active),
  ]);
  assertRemovalTransactionState(active, preparing, conflicted);
  const recovery = selectRecoveryState(active, preparing, conflicted);
  reportProgress(options, {
    stage: "removal",
    status: "started",
    message: "Removing HolyCodex-owned state",
  });
  const ownedPlugins = new Set(ownedPluginsForRemoval(recovery));
  const removed: string[] = [];
  const preserved: string[] = [];
  const reasons: string[] = [];
  let removalCheckpointWritten = false;
  const returnPreservedState = (): RemoveResult => {
    reportProgress(options, {
      stage: "removal",
      status: "completed",
      message: "HolyCodex removal preserved state for review",
    });
    return { removed, preserved, reasons };
  };
  if (recovery === undefined) {
    reportProgress(options, {
      stage: "removal",
      status: "completed",
      message: "Nothing to remove",
    });
    return { removed, preserved, reasons };
  }
  const removalConflicts = await inspectRemovalConflicts(options, environment);
  const acceptedRemovalConflicts = await resolveRemovalConflicts(options, removalConflicts);

  const configBefore = await optionalTextFile(paths.configFile);
  let configBeforeDocument = parseConfig(configBefore);
  const acceptedConfigConflicts = removalConflicts.filter(
    (conflict) =>
      conflict.key !== undefined && acceptedRemovalConflicts.has(conflictIdentity(conflict)),
  );
  const reviewedNativeConflicts = new Map<string, string>();
  for (const conflict of removalConflicts) {
    if (conflict.key !== undefined || !acceptedRemovalConflicts.has(conflictIdentity(conflict))) {
      continue;
    }
    const digest = reviewedConflictDigest(conflict);
    if (digest !== undefined) reviewedNativeConflicts.set(conflict.path, digest);
  }
  await assertRemovalReviewUnchanged(
    paths,
    configBeforeDocument,
    acceptedConfigConflicts,
    reviewedNativeConflicts,
  );
  let recoveryManagedConfig = recovery?.managed_config;
  if (recoveryManagedConfig) {
    const cleanup = await cleanupManagedRuntimeConfig(configBeforeDocument, recoveryManagedConfig, {
      schema: recoveryManagedConfig.schema,
      installId: recoveryManagedConfig.installId,
    });
    if (cleanup.preservedKeys.length > 0 || cleanup.unresolvedKeys.length > 0) {
      const keys = [...cleanup.preservedKeys, ...cleanup.unresolvedKeys];
      const conflicts = keys.map((key) => ({
        path: paths.configFile,
        key,
        action: "remove" as const,
      }));
      for (const conflict of conflicts) {
        if (acceptedRemovalConflicts.has(conflictIdentity(conflict))) {
          configBeforeDocument = deleteTomlPath(configBeforeDocument, conflict.key);
        }
      }
    }
  }
  if (recovery?.plugin_config) {
    const cleanup = await cleanupHolyCodexPluginConfig(
      configBeforeDocument,
      recovery.plugin_config,
      { allowBeforeState: true },
    );
    if (cleanup.preserved.length > 0) {
      const conflicts = cleanup.preserved.map((name) => ({
        path: paths.configFile,
        key: name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex",
        action: "remove" as const,
      }));
      for (const name of cleanup.preserved) {
        const conflict = conflicts.find(
          (candidate) =>
            candidate.key ===
            (name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex"),
        );
        if (conflict === undefined || !acceptedRemovalConflicts.has(conflictIdentity(conflict)))
          continue;
        configBeforeDocument = deleteTomlPath(
          configBeforeDocument,
          name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex",
        );
      }
    }
  }
  if (recovery?.provider_config) {
    const cleanup = await cleanupProviderPluginConfig(
      configBeforeDocument,
      withoutCodexDesktopManagedPlugins(recovery.provider_config),
      ownedPlugins,
      { allowBeforeState: true },
    );
    if (cleanup.preserved.length > 0) {
      const conflicts = cleanup.preserved.map((id) => ({
        path: paths.configFile,
        key: `plugins."${id}"`,
        action: "remove" as const,
      }));
      for (const id of cleanup.preserved) {
        const conflict = conflicts.find((candidate) => candidate.key === `plugins."${id}"`);
        if (conflict === undefined || !acceptedRemovalConflicts.has(conflictIdentity(conflict)))
          continue;
        configBeforeDocument = deleteTomlPath(configBeforeDocument, `plugins."${id}"`);
      }
    }
  }
  let manager: InstallerOptions["officialPluginManager"];
  let livePlugins: LiveOfficialPluginListEnvelope | undefined;
  if (ownedPlugins.size > 0) {
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
        "Native Codex plugin removal is unavailable.",
        error,
        {
          operation: "discover Codex",
          plugins: [...ownedPlugins].join(","),
          recovery: "Install or expose Codex, then retry.",
        },
      );
    }
    if (manager === undefined || !manager.remove || !manager.list) {
      throw new InstallerError(
        "capability_denied",
        "Native Codex plugin removal and readback are unavailable.",
        undefined,
        { operation: "prepare plugin removal", plugins: [...ownedPlugins].join(",") },
      );
    }
    try {
      livePlugins = await manager.list();
    } catch (error: unknown) {
      throw new InstallerError(
        "capability_denied",
        "Codex plugin state could not be read before removing HolyCodex-owned plugins.",
        error,
        {
          operation: "read Codex plugin state",
          plugins: [...ownedPlugins].join(","),
          recovery: "Repair or expose Codex, then retry removal.",
        },
      );
    }
  }

  let cleanedConfig:
    | { readonly document: TomlDocument; readonly state?: ManagedRuntimeConfigState }
    | undefined;
  let recoveryForRemoval = recovery;
  try {
    let document = configBeforeDocument;
    let managedState = recoveryManagedConfig;
    if (managedState) {
      const cleanup = await cleanupManagedRuntimeConfig(document, managedState, {
        schema: managedState.schema,
        installId: managedState.installId,
      });
      const conflictedKeys = [...cleanup.preservedKeys, ...cleanup.unresolvedKeys];
      const unresolvedKeys = conflictedKeys.filter(
        (key) =>
          !acceptedRemovalConflicts.has(
            conflictIdentity({ path: paths.configFile, key, action: "remove" }),
          ),
      );
      if (unresolvedKeys.length > 0) {
        preserved.push(paths.configFile);
        reasons.push("managed_config_changed");
        await writeConflictState(paths, recovery ?? emptyRemovalState());
        return returnPreservedState();
      }
      document = cleanup.document;
      if (conflictedKeys.length > 0) {
        const acceptedKeys = new Set(conflictedKeys);
        managedState = {
          ...cleanup.state,
          managed: Object.fromEntries(
            Object.entries(cleanup.state.managed).filter(
              ([key]) => !acceptedKeys.has(key as ManagedConfigKeyPath),
            ),
          ),
        };
      } else {
        managedState = cleanup.state;
      }
    }
    if (recovery?.plugin_config) {
      const cleanup = await cleanupHolyCodexPluginConfig(document, recovery.plugin_config, {
        allowBeforeState: true,
      });
      if (cleanup.preserved.length > 0) {
        preserved.push(paths.configFile);
        reasons.push("plugin_config_changed");
        await writeConflictState(paths, recovery);
        return returnPreservedState();
      }
      document = cleanup.document;
    }
    if (recovery?.provider_config) {
      const cleanup = await cleanupProviderPluginConfig(
        document,
        withoutCodexDesktopManagedPlugins(recovery.provider_config),
        ownedPlugins,
        { allowBeforeState: true },
      );
      if (cleanup.preserved.length > 0) {
        preserved.push(paths.configFile);
        reasons.push("provider_config_changed");
        await writeConflictState(paths, recovery);
        return returnPreservedState();
      }
      document = cleanup.document;
    }
    if (recovery?.managed_config || recovery?.plugin_config || recovery?.provider_config) {
      cleanedConfig = managedState === undefined ? { document } : { document, state: managedState };
    }
    if (cleanedConfig !== undefined) {
      if (Object.keys(cleanedConfig.document).length === 0 && configBefore === undefined) {
        await assertConfigTextUnchanged(paths.configFile, configBefore);
        await rm(paths.configFile, { force: false });
      } else {
        await assertConfigTextUnchanged(paths.configFile, configBefore);
        await writeAtomicText(paths.configFile, serializeConfig(cleanedConfig.document));
      }
      recoveryForRemoval = { ...recovery, managed_config: cleanedConfig.state };
      await writeConflictState(paths, recoveryForRemoval);
      removalCheckpointWritten = true;
    }
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      await writeConflictState(paths, recoveryForRemoval ?? emptyRemovalState());
      throw error;
    }
    preserved.push(paths.configFile);
    reasons.push("managed_config_write_failed");
    await writeConflictState(paths, recoveryForRemoval ?? emptyRemovalState());
    return returnPreservedState();
  }

  const native = await removeManagedNativeAgents(
    paths.codexHome,
    recovery?.managed_artifacts ?? [],
    reviewedNativeConflicts,
  );
  removed.push(...native.removed);
  preserved.push(...native.preserved);
  if (native.preserved.length > 0) {
    reasons.push("managed_artifact_changed");
    await writeConflictState(paths, recoveryForRemoval ?? recovery ?? emptyRemovalState());
    return returnPreservedState();
  }
  removed.push(
    ...(await removeEmptyManagedRoleGenerations(paths.roleRoot, recovery?.managed_artifacts ?? [])),
  );

  for (const pluginId of ownedPlugins) {
    try {
      if (
        manager?.list === undefined ||
        manager.remove === undefined ||
        livePlugins === undefined
      ) {
        throw new InstallerError(
          "capability_denied",
          "Codex plugin state is unavailable for a HolyCodex-owned plugin.",
          undefined,
          { operation: "remove Codex plugin", plugin_id: pluginId },
        );
      }
      const before = livePlugins;
      const observed = resolveOwnedPluginEntry(before, pluginId);
      if (observed?.entry.installed !== true) continue;
      const removalId = observed.entry.pluginId;
      await manager.remove(removalId);
      const live = await manager.list();
      livePlugins = live;
      const resolvedRemaining = resolveOfficialPluginEntry(live, pluginId)?.entry;
      const remaining =
        resolvedRemaining?.installed === true ||
        [...live.installed, ...live.available].some(
          (entry) => entry.pluginId === pluginId && entry.installed,
        );
      if (remaining) {
        throw new InstallerError(
          "capability_denied",
          `Codex still reports ${pluginId} after removal.`,
        );
      }
      if (cleanedConfig !== undefined) {
        await reconcileRemovedPluginPreference(paths, cleanedConfig.document, pluginId);
      }
      removed.push(pluginId);
    } catch (error: unknown) {
      reasons.push("native_plugin_remove_failed");
      await writeConflictState(paths, recoveryForRemoval ?? emptyRemovalState());
      throw new InstallerError(
        "capability_denied",
        `Codex native plugin removal did not converge for ${pluginId}: ${safeMessage(error)}`,
        error,
      );
    }
  }
  try {
    if (
      await removeOwnedContext7(
        options.runtime ?? createInstallerRuntime(environment),
        recovery.tooling?.context7,
      )
    ) {
      removed.push("ctx7");
    }
  } catch (error: unknown) {
    reasons.push("context7_remove_failed");
    await writeConflictState(paths, recoveryForRemoval ?? emptyRemovalState());
    throw new InstallerError(
      "capability_denied",
      `Context7 removal did not converge: ${safeMessage(error)}`,
      error,
    );
  }
  if (active) {
    try {
      await rm(paths.activeRecord, { force: false });
      removed.push(paths.activeRecord);
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) {
        preserved.push(paths.activeRecord);
        reasons.push("state_remove_failed");
        await writeConflictState(paths, recovery ?? active);
        return returnPreservedState();
      }
    }
  }
  if (preserved.length === 0) {
    try {
      await rm(paths.installOptions, { force: false });
      removed.push(paths.installOptions);
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) {
        preserved.push(paths.installOptions);
        reasons.push("state_remove_failed");
        await writeConflictState(paths, recovery ?? active ?? emptyRemovalState());
      }
    }
  }
  if (preserved.length === 0) {
    for (const [path, present] of [
      [paths.preparingRecord, preparing !== undefined],
      [paths.conflictedRecord, conflicted !== undefined || removalCheckpointWritten],
    ] as const) {
      if (!present) continue;
      try {
        await removeTransaction(path);
        removed.push(path);
      } catch {
        preserved.push(path);
        reasons.push("state_remove_failed");
      }
    }
  }
  if (preserved.length === 0) {
    try {
      await rmdir(paths.roleRoot);
      removed.push(paths.roleRoot);
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) {
        preserved.push(paths.roleRoot);
        reasons.push("role_directory_not_empty");
      }
    }
  }
  if (preserved.length === 0) {
    try {
      await rmdir(paths.stateRoot);
      removed.push(paths.stateRoot);
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) removed.push(paths.stateRoot);
      else {
        preserved.push(paths.stateRoot);
        reasons.push("state_directory_not_empty");
      }
    }
  }
  reportProgress(options, {
    stage: "removal",
    status: "completed",
    message:
      preserved.length === 0 && reasons.length === 0
        ? "HolyCodex removal complete"
        : "HolyCodex removal preserved state for review",
  });
  return { removed, preserved, reasons };
}

async function reconcileRemovedPluginPreference(
  paths: ResolvedInstallerPaths,
  expected: TomlDocument,
  pluginId: string,
): Promise<void> {
  const configText = await optionalTextFile(paths.configFile);
  if (configText === undefined) return;
  const document = parseConfig(configText, paths.configFile);
  const currentPlugins = document["plugins"];
  if (!isTomlTableValue(currentPlugins)) return;
  const current = currentPlugins[pluginId];
  if (
    !isTomlTableValue(current) ||
    Object.keys(current).length !== 1 ||
    current["enabled"] !== false
  ) {
    return;
  }
  const expectedPlugins = expected["plugins"];
  const preserved = isTomlTableValue(expectedPlugins) ? expectedPlugins[pluginId] : undefined;
  const plugins: Record<string, TomlValue> = { ...currentPlugins };
  if (preserved === undefined) delete plugins[pluginId];
  else plugins[pluginId] = preserved;
  const restored: Record<string, TomlValue> = { ...document };
  if (Object.keys(plugins).length === 0) delete restored["plugins"];
  else restored["plugins"] = plugins;
  await writeAtomicText(paths.configFile, serializeConfig(restored));
}

function isTomlTableValue(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove only empty generation directories named by this install's role artifacts. */
async function removeEmptyManagedRoleGenerations(
  roleRoot: string,
  artifacts: readonly InstallRecord["managed_artifacts"][number][],
): Promise<readonly string[]> {
  const generations = new Set<string>();
  for (const artifact of artifacts) {
    const parts = artifact.path.split("/");
    if (
      parts.length === 4 &&
      parts[0] === "holycodex" &&
      parts[1] === "agents" &&
      /^[a-f0-9]{20}$/u.test(parts[2] ?? "") &&
      parts[3]?.endsWith(".toml")
    ) {
      generations.add(parts[2]!);
    }
  }

  const removed: string[] = [];
  for (const generation of generations) {
    const directory = join(roleRoot, generation);
    try {
      await rmdir(directory);
      removed.push(directory);
    } catch (error: unknown) {
      // Non-empty generations can still contain user data or profiles referenced by
      // older threads. Keep them for the existing role-root preservation handling.
      if (
        !isFsCode(error, "ENOENT") &&
        !isFsCode(error, "ENOTEMPTY") &&
        !isFsCode(error, "EEXIST")
      ) {
        throw error;
      }
    }
  }
  return removed;
}

/** Migrate an existing installation in place using the running HolyCodex binary. */
export async function upgradeHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
  request: UpgradeRequest = {},
): Promise<UpgradeResult> {
  const paths = resolveInstallerPaths(options, environment);
  const active = await readActiveInstallRecord(paths);
  const [preparing, conflicted] = await Promise.all([
    readInstallTransaction(paths.preparingRecord, active),
    readInstallTransaction(paths.conflictedRecord, active),
  ]);
  if (active !== undefined && !(await recordDigestMatches(active))) {
    throw new InstallerError(
      "state_corrupt",
      "The existing HolyCodex configuration has changed and cannot be upgraded safely.",
      undefined,
      { path: paths.activeRecord },
    );
  }
  assertInstallTransactionState(active, preparing, conflicted);
  const transaction = selectRecoveryTransaction(active, preparing, conflicted);
  const source = transaction ?? active;
  if (source === undefined) {
    throw new InstallerError(
      "not_installed",
      "HolyCodex is not installed in the selected Codex home.",
      undefined,
      { recovery: "Run `holycodex install --yes` first." },
    );
  }
  const persistedOptions = await readInstallOptions(paths);
  const sourceOptions =
    persistedOptions === undefined
      ? {
          profile: source.profile,
          tier: source.tier,
          optional: {
            browser_use: source.optional_selections.browser_use,
            computer_use: source.optional_selections.computer_use,
            sites: source.optional_selections.sites,
          },
          officialPlugins: additionalPluginsFromRecord(source),
        }
      : withoutLegacyWorkPlugins(installRequestFromPersistedOptions(persistedOptions));
  const selectedOptions =
    request.options === undefined ? sourceOptions : validateInstallOptions(request.options);
  const effectiveOptions = {
    profile: selectedOptions.profile ?? sourceOptions.profile,
    tier: selectedOptions.tier ?? sourceOptions.tier,
    optional: {
      ...sourceOptions.optional,
      ...selectedOptions.optional,
    },
    officialPlugins: selectedOptions.officialPlugins ?? sourceOptions.officialPlugins,
  };
  const optionsChanged = !sameInstallOptions(effectiveOptions, sourceOptions);
  let targetVersion: ReleaseVersion;
  try {
    targetVersion = await readInstallationVersion();
  } catch (error: unknown) {
    throw new InstallerError(
      "upgrade_failed",
      "The running HolyCodex version is unavailable.",
      error,
    );
  }
  // A development artifact and its stable install record share one release
  // base. Reconciliation may cross that channel boundary in either direction;
  // older bases and older builds within the development channel remain blocked.
  const sameBaseChannelTransition =
    targetVersion.split("-", 1)[0] === source.version.split("-", 1)[0] &&
    targetVersion.includes("-dev.") !== source.version.includes("-dev.");
  const ordering = sameBaseChannelTransition
    ? 0
    : compareReleaseVersions(targetVersion, source.version);
  if (ordering < 0) {
    throw new InstallerError(
      "upgrade_downgrade",
      `The running HolyCodex version ${targetVersion} is older than the installed version ${source.version}.`,
      undefined,
      { installed_version: source.version, running_version: targetVersion },
    );
  }
  const legacyContext = source.managed_config?.managed["features.context_management"] !== undefined;
  const legacyAutoCompact =
    source.managed_config?.managed[LEGACY_ROOT_CONFIG_KEY_PATHS[0]!] !== undefined;
  const dryRunConflictInventory: ManagedConflict[] = [];
  if (request.dryRun === true) {
    const document = parseConfig(await optionalTextFile(paths.configFile));
    if (source.managed_config !== undefined) {
      for (const key of Object.keys(source.managed_config.managed) as ManagedConfigKeyPath[]) {
        if (!isManagedConfigKeyPath(key)) continue;
        const comparison = await compareManagedConfigKey(document, source.managed_config, key);
        if (comparison.status !== "unchanged") {
          dryRunConflictInventory.push({ path: paths.configFile, key, action: "replace" });
        }
      }
    }
    if (source.plugin_config !== undefined) {
      const cleanup = await cleanupHolyCodexPluginConfig(document, source.plugin_config);
      for (const name of cleanup.preserved) {
        const key =
          name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex";
        dryRunConflictInventory.push({ path: paths.configFile, key, action: "replace" });
      }
    }
    if (source.provider_config !== undefined) {
      const cleanup = await cleanupProviderPluginConfig(
        document,
        withoutCodexDesktopManagedPlugins(source.provider_config),
        new Set(ownedPluginsForRemoval(source)),
      );
      for (const pluginId of cleanup.preserved) {
        dryRunConflictInventory.push({
          path: paths.configFile,
          key: `plugins."${pluginId}"`,
          action: "replace",
        });
      }
    }
    const nativeConflicts = await inspectNativeAgentConflicts(
      paths.codexHome,
      source.profile,
      source.managed_artifacts,
      source.tier,
      {
        browserUse: source.optional_selections.browser_use,
        computerUse: source.optional_selections.computer_use,
      },
    );
    for (const conflict of nativeConflicts) {
      dryRunConflictInventory.push(conflict);
    }
  }
  let toolingDrift = false;
  const toolingDriftReasons: string[] = [];
  try {
    const runtime = options.runtime ?? createInstallerRuntime(environment);
    let context7: Awaited<ReturnType<typeof inspectContext7ReadOnly>> | undefined;
    try {
      context7 = await inspectContext7ReadOnly(runtime, source.tooling?.context7);
    } catch (error: unknown) {
      if (source.tooling?.context7 !== undefined || !isContext7Absent(error)) throw error;
    }
    const recordedContext7 = source.tooling?.context7;
    if (recordedContext7?.manager !== context7?.manager) {
      toolingDriftReasons.push("Context7 manager changed");
    }
    if (recordedContext7?.version !== context7?.version) {
      toolingDriftReasons.push("Context7 version changed");
    }
    if (
      recordedContext7?.executable === undefined
        ? context7?.executable !== undefined
        : context7?.executable === undefined ||
          !(await sameInstallerFile(runtime, recordedContext7.executable, context7.executable))
    ) {
      toolingDriftReasons.push("Context7 executable changed");
    }
    toolingDrift ||= toolingDriftReasons.length > 0;
  } catch (error: unknown) {
    toolingDrift = true;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : error instanceof Error
          ? error.name
          : "inspection failed";
    toolingDriftReasons.push(`inspection failed (${code})`);
  }
  const changes = [
    ...(ordering > 0 || sameBaseChannelTransition ? ["version"] : []),
    ...(optionsChanged ? ["installation options"] : []),
    ...(persistedOptions === undefined ? ["installation options migration"] : []),
    ...(legacyContext ? ["context-management configuration migration"] : []),
    ...(legacyAutoCompact ? ["auto-compaction configuration cleanup"] : []),
    ...(ordering > 0 || legacyContext || legacyAutoCompact
      ? ["Root/session configuration", "specialist role definitions"]
      : []),
    ...(transaction ? ["interrupted transaction recovery"] : []),
    ...(toolingDrift ? [`shared tooling reconciliation (${toolingDriftReasons.join(", ")})`] : []),
    ...dryRunConflictInventory.map(
      (conflict) =>
        `conflict: ${conflict.path}${conflict.key === undefined ? "" : ` (${conflict.key})`} -> ${conflict.action}`,
    ),
  ];
  if (changes.length === 0) {
    return {
      status: request.dryRun === true ? "dry_run" : "current",
      from_version: source.version,
      to_version: targetVersion,
      changes: [],
      record: active,
      preserved: [],
      warnings: [],
      conflicts: dryRunConflictInventory,
    };
  }
  if (request.dryRun === true) {
    return {
      status: "dry_run",
      from_version: source.version,
      to_version: targetVersion,
      changes,
      record: active,
      preserved: [],
      warnings: [],
      conflicts: dryRunConflictInventory,
    };
  }
  try {
    const result = await installHolyCodex(effectiveOptions, options, environment);
    return {
      status: "upgraded",
      from_version: source.version,
      to_version: targetVersion,
      changes,
      record: result.record,
      preserved: result.preserved,
      warnings: result.warnings,
    };
  } catch (error: unknown) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "upgrade_failed",
      `HolyCodex upgrade failed: ${safeMessage(error)}`,
      error,
    );
  }
}

function additionalPluginsFromRecord(
  record: Pick<InstallRecord, "official_plugins" | "optional_selections">,
): readonly string[] {
  const capabilityPlugins = new Set(pluginIdsForOptionalCapabilities(record.optional_selections));
  return (record.official_plugins ?? []).filter(
    (pluginId) =>
      pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID &&
      !isLegacyWorkPlugin(pluginId) &&
      !capabilityPlugins.has(pluginId),
  );
}

function withoutCodexDesktopManagedPlugins<T extends { readonly plugin_id: string }>(
  snapshots: readonly T[],
): readonly T[] {
  return snapshots.filter((snapshot) => snapshot.plugin_id !== CODEX_DESKTOP_BROWSER_PLUGIN_ID);
}

function withoutLegacyWorkPlugins(request: InstallRequest): InstallRequest {
  return {
    ...request,
    ...(request.officialPlugins === undefined
      ? {}
      : {
          officialPlugins: request.officialPlugins.filter(
            (pluginId) => !isLegacyWorkPlugin(pluginId),
          ),
        }),
  };
}

function isLegacyWorkPlugin(pluginId: string): boolean {
  const name = pluginId.slice(0, pluginId.lastIndexOf("@"));
  return LEGACY_WORK_PLUGIN_NAMES.has(name);
}

function sameInstallOptions(left: InstallRequest, right: InstallRequest): boolean {
  const leftOptional = left.optional ?? {};
  const rightOptional = right.optional ?? {};
  const leftPlugins = [...new Set(left.officialPlugins ?? [])];
  const rightPlugins = [...new Set(right.officialPlugins ?? [])];
  return (
    left.profile === right.profile &&
    left.tier === right.tier &&
    leftOptional.browser_use === rightOptional.browser_use &&
    leftOptional.computer_use === rightOptional.computer_use &&
    leftOptional.sites === rightOptional.sites &&
    leftPlugins.length === rightPlugins.length &&
    leftPlugins.every((pluginId, index) => pluginId === rightPlugins[index])
  );
}

async function resolveRemovalConflicts(
  options: InstallerOptions,
  conflicts: readonly {
    readonly path: string;
    readonly key?: string | undefined;
    readonly action: "remove";
  }[],
): Promise<ReadonlySet<string>> {
  const accepted = new Set<string>();
  if (options.resolveConflicts !== undefined && conflicts.length > 0) {
    const structured = conflicts.map((conflict) => ({
      ...conflict,
      identity: `remove:${conflict.path}:${conflict.key ?? ""}`,
      category: conflict.key === undefined ? "role-asset" : "config-key",
      target: conflict.key ?? conflict.path,
      explanation: "HolyCodex can remove this managed value after reviewing the change.",
      validDecisions: ["keep", "remove", "cancel"] as const,
      defaultDecision: "keep" as const,
    }));
    const decisions = await options.resolveConflicts(structured);
    for (let index = 0; index < structured.length; index += 1) {
      const conflict = structured[index]!;
      const decision = decisions[conflict.identity!];
      if (decision === "remove") {
        accepted.add(conflictIdentity(conflicts[index]!));
      } else if (decision === "keep") {
        continue;
      } else if (decision === "cancel") {
        throw new InstallerError(
          "confirmation_required",
          "Conflict resolution was cancelled.",
          undefined,
          {
            identity: conflict.identity!,
            path: conflict.path,
            ...(conflict.key === undefined ? {} : { key: conflict.key }),
          },
        );
      } else {
        throw new InstallerError(
          "confirmation_required",
          `The removal conflict at ${conflict.target} requires a keep, remove, or cancel decision.`,
          undefined,
          {
            identity: conflict.identity!,
            path: conflict.path,
            ...(conflict.key === undefined ? {} : { key: conflict.key }),
            decision: decision ?? "unavailable",
          },
        );
      }
    }
    return accepted;
  }
  for (const conflict of conflicts) {
    const resolution = await options.resolveConflict?.(conflict);
    if (resolution === "accept") {
      accepted.add(conflictIdentity(conflict));
      continue;
    }
    if (resolution === "decline") continue;
    throw new InstallerError(
      "confirmation_required",
      resolution === "cancel"
        ? "Conflict resolution was cancelled."
        : "Modified HolyCodex-owned state requires confirmation before removal.",
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

function conflictIdentity(conflict: {
  readonly path: string;
  readonly key?: string | undefined;
  readonly action: "replace" | "remove";
}): string {
  return `${conflict.action}\u0000${conflict.path}\u0000${conflict.key ?? ""}`;
}

async function removalConfigConflict(
  path: string,
  key: string,
  document: TomlDocument,
  category: string,
  explanation: string,
): Promise<ManagedConflict & { readonly action: "remove" }> {
  const existing = readTomlPath(document, key);
  const digest = await removalConfigDigest(document, key);
  return {
    identity: conflictIdentity({ path, key, action: "remove" }),
    category,
    target: key,
    existing: { present: existing !== undefined, digest },
    desired: { present: false },
    explanation,
    validDecisions: ["keep", "remove", "cancel"],
    defaultDecision: "keep",
    path,
    key,
    action: "remove",
  };
}

async function removalConfigDigest(document: TomlDocument, key: string): Promise<string> {
  const current = readTomlPath(document, key);
  const observation =
    current === undefined
      ? { present: false as const }
      : { present: true as const, value: current };
  return await domainSeparatedSha256("holycodex-removal-config-review-v1", [
    canonicalJsonUtf8(asJsonValue(observation)),
  ]);
}

function reviewedConflictDigest(conflict: ManagedConflict): string | undefined {
  if (typeof conflict.existing !== "object" || conflict.existing === null) return undefined;
  const digest = (conflict.existing as { readonly digest?: unknown }).digest;
  return typeof digest === "string" ? digest : undefined;
}

async function assertRemovalReviewUnchanged(
  paths: ResolvedInstallerPaths,
  document: TomlDocument,
  acceptedConfigConflicts: readonly ManagedConflict[],
  reviewedNativeConflicts: ReadonlyMap<string, string>,
): Promise<void> {
  for (const conflict of acceptedConfigConflicts) {
    if (conflict.key === undefined) continue;
    const expected = reviewedConflictDigest(conflict);
    if (
      expected === undefined ||
      (await removalConfigDigest(document, conflict.key)) !== expected
    ) {
      throw reviewedRemovalChanged(conflict.path, conflict.key);
    }
  }
  let changedNativePaths: readonly string[];
  try {
    changedNativePaths = await changedNativeAgentRemovalConflicts(
      paths.codexHome,
      reviewedNativeConflicts,
    );
  } catch (error: unknown) {
    const subject = reviewedNativeConflicts.keys().next().value as string | undefined;
    throw new InstallerError(
      "confirmation_required",
      "A reviewed HolyCodex file could not be checked safely, so removal did not continue.",
      error,
      {
        operation: "verify removal review",
        ...(subject === undefined ? {} : { path: subject }),
        recovery: "Check file access, then run remove again to review current state.",
      },
    );
  }
  if (changedNativePaths.length > 0) throw reviewedRemovalChanged(changedNativePaths[0]!);
}

function reviewedRemovalChanged(path: string, key?: string): InstallerError {
  return new InstallerError(
    "confirmation_required",
    "A reviewed HolyCodex item changed before removal. No reviewed changes were applied; run remove again to review the current state.",
    undefined,
    {
      operation: "remove HolyCodex",
      path,
      ...(key === undefined ? {} : { key }),
      recovery: "Run remove again to review the current state.",
    },
  );
}

async function assertConfigTextUnchanged(
  path: string,
  reviewedText: string | undefined,
): Promise<void> {
  if ((await optionalTextFile(path)) !== reviewedText) throw reviewedRemovalChanged(path);
}

async function doctorRuntimeConfig(
  paths: ResolvedInstallerPaths,
  active: InstallRecord,
): Promise<DoctorCheck> {
  if (!active.managed_config) return failedCheck(["incomplete_install_state"]);
  try {
    const document = parseConfig(await optionalTextFile(paths.configFile));
    const expected = desiredRootConfig(active.profile, active.tier, {
      browserUse:
        active.capability_state?.browser_use.status === "healthy" &&
        active.capability_state.browser_use.selected,
      computerUse: active.optional_selections.computer_use,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
      security: DEFAULT_CAPABILITY_SELECTIONS.security,
    });
    const drift: string[] = [];
    for (const keyPath of Object.keys(expected)) {
      const comparison = await compareManagedConfigKey(
        document,
        active.managed_config,
        keyPath as ManagedConfigKeyPath,
      );
      if (comparison.status !== "unchanged") {
        drift.push(keyPath);
      }
    }
    return drift.length === 0
      ? healthyCheck({ managed_keys: Object.keys(expected).length })
      : failedCheck(["changed_holycodex_config"], { keys: drift });
  } catch (error: unknown) {
    return failedCheck(["config_unreadable"], { error: safeMessage(error) });
  }
}

async function doctorNativeRoles(
  paths: ResolvedInstallerPaths,
  profile: InstallRecord["profile"],
  tier: InstallRecord["tier"],
  capabilities: Readonly<{ browserUse: boolean; computerUse: boolean }> = {
    browserUse: false,
    computerUse: false,
  },
): Promise<DoctorCheck> {
  try {
    const document = parseConfig(await optionalTextFile(paths.configFile));
    const failures: string[] = [];
    const generationId = nativeAgentGenerationId(profile, tier, capabilities);
    for (const agent of projectNativeAgents(profile, tier)) {
      const ref = readTomlPath(document, `agents."${agent.name}".config_file`);
      const expected = resolveAgentConfigPath(
        paths.configFile,
        nativeAgentConfigPath(agent.name, generationId),
      ).replaceAll("\\", "/");
      if (
        typeof ref !== "string" ||
        resolveAgentConfigPath(paths.configFile, ref).replaceAll("\\", "/") !== expected
      ) {
        failures.push(`${agent.name}:registration`);
        continue;
      }
      const roleText = await optionalTextFile(expected);
      if (roleText === undefined) {
        failures.push(`${agent.name}:missing`);
        continue;
      }
      if (roleText !== renderNativeAgent(agent, capabilities)) {
        failures.push(`${agent.name}:changed`);
        continue;
      }
      const roleDocument = parseConfig(roleText);
      if (
        roleDocument["name"] !== agent.name ||
        typeof roleDocument["description"] !== "string" ||
        typeof roleDocument["developer_instructions"] !== "string" ||
        roleDocument["model"] !== agent.model ||
        roleDocument["model_reasoning_effort"] !== agent.effort ||
        roleDocument["model_reasoning_summary"] !== "none" ||
        roleDocument["model_verbosity"] !== "low" ||
        roleDocument["tool_output_token_limit"] !== undefined ||
        roleDocument["service_tier"] !== (tier === "standard" ? "default" : "fast") ||
        !nativeAgentSandboxConfigurationMatches(agent, roleDocument) ||
        roleDocument["approval_policy"] !== "never" ||
        roleDocument["web_search"] !== (agent.permissions.network ? "live" : "disabled") ||
        readTomlPath(roleDocument, "agents.enabled") !== false ||
        readTomlPath(roleDocument, "features.multi_agent") !== false ||
        readTomlPath(roleDocument, "features.multi_agent_v2") !== false ||
        readTomlPath(roleDocument, "features.agent_message_board") !== false ||
        readTomlPath(roleDocument, "features.context_management.experimental_mode") !== true ||
        Object.keys((roleDocument["features"] as Record<string, unknown> | undefined) ?? {}).some(
          (key) =>
            ![
              "multi_agent",
              "multi_agent_v2",
              "agent_message_board",
              "context_management",
            ].includes(key),
        )
      ) {
        failures.push(`${agent.name}:malformed`);
      }
    }
    const staleRoot = await optionalTextFile(`${paths.codexHome}/agents/root.toml`);
    if (staleRoot !== undefined && isKnownLegacyRootRoleContent(staleRoot)) {
      failures.push("root:stale");
    }
    return failures.length === 0
      ? healthyCheck({
          role_root: paths.roleRoot,
          agent_types: projectNativeAgents(profile, tier).map((agent) => agent.name),
        })
      : failedCheck(["native_role_disagreement"], { roles: failures });
  } catch (error: unknown) {
    return failedCheck(["native_role_invalid"], { error: safeMessage(error) });
  }
}

async function writeConflictState(
  paths: ResolvedInstallerPaths,
  active: PersistedInstallState,
): Promise<void> {
  const transaction = {
    ...active,
    status: "conflicted" as const,
    step: "conflicted" as const,
    managed_config:
      active.managed_config ??
      ({
        owner: "holycodex",
        schema: active.schema_epoch,
        installId: active.install_id,
        managed: {},
      } satisfies ManagedRuntimeConfigState),
    plugin_snapshot: active.plugin_snapshot ?? [],
    owned_plugins: active.owned_plugins ?? [],
  };
  if (decodeSchema(InstallTransactionSchema, transaction) !== undefined) {
    await writeAtomicJson(paths.conflictedRecord, asJsonValue(transaction));
  }
}

type PersistedInstallState = Omit<InstallRecord, "status" | "step"> & {
  readonly status?: "active" | "preparing" | "conflicted" | undefined;
  readonly step?:
    | "active"
    | "validated"
    | "plugins_snapshotted"
    | "roles_prepared"
    | "plugins_installed"
    | "config_published"
    | "verified"
    | "conflicted"
    | undefined;
};

function selectRecoveryTransaction(
  active: InstallRecord | undefined,
  preparing: PersistedInstallState | undefined,
  conflicted: PersistedInstallState | undefined,
): PersistedInstallState | undefined {
  return [conflicted, preparing].find(
    (transaction) =>
      transaction !== undefined &&
      (active === undefined || isTransactionBoundToActive(transaction, active)),
  );
}

function selectRecoveryState(
  active: InstallRecord | undefined,
  preparing: PersistedInstallState | undefined,
  conflicted: PersistedInstallState | undefined,
): PersistedInstallState | InstallRecord | undefined {
  return selectRecoveryTransaction(active, preparing, conflicted) ?? active;
}

function emptyRemovalState(): InstallRecord {
  return {
    owner: "holycodex",
    schema_epoch: "state-0.16",
    install_id: "remove-conflict",
    version: "0.0.0",
    digest: "0".repeat(64),
    profile: "default",
    tier: "standard",
    optional_selections: {
      browser_use: false,
      computer_use: false,
      sites: false,
      coding: true,
    },
    explicit_optional_selections: {},
    managed_artifacts: [],
    installed_at: new Date(0).toISOString(),
  };
}

function ownedPluginsForRemoval(state: PersistedInstallState | undefined): readonly string[] {
  if (state?.owned_plugins !== undefined) {
    return [...new Set(state.owned_plugins)].filter(
      (pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID,
    );
  }
  const inferred = (state?.plugin_snapshot ?? [])
    .filter(
      (snapshot) =>
        snapshot.plugin_id !== CODEX_DESKTOP_BROWSER_PLUGIN_ID &&
        (snapshot.status === "missing" || snapshot.status === "available"),
    )
    .map((snapshot) => snapshot.plugin_id);
  const configOwned =
    state?.plugin_config?.before.preference.presence === "absent" &&
    state.plugin_config.after.preference.presence === "present"
      ? [HOLYCODEX_PLUGIN]
      : [];
  const providerOwned = (state?.provider_config ?? [])
    .filter(
      (snapshot) =>
        snapshot.plugin_id !== CODEX_DESKTOP_BROWSER_PLUGIN_ID &&
        snapshot.before.presence === "absent" &&
        snapshot.after.presence === "present",
    )
    .map((snapshot) => snapshot.plugin_id);
  return [...new Set([...inferred, ...configOwned, ...providerOwned])];
}

function resolveOwnedPluginEntry(live: LiveOfficialPluginListEnvelope, pluginId: string) {
  const resolved = resolveOfficialPluginEntry(live, pluginId);
  if (resolved !== undefined) return resolved;
  const entry = [...live.installed, ...live.available].find(
    (candidate) => candidate.pluginId === pluginId,
  );
  return entry === undefined ? undefined : { entry };
}

function healthyCheck(details: Record<string, unknown>): DoctorCheck {
  return { status: "healthy", reasons: [], details: details as DoctorCheck["details"] };
}
function failedCheck(
  reasons: readonly string[],
  details: Record<string, unknown> = {},
): DoctorCheck {
  return { status: "failed", reasons, details: details as DoctorCheck["details"] };
}

async function removeTransaction(path: string): Promise<void> {
  await rm(path, { force: false }).catch((error: unknown) => {
    if (!isFsCode(error, "ENOENT")) throw error;
  });
}

function isContext7Absent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "context7_unavailable" || error.code === "context7_manager_unknown")
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}

function reportProgress(options: InstallerOptions, event: InstallProgressEvent): void {
  try {
    options.onProgress?.(event);
  } catch {
    // Progress rendering is observational and must never change removal semantics.
  }
}
