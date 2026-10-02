// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { rm, rmdir } from "node:fs/promises";
import { join, relative } from "node:path";

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
} from "@holycodex/core";
import * as Effect from "effect/Effect";

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
import { patchCurrentModelCatalog } from "./model-catalog.ts";
import {
  isKnownLegacyRootRoleContent,
  changedNativeAgentRemovalConflicts,
  inspectNativeAgentConflicts,
  inspectNativeAgentRemovalConflicts,
  nativeAgentConfigPath,
  nativeAgentGenerationId,
  nativeModelCatalogPath,
  projectNativeAgents,
  rootPersonalityIsNone,
  renderNativeAgent,
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
import { optionalTextFile, writeAtomicState, writeAtomicText } from "./storage.ts";
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
export function doctorHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DoctorResult> {
  return Effect.runPromise(doctorHolyCodexEffect(options, environment));
}

/** Inspect HolyCodex state as an Effect for composition inside CLI workflows. */
export function doctorHolyCodexEffect(
  options: InstallerOptions,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<DoctorResult, unknown> {
  return Effect.gen(function* () {
    const paths = resolveInstallerPaths(options, environment);
    const checks: Record<string, DoctorCheck> = {};
    const pathsResult = yield* fromPromise(() => assertNoSymlinkTree(paths.codexHome)).pipe(
      Effect.flatMap(() => fromPromise(() => assertNoSymlinkTree(paths.stateRoot))),
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: () => ({ error: undefined }),
      }),
    );
    checks["paths"] =
      pathsResult.error === undefined
        ? healthyCheck({ state_root: paths.stateRoot })
        : failedCheck(["path_symlink"], { error: safeMessage(pathsResult.error) });

    const activeResult = yield* fromPromise(() => readActiveInstallRecord(paths)).pipe(
      Effect.match({ onFailure: (error) => ({ error }), onSuccess: (active) => ({ active }) }),
    );
    const active = "active" in activeResult ? activeResult.active : undefined;
    if ("error" in activeResult) {
      checks["configuration"] = failedCheck(["state_corrupt"], {
        error: safeMessage(activeResult.error),
      });
    }
    const preparingResult = yield* fromPromise(() =>
      readInstallTransaction(paths.preparingRecord, active),
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (preparing) => ({ preparing }),
      }),
    );
    const conflictedResult = yield* fromPromise(() =>
      readInstallTransaction(paths.conflictedRecord, active),
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (conflicted) => ({ conflicted }),
      }),
    );
    const preparing = "preparing" in preparingResult ? preparingResult.preparing : undefined;
    const conflicted = "conflicted" in conflictedResult ? conflictedResult.conflicted : undefined;
    for (const [result, path] of [
      [preparingResult, paths.preparingRecord],
      [conflictedResult, paths.conflictedRecord],
    ] as const) {
      if ("error" in result) {
        checks["transaction"] = failedCheck(["state_corrupt"], {
          path,
          error: safeMessage(result.error),
        });
      }
    }
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
            return diagnosis.status === "preparing"
              ? "incomplete_install_state"
              : "conflicted_state";
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
      } else if (yield* fromPromise(() => recordDigestMatches(active))) {
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
      checks["runtime_config"] = yield* doctorRuntimeConfigEffect(paths, active);
      checks["native_roles"] = yield* doctorNativeRolesEffect(
        paths,
        active.profile,
        active.tier,
        {
          browserUse:
            active.capability_state?.browser_use.status === "healthy" &&
            active.capability_state.browser_use.selected,
          computerUse:
            active.capability_state?.computer_use.status === "healthy" &&
            active.capability_state.computer_use.selected,
        },
        active.managed_artifacts,
      );
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
    const context7Result = yield* fromPromise(() =>
      inspectContext7ReadOnly(runtime, active?.tooling?.context7),
    ).pipe(
      Effect.match({ onFailure: (error) => ({ error }), onSuccess: (context7) => ({ context7 }) }),
    );
    if ("context7" in context7Result) {
      checks["context7"] = healthyCheck({
        manager: context7Result.context7.manager,
        version: context7Result.context7.version,
        executable: context7Result.context7.executable,
        ownership: context7Result.context7.ownership,
      });
    } else {
      checks["context7"] = {
        status: "warning",
        reasons: ["context7_unavailable"],
        details: { error: safeMessage(context7Result.error) },
      };
    }

    const legacyRootResult = yield* fromPromise(() =>
      optionalTextFile(`${paths.codexHome}/agents/root.toml`),
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (legacyRoot) => ({ legacyRoot }),
      }),
    );
    if ("legacyRoot" in legacyRootResult) {
      const legacyRoot = legacyRootResult.legacyRoot;
      if (legacyRoot !== undefined && isKnownLegacyRootRoleContent(legacyRoot)) {
        const existing = checks["native_roles"];
        checks["native_roles"] = {
          status: "failed",
          reasons: [...(existing?.reasons ?? []), "stale_legacy_root"],
          details: { ...existing?.details, path: `${paths.codexHome}/agents/root.toml` },
        };
      }
    } else {
      checks["native_roles"] = failedCheck(["native_role_invalid"], {
        error: safeMessage(legacyRootResult.error),
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
              "session-audit": active.optional_selections["session-audit"],
              "auto-reset": active.optional_selections["auto-reset"],
            },
            active.official_plugins,
          ),
          ...(active.owned_plugins ?? []).filter(
            (pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID,
          ),
        ]),
      ].filter((pluginId) => pluginId !== CODEX_DESKTOP_BROWSER_PLUGIN_ID);
      const statusResult = yield* fromPromise(() => manager.status!(selected)).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (status) => ({ status }) }),
      );
      if ("status" in statusResult) {
        const status = statusResult.status;
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
      } else {
        checks["native_plugins"] = failedCheck(["native_plugin_status_failed"], {
          error: safeMessage(statusResult.error),
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
  });
}

