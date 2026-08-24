// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { verifyPayload } from "@holycodex/plugin";
import {
  CAPABILITY_REGISTRY,
  OPTIONAL_CAPABILITY_NAMES,
  capabilityHealth,
  pluginIdsForOptionalCapabilities,
  type JsonObject,
} from "@holycodex/core";
import { FileRunStore } from "@holycodex/workflow-host";
import {
  InstallJournalRecordSchema,
  appendJournal,
  readActiveInstallRecord,
  verifyActivation,
} from "./installer.ts";
import { acquireInstallLock, type LockLease } from "./lock.ts";
import {
  findManagedEntry,
  managedEntryMatches,
  readMarketplace,
  writeMarketplace,
} from "./marketplace.ts";
import {
  assertNoSymlink,
  assertNoSymlinkTree,
  isFsCode,
  pathWithin,
  resolveInstallerPaths,
  type ResolvedInstallerPaths,
} from "./paths.ts";
import { decodeSchema } from "./schema.ts";
import { inspectLegacyState } from "./migration.ts";
import { StorageError } from "./storage.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import {
  assertSafeSessionId,
  GeneratedWorkflowStore,
  GeneratedWorkflowStoreError,
} from "./generated-workflow-store.ts";
import type {
  CleanupResult,
  CleanupScope,
  DoctorCheck,
  DoctorResult,
  InstallRecord,
  InstallerOptions,
} from "./types.ts";

