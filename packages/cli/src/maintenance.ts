// SPDX-License-Identifier: Apache-2.0

import { rm, rmdir } from "node:fs/promises";

import {
  cleanupManagedRuntimeConfig,
  compareManagedConfigKey,
  readTomlPath,
  resolveAgentConfigPath,
  type ManagedConfigKeyPath,
  type ManagedRuntimeConfigState,
  type TomlDocument,
} from "@holycodex/codex";
import { pluginIdsForOptionalCapabilities } from "@holycodex/core";

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
} from "./installer.ts";
import { asJsonValue } from "./json.ts";
import { isKnownLegacyRootRoleContent, removeManagedNativeAgents } from "./native-agents.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import {
  assertNoSymlinkTree,
  isFsCode,
  resolveInstallerPaths,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import { decodeSchema, InstallTransactionSchema } from "./schema.ts";
import { optionalJsonFile, optionalTextFile, writeAtomicJson, writeAtomicText } from "./storage.ts";
import type {
  DoctorCheck,
  DoctorResult,
  InstallerOptions,
  InstallRecord,
  RemoveResult,
} from "./types.ts";

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
  if (preparing !== undefined && checks["transaction"]?.status !== "failed") {
    checks["transaction"] = failedCheck(["incomplete_install_state"]);
  }
  if (conflicted !== undefined && checks["transaction"]?.status !== "failed") {
    checks["transaction"] = failedCheck(["conflicted_state"]);
  }

  if (!checks["configuration"]) {
    if (!active) {
      checks["configuration"] = failedCheck(["configuration_missing"]);
    } else if (await recordDigestMatches(active)) {
      checks["configuration"] = healthyCheck({
        plan: active.plan,
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
    checks["native_roles"] = await doctorNativeRoles(paths, active.tier);
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
            work: active.optional_selections.work,
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
      checks["native_plugins"] =
        missing.length === 0
          ? healthyCheck({ status })
          : failedCheck(["native_plugin_disagreement"], { missing, status });
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

export async function removeHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RemoveResult> {
  const paths = resolveInstallerPaths(options, environment);
  await assertNoSymlinkTree(paths.codexHome);
  await assertNoSymlinkTree(paths.stateRoot);
  const active = await readActiveInstallRecord(paths);
  const [preparing, conflicted] = await Promise.all([
    optionalJsonFile(paths.preparingRecord, InstallTransactionSchema),
    optionalJsonFile(paths.conflictedRecord, InstallTransactionSchema),
  ]);
  // A conflicted or preparing transaction is newer than the last active
  // record.  Prefer it so removal can account for plugins/configuration
  // touched by an interrupted reinstall instead of silently leaving those
  // newly-owned effects behind while consulting stale active state.
  const recovery = conflicted ?? preparing ?? active;
  const ownedPlugins = new Set(ownedPluginsForRemoval(recovery));
  const removed: string[] = [];
  const preserved: string[] = [];
  const reasons: string[] = [];
  if (active && !(await recordDigestMatches(active))) {
    preserved.push(paths.activeRecord);
    reasons.push("configuration_changed");
    return { removed, preserved, reasons };
  }

  const configBefore = await optionalTextFile(paths.configFile);
  const configBeforeDocument = parseConfig(configBefore);
  if (recovery?.managed_config) {
    const cleanup = await cleanupManagedRuntimeConfig(
      configBeforeDocument,
      recovery.managed_config,
      { schema: recovery.managed_config.schema, installId: recovery.managed_config.installId },
    );
    if (cleanup.preservedKeys.length > 0 || cleanup.unresolvedKeys.length > 0) {
      preserved.push(paths.configFile);
      reasons.push("managed_config_changed");
      await writeConflictState(paths, recovery);
      return { removed, preserved, reasons };
    }
  }
  if (recovery?.plugin_config) {
    const cleanup = await cleanupHolyCodexPluginConfig(
      configBeforeDocument,
      recovery.plugin_config,
    );
    if (cleanup.preserved.length > 0) {
      preserved.push(paths.configFile);
      reasons.push("plugin_config_changed");
      await writeConflictState(paths, recovery);
      return { removed, preserved, reasons };
    }
  }
  if (recovery?.provider_config) {
    const cleanup = await cleanupProviderPluginConfig(
      configBeforeDocument,
      recovery.provider_config,
      ownedPlugins,
    );
    if (cleanup.preserved.length > 0) {
      preserved.push(paths.configFile);
      reasons.push("provider_config_changed");
      await writeConflictState(paths, recovery);
      return { removed, preserved, reasons };
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
  );
  removed.push(...native.removed);
  preserved.push(...native.preserved);
  if (native.preserved.length > 0) reasons.push("managed_artifact_changed");

  for (const pluginId of ownedPlugins) {
    try {
      await manager.remove(pluginId);
      const live = await manager.list();
      const remaining = [...live.installed, ...live.available].find(
        (entry) => entry.pluginId === pluginId && entry.installed,
      );
      if (remaining !== undefined) {
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
  if (native.preserved.length > 0) {
    await writeConflictState(paths, recovery ?? emptyRemovalState());
    return { removed, preserved, reasons };
  }
  let cleanedConfig:
    | { readonly document: TomlDocument; readonly state?: ManagedRuntimeConfigState }
    | undefined;
  try {
    let document = parseConfig(await optionalTextFile(paths.configFile));
    let managedState = recovery?.managed_config;
    if (managedState) {
      const cleanup = await cleanupManagedRuntimeConfig(document, managedState, {
        schema: managedState.schema,
        installId: managedState.installId,
      });
      if (cleanup.preservedKeys.length > 0 || cleanup.unresolvedKeys.length > 0) {
        preserved.push(paths.configFile);
        reasons.push("managed_config_changed");
        await writeConflictState(paths, recovery ?? emptyRemovalState());
        return { removed, preserved, reasons };
      }
      document = cleanup.document;
      managedState = cleanup.state;
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
      if (isFsCode(error, "ENOENT")) removed.push(paths.activeRecord);
      else {
        preserved.push(paths.activeRecord);
        reasons.push("state_remove_failed");
        await writeConflictState(paths, recovery ?? active);
        return { removed, preserved, reasons };
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
  return { removed, preserved, reasons };
}

async function doctorRuntimeConfig(
  paths: ResolvedInstallerPaths,
  active: InstallRecord,
): Promise<DoctorCheck> {
  if (!active.managed_config) return failedCheck(["incomplete_install_state"]);
  try {
    const document = parseConfig(await optionalTextFile(paths.configFile));
    const expected = desiredRootConfig(active.plan, active.tier);
    const drift: string[] = [];
    for (const [keyPath, value] of Object.entries(expected)) {
      const comparison = await compareManagedConfigKey(
        document,
        active.managed_config,
        keyPath as ManagedConfigKeyPath,
      );
      if (
        comparison.status !== "unchanged" ||
        (keyPath !== "developer_instructions" && readTomlPath(document, keyPath) !== value)
      ) {
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
  tier: InstallRecord["tier"],
): Promise<DoctorCheck> {
  try {
    const document = parseConfig(await optionalTextFile(paths.configFile));
    const failures: string[] = [];
    for (const role of ["explorer", "librarian", "worker", "reviewer"] as const) {
      const ref = readTomlPath(document, `agents.${role}.config_file`);
      const expected = `${paths.roleRoot}/${role}.toml`.replaceAll("\\", "/");
      if (
        typeof ref !== "string" ||
        resolveAgentConfigPath(paths.configFile, ref).replaceAll("\\", "/") !== expected
      ) {
        failures.push(`${role}:registration`);
        continue;
      }
      const roleText = await optionalTextFile(`${paths.roleRoot}/${role}.toml`);
      if (roleText === undefined) {
        failures.push(`${role}:missing`);
        continue;
      }
      const roleDocument = parseConfig(roleText);
      if (
        roleDocument["name"] !== role ||
        typeof roleDocument["description"] !== "string" ||
        typeof roleDocument["developer_instructions"] !== "string" ||
        roleDocument["model"] !== "gpt-5.6-luna" ||
        roleDocument["model_reasoning_summary"] !== "none" ||
        roleDocument["model_verbosity"] !== "low" ||
        roleDocument["tool_output_token_limit"] !== 12000 ||
        roleDocument["service_tier"] !== (tier === "standard" ? "default" : "fast") ||
        readTomlPath(roleDocument, "agents.enabled") !== false ||
        readTomlPath(roleDocument, "features.multi_agent_v2") !== false ||
        readTomlPath(roleDocument, "features.multi_agent") !== false
      ) {
        failures.push(`${role}:malformed`);
      }
    }
    const staleRoot = await optionalTextFile(`${paths.codexHome}/agents/root.toml`);
    if (staleRoot !== undefined && isKnownLegacyRootRoleContent(staleRoot)) {
      failures.push("root:stale");
    }
    return failures.length === 0
      ? healthyCheck({ role_root: paths.roleRoot })
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

function emptyRemovalState(): InstallRecord {
  return {
    owner: "holycodex",
    schema_epoch: "state-0.16",
    install_id: "remove-conflict",
    version: "0.0.0",
    digest: "0".repeat(64),
    plan: "plus",
    tier: "standard",
    optional_selections: {
      computer_use: false,
      work: false,
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
    .filter(
      (snapshot) => snapshot.plugin_id !== HOLYCODEX_PLUGIN && snapshot.status !== "installed",
    )
    .map((snapshot) => snapshot.plugin_id);
  return [...new Set([HOLYCODEX_PLUGIN, ...inferred])];
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