/** Discover provably owned removal conflicts without mutating installation or provider state. */
export function inspectRemovalConflicts(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly (ManagedConflict & { readonly action: "remove" })[]> {
  return Effect.runPromise(inspectRemovalConflictsEffect(options, environment));
}

/** Discover removal conflicts as an Effect for composition inside CLI workflows. */
export function inspectRemovalConflictsEffect(
  options: InstallerOptions,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<readonly (ManagedConflict & { readonly action: "remove" })[], unknown> {
  return Effect.gen(function* () {
    const paths = resolveInstallerPaths(options, environment);
    yield* fromPromise(() => assertNoSymlinkTree(paths.codexHome));
    yield* fromPromise(() => assertNoSymlinkTree(paths.stateRoot));
    const active = yield* fromPromise(() => readActiveInstallRecord(paths));
    if (active !== undefined && !(yield* fromPromise(() => recordDigestMatches(active)))) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The HolyCodex ownership record has an invalid digest and cannot authorize removal.",
          undefined,
          { path: paths.activeRecord },
        ),
      );
    }
    const preparing = yield* fromPromise(() =>
      readInstallTransaction(paths.preparingRecord, active),
    );
    const conflicted = yield* fromPromise(() =>
      readInstallTransaction(paths.conflictedRecord, active),
    );
    yield* Effect.try({
      try: () => assertRemovalTransactionState(active, preparing, conflicted),
      catch: (error) => error,
    });
    const recovery = selectRecoveryState(active, preparing, conflicted);
    if (recovery === undefined) return [];
    const configText = yield* fromPromise(() => optionalTextFile(paths.configFile));
    const document = yield* Effect.try({
      try: () => parseConfig(configText),
      catch: (error) => error,
    });
    const conflicts: (ManagedConflict & { readonly action: "remove" })[] = [];
    const managedConfig = recovery.managed_config;
    if (managedConfig !== undefined) {
      const cleanup = yield* fromPromise(() =>
        cleanupManagedRuntimeConfig(document, managedConfig, {
          schema: managedConfig.schema,
          installId: managedConfig.installId,
        }),
      );
      for (const key of [...cleanup.preservedKeys, ...cleanup.unresolvedKeys]) {
        conflicts.push(
          yield* removalConfigConflictEffect(
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
      const cleanup = yield* fromPromise(() =>
        cleanupHolyCodexPluginConfig(document, recovery.plugin_config!, {
          allowBeforeState: true,
        }),
      );
      for (const name of cleanup.preserved) {
        const key =
          name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex";
        conflicts.push(
          yield* removalConfigConflictEffect(
            paths.configFile,
            key,
            document,
            "plugin-config",
            "This HolyCodex plugin setting differs from the recorded install state.",
          ),
        );
      }
    }
    const providerConfig = recovery.provider_config;
    if (providerConfig !== undefined) {
      const cleanup = yield* fromPromise(() =>
        cleanupProviderPluginConfig(
          document,
          withoutCodexDesktopManagedPlugins(providerConfig),
          new Set(ownedPluginsForRemoval(recovery)),
          { allowBeforeState: true },
        ),
      );
      for (const pluginId of cleanup.preserved) {
        const key = `plugins.${JSON.stringify(pluginId)}`;
        conflicts.push(
          yield* removalConfigConflictEffect(
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
      ...(yield* fromPromise(() =>
        inspectNativeAgentRemovalConflicts(paths.codexHome, recovery.managed_artifacts),
      )),
    );
    return [
      ...new Map(conflicts.map((conflict) => [conflictIdentity(conflict), conflict])).values(),
    ];
  });
}

/** Remove HolyCodex-owned state while preserving unrelated or user-modified data. */
export function removeHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RemoveResult> {
  return Effect.runPromise(removeHolyCodexEffect(options, environment));
}

/** Remove HolyCodex-owned state as an Effect for composition inside CLI workflows. */
export function removeHolyCodexEffect(
  options: InstallerOptions,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<RemoveResult, unknown> {
  return Effect.gen(function* () {
    const paths = resolveInstallerPaths(options, environment);
    yield* fromPromise(() => assertNoSymlinkTree(paths.codexHome));
    yield* fromPromise(() => assertNoSymlinkTree(paths.stateRoot));
    const active = yield* fromPromise(() => readActiveInstallRecord(paths));
    if (active && !(yield* fromPromise(() => recordDigestMatches(active)))) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The HolyCodex ownership record has an invalid digest and cannot authorize removal.",
          undefined,
          { path: paths.activeRecord },
        ),
      );
    }
    const preparing = yield* fromPromise(() =>
      readInstallTransaction(paths.preparingRecord, active),
    );
    const conflicted = yield* fromPromise(() =>
      readInstallTransaction(paths.conflictedRecord, active),
    );
    yield* Effect.try({
      try: () => assertRemovalTransactionState(active, preparing, conflicted),
      catch: (error) => error,
    });
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
    const removalConflicts = yield* inspectRemovalConflictsEffect(options, environment);
    const acceptedRemovalConflicts = yield* resolveRemovalConflictsEffect(
      options,
      removalConflicts,
    );

    const configBefore = yield* fromPromise(() => optionalTextFile(paths.configFile));
    let configBeforeDocument = yield* Effect.try({
      try: () => parseConfig(configBefore),
      catch: (error) => error,
    });
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
    yield* assertRemovalReviewUnchangedEffect(
      paths,
      configBeforeDocument,
      acceptedConfigConflicts,
      reviewedNativeConflicts,
    );
    let recoveryManagedConfig = recovery?.managed_config;
    if (recoveryManagedConfig) {
      const cleanup = yield* fromPromise(() =>
        cleanupManagedRuntimeConfig(configBeforeDocument, recoveryManagedConfig, {
          schema: recoveryManagedConfig.schema,
          installId: recoveryManagedConfig.installId,
        }),
      );
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
      const pluginConfig = recovery.plugin_config;
      const cleanup = yield* fromPromise(() =>
        cleanupHolyCodexPluginConfig(configBeforeDocument, pluginConfig, {
          allowBeforeState: true,
        }),
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
      const providerConfig = recovery.provider_config;
      const cleanup = yield* fromPromise(() =>
        cleanupProviderPluginConfig(
          configBeforeDocument,
          withoutCodexDesktopManagedPlugins(providerConfig),
          ownedPlugins,
          { allowBeforeState: true },
        ),
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
      manager = options.officialPluginManager;
      if (manager === undefined) {
        manager = yield* fromPromise(() =>
          CodexOfficialPluginManager.discover({
            ...environment,
            CODEX_HOME: paths.codexHome,
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.fail(
              new InstallerError(
                "capability_denied",
                "Native Codex plugin removal is unavailable.",
                error,
                {
                  operation: "discover Codex",
                  plugins: [...ownedPlugins].join(","),
                  recovery: "Install or expose Codex, then retry.",
                },
              ),
            ),
          ),
        );
      }
      if (manager === undefined || !manager.remove || !manager.list) {
        return yield* Effect.fail(
          new InstallerError(
            "capability_denied",
            "Native Codex plugin removal and readback are unavailable.",
            undefined,
            { operation: "prepare plugin removal", plugins: [...ownedPlugins].join(",") },
          ),
        );
      }
      const pluginManager = manager;
      livePlugins = yield* fromPromise(() => pluginManager.list!()).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new InstallerError(
              "capability_denied",
              "Codex plugin state could not be read before removing HolyCodex-owned plugins.",
              error,
              {
                operation: "read Codex plugin state",
                plugins: [...ownedPlugins].join(","),
                recovery: "Repair or expose Codex, then retry removal.",
              },
            ),
          ),
        ),
      );
    }

    let cleanedConfig:
      | { readonly document: TomlDocument; readonly state?: ManagedRuntimeConfigState }
      | undefined;
    let recoveryForRemoval = recovery;
    const configOperation = Effect.gen(function* () {
      let document = configBeforeDocument;
      let managedState = recoveryManagedConfig;
      if (managedState) {
        const cleanup = yield* fromPromise(() =>
          cleanupManagedRuntimeConfig(document, managedState!, {
            schema: managedState!.schema,
            installId: managedState!.installId,
          }),
        );
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
          yield* writeConflictStateEffect(paths, recovery ?? emptyRemovalState());
          return { preserved: returnPreservedState() };
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
        const cleanup = yield* fromPromise(() =>
          cleanupHolyCodexPluginConfig(document, recovery!.plugin_config!, {
            allowBeforeState: true,
          }),
        );
        if (cleanup.preserved.length > 0) {
          preserved.push(paths.configFile);
          reasons.push("plugin_config_changed");
          yield* writeConflictStateEffect(paths, recovery!);
          return { preserved: returnPreservedState() };
        }
        document = cleanup.document;
      }
      if (recovery?.provider_config) {
        const cleanup = yield* fromPromise(() =>
          cleanupProviderPluginConfig(
            document,
            withoutCodexDesktopManagedPlugins(recovery!.provider_config!),
            ownedPlugins,
            { allowBeforeState: true },
          ),
        );
        if (cleanup.preserved.length > 0) {
          preserved.push(paths.configFile);
          reasons.push("provider_config_changed");
          yield* writeConflictStateEffect(paths, recovery!);
          return { preserved: returnPreservedState() };
        }
        document = cleanup.document;
      }
      const removesHolyCodexDefault =
        readTomlPath(document, "default_permissions") === "holycodex" &&
        readTomlPath(document, "permissions.holycodex") === undefined;
      if (removesHolyCodexDefault) {
        document = deleteTomlPath(document, "default_permissions");
      }
      if (
        recovery?.managed_config ||
        recovery?.plugin_config ||
        recovery?.provider_config ||
        removesHolyCodexDefault
      ) {
        cleanedConfig =
          managedState === undefined ? { document } : { document, state: managedState };
      }
      if (cleanedConfig !== undefined) {
        if (Object.keys(cleanedConfig.document).length === 0 && configBefore === undefined) {
          yield* assertConfigTextUnchangedEffect(paths.configFile, configBefore);
          yield* fromPromise(() => rm(paths.configFile, { force: false }));
        } else {
          yield* assertConfigTextUnchangedEffect(paths.configFile, configBefore);
          yield* fromPromise(() =>
            writeAtomicText(paths.configFile, serializeConfig(cleanedConfig!.document)),
          );
        }
        recoveryForRemoval = { ...recovery!, managed_config: cleanedConfig.state };
        yield* writeConflictStateEffect(paths, recoveryForRemoval);
        removalCheckpointWritten = true;
      }
      return { complete: true as const };
    });
    const configOutcome = yield* configOperation.pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (result) => ({ result }),
      }),
    );
    if ("result" in configOutcome && "preserved" in configOutcome.result) {
      return configOutcome.result.preserved;
    }
    if ("error" in configOutcome) {
      const error = configOutcome.error;
      if (error instanceof InstallerError) {
        yield* writeConflictStateEffect(paths, recoveryForRemoval ?? emptyRemovalState());
        return yield* Effect.fail(error);
      }
      preserved.push(paths.configFile);
      reasons.push("managed_config_write_failed");
      yield* writeConflictStateEffect(paths, recoveryForRemoval ?? emptyRemovalState());
      return returnPreservedState();
    }

    const native = yield* fromPromise(() =>
      removeManagedNativeAgents(
        paths.codexHome,
        recovery?.managed_artifacts ?? [],
        reviewedNativeConflicts,
      ),
    );
    removed.push(...native.removed);
    preserved.push(...native.preserved);
    if (native.preserved.length > 0) {
      reasons.push("managed_artifact_changed");
      yield* writeConflictStateEffect(paths, recoveryForRemoval ?? recovery ?? emptyRemovalState());
      return returnPreservedState();
    }
    removed.push(
      ...(yield* removeEmptyManagedRoleGenerationsEffect(
        paths.roleRoot,
        recovery?.managed_artifacts ?? [],
      )),
    );

    for (const pluginId of ownedPlugins) {
      const pluginOutcome = yield* Effect.gen(function* () {
        if (
          manager?.list === undefined ||
          manager.remove === undefined ||
          livePlugins === undefined
        ) {
          return yield* Effect.fail(
            new InstallerError(
              "capability_denied",
              "Codex plugin state is unavailable for a HolyCodex-owned plugin.",
              undefined,
              { operation: "remove Codex plugin", plugin_id: pluginId },
            ),
          );
        }
        const before = livePlugins;
        const observed = resolveOwnedPluginEntry(before, pluginId);
        if (observed?.entry.installed !== true) return;
        const removalId = observed.entry.pluginId;
        yield* fromPromise(() => manager!.remove!(removalId));
        const live = yield* fromPromise(() => manager!.list!());
        livePlugins = live;
        const resolvedRemaining = resolveOfficialPluginEntry(live, pluginId)?.entry;
        const remaining =
          resolvedRemaining?.installed === true ||
          [...live.installed, ...live.available].some(
            (entry) => entry.pluginId === pluginId && entry.installed,
          );
        if (remaining) {
          return yield* Effect.fail(
            new InstallerError(
              "capability_denied",
              `Codex still reports ${pluginId} after removal.`,
            ),
          );
        }
        if (cleanedConfig !== undefined) {
          yield* reconcileRemovedPluginPreferenceEffect(paths, cleanedConfig.document, pluginId);
        }
        removed.push(pluginId);
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ success: true as const }),
        }),
      );
      if ("error" in pluginOutcome) {
        const error = pluginOutcome.error;
        reasons.push("native_plugin_remove_failed");
        yield* writeConflictStateEffect(paths, recoveryForRemoval ?? emptyRemovalState());
        return yield* Effect.fail(
          new InstallerError(
            "capability_denied",
            `Codex native plugin removal did not converge for ${pluginId}: ${safeMessage(error)}`,
            error,
          ),
        );
      }
    }
    const context7Removal = yield* fromPromise(() =>
      removeOwnedContext7(
        options.runtime ?? createInstallerRuntime(environment),
        recovery.tooling?.context7,
      ),
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (removedContext7) => ({ removedContext7 }),
      }),
    );
    if ("error" in context7Removal) {
      const error = context7Removal.error;
      reasons.push("context7_remove_failed");
      yield* writeConflictStateEffect(paths, recoveryForRemoval ?? emptyRemovalState());
      return yield* Effect.fail(
        new InstallerError(
          "capability_denied",
          `Context7 removal did not converge: ${safeMessage(error)}`,
          error,
        ),
      );
    }
    if (context7Removal.removedContext7) {
      removed.push("ctx7");
    }
    if (active) {
      const activeRemoval = yield* fromPromise(() => rm(paths.activeRecord, { force: false })).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ success: true as const }),
        }),
      );
      if ("success" in activeRemoval) {
        removed.push(paths.activeRecord);
      } else {
        const error = activeRemoval.error;
        if (!isFsCode(error, "ENOENT")) {
          preserved.push(paths.activeRecord);
          reasons.push("state_remove_failed");
          yield* writeConflictStateEffect(paths, recovery ?? active);
          return returnPreservedState();
        }
      }
    }
    if (preserved.length === 0) {
      const optionsRemoval = yield* fromPromise(() =>
        rm(paths.installOptions, { force: false }),
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ success: true as const }),
        }),
      );
      if ("success" in optionsRemoval) {
        removed.push(paths.installOptions);
      } else {
        const error = optionsRemoval.error;
        if (!isFsCode(error, "ENOENT")) {
          preserved.push(paths.installOptions);
          reasons.push("state_remove_failed");
          yield* writeConflictStateEffect(paths, recovery ?? active ?? emptyRemovalState());
        }
      }
    }
    if (preserved.length === 0) {
      for (const [path, present] of [
        [paths.preparingRecord, preparing !== undefined],
        [paths.conflictedRecord, conflicted !== undefined || removalCheckpointWritten],
      ] as const) {
        if (!present) continue;
        const transactionRemoval = yield* removeTransactionEffect(path).pipe(
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: () => ({ success: true as const }),
          }),
        );
        if ("success" in transactionRemoval) {
          removed.push(path);
        } else {
          preserved.push(path);
          reasons.push("state_remove_failed");
        }
      }
    }
    if (preserved.length === 0) {
      const roleDirectoryRemoval = yield* fromPromise(() => rmdir(paths.roleRoot)).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ success: true as const }),
        }),
      );
      if ("success" in roleDirectoryRemoval) {
        removed.push(paths.roleRoot);
      } else {
        const error = roleDirectoryRemoval.error;
        if (!isFsCode(error, "ENOENT")) {
          preserved.push(paths.roleRoot);
          reasons.push("role_directory_not_empty");
        }
      }
    }
    if (preserved.length === 0) {
      const stateDirectoryRemoval = yield* fromPromise(() => rmdir(paths.stateRoot)).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ success: true as const }),
        }),
      );
      if ("success" in stateDirectoryRemoval) {
        removed.push(paths.stateRoot);
      } else {
        const error = stateDirectoryRemoval.error;
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
  });
}

