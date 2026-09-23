// SPDX-License-Identifier: Apache-2.0

import { rm, rmdir } from "node:fs/promises";

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
  type LiveOfficialPluginListEnvelope,
} from "@holycodex/codex";
import {
  compareReleaseVersions,
  pluginIdsForOptionalCapabilities,
  type ReleaseVersion,
} from "@holycodex/core";

import {
  HOLYCODEX_PLUGIN,
  cleanupHolyCodexPluginConfig,
  cleanupProviderPluginConfig,
  desiredRootConfig,
  parseConfig,
  readActiveInstallRecord,
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
  inspectNativeAgentConflicts,
  inspectNativeAgentRemovalConflicts,
  projectNativeAgents,
  renderNativeAgent,
  nativeAgentSandboxMode,
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
import { optionalJsonFile, optionalTextFile, writeAtomicJson, writeAtomicText } from "./storage.ts";
import {
  createInstallerRuntime,
  ensureContext7,
  ensureGitBash,
  removeOwnedContext7,
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

  const [active, preparing, conflicted] = await Promise.all([
    readActiveInstallRecord(paths).catch((error: unknown) => {
      checks["configuration"] = failedCheck(["state_corrupt"], { error: safeMessage(error) });
      return undefined;
    }),
    optionalJsonFile(paths.preparingRecord, InstallTransactionSchema).catch((error: unknown) => {
      checks["transaction"] = failedCheck(["state_corrupt"], {
        path: paths.preparingRecord,
        error: safeMessage(error),
      });
      return undefined;
    }),
    optionalJsonFile(paths.conflictedRecord, InstallTransactionSchema).catch((error: unknown) => {
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
    checks["native_roles"] = await doctorNativeRoles(
      paths,
      active.profile,
      active.tier,
      active.tooling?.git_bash.status === "healthy" ? active.tooling.git_bash.path : undefined,
    );
    const failedCapability = Object.entries(active.capability_state ?? {}).find(
      ([, value]) => value.selected && value.status !== "healthy",
    );
    if (failedCapability) {
      checks["capabilities"] = failedCheck(["selected_capability_not_healthy"], {
        capability: failedCapability[0]!,
        status: failedCapability[1].status,
      });
    }
  }

  const runtime = options.runtime ?? createInstallerRuntime(environment);
  try {
    const gitBash = await ensureGitBash(runtime, false);
    checks["git_bash"] =
      gitBash.status === "missing"
        ? failedCheck(["git_bash_missing"])
        : healthyCheck(gitBash.status === "healthy" ? { path: gitBash.path } : {});
  } catch (error: unknown) {
    checks["git_bash"] = failedCheck(["git_bash_unavailable"], { error: safeMessage(error) });
  }
  try {
    const context7 = await ensureContext7(runtime, false, active?.tooling?.context7);
    checks["context7"] = healthyCheck({
      manager: context7.manager,
      version: context7.version,
      executable: context7.executable,
      ownership: context7.ownership,
    });
  } catch (error: unknown) {
    checks["context7"] = failedCheck(["context7_unavailable"], { error: safeMessage(error) });
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

  const manager =
    options.officialPluginManager ??
    (await CodexOfficialPluginManager.discover({
      ...environment,
      CODEX_HOME: paths.codexHome,
    }).catch(() => undefined));
  if (active && manager?.status) {
    const selected = [
      ...new Set([
        HOLYCODEX_PLUGIN,
        ...pluginIdsForOptionalCapabilities(
          {
            computer_use: active.optional_selections.computer_use,
            frontend: active.optional_selections.frontend,
            security: active.optional_selections.security,
          },
          active.official_plugins,
        ),
        ...(active.owned_plugins ?? []),
      ]),
    ];
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
    checks["native_plugins"] = {
      status: "unsupported",
      reasons: ["native_plugin_manager_unavailable"],
      details: {},
    };
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
    optionalJsonFile(paths.preparingRecord, InstallTransactionSchema),
    optionalJsonFile(paths.conflictedRecord, InstallTransactionSchema),
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
      conflicts.push({ path: paths.configFile, key, action: "remove" });
    }
  }
  if (recovery.plugin_config !== undefined) {
    const cleanup = await cleanupHolyCodexPluginConfig(document, recovery.plugin_config);
    for (const name of cleanup.preserved) {
      conflicts.push({
        path: paths.configFile,
        key: name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex",
        action: "remove",
      });
    }
  }
  if (recovery.provider_config !== undefined) {
    const cleanup = await cleanupProviderPluginConfig(
      document,
      recovery.provider_config,
      new Set(ownedPluginsForRemoval(recovery)),
    );
    for (const pluginId of cleanup.preserved) {
      conflicts.push({
        path: paths.configFile,
        key: `plugins."${pluginId}"`,
        action: "remove",
      });
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
    optionalJsonFile(paths.preparingRecord, InstallTransactionSchema),
    optionalJsonFile(paths.conflictedRecord, InstallTransactionSchema),
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
      recovery.provider_config,
      ownedPlugins,
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
      { recovery: "Install or expose Codex, then retry." },
    );
  }
  if (manager === undefined || !manager.remove || !manager.list) {
    throw new InstallerError(
      "capability_denied",
      "Native Codex plugin removal and readback are unavailable.",
    );
  }

  const native = await removeManagedNativeAgents(
    paths.codexHome,
    recovery?.managed_artifacts ?? [],
    new Set(
      removalConflicts
        .filter(
          (conflict) =>
            conflict.key === undefined && acceptedRemovalConflicts.has(conflictIdentity(conflict)),
        )
        .map((conflict) => conflict.path),
    ),
  );
  removed.push(...native.removed);
  preserved.push(...native.preserved);
  if (native.preserved.length > 0) reasons.push("managed_artifact_changed");

  for (const pluginId of ownedPlugins) {
    try {
      const before = await manager.list();
      const observed = resolveOwnedPluginEntry(before, pluginId);
      if (observed?.entry.installed !== true) continue;
      const removalId = observed.entry.pluginId;
      await manager.remove(removalId);
      const live = await manager.list();
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
      removed.push(pluginId);
    } catch (error: unknown) {
      reasons.push("native_plugin_remove_failed");
      await writeConflictState(paths, recovery ?? emptyRemovalState());
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
    await writeConflictState(paths, recovery);
    throw new InstallerError(
      "capability_denied",
      `Context7 removal did not converge: ${safeMessage(error)}`,
      error,
    );
  }
  let cleanedConfig:
    | { readonly document: TomlDocument; readonly state?: ManagedRuntimeConfigState }
    | undefined;
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
        return { removed, preserved, reasons };
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
        return { removed, preserved, reasons };
      }
      document = cleanup.document;
    }
    if (recovery?.provider_config) {
      const cleanup = await cleanupProviderPluginConfig(
        document,
        recovery.provider_config,
        ownedPlugins,
        { allowBeforeState: true },
      );
      if (cleanup.preserved.length > 0) {
        preserved.push(paths.configFile);
        reasons.push("provider_config_changed");
        await writeConflictState(paths, recovery);
        return { removed, preserved, reasons };
      }
      document = cleanup.document;
    }
    if (recovery?.managed_config || recovery?.plugin_config || recovery?.provider_config) {
      cleanedConfig = managedState === undefined ? { document } : { document, state: managedState };
    }
    if (cleanedConfig !== undefined) {
      if (Object.keys(cleanedConfig.document).length === 0 && configBefore === undefined) {
        await rm(paths.configFile, { force: false });
      } else {
        await writeAtomicText(paths.configFile, serializeConfig(cleanedConfig.document));
      }
    }
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      await writeConflictState(paths, recovery ?? emptyRemovalState());
      throw error;
    }
    {
      preserved.push(paths.configFile);
      reasons.push("managed_config_write_failed");
      await writeConflictState(paths, recovery ?? emptyRemovalState());
      return { removed, preserved, reasons };
    }
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
        return { removed, preserved, reasons };
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
      [paths.conflictedRecord, conflicted !== undefined],
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

/** Migrate an existing installation in place using the running HolyCodex binary. */
export async function upgradeHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
  request: UpgradeRequest = {},
): Promise<UpgradeResult> {
  const paths = resolveInstallerPaths(options, environment);
  const [active, preparing, conflicted] = await Promise.all([
    readActiveInstallRecord(paths),
    optionalJsonFile(paths.preparingRecord, InstallTransactionSchema),
    optionalJsonFile(paths.conflictedRecord, InstallTransactionSchema),
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
            computer_use: source.optional_selections.computer_use,
            frontend: source.optional_selections.frontend,
            security: source.optional_selections.security,
          },
          officialPlugins: additionalPluginsFromRecord(source),
        }
      : installRequestFromPersistedOptions(persistedOptions);
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
  const legacyContext =
    source.managed_config?.managed["features.context_management.experimental_mode"] !== undefined;
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
        source.provider_config,
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
      source.tooling?.git_bash.status === "healthy" ? source.tooling.git_bash.path : undefined,
    );
    for (const conflict of nativeConflicts) {
      dryRunConflictInventory.push(conflict);
    }
  }
  let toolingDrift = source.tooling === undefined;
  try {
    const runtime = options.runtime ?? createInstallerRuntime(environment);
    const gitBash = await ensureGitBash(runtime, false);
    const context7 = await ensureContext7(runtime, false, source.tooling?.context7);
    toolingDrift ||=
      gitBash.status === "missing" ||
      context7.manager !== source.tooling?.context7.manager ||
      context7.version !== source.tooling?.context7.version ||
      context7.executable !== source.tooling?.context7.executable;
  } catch {
    toolingDrift = true;
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
    ...(toolingDrift ? ["shared tooling reconciliation"] : []),
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
  return (record.official_plugins ?? []).filter((pluginId) => !capabilityPlugins.has(pluginId));
}

function sameInstallOptions(left: InstallRequest, right: InstallRequest): boolean {
  const leftOptional = left.optional ?? {};
  const rightOptional = right.optional ?? {};
  const leftPlugins = [...new Set(left.officialPlugins ?? [])];
  const rightPlugins = [...new Set(right.officialPlugins ?? [])];
  return (
    left.profile === right.profile &&
    left.tier === right.tier &&
    leftOptional.computer_use === rightOptional.computer_use &&
    leftOptional.frontend === rightOptional.frontend &&
    leftOptional.security === rightOptional.security &&
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

async function doctorRuntimeConfig(
  paths: ResolvedInstallerPaths,
  active: InstallRecord,
): Promise<DoctorCheck> {
  if (!active.managed_config) return failedCheck(["incomplete_install_state"]);
  try {
    const document = parseConfig(await optionalTextFile(paths.configFile));
    const expected = desiredRootConfig(active.profile, active.tier, {
      computerUse: active.optional_selections.computer_use,
      frontend: active.optional_selections.frontend,
      security: active.optional_selections.security,
      ...(active.tooling?.git_bash.status === "healthy"
        ? { windowsGitBashExecutable: active.tooling.git_bash.path }
        : {}),
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
  windowsGitBashExecutable?: string,
): Promise<DoctorCheck> {
  try {
    const document = parseConfig(await optionalTextFile(paths.configFile));
    const failures: string[] = [];
    for (const agent of projectNativeAgents(profile, tier)) {
      const ref = readTomlPath(document, `agents."${agent.name}".config_file`);
      const expected = `${paths.roleRoot}/${agent.name}.toml`.replaceAll("\\", "/");
      if (
        typeof ref !== "string" ||
        resolveAgentConfigPath(paths.configFile, ref).replaceAll("\\", "/") !== expected
      ) {
        failures.push(`${agent.name}:registration`);
        continue;
      }
      const roleText = await optionalTextFile(`${paths.roleRoot}/${agent.name}.toml`);
      if (roleText === undefined) {
        failures.push(`${agent.name}:missing`);
        continue;
      }
      if (
        roleText !==
        renderNativeAgent(
          agent,
          windowsGitBashExecutable === undefined ? {} : { windowsGitBashExecutable },
        )
      ) {
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
        roleDocument["sandbox_mode"] !== nativeAgentSandboxMode(agent) ||
        roleDocument["approval_policy"] !== "never" ||
        roleDocument["web_search"] !== (agent.permissions.network ? "live" : "disabled") ||
        readTomlPath(roleDocument, "agents.enabled") !== false ||
        readTomlPath(roleDocument, "features.multi_agent_v2") !== false ||
        readTomlPath(roleDocument, "features.multi_agent") !== false ||
        readTomlPath(roleDocument, "features.context_management") !== true ||
        readTomlPath(roleDocument, "features.computer_use") !== false ||
        readTomlPath(roleDocument, "features.browser_use") !== false ||
        readTomlPath(roleDocument, "features.in_app_browser") !== false
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
      computer_use: false,
      frontend: false,
      security: false,
      coding: true,
    },
    explicit_optional_selections: {},
    managed_artifacts: [],
    installed_at: new Date(0).toISOString(),
  };
}

function ownedPluginsForRemoval(state: PersistedInstallState | undefined): readonly string[] {
  if (state?.owned_plugins !== undefined) return [...new Set(state.owned_plugins)];
  const inferred = (state?.plugin_snapshot ?? [])
    .filter((snapshot) => snapshot.status === "missing" || snapshot.status === "available")
    .map((snapshot) => snapshot.plugin_id);
  const configOwned =
    state?.plugin_config?.before.preference.presence === "absent" &&
    state.plugin_config.after.preference.presence === "present"
      ? [HOLYCODEX_PLUGIN]
      : [];
  const providerOwned = (state?.provider_config ?? [])
    .filter(
      (snapshot) => snapshot.before.presence === "absent" && snapshot.after.presence === "present",
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