export async function doctorHolyCodex(
  options: InstallerOptions = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DoctorResult> {
  const paths = resolveInstallerPaths(options, environment);
  const checks: Record<string, DoctorCheck> = {};
  try {
    await assertNoSymlinkTree(paths.codexHome);
    await assertNoSymlinkTree(paths.marketplaceRoot);
    await assertNoSymlinkTree(paths.stateRoot);
  } catch (error: unknown) {
    checks["paths"] = failedCheck(["path_symlink"], { error: safeMessage(error) });
    return {
      healthy: false,
      checks,
      reasons: ["path_symlink"],
      inactive_artifacts: [],
    };
  }
  let active: InstallRecord | undefined;
  try {
    active = await readActiveInstallRecord(paths);
    checks["state"] = active
      ? healthyCheck({ artifact_id: active.artifact_id })
      : failedCheck(["active_record_missing"]);
  } catch (error: unknown) {
    checks["state"] = failedCheck(["state_corrupt"], { error: safeMessage(error) });
  }
  try {
    const migration = await inspectLegacyState(paths);
    checks["migration"] =
      migration.status === "quarantined"
        ? failedCheck(["legacy_state_quarantined"], { target: migration.target_path })
        : migration.source_paths.length > 0
          ? warningCheck(["legacy_state_present"], { target: migration.target_path })
          : healthyCheck({ target: migration.target_path });
  } catch (error: unknown) {
    checks["migration"] = failedCheck(["migration_state_corrupt"], {
      error: safeMessage(error),
    });
  }
  if (active) {
    const artifact = join(paths.marketplaceRoot, active.relative_path.slice(2));
    try {
      const artifactName = active.relative_path.split("/").at(-1);
      if (artifactName !== active.artifact_id || !pathWithin(paths.payloadRoot, artifact)) {
        throw new CleanupError("cleanup_failed", "The active payload identity is inconsistent.");
      }
      await assertNoSymlink(artifact);
      const verified = await verifyPayload(artifact);
      if (
        verified.identity.digest !== active.digest ||
        verified.identity.version !== active.version ||
        verified.identity.epoch !== active.epoch
      ) {
        checks["payload"] = failedCheck(["identity_mismatch"]);
      } else {
        checks["payload"] = healthyCheck({
          path: active.relative_path,
          files: verified.manifest.files.length,
        });
      }
    } catch (error: unknown) {
      checks["payload"] = failedCheck(["payload_missing_or_corrupt"], {
        error: safeMessage(error),
      });
    }
    try {
      const marketplace = await readMarketplace(paths.marketplaceFile);
      const entry = findManagedEntry(marketplace);
      checks["marketplace"] = managedEntryMatches(entry, active)
        ? healthyCheck({ source: active.relative_path })
        : failedCheck(["marketplace_mismatch"]);
    } catch (error: unknown) {
      checks["marketplace"] = failedCheck(["marketplace_corrupt"], { error: safeMessage(error) });
    }
  } else {
    checks["payload"] = failedCheck(["active_record_missing"]);
    checks["marketplace"] = failedCheck(["active_record_missing"]);
  }
  checks["journal"] = await inspectJournal(paths);
  checks["staging"] = await inspectStaging(paths);
  checks["lock"] = await inspectLock(paths);
  checks["codex_mcp"] = await inspectCodexMcp(paths);
  checks["codex_executable"] = await inspectCodexExecutable(options);
  const inactive = await listInactiveArtifacts(paths, active?.artifact_id);
  checks["inactive_caches"] =
    inactive.length === 0
      ? healthyCheck({ count: 0 })
      : warningCheck(["inactive_owned_payloads"], { count: inactive.length });
  const officialPluginManager =
    options.officialPluginManager ??
    (await CodexOfficialPluginManager.discover().catch(() => undefined));
  checks["capabilities"] = await inspectCapabilities(active, officialPluginManager);
  if (officialPluginManager?.status) {
    try {
      const status = await officialPluginManager.status(active?.official_plugins ?? []);
      const missing = Object.entries(status)
        .filter(([, value]) => value !== "installed")
        .map(([key]) => key);
      checks["official_plugins"] =
        missing.length === 0
          ? healthyCheck({ status })
          : failedCheck(["official_plugin_disagreement"], { missing, status });
    } catch (error: unknown) {
      checks["official_plugins"] = failedCheck(["official_plugin_status_failed"], {
        error: safeMessage(error),
      });
    }
  } else {
    checks["official_plugins"] = {
      status: "unsupported",
      reasons: ["official_plugin_manager_not_configured"],
      details: {},
    };
  }
  const reasons = Object.values(checks).flatMap((check) => check.reasons);
  return {
    healthy: Object.values(checks).every((check) => check.status !== "failed"),
    checks,
    reasons: [...new Set(reasons)],
    inactive_artifacts: inactive,
  };
}

async function inspectCapabilities(
  active: InstallRecord | undefined,
  manager: InstallerOptions["officialPluginManager"] | undefined,
): Promise<DoctorCheck> {
  const details: Record<string, JsonObject> = {};
  const reasons: string[] = [];
  if (!active) {
    return healthyCheck({ configured: false });
  }
  let liveStatus: Readonly<
    Record<string, "installed" | "available" | "missing" | "disabled" | "uncertain" | "unknown">
  > = {};
  if (manager?.status || manager?.list) {
    try {
      const selectedProviderIds = pluginIdsForOptionalCapabilities(active.optional_selections);
      const providerIds = [
        ...new Set([
          ...(active.official_plugins ?? []),
          ...selectedProviderIds,
          ...OPTIONAL_CAPABILITY_NAMES.flatMap(
            (name) => active.capability_state?.[name]?.plugin_ids ?? [],
          ),
        ]),
      ];
      if (manager.status) {
        liveStatus = await manager.status(providerIds);
      } else {
        const list = manager.list;
        if (list === undefined) throw new Error("Official plugin listing is unavailable.");
        const live = await list();
        for (const pluginId of providerIds) {
          const entry = [...live.installed, ...live.available].find(
            (candidate) => candidate.pluginId === pluginId,
          );
          liveStatus = {
            ...liveStatus,
            [pluginId]:
              entry === undefined
                ? "missing"
                : entry.installed && entry.enabled
                  ? "installed"
                  : entry.installed
                    ? "disabled"
                    : "missing",
          };
        }
      }
    } catch (error: unknown) {
      for (const name of OPTIONAL_CAPABILITY_NAMES) {
        if (active.optional_selections[name]) {
          reasons.push(`${name}:uncertain`);
          details[name] = { selected: true, status: "uncertain", reason: safeMessage(error) };
        } else {
          details[name] = { selected: false, status: "healthy" };
        }
      }
      return failedCheck(reasons, details);
    }
  }
  for (const name of OPTIONAL_CAPABILITY_NAMES) {
    const selected = active.optional_selections[name];
    if (!selected) {
      details[name] = { selected: false, status: "healthy" };
      continue;
    }
    const state = active.capability_state?.[name];
    const pluginIds = state?.plugin_ids ?? CAPABILITY_REGISTRY[name].pluginIds;
    const statuses = pluginIds.map((pluginId) => liveStatus[pluginId] ?? "unknown");
    const providerStatus = statuses.includes("disabled")
      ? "disabled"
      : statuses.includes("uncertain") || statuses.includes("unknown")
        ? "uncertain"
        : statuses.includes("missing") || statuses.includes("available")
          ? "missing"
          : "installed";
    const status = capabilityHealth(selected, providerStatus);
    details[name] = {
      selected: true,
      status,
      plugin_ids: [...pluginIds],
      persisted_status: state?.status ?? "missing",
    };
    if (status !== "healthy") reasons.push(`${name}:${status}`);
  }
  return reasons.length === 0 ? healthyCheck(details) : failedCheck(reasons, details);
}

export async function cleanupHolyCodex(
  scope: CleanupScope,
  options: InstallerOptions = {},
  input: Readonly<{ yes?: boolean; runId?: string; sessionId?: string }> = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CleanupResult> {
  const paths = resolveInstallerPaths(options, environment);
  await assertNoSymlinkTree(paths.codexHome);
  await assertNoSymlinkTree(paths.marketplaceRoot);
  await assertNoSymlinkTree(paths.stateRoot);
  if (input.yes === true) {
    const now = options.now ?? (() => new Date());
    const runId = options.runIdFactory?.() ?? `cleanup-${crypto.randomUUID()}`;
    let lease: LockLease | undefined;
    try {
      lease = await acquireInstallLock(
        paths,
        {
          ttlMs: options.lockTtlMs ?? 5 * 60 * 1000,
          pid: options.pid ?? process.pid,
          runId,
          now,
        },
        async (details) => appendJournal(paths, runId, "lock-recovery", details, now),
      );
      return await cleanupHolyCodexUnlocked(scope, options, input, paths);
    } finally {
      await lease?.release();
    }
  }
  return await cleanupHolyCodexUnlocked(scope, options, input, paths);
}

async function cleanupHolyCodexUnlocked(
  scope: CleanupScope,
  options: InstallerOptions,
  input: Readonly<{ yes?: boolean; runId?: string; sessionId?: string }>,
  paths: ResolvedInstallerPaths,
): Promise<CleanupResult> {
  const preview = input.yes !== true;
  const removed: string[] = [];
  const preserved: string[] = [];
  const reasons: string[] = [];
  const retentionDays = options.retentionDays ?? 30;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new CleanupError("cleanup_failed", "Cleanup retention must be finite and positive.");
  }
  const now = options.now?.() ?? new Date();
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const active = await readActiveInstallRecord(paths).catch((error: unknown) => {
    if (error instanceof StorageError && error.code === "state_corrupt") {
      reasons.push("state_corrupt");
      return undefined;
    }
    if (isFsCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (scope === "run") {
    if (!input.runId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.runId)) {
      throw new CleanupError("cleanup_failed", "Run cleanup requires a safe run id.");
    }
    const target = join(paths.runsRoot, input.runId);
    if (!pathWithin(paths.runsRoot, target)) {
      throw new CleanupError("cleanup_failed", "The run path escaped the owned root.");
    }
    try {
      const loaded = await new FileRunStore(paths.stateRoot).load(input.runId);
      const resolved =
        loaded.snapshot.integrity === "valid" &&
        ["completed", "failed", "stopped"].includes(loaded.snapshot.status) &&
        loaded.snapshot.checkpoint?.unresolved_work.length === 0 &&
        loaded.snapshot.checkpoint?.usage_completeness !== "unknown" &&
        !loaded.journal.some(
          (event) => event.event === "operation" && event.lifecycle.state === "uncertain",
        );
      if (!resolved) {
        preserved.push(target);
        reasons.push("run_unresolved_or_uncertain");
        return { scope, preview, removed, preserved, reasons };
      }
    } catch {
      preserved.push(target);
      reasons.push("run_unverifiable");
      return { scope, preview, removed, preserved, reasons };
    }
    await planOrRemove(target, preview, removed, preserved);
    return { scope, preview, removed, preserved, reasons };
  }
  if (scope === "workflow-session") {
    if (input.sessionId === undefined) {
      throw new CleanupError(
        "cleanup_failed",
        "Workflow session cleanup requires one validated session id.",
      );
    }
    const sessionId = assertSafeSessionId(input.sessionId);
    const target = join(paths.generatedWorkflowsRoot, sessionId);
    if (!pathWithin(paths.generatedWorkflowsRoot, target)) {
      throw new CleanupError("cleanup_failed", "The workflow session path escaped the owned root.");
    }
    try {
      const store = new GeneratedWorkflowStore(paths.stateRoot, {
        now: () => now,
        ...(options.generatedWorkflowBoundary === undefined
          ? {}
          : { boundary: options.generatedWorkflowBoundary }),
      });
      if (!(await store.sessionExists(sessionId))) {
        return { scope, preview, removed, preserved, reasons };
      }
      if (!preview) await store.sessionEnd(sessionId);
      removed.push(target);
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) return { scope, preview, removed, preserved, reasons };
      if (error instanceof GeneratedWorkflowStoreError && error.code === "needs_root_decision") {
        preserved.push(target);
        reasons.push("workflow_session_uncertain");
        return { scope, preview, removed, preserved, reasons };
      }
      throw new CleanupError(
        "cleanup_failed",
        "The generated workflow session could not be cleaned.",
        error,
      );
    }
    return { scope, preview, removed, preserved, reasons };
  }
  if (scope === "expired") {
    await removeExpired(paths, preview, removed, preserved, active?.artifact_id, cutoff);
    await removeExpiredGeneratedWorkflows(
      paths,
      preview,
      removed,
      preserved,
      now,
      cutoff,
      options.generatedWorkflowBoundary,
    );
    return { scope, preview, removed, preserved, reasons };
  }
  if (active) {
    try {
      await verifyActivation(paths, active);
    } catch {
      preserved.push("marketplace:holycodex");
      reasons.push("effect_uncertain");
      return { scope, preview, removed, preserved, reasons };
    }
  }
  const marketplace = await readMarketplace(paths.marketplaceFile).catch((error: unknown) => {
    if (isFsCode(error, "ENOENT")) {
      return { plugins: [] };
    }
    throw error;
  });
  const managed = active ? findManagedEntry(marketplace) : undefined;
  if (active && managed && managedEntryMatches(managed, active)) {
    const next = {
      ...marketplace,
      plugins: marketplace.plugins.filter((entry) => entry !== managed),
    };
    if (!preview) {
      await writeMarketplace(paths.marketplaceFile, next);
    }
    removed.push("marketplace:holycodex");
  } else if (managed) {
    preserved.push("marketplace:holycodex");
    reasons.push("marketplace_entry_changed");
  }
  if (active) {
    const artifact = join(paths.marketplaceRoot, active.relative_path.slice(2));
    await planOrRemove(artifact, preview, removed, preserved);
    await planOrRemove(paths.activeRecord, preview, removed, preserved);
  }
  await planOrRemove(paths.journal, preview, removed, preserved);
  await removeExpired(paths, preview, removed, preserved, active?.artifact_id, cutoff);
  await removeExpiredGeneratedWorkflows(
    paths,
    preview,
    removed,
    preserved,
    now,
    cutoff,
    options.generatedWorkflowBoundary,
  );
  return { scope, preview, removed, preserved, reasons };
}

async function removeExpiredGeneratedWorkflows(
  paths: ResolvedInstallerPaths,
  preview: boolean,
  removed: string[],
  preserved: string[],
  now: Date,
  cutoff: number,
  boundary: InstallerOptions["generatedWorkflowBoundary"],
): Promise<void> {
  try {
    const store = new GeneratedWorkflowStore(paths.stateRoot, {
      now: () => now,
      ttlMs: Math.max(1, now.getTime() - cutoff),
      ...(boundary === undefined ? {} : { boundary }),
    });
    const result = await store.cleanupExpired({ preview, maxEntries: 128, maxMs: 250 });
    removed.push(...result.removed);
    preserved.push(...result.preserved);
    preserved.push(...result.uncertain);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return;
    if (error instanceof GeneratedWorkflowStoreError && error.code === "needs_root_decision") {
      preserved.push(paths.generatedWorkflowsRoot);
      return;
    }
    preserved.push(paths.generatedWorkflowsRoot);
  }
}

async function inspectJournal(paths: ResolvedInstallerPaths): Promise<DoctorCheck> {
  try {
    const text = await readFile(paths.journal, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    let expectedSequence = 1;
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      const record = decodeSchema(InstallJournalRecordSchema, parsed);
      if (record === undefined || record.sequence !== expectedSequence) {
        return failedCheck(["journal_corrupt"]);
      }
      expectedSequence += 1;
    }
    return healthyCheck({ entries: lines.length });
  } catch (error: unknown) {
    return isFsCode(error, "ENOENT")
      ? healthyCheck({ entries: 0 })
      : failedCheck(["journal_corrupt"]);
  }
}

async function inspectStaging(paths: ResolvedInstallerPaths): Promise<DoctorCheck> {
  try {
    await assertNoSymlink(paths.stagingRoot);
    const entries = await readdir(paths.stagingRoot);
    return entries.length === 0
      ? healthyCheck({ count: 0 })
      : warningCheck(["staging_present"], { count: entries.length });
  } catch (error: unknown) {
    return isFsCode(error, "ENOENT")
      ? healthyCheck({ count: 0 })
      : failedCheck(["staging_corrupt"]);
  }
}

async function inspectLock(paths: ResolvedInstallerPaths): Promise<DoctorCheck> {
  try {
    const entry = await lstat(paths.lock);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return failedCheck(["lock_corrupt"]);
    }
    return warningCheck(["lock_present"], {});
  } catch (error: unknown) {
    return isFsCode(error, "ENOENT")
      ? healthyCheck({ present: false })
      : failedCheck(["lock_unreadable"]);
  }
}

async function inspectCodexMcp(paths: ResolvedInstallerPaths): Promise<DoctorCheck> {
  const config = join(paths.codexHome, "config.toml");
  try {
    await assertNoSymlink(config);
    const contents = await readFile(config, "utf8");
    if (/mcp[\s._-]*servers?/iu.test(contents) && /holycodex/iu.test(contents)) {
      return failedCheck(["holycodex_mcp_present"]);
    }
    return healthyCheck({ configured: true });
  } catch (error: unknown) {
    return isFsCode(error, "ENOENT")
      ? healthyCheck({ configured: false })
      : failedCheck(["config_unreadable"]);
  }
}

async function inspectCodexExecutable(options: InstallerOptions): Promise<DoctorCheck> {
  if (!options.codexExecutable) {
    return {
      status: "unsupported",
      reasons: ["codex_executable_probe_not_configured"],
      details: {},
    };
  }
  try {
    const identity = await options.codexExecutable.discover();
    return healthyCheck({
      path: identity.path,
      version: identity.version,
      sha256: identity.sha256,
    });
  } catch (error: unknown) {
    return failedCheck(["codex_executable_unavailable"], { error: safeMessage(error) });
  }
}

async function listInactiveArtifacts(
  paths: ResolvedInstallerPaths,
  activeId: string | undefined,
): Promise<readonly string[]> {
  try {
    const entries = await readdir(paths.payloadRoot);
    return entries.filter((entry) => entry !== activeId && entry.startsWith("artifact-")).sort();
  } catch (error: unknown) {
    return isFsCode(error, "ENOENT") ? [] : ["payload-root-unreadable"];
  }
}

async function removeExpired(
  paths: ResolvedInstallerPaths,
  preview: boolean,
  removed: string[],
  preserved: string[],
  activeArtifactId?: string,
  cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000,
): Promise<void> {
  const store = new FileRunStore(paths.stateRoot);
  for (const root of [paths.stagingRoot, paths.runsRoot]) {
    try {
      await assertNoSymlink(root);
      const entries = await readdir(root);
      for (const entry of [...entries].sort()) {
        const candidate = join(root, entry);
        if (!pathWithin(root, candidate)) {
          preserved.push(candidate);
          continue;
        }
        const metadata = await lstat(candidate).catch(() => undefined);
        if (!metadata || metadata.isSymbolicLink()) {
          preserved.push(candidate);
          continue;
        }
        if (metadata.mtimeMs > cutoff) {
          preserved.push(candidate);
          continue;
        }
        if (root === paths.runsRoot) {
          try {
            const loaded = await store.load(entry);
            const resolved =
              loaded.snapshot.integrity === "valid" &&
              ["completed", "failed", "stopped"].includes(loaded.snapshot.status) &&
              loaded.snapshot.checkpoint?.unresolved_work.length === 0 &&
              loaded.snapshot.checkpoint?.usage_completeness !== "unknown" &&
              !loaded.journal.some(
                (event) => event.event === "operation" && event.lifecycle.state === "uncertain",
              );
            if (!resolved) {
              preserved.push(candidate);
              continue;
            }
          } catch {
            preserved.push(candidate);
            continue;
          }
        } else {
          try {
            await verifyPayload(candidate);
          } catch {
            preserved.push(candidate);
            continue;
          }
        }
        await planOrRemove(candidate, preview, removed, preserved);
      }
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) {
        preserved.push(root);
      }
    }
  }
  try {
    const entries = await readdir(paths.payloadRoot);
    for (const entry of [...entries.filter((value) => value.startsWith("artifact-"))].sort()) {
      if (entry === activeArtifactId) {
        preserved.push(join(paths.payloadRoot, entry));
        continue;
      }
      const candidate = join(paths.payloadRoot, entry);
      try {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink() || metadata.mtimeMs > cutoff) {
          preserved.push(candidate);
          continue;
        }
        await assertNoSymlink(candidate);
        const verified = await verifyPayload(candidate);
        if (!entry.startsWith(`artifact-${verified.identity.digest}-${verified.identity.epoch}`)) {
          preserved.push(candidate);
          continue;
        }
      } catch {
        preserved.push(candidate);
        continue;
      }
      await planOrRemove(candidate, preview, removed, preserved);
    }
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) {
      preserved.push(paths.payloadRoot);
    }
  }
}

async function planOrRemove(
  path: string,
  preview: boolean,
  removed: string[],
  preserved: string[],
): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      preserved.push(path);
      return;
    }
    if (!preview) {
      await rm(path, { recursive: entry.isDirectory(), force: false });
    }
    removed.push(path);
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) {
      preserved.push(path);
    }
  }
}

function healthyCheck(details: JsonObject): DoctorCheck {
  return { status: "healthy", reasons: [], details };
}

function warningCheck(reasons: readonly string[], details: JsonObject): DoctorCheck {
  return { status: "warning", reasons, details };
}

function failedCheck(reasons: readonly string[], details: JsonObject = {}): DoctorCheck {
  return { status: "failed", reasons, details };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}

export class CleanupError extends Error {
  readonly code: "cleanup_failed";
  readonly causeValue: unknown;

  constructor(code: "cleanup_failed", message: string, causeValue?: unknown) {
    super(message);
    this.name = "CleanupError";
    this.code = code;
    this.causeValue = causeValue;
  }
}