function reconcileRemovedPluginPreferenceEffect(
  paths: ResolvedInstallerPaths,
  expected: TomlDocument,
  pluginId: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const configText = yield* fromPromise(() => optionalTextFile(paths.configFile));
    if (configText === undefined) return;
    const document = yield* Effect.try({
      try: () => parseConfig(configText, paths.configFile),
      catch: (error) => error,
    });
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
    yield* fromPromise(() => writeAtomicText(paths.configFile, serializeConfig(restored)));
  });
}

function isTomlTableValue(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove only empty generation directories named by this install's role artifacts. */
function removeEmptyManagedRoleGenerationsEffect(
  roleRoot: string,
  artifacts: readonly InstallRecord["managed_artifacts"][number][],
): Effect.Effect<readonly string[], unknown> {
  return Effect.gen(function* () {
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
      const result = yield* fromPromise(() => rmdir(directory)).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: () => ({ removed: true as const }),
        }),
      );
      if ("removed" in result) {
        removed.push(directory);
      } else {
        const error = result.error;
        // Non-empty generations can still contain user data or profiles referenced by
        // older threads. Keep them for the existing role-root preservation handling.
        if (
          !isFsCode(error, "ENOENT") &&
          !isFsCode(error, "ENOTEMPTY") &&
          !isFsCode(error, "EEXIST")
        ) {
          return yield* Effect.fail(error);
        }
      }
    }
    return removed;
  });
}

