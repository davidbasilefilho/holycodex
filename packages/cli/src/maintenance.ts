// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FileRunStore } from "@holycodex/workflow-host";
import { pluginIdsForOptionalCapabilities, type JsonObject } from "@holycodex/core";
import { DEFAULT_MODE_USER_INPUT_FEATURE, readActiveInstallRecord } from "./installer.ts";
import { CodexOfficialPluginManager } from "./official-manager.ts";
import { assertNoSymlinkTree, isFsCode, pathWithin, resolveInstallerPaths } from "./paths.ts";
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
    checks["configuration"] = active
      ? healthyCheck({ plan: active.plan, tier: active.tier })
      : failedCheck(["configuration_missing"]);
  }
  const manager =
    options.officialPluginManager ??
    (await CodexOfficialPluginManager.discover(environment).catch(() => undefined));
  if (active && manager?.status) {
    const selected = [
      "holycodex@holycodex",
      ...pluginIdsForOptionalCapabilities(active.optional_selections, active.official_plugins),
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
  if (manager?.featureEnabled) {
    try {
      checks["request_user_input"] = (await manager.featureEnabled(DEFAULT_MODE_USER_INPUT_FEATURE))
        ? healthyCheck({ feature: DEFAULT_MODE_USER_INPUT_FEATURE })
        : failedCheck(["request_user_input_disabled"]);
    } catch (error: unknown) {
      checks["request_user_input"] = failedCheck(["request_user_input_verification_failed"], {
        error: safeMessage(error),
      });
    }
  } else {
    checks["request_user_input"] = {
      status: "unsupported",
      reasons: ["request_user_input_verification_unavailable"],
      details: {},
    };
  }
  const reasons = Object.values(checks).flatMap((check) => check.reasons);
  return {
    healthy: Object.values(checks).every((check) => check.status !== "failed"),
    checks,
    reasons: [...new Set(reasons)],
    inactive_artifacts: [],
  };
}

export async function cleanupHolyCodex(
  scope: CleanupScope,
  options: InstallerOptions = {},
  input: Readonly<{ yes?: boolean; runId?: string; sessionId?: string }> = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CleanupResult> {
  const paths = resolveInstallerPaths(options, environment);
  await assertNoSymlinkTree(paths.stateRoot);
  const preview = input.yes !== true;
  const removed: string[] = [];
  const preserved: string[] = [];
  const reasons: string[] = [];
  if (scope === "run") {
    if (!input.runId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.runId)) {
      throw new CleanupError("cleanup_failed", "Run cleanup requires a safe run id.");
    }
    const target = join(paths.runsRoot, input.runId);
    if (!pathWithin(paths.runsRoot, target))
      throw new CleanupError("cleanup_failed", "Run path escaped the owned root.");
    if (!(await runResolved(paths.stateRoot, input.runId))) {
      preserved.push(target);
      reasons.push("run_unresolved_or_uncertain");
    } else await planOrRemove(target, preview, removed, preserved);
    return { scope, preview, removed, preserved, reasons };
  }
  if (scope === "workflow-session") {
    const sessionId = assertSafeSessionId(input.sessionId ?? "");
    const target = join(paths.generatedWorkflowsRoot, sessionId);
    try {
      const store = new GeneratedWorkflowStore(paths.codexHome, boundaryOptions(options));
      if (await store.sessionExists(sessionId)) {
        if (!preview) await store.sessionEnd(sessionId);
        removed.push(target);
      }
    } catch (error: unknown) {
      if (error instanceof GeneratedWorkflowStoreError && error.code === "needs_root_decision") {
        preserved.push(target);
        reasons.push("workflow_session_uncertain");
      } else throw error;
    }
    return { scope, preview, removed, preserved, reasons };
  }
  if (scope === "workspace") {
    await planOrRemove(paths.activeRecord, preview, removed, preserved);
  }
  await removeExpiredRuns(paths.stateRoot, paths.runsRoot, preview, removed, preserved, options);
  try {
    const store = new GeneratedWorkflowStore(paths.codexHome, boundaryOptions(options));
    const result = await store.cleanupExpired({ preview, maxEntries: 128, maxMs: 250 });
    removed.push(...result.removed);
    preserved.push(...result.preserved, ...result.uncertain);
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) preserved.push(paths.generatedWorkflowsRoot);
  }
  return { scope, preview, removed, preserved, reasons };
}

function boundaryOptions(options: InstallerOptions) {
  return {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.generatedWorkflowBoundary === undefined
      ? {}
      : { boundary: options.generatedWorkflowBoundary }),
  };
}

async function runResolved(stateRoot: string, runId: string): Promise<boolean> {
  try {
    const loaded = await new FileRunStore(stateRoot).load(runId);
    return (
      loaded.snapshot.integrity === "valid" &&
      ["completed", "failed", "stopped"].includes(loaded.snapshot.status) &&
      loaded.snapshot.checkpoint?.unresolved_work.length === 0 &&
      loaded.snapshot.checkpoint?.usage_completeness !== "unknown" &&
      !loaded.journal.some(
        (event) => event.event === "operation" && event.lifecycle.state === "uncertain",
      )
    );
  } catch {
    return false;
  }
}

async function removeExpiredRuns(
  stateRoot: string,
  root: string,
  preview: boolean,
  removed: string[],
  preserved: string[],
  options: InstallerOptions,
): Promise<void> {
  const cutoff =
    (options.now?.() ?? new Date()).getTime() - (options.retentionDays ?? 30) * 86_400_000;
  try {
    for (const entry of await readdir(root)) {
      const target = join(root, entry);
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || stat.mtimeMs > cutoff || !(await runResolved(stateRoot, entry)))
        preserved.push(target);
      else await planOrRemove(target, preview, removed, preserved);
    }
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) preserved.push(root);
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
    if (entry.isSymbolicLink()) preserved.push(path);
    else {
      if (!preview) await rm(path, { recursive: entry.isDirectory(), force: false });
      removed.push(path);
    }
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) preserved.push(path);
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

export class CleanupError extends Error {
  readonly code = "cleanup_failed" as const;
  readonly causeValue: unknown;
  constructor(_code: "cleanup_failed", message: string, causeValue?: unknown) {
    super(message);
    this.name = "CleanupError";
    this.causeValue = causeValue;
  }
}
