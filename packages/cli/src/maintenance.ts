// SPDX-License-Identifier: Apache-2.0

import { lstat, rm, rmdir } from "node:fs/promises";
import { pluginIdsForOptionalCapabilities, type JsonObject } from "@holycodex/core";
import {
  HOLYCODEX_PLUGIN,
  readActiveInstallRecord,
  recordDigestMatches,
  InstallerError,
} from "./installer.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import {
  assertNoSymlinkTree,
  isFsCode,
  resolveInstallerPaths,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import { removeManagedNativeAgents } from "./native-agents.ts";
import type { DoctorCheck, DoctorResult, InstallerOptions, RemoveResult } from "./types.ts";

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
  const manager =
    options.officialPluginManager ??
    (await CodexOfficialPluginManager.discover({
      ...environment,
      CODEX_HOME: paths.codexHome,
    }).catch(() => undefined));
  if (active && manager?.status) {
    const selected = [
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
  const removed: string[] = [];
  const preserved: string[] = [];
  const reasons: string[] = [];
  if (active && !(await recordDigestMatches(active))) {
    preserved.push(paths.activeRecord);
    reasons.push("configuration_changed");
    return { removed, preserved, reasons };
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
  if (manager === undefined) {
    throw new InstallerError("capability_denied", "Native Codex plugin removal is unavailable.");
  }
  if (!manager.remove) {
    throw new InstallerError("capability_denied", "Native Codex plugin removal is unavailable.");
  }
  try {
    await manager.remove(HOLYCODEX_PLUGIN);
  } catch (error: unknown) {
    throw new InstallerError(
      "capability_denied",
      `Codex native plugin removal did not converge: ${safeMessage(error)}`,
      error,
    );
  }
  if (!active) {
    await removeLegacyState(paths, removed, preserved, reasons);
    return { removed, preserved, reasons };
  }
  const native = await removeManagedNativeAgents(paths.codexHome, active.managed_artifacts);
  removed.push(...native.removed);
  preserved.push(...native.preserved);
  if (native.preserved.length > 0) {
    reasons.push("managed_artifact_changed");
    return { removed: [HOLYCODEX_PLUGIN, ...removed], preserved, reasons };
  }
  try {
    await rm(paths.activeRecord, { force: false });
    removed.push(paths.activeRecord);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) removed.push(paths.activeRecord);
    else preserved.push(paths.activeRecord);
  }
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
  return { removed: [HOLYCODEX_PLUGIN, ...removed], preserved, reasons };
}

async function removeLegacyState(
  paths: ResolvedInstallerPaths,
  removed: string[],
  preserved: string[],
  reasons: string[],
): Promise<void> {
  try {
    const entry = await lstat(paths.stateRoot);
    if (entry.isSymbolicLink()) {
      preserved.push(paths.stateRoot);
      return;
    }
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

function healthyCheck(details: JsonObject): DoctorCheck {
  return { status: "healthy", reasons: [], details };
}
function failedCheck(reasons: readonly string[], details: JsonObject = {}): DoctorCheck {
  return { status: "failed", reasons, details };
}
function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}