/** Migrate an existing installation in place using the running HolyCodex binary. */
export function upgradeHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
  request: UpgradeRequest = {},
): Promise<UpgradeResult> {
  return Effect.runPromise(upgradeHolyCodexEffect(options, environment, request));
}

/** Upgrade HolyCodex as an Effect for composition inside CLI workflows. */
export function upgradeHolyCodexEffect(
  options: InstallerOptions,
  environment: Readonly<Record<string, string | undefined>>,
  request: UpgradeRequest,
): Effect.Effect<UpgradeResult, unknown> {
  return Effect.gen(function* () {
    const paths = resolveInstallerPaths(options, environment);
    const active = yield* fromPromise(() => readActiveInstallRecord(paths));
    const preparing = yield* fromPromise(() =>
      readInstallTransaction(paths.preparingRecord, active),
    );
    const conflicted = yield* fromPromise(() =>
      readInstallTransaction(paths.conflictedRecord, active),
    );
    if (active !== undefined && !(yield* fromPromise(() => recordDigestMatches(active)))) {
      return yield* Effect.fail(
        new InstallerError(
          "state_corrupt",
          "The existing HolyCodex configuration has changed and cannot be upgraded safely.",
          undefined,
          { path: paths.activeRecord },
        ),
      );
    }
    yield* Effect.try({
      try: () => assertInstallTransactionState(active, preparing, conflicted),
      catch: (error) => error,
    });
    const transaction = selectRecoveryTransaction(active, preparing, conflicted);
    const source = transaction ?? active;
    if (source === undefined) {
      return yield* Effect.fail(
        new InstallerError(
          "not_installed",
          "HolyCodex is not installed in the selected Codex home.",
          undefined,
          { recovery: "Run `holycodex install --yes` first." },
        ),
      );
    }
    const persistedOptions = yield* fromPromise(() => readInstallOptions(paths));
    const sourceOptions =
      persistedOptions === undefined
        ? {
            profile: source.profile,
            tier: source.tier,
            optional: {
              browser_use: source.optional_selections.browser_use,
              computer_use: source.optional_selections.computer_use,
              sites: source.optional_selections.sites,
              "session-audit": source.optional_selections["session-audit"],
              "auto-reset": source.optional_selections["auto-reset"],
            },
            officialPlugins: additionalPluginsFromRecord(source),
          }
        : withoutLegacyWorkPlugins(installRequestFromPersistedOptions(persistedOptions));
    const selectedOptions =
      request.options === undefined
        ? sourceOptions
        : yield* Effect.try({
            try: () => validateInstallOptions(request.options),
            catch: (error) => error,
          });
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
    const targetVersion = yield* fromPromise(() => readInstallationVersion()).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new InstallerError(
            "upgrade_failed",
            "The running HolyCodex version is unavailable.",
            error,
          ),
        ),
      ),
    );
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
      return yield* Effect.fail(
        new InstallerError(
          "upgrade_downgrade",
          `The running HolyCodex version ${targetVersion} is older than the installed version ${source.version}.`,
          undefined,
          { installed_version: source.version, running_version: targetVersion },
        ),
      );
    }
    const legacyContext =
      source.managed_config?.managed["features.context_management"] !== undefined;
    const legacyAutoCompact =
      source.managed_config?.managed[LEGACY_ROOT_CONFIG_KEY_PATHS[0]!] !== undefined;
    const dryRunConflictInventory: ManagedConflict[] = [];
    if (request.dryRun === true) {
      const configText = yield* fromPromise(() => optionalTextFile(paths.configFile));
      const document = yield* Effect.try({
        try: () => parseConfig(configText),
        catch: (error) => error,
      });
      if (source.managed_config !== undefined) {
        for (const key of Object.keys(source.managed_config.managed) as ManagedConfigKeyPath[]) {
          if (!isManagedConfigKeyPath(key)) continue;
          const comparison = yield* fromPromise(() =>
            compareManagedConfigKey(document, source.managed_config!, key),
          );
          if (comparison.status !== "unchanged") {
            dryRunConflictInventory.push({ path: paths.configFile, key, action: "replace" });
          }
        }
      }
      if (source.plugin_config !== undefined) {
        const cleanup = yield* fromPromise(() =>
          cleanupHolyCodexPluginConfig(document, source.plugin_config!),
        );
        for (const name of cleanup.preserved) {
          const key =
            name === "preference" ? 'plugins."holycodex@holycodex"' : "marketplaces.holycodex";
          dryRunConflictInventory.push({ path: paths.configFile, key, action: "replace" });
        }
      }
      if (source.provider_config !== undefined) {
        const providerConfig = source.provider_config;
        const cleanup = yield* fromPromise(() =>
          cleanupProviderPluginConfig(
            document,
            withoutCodexDesktopManagedPlugins(providerConfig),
            new Set(ownedPluginsForRemoval(source)),
          ),
        );
        for (const pluginId of cleanup.preserved) {
          dryRunConflictInventory.push({
            path: paths.configFile,
            key: `plugins."${pluginId}"`,
            action: "replace",
          });
        }
      }
      const nativeConflicts = yield* fromPromise(() =>
        inspectNativeAgentConflicts(
          paths.codexHome,
          source.profile,
          source.managed_artifacts,
          source.tier,
          {
            browserUse: source.optional_selections.browser_use,
            computerUse: source.optional_selections.computer_use,
          },
        ),
      );
      for (const conflict of nativeConflicts) {
        dryRunConflictInventory.push(conflict);
      }
    }
    const runtime = options.runtime ?? createInstallerRuntime(environment);
    const catalogCommand = yield* fromPromise(() =>
      runtime.run("codex", ["debug", "models", "--bundled"]),
    );
    if (catalogCommand.exitCode !== 0) {
      return yield* Effect.fail(
        new InstallerError(
          "upgrade_failed",
          `The current Codex model catalog could not be read: ${catalogCommand.stderr || "Codex debug models failed."}`,
        ),
      );
    }
    const catalogInput = yield* Effect.try({
      try: () => JSON.parse(catalogCommand.stdout) as unknown,
      catch: (error) => error,
    });
    const currentCatalog = yield* Effect.try({
      try: () => patchCurrentModelCatalog(catalogInput),
      catch: (error) => error,
    });
    const currentJson = `${JSON.stringify(currentCatalog.catalog, null, 2)}\n`;
    const currentDigest = createHash("sha256").update(currentJson).digest("hex");
    const installedCatalog = source.managed_artifacts.find(
      (artifact) => artifact.path === "holycodex/model-catalog.json",
    );
    const modelCatalogDrift = installedCatalog?.digest !== currentDigest;
    let toolingDrift = false;
    const toolingDriftReasons: string[] = [];
    const toolingOutcome = yield* Effect.gen(function* () {
      const context7Outcome = yield* fromPromise(() =>
        inspectContext7ReadOnly(runtime, source.tooling?.context7),
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (context7) => ({ context7 }),
        }),
      );
      let context7: Awaited<ReturnType<typeof inspectContext7ReadOnly>> | undefined;
      if ("error" in context7Outcome) {
        if (source.tooling?.context7 !== undefined || !isContext7Absent(context7Outcome.error)) {
          return yield* Effect.fail(context7Outcome.error);
        }
      } else {
        context7 = context7Outcome.context7;
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
            !(yield* fromPromise(() =>
              sameInstallerFile(runtime, recordedContext7.executable!, context7!.executable!),
            ))
      ) {
        toolingDriftReasons.push("Context7 executable changed");
      }
      toolingDrift ||= toolingDriftReasons.length > 0;
      return { driftReasons: toolingDriftReasons };
    }).pipe(Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => value }));
    if ("error" in toolingOutcome) {
      const error = toolingOutcome.error;
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
    } else {
      toolingDriftReasons.push(...toolingOutcome.driftReasons);
      toolingDrift ||= toolingDriftReasons.length > 0;
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
      ...(modelCatalogDrift ? ["current Codex model catalog changed"] : []),
      ...(toolingDrift
        ? [`shared tooling reconciliation (${toolingDriftReasons.join(", ")})`]
        : []),
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
    const result = yield* fromPromise(() =>
      installHolyCodex(effectiveOptions, options, environment),
    ).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof InstallerError
            ? error
            : new InstallerError(
                "upgrade_failed",
                `HolyCodex upgrade failed: ${safeMessage(error)}`,
                error,
              ),
        ),
      ),
    );
    return {
      status: "upgraded",
      from_version: source.version,
      to_version: targetVersion,
      changes,
      record: result.record,
      preserved: result.preserved,
      warnings: result.warnings,
    };
  });
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

function resolveRemovalConflictsEffect(
  options: InstallerOptions,
  conflicts: readonly {
    readonly path: string;
    readonly key?: string | undefined;
    readonly action: "remove";
  }[],
): Effect.Effect<ReadonlySet<string>, unknown> {
  return Effect.gen(function* () {
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
      const decisions = yield* options.resolveConflicts(structured);
      for (let index = 0; index < structured.length; index += 1) {
        const conflict = structured[index]!;
        const decision = decisions[conflict.identity!];
        if (decision === "remove") {
          accepted.add(conflictIdentity(conflicts[index]!));
        } else if (decision === "keep") {
          continue;
        } else if (decision === "cancel") {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              "Conflict resolution was cancelled.",
              undefined,
              {
                identity: conflict.identity!,
                path: conflict.path,
                ...(conflict.key === undefined ? {} : { key: conflict.key }),
              },
            ),
          );
        } else {
          return yield* Effect.fail(
            new InstallerError(
              "confirmation_required",
              `The removal conflict at ${conflict.target} requires a keep, remove, or cancel decision.`,
              undefined,
              {
                identity: conflict.identity!,
                path: conflict.path,
                ...(conflict.key === undefined ? {} : { key: conflict.key }),
                decision: decision ?? "unavailable",
              },
            ),
          );
        }
      }
      return accepted;
    }
    for (const conflict of conflicts) {
      const resolution =
        options.resolveConflict === undefined
          ? undefined
          : yield* options.resolveConflict(conflict);
      if (resolution === "accept") {
        accepted.add(conflictIdentity(conflict));
        continue;
      }
      if (resolution === "decline") continue;
      return yield* Effect.fail(
        new InstallerError(
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
        ),
      );
    }
    return accepted;
  });
}

function conflictIdentity(conflict: {
  readonly path: string;
  readonly key?: string | undefined;
  readonly action: "replace" | "remove";
}): string {
  return `${conflict.action}\u0000${conflict.path}\u0000${conflict.key ?? ""}`;
}

function removalConfigConflictEffect(
  path: string,
  key: string,
  document: TomlDocument,
  category: string,
  explanation: string,
): Effect.Effect<ManagedConflict & { readonly action: "remove" }, unknown> {
  const existing = readTomlPath(document, key);
  return removalConfigDigestEffect(document, key).pipe(
    Effect.map((digest) => ({
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
    })),
  );
}

function removalConfigDigestEffect(
  document: TomlDocument,
  key: string,
): Effect.Effect<string, unknown> {
  const current = readTomlPath(document, key);
  const observation =
    current === undefined
      ? { present: false as const }
      : { present: true as const, value: current };
  return fromPromise(() =>
    domainSeparatedSha256("holycodex-removal-config-review-v1", [
      canonicalJsonUtf8(asJsonValue(observation)),
    ]),
  );
}

function reviewedConflictDigest(conflict: ManagedConflict): string | undefined {
  if (typeof conflict.existing !== "object" || conflict.existing === null) return undefined;
  const digest = (conflict.existing as { readonly digest?: unknown }).digest;
  return typeof digest === "string" ? digest : undefined;
}

function assertRemovalReviewUnchangedEffect(
  paths: ResolvedInstallerPaths,
  document: TomlDocument,
  acceptedConfigConflicts: readonly ManagedConflict[],
  reviewedNativeConflicts: ReadonlyMap<string, string>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const conflict of acceptedConfigConflicts) {
      if (conflict.key === undefined) continue;
      const expected = reviewedConflictDigest(conflict);
      if (
        expected === undefined ||
        (yield* removalConfigDigestEffect(document, conflict.key)) !== expected
      ) {
        return yield* Effect.fail(reviewedRemovalChanged(conflict.path, conflict.key));
      }
    }
    const nativeResult = yield* fromPromise(() =>
      changedNativeAgentRemovalConflicts(paths.codexHome, reviewedNativeConflicts),
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (changedNativePaths) => ({ changedNativePaths }),
      }),
    );
    if ("error" in nativeResult) {
      const subject = reviewedNativeConflicts.keys().next().value as string | undefined;
      return yield* Effect.fail(
        new InstallerError(
          "confirmation_required",
          "A reviewed HolyCodex file could not be checked safely, so removal did not continue.",
          nativeResult.error,
          {
            operation: "verify removal review",
            ...(subject === undefined ? {} : { path: subject }),
            recovery: "Check file access, then run remove again to review current state.",
          },
        ),
      );
    }
    if (nativeResult.changedNativePaths.length > 0) {
      return yield* Effect.fail(reviewedRemovalChanged(nativeResult.changedNativePaths[0]!));
    }
  });
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

function assertConfigTextUnchangedEffect(
  path: string,
  reviewedText: string | undefined,
): Effect.Effect<void, unknown> {
  return fromPromise(() => optionalTextFile(path)).pipe(
    Effect.flatMap((current) =>
      current === reviewedText ? Effect.void : Effect.fail(reviewedRemovalChanged(path)),
    ),
  );
}

function doctorRuntimeConfigEffect(
  paths: ResolvedInstallerPaths,
  active: InstallRecord,
): Effect.Effect<DoctorCheck, never> {
  if (!active.managed_config) return Effect.succeed(failedCheck(["incomplete_install_state"]));
  return Effect.gen(function* () {
    const source = yield* fromPromise(() => optionalTextFile(paths.configFile));
    const document = yield* Effect.try({
      try: () => parseConfig(source),
      catch: (error) => error,
    });
    const modelCatalogText = yield* fromPromise(() =>
      optionalTextFile(nativeModelCatalogPath(paths.codexHome)),
    );
    if (modelCatalogText === undefined) {
      return failedCheck(["model_catalog_missing"], {
        path: nativeModelCatalogPath(paths.codexHome),
      });
    }
    const modelCatalog = yield* Effect.try({
      try: () => JSON.parse(modelCatalogText) as unknown,
      catch: (error) => error,
    });
    const expected = desiredRootConfig(
      active.profile,
      active.tier,
      {
        browserUse:
          active.capability_state?.browser_use.status === "healthy" &&
          active.capability_state.browser_use.selected,
        computerUse: active.optional_selections.computer_use,
        frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
        security: DEFAULT_CAPABILITY_SELECTIONS.security,
        sessionAudit: active.optional_selections["session-audit"],
        autoReset: active.optional_selections["auto-reset"],
        parentPersonalityNone: rootPersonalityIsNone(readTomlPath(document, "personality")),
      },
      paths.codexHome,
      modelCatalog,
    );
    const drift: string[] = [];
    for (const keyPath of Object.keys(expected)) {
      const comparison = yield* fromPromise(() =>
        compareManagedConfigKey(document, active.managed_config!, keyPath as ManagedConfigKeyPath),
      );
      if (comparison.status !== "unchanged") drift.push(keyPath);
    }
    return drift.length === 0
      ? healthyCheck({ managed_keys: Object.keys(expected).length })
      : failedCheck(["changed_holycodex_config"], { keys: drift });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(failedCheck(["config_unreadable"], { error: safeMessage(error) })),
    ),
  );
}

function doctorNativeRolesEffect(
  paths: ResolvedInstallerPaths,
  profile: InstallRecord["profile"],
  tier: InstallRecord["tier"],
  capabilities: Readonly<{ browserUse: boolean; computerUse: boolean }> = {
    browserUse: false,
    computerUse: false,
  },
  managedArtifacts: InstallRecord["managed_artifacts"] = [],
): Effect.Effect<DoctorCheck, never> {
  return Effect.gen(function* () {
    const source = yield* fromPromise(() => optionalTextFile(paths.configFile));
    const document = yield* Effect.try({ try: () => parseConfig(source), catch: (error) => error });
    const failures: string[] = [];
    const managedByPath = new Map(managedArtifacts.map((artifact) => [artifact.path, artifact]));
    const roleCapabilities = {
      ...capabilities,
      parentPersonalityNone: rootPersonalityIsNone(readTomlPath(document, "personality")),
    };
    const generationId = nativeAgentGenerationId(profile, tier, roleCapabilities);
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
      const roleText = yield* fromPromise(() => optionalTextFile(expected));
      if (roleText === undefined) {
        failures.push(`${agent.name}:missing`);
        continue;
      }
      const roleDocument = parseConfig(roleText, expected);
      const roleRelativePath = relative(paths.codexHome, expected).replaceAll("\\", "/");
      const roleArtifact = managedByPath.get(roleRelativePath);
      if (
        roleArtifact === undefined ||
        createHash("sha256").update(roleText).digest("hex") !== roleArtifact.digest
      ) {
        failures.push(`${agent.name}:changed`);
        continue;
      }
      if (
        roleDocument["personality"] !==
        (roleCapabilities.parentPersonalityNone ? "friendly" : "none")
      ) {
        failures.push(`${agent.name}:personality_changed`);
        continue;
      }
      if (roleText !== renderNativeAgent(agent, roleCapabilities)) {
        failures.push(`${agent.name}:changed`);
        continue;
      }
    }
    const staleRoot = yield* fromPromise(() =>
      optionalTextFile(`${paths.codexHome}/agents/root.toml`),
    );
    if (staleRoot !== undefined && isKnownLegacyRootRoleContent(staleRoot)) {
      failures.push("root:stale");
    }
    return failures.length === 0
      ? healthyCheck({
          role_root: paths.roleRoot,
          agent_types: projectNativeAgents(profile, tier).map((agent) => agent.name),
        })
      : failedCheck(["native_role_disagreement"], { roles: failures });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(failedCheck(["native_role_invalid"], { error: safeMessage(error) })),
    ),
  );
}

function writeConflictStateEffect(
  paths: ResolvedInstallerPaths,
  active: PersistedInstallState,
): Effect.Effect<void, unknown> {
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
    return fromPromise(() => writeAtomicState(paths.conflictedRecord, asJsonValue(transaction)));
  }
  return Effect.void;
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
      "session-audit": false,
      "auto-reset": false,
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

function removeTransactionEffect(path: string): Effect.Effect<void, unknown> {
  return fromPromise(() => rm(path, { force: false })).pipe(
    Effect.catchIf(
      (error) => isFsCode(error, "ENOENT"),
      () => Effect.void,
    ),
    Effect.asVoid,
  );
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

function fromPromise<A>(operation: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

function reportProgress(options: InstallerOptions, event: InstallProgressEvent): void {
  Effect.runSync(
    Effect.ignore(Effect.try({ try: () => options.onProgress?.(event), catch: (error) => error })),
  );
}
